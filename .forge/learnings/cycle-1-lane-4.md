# Learnings — Cycle 1, Lane 4: dlq-inspector

## FRICTION
- None significant. The store layer from lane 1 was well-structured — extending it with 4 new methods (`getDlqEvents`, `countDlqEvents`, `resetDlqEvent`, `purgeDlqEvents`) was straightforward (`src/store/index.ts:81-109`).

## GAP
- Spec says `DLQInspector.list()` returns dead events "with pagination" but doesn't specify the pagination model (cursor-based vs offset/limit), default page size, or sort order. Decision documented below.
- Spec says `DLQInspector.retry()` "re-enqueues a single dead event for reprocessing" but doesn't specify whether `retryCount` and `lastError` should be reset. Decision documented below.
- Spec says `DLQInspector.purge()` "deletes dead events older than N days" — the "older than" boundary is ambiguous (inclusive or exclusive of the Nth day). Used `<=` (inclusive) for the cutoff timestamp.

## DECISION
- **Offset/limit pagination** (`src/dlq/index.ts:6-9`): Chose offset/limit over cursor-based pagination. Simpler, sufficient for the "< 50ms for 10k dead events" perf target with the `idx_events_status` index. Default limit: 100, default offset: 0.
- **Descending sort by `created_at`** (`src/store/index.ts:85`): Most recent DLQ events appear first — the typical inspection pattern is "what just failed?" not "what failed weeks ago?"
- **Full reset on retry** (`src/store/index.ts:92-96`): `retry()` resets `status → pending`, `retry_count → 0`, `last_error → NULL`. The event re-enters the normal dispatch pipeline as if freshly published. Alternative: preserve retry history — rejected because the event will accumulate new errors on the next dispatch cycle.
- **DLQInspector takes SQLiteStore directly** (`src/dlq/index.ts:16`): No dependency on EventBus. The DLQ inspector only needs read/write access to the events table. This keeps it decoupled — can be used independently for admin tooling without spinning up the full bus.

## SURPRISE
- Lane 4 depends on lane 1 only (not lane 2/3). The DLQInspector doesn't need the Dispatcher at all — it operates purely on store state. The architecture diagram in the spec shows DLQ Inspector as a sibling to Dispatcher, but they share no runtime dependency.

## DEBT
- `purge()` uses `created_at` for age comparison, not the time the event entered DLQ. If an event was created 20 days ago but only entered DLQ 1 day ago, it would be purged by `purge(7)`. Proper fix: add a `dlq_at` timestamp column. Acceptable for v1 since events typically enter DLQ shortly after creation.
