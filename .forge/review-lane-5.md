---
verdict: VIOLATIONS
lane: 5
cycle: 1
---

## Violations

- CHK-016: Half-open state does not enforce a single probe event before reopening.
  Expected (from spec): `specs/EVENTBUS-SPECIFICATION.md:251` requires a "Circuit breaker half-open probe — send single probe event before fully reopening".
  Actual (in code): `src/dispatcher/index.ts:110`-`src/dispatcher/index.ts:125` treats `half-open` as always allowed (`return false`), with no probe-in-flight guard; multiple concurrent dispatches can pass during half-open before state is updated in `recordOutcome`.
  Test gap: `src/dispatcher/circuit-breaker.test.ts:199` and `src/dispatcher/circuit-breaker.test.ts:232` verify only sequential probe success/failure paths, not concurrent dispatches while half-open, so "single probe" is not enforced by tests.

- CHK-018: Circuit-breaker failure-rate accounting is not actually per-subscription across handled events.
  Expected (from spec): `specs/RETRY-POLICY.md:45` requires breaker logic based on whether events for a subscription fail (>50% in 1 minute, min 4 samples).
  Actual (in code): on failure, dispatcher records an outcome only for the first failed subscription (`src/dispatcher/index.ts:184`-`src/dispatcher/index.ts:187`); successful earlier handlers in the same dispatch are not recorded. Successes are recorded for all matching subscriptions only when the entire dispatch succeeds (`src/dispatcher/index.ts:170`-`src/dispatcher/index.ts:174`). This skews per-subscription sample windows/rates.
  Test gap: `src/dispatcher/circuit-breaker.test.ts:122`-`src/dispatcher/circuit-breaker.test.ts:152` checks that a healthy subscription still runs when another is broken, but does not assert that per-subscription success/failure samples are counted correctly when one subscription succeeds and another fails in the same event.

## Code Issues (if any)
- `src/dispatcher/index.ts:123`: Half-open path allows unrestricted traffic instead of a single probe event.
- `src/dispatcher/index.ts:184`: Failure outcome tracking is limited to the first failed subscription; successful subscriptions in failed dispatches are omitted from breaker accounting.
