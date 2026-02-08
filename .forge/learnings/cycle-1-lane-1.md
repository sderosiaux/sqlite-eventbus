# Learnings — Cycle 1, Lane 1: foundation-types-and-storage (attempt 2)

## FRICTION
- SQLite `:memory:` silently ignores `PRAGMA journal_mode = WAL` and returns `memory`. WAL test must use file-based DB with tmpdir cleanup (`src/store/store.test.ts:10-13`).
- Purge test needs `rawExec` to backdate `dlq_at` since `moveEventToDlq` always sets `dlq_at = now()` (`src/store/store.test.ts:265-267`).
- `better-sqlite3` pragma return type is `Array<{ journal_mode: string }>`, not a plain string (`src/store/store.test.ts:42`).
- **Review V1**: `InsertEventParams.payload` was typed as `string`, meaning callers pre-serialized. Spec says "storage layer must serialize payload as JSON text" (`EVENTBUS-SPECIFICATION.md:135`). Fixed: payload now accepts `unknown`, store calls `JSON.stringify` internally (`src/store/index.ts:107-109`).
- **Review V2**: `better-sqlite3` ABI mismatch in review environment (`NODE_MODULE_VERSION 127 vs 141`). Added `postinstall` and `rebuild` scripts to `package.json` to auto-rebuild native module.
- **Review V3**: CHK-014 test line reference in `checkboxes.md` pointed to wrong line (290 = "deletes a subscription"). Must verify line numbers after every test file edit.
- **Review code issue**: `afterEach` called `store.close()` without null guard; if constructor fails, `store` is undefined causing secondary TypeError. Fixed with optional chaining (`store?.close()`).

## GAP
- Spec doesn't specify whether `Subscription` in DB includes handler. Handlers are JS functions and can't be serialized. Created `SubscriptionRow` (without handler) for persistence vs `Subscription` (with handler) for in-memory registry (`src/types/index.ts:26-35`).
- Spec doesn't explicitly define a `dlq_at` column in the original schema (EVENTBUS-SPECIFICATION.md:144-165) — it's a future-work item (EVENTBUS-SPECIFICATION.md:250). Implemented as part of CHK-015.

## DECISION
- **Store-side serialization** (`src/store/index.ts:107-112`): `insertEvent` accepts `unknown` payload and `Record<string, string>` metadata. Store calls `JSON.stringify` for both. If payload is already a string, it's stored as-is (backward compatible with pre-serialized callers).
- **SubscriptionRow vs Subscription split** (`src/types/index.ts:26-35`): DB stores subscription metadata only; handler lives in an in-memory `Map`.
- **Prepared statement caching via Map** (`src/store/index.ts:84-91`): Key is raw SQL string. Simpler and more flexible than class-property-per-statement.
- **`purgeDlqEvents` uses `dlq_at` not `created_at`** (`src/store/index.ts:175`): Resolves previous cycle's documented debt.
- **`moveEventToDlq` as single atomic update** (`src/store/index.ts:141-145`): Sets status, last_error, dlq_at, updated_at in one statement.
- **`postinstall` rebuild script** (`package.json:8`): Ensures `better-sqlite3` native addon is built for the current Node.js ABI on install.

## SURPRISE
- `better-sqlite3` synchronous API means the entire store layer is sync. Async only enters at the handler level.
- Statement cache `Map<string, Statement>` works cleanly — prepared statements are reusable across calls with different bind parameters.

## DEBT
- `rawExec` is exposed publicly for test use. Acceptable for internal library.
- Payload serialization accepts `string | non-string`: if already a string, it's stored as-is without double-serializing. This means a caller could pass an arbitrary non-JSON string. Acceptable because the store is internal — callers are EventBus methods, not external users.
