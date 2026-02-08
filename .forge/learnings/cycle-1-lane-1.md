# Learnings — Cycle 1, Lane 1: foundation-types-and-storage

## FRICTION
- SQLite `:memory:` databases silently ignore `PRAGMA journal_mode = WAL` and return `memory` instead. WAL test must use a file-based DB with tmpdir cleanup (`src/store/store.test.ts:37`).
- `better-sqlite3` is a JS package; TypeScript types come from `@types/better-sqlite3`. The pragma return type is `Array<{ journal_mode: string }>`, not a plain string (`src/store/index.ts:37`).

## GAP
- Spec doesn't specify whether `Subscription` in the DB includes the handler function. Handlers are JS functions and can't be serialized — spec is silent on this. Created `SubscriptionRow` (without handler) for persistence vs. `Subscription` (with handler) for in-memory registry.
- Spec doesn't specify what `EventBus.subscribe()` returns. Decided it returns the subscription ID (string) since `unsubscribe()` needs it.
- Spec mentions `subscribe()` with optional `RetryPolicy` override (`bus.subscribe('order.*', handler, { retry: {...} })`), but that's a lane-3 concern. Left the API simple for now — only `(eventType, handler)`.

## DECISION
- **SubscriptionRow vs Subscription split** (`src/types/index.ts:44`): DB stores subscription metadata only; handler lives in a `Map<string, Subscription>` in EventBus memory. This avoids serialization complexity and matches the "in-process" design (spec: "no pub/sub across processes").
- **`destroy()` vs `shutdown()`**: Added `destroy()` to EventBus for test teardown. `shutdown()` is lane 5 (graceful with in-flight handling). `destroy()` is a raw close.
- **`getHandlers()` / `getStore()` accessors** (`src/bus/index.ts:48-53`): Exposed for Dispatcher (lane 2) to access internals. Kept as explicit methods rather than public fields.

## SURPRISE
- `better-sqlite3` operations are synchronous (not async). The entire store layer is sync, which simplifies the code significantly. Async only enters at the handler level.

## DEBT
- No prepared statement caching — each call creates a new prepared statement. Acceptable for v1; `better-sqlite3` handles this efficiently internally. Proper fix: cache statements as class properties.
