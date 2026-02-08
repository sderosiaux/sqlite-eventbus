# Learnings — Cycle 1, Lane 3: retry-and-dlq-routing (attempt 2)

## FRICTION
- Existing lane-2 test `records error on handler failure` (`src/dispatcher/dispatcher.test.ts:85`) assumed `lastError` was a plain string. Changing to JSON array required updating assertion to `JSON.parse` + `.toContain`.
- Timeout tests (`CHK-017`) used default retry policy (1s base delay), making the suite ~20s. Fixed by passing `maxRetries: 0` in timeout test setup (`src/dispatcher/dispatcher.test.ts:150-151`) to eliminate retry overhead.

## GAP
- Spec says "All error messages from each attempt" (EVENTBUS-SPECIFICATION.md:172) but the `events` table has a single `last_error TEXT` column — no array/history column. Decision documented below.

## DECISION
- **Error history as JSON array in `lastError`** (`src/dispatcher/index.ts:63-83`): Accumulate errors in `string[]`, serialize via `JSON.stringify` before storing in the `last_error TEXT` column. Each failed attempt pushes its error message. Successful attempts don't push (array length = number of failed attempts). Alternative: separate `dlq_errors` table — rejected as over-engineering for v1 with a single TEXT column already available.
- **Structured log on every failed attempt** (`src/dispatcher/index.ts:91-101`): Removed the `attempt < maxAttempts` guard. The final failed attempt now also emits a log entry with `delay_ms: 0` since there's no next retry. Spec says "Each retry attempt must emit a structured log entry" — the last attempt is still an attempt.
- **Removed redundant `updateEventRetry`** after loop exit (`src/dispatcher/index.ts:109` in previous code): The same values were already written at line 85 during the last loop iteration. Removing it eliminates dead code.
- **Fast retry policy in timeout tests** (`src/dispatcher/dispatcher.test.ts:150-151`): Passed `maxRetries: 0` to avoid retrying timeout failures 3 times with 1s+ delays. This reduces timeout test duration from ~20s to <1s.

## SURPRISE
- The `errorHistory` array naturally serves as an audit trail — its length equals the number of failed attempts, which is independently useful for diagnostics beyond just the error messages themselves.

## DEBT
- None added in this attempt. Previous debt items (prepared statement caching, matchGlob edge cases) remain from lanes 1-2.
