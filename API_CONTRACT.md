# API Contract — Campus Equipment Booking API

Base URL (local): `http://localhost:8787/api`
All bodies are JSON (`Content-Type: application/json`). All timestamps are ISO 8601 UTC, e.g. `2026-10-20T09:00:00.000Z`.

## Endpoints

| Method | Path | Success | Errors |
|---|---|---:|---|
| GET | `/equipment` | 200 | – |
| GET | `/bookings` (optional `?equipmentId=`) | 200 | – |
| GET | `/bookings/:id` | 200 | 404 |
| POST | `/bookings` | 201 | 400, 409 |
| PATCH | `/bookings/:id` | 200 | 400, 404, 409 |
| DELETE | `/bookings/:id` | 204 (no body) | 404 |

## Booking object
```json
{
  "id": "223fc300-3962-4d51-9c1d-69b166db687f",
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation",
  "createdAt": "2026-10-06T06:59:53.150Z"
}
```

## Validation rules
| Field | Rule |
|---|---|
| equipmentId | required string; must exist in `equipment` |
| borrowerName | required string, 1–100 chars after trim |
| startAt / endAt | required, strict ISO 8601 UTC; `startAt < endAt` |
| purpose | optional string, ≤ 200 chars (defaults to `""`) |

PATCH accepts any subset of the fields (at least one). The server merges them with the stored booking and re-validates the whole result.

## Error format
Always `{ "error": "message" }`.

| Status | When |
|---|---|
| 400 | invalid JSON, missing/wrong-type field, bad date, `startAt >= endAt`, unknown `equipmentId` in body, empty PATCH |
| 404 | booking `:id` in the URL not found; unknown route |
| 409 | time range overlaps another booking of the same equipment (create **and** update) |
| 413 | body larger than 10 KB |
| 500 | unexpected server error (generic message, no internals) |

## Assumptions (and why)
1. **Overlap rule is half-open**: `existing.start < new.end AND existing.end > new.start`. Back-to-back bookings (09–11, 11–13) are allowed.
2. **Unknown `equipmentId` in a body → 400**, not 404: the URL is valid, the payload is wrong. 404 is for the URL's resource.
3. Overlap is checked per equipment only; different equipment may share a time.
4. Timestamps are normalised to `toISOString()` so stored strings have a fixed width and can be compared as text in SQL.
5. No authentication (not in the brief). Would be the next step in a real system.
