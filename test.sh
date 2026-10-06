#!/usr/bin/env bash
# Usage: BASE_URL=http://localhost:8787/api bash test.sh
# Each case prints: PASS/FAIL, expected vs actual status, and the response body (evidence).
BASE_URL="${BASE_URL:-http://localhost:8787/api}"
PASS=0; FAIL=0
TMP=$(mktemp)

# check "name" EXPECTED_STATUS METHOD PATH [json-body]
check() {
  local name="$1" expected="$2" method="$3" path="$4" body="$5" status
  if [ -n "$body" ]; then
    status=$(curl -s -o "$TMP" -w '%{http_code}' -X "$method" "$BASE_URL$path" -H 'Content-Type: application/json' -d "$body")
  else
    status=$(curl -s -o "$TMP" -w '%{http_code}' -X "$method" "$BASE_URL$path")
  fi
  if [ "$status" = "$expected" ]; then PASS=$((PASS+1)); r=PASS; else FAIL=$((FAIL+1)); r=FAIL; fi
  echo "[$r] $name  ($method $path) expected=$expected actual=$status"
  echo "      $(cat "$TMP")"
}

B1='{"equipmentId":"eq-1","borrowerName":"Somchai Jaidee","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z","purpose":"Class presentation"}'

check "01 list equipment"                200 GET  /equipment
check "02 create booking"                201 POST /bookings "$B1"
ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$TMP")
check "03 get booking by id"             200 GET  "/bookings/$ID"
check "04 list bookings"                 200 GET  /bookings
check "05 overlap (create) -> conflict"  409 POST /bookings '{"equipmentId":"eq-1","borrowerName":"Mali","startAt":"2026-10-20T10:00:00.000Z","endAt":"2026-10-20T12:00:00.000Z"}'
check "06 back-to-back is allowed"       201 POST /bookings '{"equipmentId":"eq-1","borrowerName":"Mali","startAt":"2026-10-20T11:00:00.000Z","endAt":"2026-10-20T13:00:00.000Z"}'
ID2=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$TMP")
check "07 same time, other equipment ok" 201 POST /bookings '{"equipmentId":"eq-2","borrowerName":"Mali","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z"}'
ID3=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$TMP")
check "08 update purpose only"           200 PATCH "/bookings/$ID" '{"purpose":"Updated purpose"}'
check "09 update keeps own slot (no self-conflict)" 200 PATCH "/bookings/$ID" '{"startAt":"2026-10-20T09:30:00.000Z"}'
check "10 update into other booking -> conflict" 409 PATCH "/bookings/$ID" '{"endAt":"2026-10-20T12:00:00.000Z"}'
check "11 update start>=end -> 400"      400 PATCH "/bookings/$ID" '{"startAt":"2026-10-20T11:00:00.000Z"}'
check "12 update empty body -> 400"      400 PATCH "/bookings/$ID" '{}'
check "13 update missing id -> 404"      404 PATCH /bookings/does-not-exist '{"purpose":"x"}'
check "14 unknown equipmentId -> 400"    400 POST /bookings '{"equipmentId":"eq-999","borrowerName":"A","startAt":"2026-10-21T09:00:00.000Z","endAt":"2026-10-21T10:00:00.000Z"}'
check "15 missing field -> 400"          400 POST /bookings '{"equipmentId":"eq-1","borrowerName":"A","startAt":"2026-10-21T09:00:00.000Z"}'
check "16 start after end -> 400"        400 POST /bookings '{"equipmentId":"eq-1","borrowerName":"A","startAt":"2026-10-21T11:00:00.000Z","endAt":"2026-10-21T10:00:00.000Z"}'
check "17 bad date format -> 400"        400 POST /bookings '{"equipmentId":"eq-1","borrowerName":"A","startAt":"tomorrow","endAt":"2026-10-21T10:00:00.000Z"}'
check "18 wrong type -> 400"             400 POST /bookings '{"equipmentId":"eq-1","borrowerName":123,"startAt":"2026-10-21T09:00:00.000Z","endAt":"2026-10-21T10:00:00.000Z"}'
check "19 malformed JSON -> 400"         400 POST /bookings '{"equipmentId":'
check "20 SQL injection string is inert" 404 GET  "/bookings/1'%20OR%20'1'='1"
check "21 get missing -> 404"            404 GET  /bookings/does-not-exist
check "22 delete booking"                204 DELETE "/bookings/$ID"
check "23 delete again -> 404"           404 DELETE "/bookings/$ID"
check "24 get deleted -> 404"            404 GET  "/bookings/$ID"
check "25 unknown route -> JSON 404"     404 GET  /nope
check "26 cleanup booking 2"             204 DELETE "/bookings/$ID2"
check "27 cleanup booking 3"             204 DELETE "/bookings/$ID3"

echo; echo "Result: $PASS passed, $FAIL failed"; rm -f "$TMP"; [ "$FAIL" -eq 0 ]
