# Learnings — Cycle 1, Lane 1: foundation-types-and-storage (attempt 3)

## FRICTION
- SQLite `:memory:` silently ignores `PRAGMA journal_mode = WAL`. WAL test must use file-based DB with tmpdir cleanup (`src/store/store.test.ts:10-13`).
- `better-sqlite3` ABI mismatch recurs across sessions when Node.js version changes. `postinstall` script in `package.json:8` auto-rebuilds, but doesn't help when the binary was already loaded by a previous `npm install`. Must run `npm rebuild better-sqlite3` explicitly.
- **Review V1 (attempt 2)**: Spec CHK-015 wording "purge() uses `created_at`, not DLQ entry time" means purge should use `created_at` — the `dlq_at` column is informational metadata, not the purge cutoff. Initially implemented purge against `dlq_at` which reversed the spec intent.
- **Review V2 (attempt 2)**: Asserting `getCacheSize() > 0` doesn't prove reuse — a per-call cache that creates new entries each time would also pass. Need to prove cache hits via counter (`src/store/index.ts:84-88`).

## GAP
- Spec doesn't specify whether `Subscription` in DB includes handler. Created `SubscriptionRow` (without handler) for persistence vs `Subscription` (with handler) for in-memory registry (`src/types/index.ts:26-35`).
- Spec doesn't explicitly define `dlq_at` in the original schema — it's a future-work item (EVENTBUS-SPECIFICATION.md:250). Added to CREATE TABLE as part of CHK-015.

## DECISION
- **`purgeDlqEvents` uses `created_at`** (`src/store/index.ts:177`): Spec says `purge()` uses `created_at`. The `dlq_at` column records when an event entered DLQ but is not used for purge cutoff. Added a second test that proves `dlq_at` is ignored by purge (`src/store/store.test.ts:317`).
- **Cache hit counter for CHK-014** (`src/store/index.ts:84-88,98-100`): `cacheHits` increments on every cache hit. Test asserts `hitsAfter - hitsBefore >= 9` after 10 inserts (first is a miss, 9 are hits). Also asserts cache size doesn't grow — same SQL reused.
- **Store-side serialization** (`src/store/index.ts:107-112`): `insertEvent` accepts `unknown` payload, serializes via `JSON.stringify`. If already a string, stored as-is.
- **Prepared statement caching via Map** (`src/store/index.ts:84-93`): Key is raw SQL string. `getCacheHits()` exposed for testing.

## SURPRISE
- The `better-sqlite3` ABI mismatch is session-dependent — the same `node_modules` can work in one session and break in the next if the Node.js version changes between Claude Code invocations.

## DEBT
- `rawExec` exposed publicly for test backdating. Acceptable for internal library.
- `getCacheHits()` and `getCacheSize()` are test-only introspection methods on a production class.
