# Learnings — Cycle 1, Lane 4: dlq-inspector

## FRICTION
- None significant. Store layer already had `getDlqEvents`, `countDlqEvents`, `resetDlqEvent`, `purgeDlqEvents` from lane 1. DLQInspector is a thin wrapper — 3 methods, ~30 lines (`src/dlq/index.ts`).

## GAP
- Spec says `DLQInspector.list()` returns dead events "with pagination" but doesn't specify the pagination model (cursor-based vs offset/limit), default page size, or sort order. Decision documented below.
- Spec says `DLQInspector.retry()` "re-enqueues a single dead event for reprocessing" but doesn't specify whether `retryCount` and `lastError` should be reset. Spec CHK-010 says "full reset (status→pending, retry_count→0, last_error→NULL)".
- Spec says `DLQInspector.purge()` "deletes dead events older than N days" — the "older than" boundary is ambiguous (inclusive or exclusive of the Nth day). Used `<=` (inclusive) for the cutoff timestamp.

## DECISION
- **Offset/limit pagination** (`src/dlq/index.ts:3-5`): Chose offset/limit over cursor-based. Simpler, sufficient for "< 50ms for 10k dead events" perf target with `idx_events_status` index. Default limit: 100, offset: 0.
- **Descending sort by `created_at`** (`src/store/index.ts:166`): Most recent DLQ events first — typical inspection pattern.
- **Full reset on retry** (`src/store/index.ts:176-179`): Resets status→pending, retry_count→0, last_error→NULL, dlq_at→NULL. Event re-enters dispatch as if freshly published.
- **DLQInspector takes SQLiteStore directly** (`src/dlq/index.ts:19`): Per AD-5 in spec. No dependency on EventBus or Dispatcher.
- **Retry guards** (`src/dlq/index.ts:35-40`): `retry()` throws on non-existent event ID and on events not in DLQ status. Prevents accidental reset of in-flight events.
- **DlqListResult includes total count** (`src/dlq/index.ts:8-11`): `list()` returns `{ events, total }` where total is the full DLQ count regardless of pagination. Enables UI to show "page 2 of 5" without a separate count call.

## SURPRISE
- The entire DLQInspector implementation + 20 tests took minimal effort because the store already had all the DLQ query methods from lane 1. The thin wrapper pattern (inspector delegates to store) keeps the class trivially testable.

## DEBT
- `purge()` uses `created_at` for age comparison, not `dlq_at`. If an event was created 20 days ago but entered DLQ 1 day ago, it would be purged by `purge(7)`. This matches the spec (CHK-011 says `created_at <= cutoff`) and `dlq_at` exists in the schema, so this can be changed later if needed.
