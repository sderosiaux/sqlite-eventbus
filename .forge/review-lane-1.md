---
verdict: VIOLATIONS
lane: 1
cycle: 1
---

## Violations

- CHK-002: SQLiteStore does not perform payload serialization as required by spec.
  Expected (from spec): `specs/EVENTBUS-SPECIFICATION.md:135` says the storage layer must "Serialize `payload` as JSON text".
  Actual (in code): `src/store/index.ts:24` defines `InsertEventParams.payload` as `string`, and `src/store/index.ts:103` inserts `params.payload` directly without serializing.
  Test gap: `src/store/store.test.ts:83` (and other insert calls) always passes pre-serialized strings, so tests do not verify store-side serialization behavior.

- CHK-002 / CHK-014 / CHK-015: Required lane tests are not passing.
  Expected (from spec): lane work items must be validated by passing tests for WAL/auto-migration/CRUD, statement caching, and `dlq_at` behavior.
  Actual (in code): `npm test` failed with 18 failures in `src/store/store.test.ts`; only `src/types/types.test.ts` passed. Failure root is `better-sqlite3` ABI mismatch (`NODE_MODULE_VERSION 127` vs required `141`), so store work-item tests did not pass.
  Test gap: because store tests fail at setup (`new SQLiteStore(...)`), behavioral assertions for CHK-002/014/015 are not executed successfully.

- CHK-014: Recorded test location in `checkboxes.md` is incorrect for the stated work item.
  Expected (from spec): traceable test evidence for "Prepared statement caching".
  Actual (in code): `.forge/checkboxes.md:19` records `src/store/store.test.ts:290`, but the CHK-014 test is at `src/store/store.test.ts:309`.
  Test gap: traceability entry points to a different test (`deletes a subscription`), so the recorded evidence is inaccurate.

## Code Issues (if any)
- `src/store/store.test.ts:34`: `afterEach` unconditionally calls `store.close()`. When constructor/setup fails, this triggers a secondary `TypeError` (`Cannot read properties of undefined`), obscuring primary failures.
