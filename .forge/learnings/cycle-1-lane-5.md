# Learnings — Cycle 1, Lane 5: lifecycle-and-resilience (attempt 2)

## FRICTION
- `destroy()` needed guard against double-close after `shutdown()` — `better-sqlite3` throws if you close an already-closed DB (`src/bus/index.ts:114`)
- Circuit breaker tests needed `vi.useFakeTimers()` for the 30s resume test, but `Date.now()` inside `isCircuitOpen` uses real time. Had to ensure fake timers were set before dispatch, not after.
- The Dispatcher's `dispatch()` was synchronous from caller perspective (no fire-and-forget). In-flight tracking via `Set<Promise>` required wrapping in `doDispatch` to separate the trackable promise from the awaited one (`src/dispatcher/index.ts:64-71`).
- **Shutdown timeout test**: `publish()` awaits `dispatch()`, which awaits the handler. A test with a hanging handler cannot await `publish()` before calling `shutdown()` — it blocks forever. Must fire publish without awaiting, let it enter dispatch, then call shutdown. The timeout races `drain()` via `Promise.race` (`src/bus/shutdown.test.ts:65`).

## GAP
- Spec says "wait for in-flight dispatches to complete (with timeout)" (`EVENTBUS-SPECIFICATION.md:182`) but doesn't specify the timeout value. Chose 30s default (`DEFAULT_SHUTDOWN_TIMEOUT_MS`), configurable via `shutdownTimeoutMs` option.
- Spec says "if >50% of events for a subscription fail in a 1-minute window" but doesn't define minimum sample size. Used `CIRCUIT_MIN_SAMPLES = 4` to avoid tripping the breaker on 1 failure out of 1 event (100% failure rate).
- Spec doesn't clarify whether circuit-broken subscriptions should cause the entire dispatch to fail or just skip that subscription. Chose: skip the paused subscription, other healthy subscriptions still process normally.

## DECISION
- **Shutdown timeout via `Promise.race`** (`src/bus/index.ts:97`): `shutdown()` races `drain()` against `setTimeout(resolve, shutdownTimeoutMs)`. If drain doesn't complete in time, shutdown proceeds to close the DB anyway. Abandoned in-flight handlers continue running but have no effect since the store is closed.
- **`shutdownTimeoutMs` as EventBusOptions field** (`src/bus/index.ts:10`): Configurable per-instance. Default 30s matches handler timeout. Alternative: hardcoded constant — rejected because shutdown tolerance varies by use case.
- **Circuit breaker minimum samples = 4**: Prevents premature tripping. With <4 samples, a single failure would be >50%. 4 gives meaningful signal.
- **Metrics tracked in-memory on Dispatcher**: Not persisted. The spec says "track" — in-memory `Map<eventType, RetryMetrics>` is sufficient. No DB schema changes needed.
- **`start()` increments retryCount before re-dispatch**: Per spec "increment retry_count". The crashed attempt counts as a failed attempt.
- **Circuit breaker state lives on Dispatcher, not EventBus**: Dispatcher owns dispatch logic, so circuit state belongs there.

## SURPRISE
- `Promise.race` for shutdown timeout means the losing promise (either drain or timeout) is **abandoned but still runs**. In the timeout case, drain's constituent promises (the in-flight handlers) keep executing. This is fine — the handlers are orphaned and the closed DB will cause their store calls to throw, which propagates to the abandoned publish promise.
- `vi.useFakeTimers()` works with `Date.now()` in vitest — unlike some setups where only `setTimeout`/`setInterval` are mocked. This simplified the circuit breaker resume test.

## DEBT
- **Abandoned handlers after shutdown timeout**: If shutdown times out, handlers continue executing in the background with a closed DB. Their errors propagate to the publish caller's promise. No cleanup mechanism exists. Acceptable for a single-process bus — the process is likely shutting down anyway.
- **Circuit breaker half-open state is simple reset**: On resume, outcomes are cleared entirely rather than using a proper half-open probe pattern. Acceptable for a single-process event bus.
