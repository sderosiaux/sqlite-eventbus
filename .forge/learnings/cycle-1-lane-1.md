# Learnings — Cycle 1, Lane 1: foundation-types-and-storage

## FRICTION
- SQLite `:memory:` silently ignores `PRAGMA journal_mode = WAL` and returns `memory`. WAL test must use file-based DB with tmpdir cleanup (`src/store/store.test.ts:18-20`).
- Purge test initially used `created_at` logic but `purgeDlqEvents` uses `dlq_at`. Since `moveEventToDlq` sets `dlq_at = now()`, test needed `rawExec` to backdate `dlq_at` for the old event (`src/store/store.test.ts:263`).
- `better-sqlite3` pragma return type is `Array<{ journal_mode: string }>`, not a plain string (`src/store/store.test.ts:42`).

## GAP
- Spec doesn't specify whether `Subscription` in DB includes handler. Handlers are JS functions and can't be serialized. Created `SubscriptionRow` (without handler) for persistence vs `Subscription` (with handler) for in-memory registry (`src/types/index.ts:26-35`).
- Spec doesn't explicitly define a `dlq_at` column in the original schema (EVENTBUS-SPECIFICATION.md:144-165) — it's a future-work item (EVENTBUS-SPECIFICATION.md:250). Implemented as part of CHK-015 by adding it to the CREATE TABLE.

## DECISION
- **SubscriptionRow vs Subscription split** (`src/types/index.ts:26-35`): DB stores subscription metadata only; handler lives in an in-memory `Map`. Matches "in-process" design.
- **Prepared statement caching via Map** (`src/store/index.ts:80-87`): Statements cached on first `prepare()` and reused. Key is the raw SQL string. Simpler than class property per statement — more flexible for adding new queries in later lanes.
- **`purgeDlqEvents` uses `dlq_at` not `created_at`** (`src/store/index.ts:145`): CHK-015 adds `dlq_at` column specifically so purge operates on DLQ entry time. Previous cycle used `created_at` which was documented as debt.
- **`rawExec` escape hatch** (`src/store/index.ts:152`): Exposed for test backdating. Not part of production API but needed for realistic purge testing.
- **`moveEventToDlq` as single atomic update** (`src/store/index.ts:118-122`): Sets `status='dlq'`, `last_error`, `dlq_at`, and `updated_at` in one statement. Cleaner than separate `updateEventStatus` + `updateEventRetry`.

## SURPRISE
- `better-sqlite3` synchronous API means the entire store layer is sync. No async/await needed until handler invocation in later lanes.
- Statement cache `Map<string, Statement>` works cleanly — `better-sqlite3` prepared statements are reusable across calls with different bind parameters.

## DEBT
- `rawExec` is exposed publicly for test use. Could be test-only via subclass, but not worth the complexity for an internal library.
