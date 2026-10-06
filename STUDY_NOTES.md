# STUDY_NOTES — questions you may be asked, and the answers in this code

1. **Why 400 for unknown equipmentId but 404 for unknown booking id?** The URL `/bookings/:id` identifies the resource → missing = 404. `equipmentId` is data inside the body → invalid data = 400.
2. **Explain the overlap condition.** Two ranges overlap iff each starts before the other ends: `existing.start < new.end AND existing.end > new.start`. Strict `<`/`>` makes the ends exclusive, so 09–11 and 11–13 don't clash.
3. **Why `id != ?` on update?** Otherwise a booking would conflict with its own old time slot.
4. **Why merge before validating in PATCH?** A partial body (just `endAt`) can only be judged against the stored `startAt`. Validating the merged result applies the same rules as POST.
5. **Why one INSERT…WHERE NOT EXISTS instead of SELECT then INSERT?** Two separate statements allow a race: two requests both see "free" then both insert. One statement checks and writes together.
6. **Why does string comparison of times work?** Every value is normalised with `toISOString()` (fixed width, UTC), so lexical order = chronological order.
7. **What is parameter binding?** SQL text with `?` placeholders is compiled separately from values passed to `.bind()`, so input can never change the query structure (SQL injection). See test 20.
8. **What does `onError` do?** Known `HttpError` → its status + message. Anything else → log internally, return generic 500 (no stack trace leak).
9. **Why 204 on DELETE with no body?** Nothing to return; 204 says success with empty body.
10. **Known limitations:** no auth, no pagination, `purpose` optional (assumption), a booking deleted between the existence check and UPDATE would return 409 instead of 404 (negligible).
