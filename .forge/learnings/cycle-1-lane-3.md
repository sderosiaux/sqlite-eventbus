# Learnings — Cycle 1, Lane 3: dispatch-and-retry (attempt 4)

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

## DECISION (continued)
- **EventBus.publish() delegates to Dispatcher** (`src/bus/index.ts:98-99`): Removed inline sequential dispatch from publish(). Now creates Dispatcher in constructor, passes `DispatcherOptions` through. Bus test for handler failure updated: expects `dlq` instead of `processing` since Dispatcher handles full retry→DLQ lifecycle.
- **EventBus constructor accepts DispatcherOptions** (`src/bus/index.ts:13-16`): Allows tests to inject `delayFn: async () => {}` for fast retry-related tests at the bus integration level.

## FRICTION (attempt 3)
- **Review V1**: Retry policy derived from `matching[0].retry` only. When two matching subs had different `maxRetries`, the second sub's override was ignored. Fix: `mergeRetryPolicies()` iterates all matching subs with overrides, takes most permissive per field (`src/dispatcher/index.ts:59-80`).
- **Review V2**: CHK-006 recorded evidence line (`dispatcher.test.ts:77`) tested handler invocation ordering but not timeout protection. Fix: added timeout assertion test within CHK-006 describe block (`src/dispatcher/dispatcher.test.ts:93-105`).
- Initial merge logic used `{ ...DEFAULT, ...sub.retry }` for base then `Math.max` against defaults — caused single-sub overrides with `maxRetries < 3` to always resolve to 3 (the default). Fix: start from first override's merged values, then merge remaining overrides only.

## DECISION (attempt 3)
- **Most-permissive merge for multi-sub retry policies** (`src/dispatcher/index.ts:59-80`): When N subs match, merge: `maxRetries=max`, `baseDelayMs=min`, `maxDelayMs=max`, `backoffMultiplier=max`. Ensures no subscription's retry budget is cut short by another sub's policy. If no subs have overrides, DEFAULT_RETRY_POLICY used.

## FRICTION (attempt 4)
- **Review V1**: CHK-020 tests only exercised custom `timeoutMs` overrides, never the default 30s. A regression in `DEFAULT_HANDLER_TIMEOUT_MS` would pass all tests. Fix: exported constant + `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(30001)` to prove default 30s fires without waiting real time (`src/dispatcher/dispatcher.test.ts:130-155`).
- `vi.useFakeTimers()` must wrap in try/finally with `vi.useRealTimers()` to avoid polluting other tests sharing the same process.

## DEBT
- None added in this attempt. Previous debt items (prepared statement caching, matchGlob edge cases) remain from lanes 1-2.
