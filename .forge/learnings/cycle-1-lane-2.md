# Learnings — Cycle 1, Lane 2: core-dispatch-pipeline

## FRICTION
- Timeout testing requires real timers. Using short timeouts (50ms) vs long handler delays (500ms) gives reliable results, but tests are inherently slower than pure unit tests. No way around this with `Promise.race`-based timeout — `vi.useFakeTimers()` doesn't help with competing real async operations (`src/dispatcher/dispatcher.test.ts:117`).

## GAP
- Spec doesn't specify what happens when an event matches **multiple subscriptions** and one fails. Spec tracks retry/status at the event level (single `retryCount`, single `status`). Per-subscription delivery tracking is not modeled.
- Spec says "publish persists then dispatches" but doesn't specify whether `publish()` awaits the dispatch or fires-and-forgets. We await it — callers know when dispatch completes.
- Spec doesn't define `publish()` return value. We return the event ID (string) for consistency with `subscribe()` returning an ID.

## DECISION
- **Event-level failure tracking** (`src/dispatcher/index.ts:38-47`): If any matching handler fails, `retryCount` increments and `lastError` captures the last failure message. Event stays in `processing` state for lane 3's retry logic to pick up. Alternative: per-subscription delivery table — rejected as over-engineering for v1.
- **Sequential handler invocation** (`src/dispatcher/index.ts:36`): Handlers for the same event are invoked sequentially (for-of loop), not concurrently. This simplifies error handling and prevents resource exhaustion. Lane 5 could optimize with concurrency if needed.
- **Glob matcher as pure function** (`src/dispatcher/index.ts:80-93`): Standalone `matchGlob()` function, not a class method. Segment-by-segment comparison: `*` matches exactly one segment, standalone `*` matches everything. No regex involved.
- **Dispatcher takes handler map reference** (`src/dispatcher/index.ts:17`): Dispatcher holds a reference to the EventBus's `Map<string, Subscription>`, not a copy. This means subscriptions added after Dispatcher creation are automatically visible. Trade-off: tighter coupling, but avoids synchronization bugs.
- **Per-subscription timeout via `SubscribeOptions`** (`src/types/index.ts:23`): Extended `Subscription` type with optional `timeoutMs`. `subscribe()` now accepts an optional third argument `{ timeoutMs }`. Default 30s lives in Dispatcher, not in the type.

## SURPRISE
- `Promise.race` for timeout means the timed-out handler's promise is **abandoned but still runs** in the background. There's no way to truly cancel a JS async function. This is acceptable for the spec ("kill handler execution after timeout" is best-effort in single-threaded Node.js), but the handler may still mutate state after timeout.

## DEBT
- No structured logging for dispatch attempts yet. Spec's "Retry Observability" section (RETRY-POLICY.md:49-61) defines a log structure. Deferred to lane 3 where retry logic is implemented.
- `matchGlob` doesn't handle edge cases like empty segments (`user..created`) or empty pattern. Not in spec, not worth handling.
