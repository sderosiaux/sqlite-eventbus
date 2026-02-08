---
verdict: VIOLATIONS
lane: 1
cycle: 1
---

## Violations

- CHK-015: Purge semantics diverge from spec.
  Expected (from spec): `specs/EVENTBUS-SPECIFICATION.md:250` states: add `dlq_at`, while `purge()` uses `created_at` (not DLQ entry time).
  Actual (in code): `src/store/index.ts:175` deletes by `dlq_at <= cutoff`.
  Test gap: `src/store/store.test.ts:279` validates purge behavior against `dlq_at`, so the suite enforces the opposite of the CHK-015 wording and never verifies `created_at`-based purge behavior.

- CHK-014: Prepared-statement caching test is too loose for the spec requirement.
  Expected (from spec): `specs/EVENTBUS-SPECIFICATION.md:249` requires caching statements instead of per-call creation.
  Actual (in code): caching exists via `stmtCache`, but the recorded test (`src/store/store.test.ts:348`) only asserts `getCacheSize() > 0` after inserts.
  Test gap: this assertion does not prove statements are reused (it would still pass with non-reused/per-call prepared statements as long as cache count is non-zero).

## Code Issues (if any)
- None beyond the blocking spec/test violations above.
