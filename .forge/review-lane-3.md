---
verdict: VIOLATIONS
lane: 3
cycle: 1
---

## Violations

- **CHK-008**: DLQ routing does not preserve all error messages from each attempt.
  Expected (from spec): EVENTBUS-SPECIFICATION.md:172 — "All error messages from each attempt" must be included when routing to DLQ.
  Actual (in code): `src/dispatcher/index.ts:72-85` — `lastError` is reset to `''` on each attempt and overwritten with only the most recent failure. At DLQ time (line 109), only the final attempt's error is persisted via `updateEventRetry`. The `Event` type (`src/types/index.ts:16`) has a single `lastError?: string` field — no array or history mechanism exists.
  Test gap: `src/dispatcher/retry.test.ts:174-188` ("preserves last error message when routing to DLQ") only asserts the final attempt's error (`failure-attempt-4`). It does not verify that errors from attempts 1-3 are preserved. The test name itself says "last error message" — it validates the wrong invariant per spec.

## Code Issues

- `src/dispatcher/index.ts:93-105`: Structured retry log (per RETRY-POLICY.md:49-61) is only emitted when `attempt < maxAttempts`. The final failed attempt that triggers DLQ routing produces no log entry. Spec says "Each retry attempt must emit a structured log entry" — the last attempt is still an attempt.
- `src/dispatcher/index.ts:109`: Redundant `updateEventRetry` call after loop exit — the same values were already written at line 85 during the last iteration. Not a bug, but dead code.
