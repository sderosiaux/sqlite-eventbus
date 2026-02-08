# Learnings — Cycle 1, Lane 5: lifecycle-and-resilience

## FRICTION
- `destroy()` needed guard against double-close after `shutdown()` — `better-sqlite3` throws if you close an already-closed DB.
- Circuit breaker tests needed `vi.useFakeTimers()` for 30s resume test. `Date.now()` inside circuit breaker uses real time, so fake timers must be set before dispatch calls, not after.
- `Dispatcher.dispatch()` is awaited by `publish()`. In-flight tracking via `Set<Promise>` tracks the dispatch promise; `finally()` removes it on completion.
- **Shutdown timeout test**: `publish()` awaits `dispatch()`, which awaits the handler. A test with a hanging handler cannot await `publish()` before calling `shutdown()` — it blocks forever. Must fire publish without awaiting, let it enter dispatch, then call shutdown.
- **Abandoned dispatch after shutdown**: When shutdown times out, abandoned dispatches try to use a closed DB. Solved via `storeOp()` wrapper in Dispatcher that catches "not open" TypeError silently (`src/dispatcher/index.ts`).
- **Circuit breaker + sequential handlers**: `runHandlers` is sequential, abort-on-first-failure. When testing "circuit breaker only affects specific subscription", the healthy sub must come *before* the failing sub in Map iteration order, otherwise it never runs.

## GAP
- Spec says "wait for in-flight dispatches to complete (with timeout)" but doesn't specify timeout value. Chose 30s default, configurable via `shutdownTimeoutMs`.
- Spec says ">50% failure in 1-minute window" but doesn't define minimum sample size. Used 4 (`CIRCUIT_BREAKER_MIN_SAMPLES`) to avoid premature tripping.
- Spec doesn't clarify whether circuit-broken subs should cause dispatch to fail or just skip. Chose: skip paused sub, other healthy subs still process normally.

## DECISION
- **Shutdown via `Promise.race`**: Races drain against timeout. If drain exceeds timeout, shutdown proceeds to close DB. Abandoned handlers silently fail via `storeOp()`.
- **`shutdownTimeoutMs` configurable**: Default 30s matches handler timeout. Rejected hardcoded constant because shutdown tolerance varies by use case.
- **Circuit breaker min samples = 4**: Prevents premature tripping. With <4 samples, a single failure would be >50%.
- **Circuit breaker state per-subscription on Dispatcher**: In-memory `Map<subId, CircuitBreakerState>` with rolling 1-minute window of outcomes. States: closed/open/half-open.
- **Half-open probe**: After 30s pause, next dispatch allows single probe. Probe success → close circuit (clear outcomes). Probe failure → re-open circuit (reset openedAt).
- **Retry metrics in-memory on Dispatcher**: `Map<eventType, RetryMetrics>` with totalRetries, successAfterRetry, dlqCount, totalEvents. No persistence needed.
- **`start()` increments retryCount before re-dispatch**: Crashed attempt counts as a failed attempt.
- **`storeOp()` wrapper**: All store calls in `dispatch()` go through try-catch that silently swallows "database not open" errors. Prevents unhandled rejections from abandoned dispatches after shutdown.

## SURPRISE
- `Promise.race` for shutdown means losing promise is abandoned but still runs. The handlers are orphaned; their store calls fail silently via `storeOp()`.
- `vi.useFakeTimers()` works with `Date.now()` in vitest, simplifying circuit breaker tests.
- Circuit breaker outcome tracking works well with the retry loop — each retry attempt's success/failure feeds into the circuit breaker state for the relevant subscription.

## DEBT
- **No cleanup of abandoned handlers**: If shutdown times out, handlers continue in background. Acceptable for single-process bus — process is likely shutting down.
- **Circuit breaker window pruning**: Outcomes outside 1-minute window are pruned on every `recordOutcome()` call. No background cleanup. Long-idle subs accumulate no stale entries since no events arrive.
