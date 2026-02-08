---
verdict: VIOLATIONS
lane: 5
cycle: 1
---

## Violations

- CHK-016: Half-open probe can deadlock and prevent reopening/resume in multi-subscription dispatch.
  Expected (from spec): `specs/EVENTBUS-SPECIFICATION.md:251` requires a half-open single probe before reopening, and `specs/RETRY-POLICY.md:45` requires paused subscriptions to resume after 30s.
  Actual (in code): `src/dispatcher/index.ts:118` sets `probeInFlight=true` when transitioning `open -> half-open`. If another earlier subscription fails first, `runHandlers` exits before the half-open subscription executes; failure-path accounting at `src/dispatcher/index.ts:189` only records outcomes for succeeded/failed executed subs, so the half-open sub never calls `recordOutcome` to clear `probeInFlight` (`src/dispatcher/index.ts:88`). Subsequent dispatches then keep skipping it via `src/dispatcher/index.ts:126`.
  Test gap: `src/dispatcher/circuit-breaker.test.ts:233`, `src/dispatcher/circuit-breaker.test.ts:266`, and `src/dispatcher/circuit-breaker.test.ts:304` cover single-sub probe success/failure and concurrent probe blocking, but do not cover the multi-sub path where a different earlier handler failure causes the probe subscription to be skipped and stuck.

## Code Issues (if any)
- `src/dispatcher/index.ts:118`: `probeInFlight` is set during filtering, not when probe handler actually starts.
- `src/dispatcher/index.ts:189`: failure-path outcome recording does not clear half-open probe state for subscriptions skipped due an earlier handler failure.
