---
verdict: VIOLATIONS
lane: 3
cycle: 1
---

## Violations

- CHK-007: Per-subscription retry override is not honored for all matching subscriptions.
  Expected (from spec): `SubscribeOptions.retry` is a per-subscription override and partial overrides merge with defaults (`EVENTBUS-SPECIFICATION.md:116-119`, `RETRY-POLICY.md:18-27`).
  Actual (in code): Retry policy is derived once from only the first matching subscription (`src/dispatcher/index.ts:58-64`) and then applied to all attempts for the event (`src/dispatcher/index.ts:66-107`). If another matching subscription fails and has a different retry override, that override is ignored.
  Test gap: Tests only cover single-subscription override (`src/dispatcher/dispatcher.test.ts:286`), so multi-subscription conflicting retry policies are untested.

- CHK-006: Recorded test coverage does not assert timeout protection for the work item itself.
  Expected (from spec): Dispatcher work item explicitly includes timeout protection (`EVENTBUS-SPECIFICATION.md:69`).
  Actual (in tests): The recorded CHK-006 location (`src/dispatcher/dispatcher.test.ts:77`) verifies matching/ordering only, not timeout behavior.
  Test gap: Timeout assertions exist in CHK-020 tests, but CHK-006’s recorded evidence line does not verify its own timeout requirement (`src/dispatcher/dispatcher.test.ts:77-105` vs timeout checks at `src/dispatcher/dispatcher.test.ts:110-154`).

## Code Issues (if any)
- `src/dispatcher/index.ts:58`: Retry policy selection from `matching[0]` creates incorrect behavior when multiple matching subscriptions define different retry overrides.
