---
verdict: VIOLATIONS
lane: 3
cycle: 1
---

## Violations

- CHK-020: Test coverage does not verify the required default timeout behavior.
  Expected (from spec): Handler timeout must be default 30s and configurable per subscription via `SubscribeOptions.timeoutMs`, using best-effort kill via `Promise.race` (`RETRY-POLICY.md:65`, `EVENTBUS-SPECIFICATION.md:239`).
  Actual (in code/tests): Implementation defines a 30s default (`src/dispatcher/index.ts:6`, `src/dispatcher/index.ts:114-134`), but CHK-020 tests only exercise custom `timeoutMs` overrides (`src/dispatcher/dispatcher.test.ts:126-169`) and do not assert behavior when `timeoutMs` is omitted.
  Test gap: A regression in the default timeout value could pass current CHK-020 tests because they rely on explicit override values.

## Code Issues (if any)
- None blocking found in `HEAD~1..HEAD` beyond the CHK-020 test precision gap.
