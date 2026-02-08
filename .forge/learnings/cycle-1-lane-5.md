# Learnings — Cycle 1, Lane 5: lifecycle-and-resilience (attempt 2 — review fixes)

## FRICTION
- `destroy()` needed guard against double-close after `shutdown()` — `better-sqlite3` throws if you close an already-closed DB.
- Circuit breaker tests needed `vi.useFakeTimers()` for 30s resume test. `Date.now()` inside circuit breaker uses real time, so fake timers must be set before dispatch calls, not after.
- `Dispatcher.dispatch()` is awaited by `publish()`. In-flight tracking via `Set<Promise>` tracks the dispatch promise; `finally()` removes it on completion.
- **Shutdown timeout test**: `publish()` awaits `dispatch()`, which awaits the handler. A test with a hanging handler cannot await `publish()` before calling `shutdown()` — it blocks forever. Must fire publish without awaiting, let it enter dispatch, then call shutdown.
- **Abandoned dispatch after shutdown**: When shutdown times out, abandoned dispatches try to use a closed DB. Solved via `storeOp()` wrapper in Dispatcher that catches "not open" TypeError silently.
- **Circuit breaker + sequential handlers**: `runHandlers` is sequential, abort-on-first-failure. When testing "circuit breaker only affects specific subscription", the healthy sub must come *before* the failing sub in Map iteration order, otherwise it never runs.
- **[Review fix] Single-probe test with fake timers**: Cannot use a blocking handler + `vi.advanceTimersByTimeAsync(0)` to test probe-in-flight — the dispatch awaits the handler and the handler blocks on a non-timer promise. Fix: fire two concurrent `Promise.all` dispatches; only the first gets the probe slot, second is skipped.
- **[Review fix] Per-sub outcome recording**: Originally only recorded failure for the failed sub; subs that succeeded earlier in `runHandlers` got no outcome recorded. Changed `runHandlers` to return `succeededSubIds[]` and record success outcomes for each before recording the failure.

## GAP
- Spec says "wait for in-flight dispatches to complete (with timeout)" but doesn't specify timeout value. Chose 30s default, configurable via `shutdownTimeoutMs`.
- Spec says ">50% failure in 1-minute window" but doesn't define minimum sample size. Used 4 (`CIRCUIT_BREAKER_MIN_SAMPLES`) to avoid premature tripping.
- Spec doesn't clarify whether circuit-broken subs should cause dispatch to fail or just skip. Chose: skip paused sub, other healthy subs still process normally.

## DECISION
- **Shutdown via `Promise.race`**: Races drain against timeout. If drain exceeds timeout, shutdown proceeds to close DB. Abandoned handlers silently fail via `storeOp()`.
- **`shutdownTimeoutMs` configurable**: Default 30s matches handler timeout. Rejected hardcoded constant because shutdown tolerance varies by use case.
- **Circuit breaker min samples = 4**: Prevents premature tripping. With <4 samples, a single failure would be >50%.
- **Circuit breaker state per-subscription on Dispatcher**: In-memory `Map<subId, CircuitBreakerState>` with rolling 1-minute window of outcomes. States: closed/open/half-open.
- **Half-open single-probe via `probeInFlight` flag** (`src/dispatcher/index.ts:38`): `isCircuitOpen()` sets `probeInFlight=true` on transition to half-open, blocking subsequent dispatches until `recordOutcome()` clears it. Ensures exactly one event probes the recovering subscription.
- **Per-sub outcome recording on failure** (`src/dispatcher/index.ts:186-189`): `runHandlers` returns `succeededSubIds[]`. On failure path, record `success` for each sub that ran before the failure, then `failure` for the failed sub. Ensures accurate per-sub sample windows.
- **Retry metrics in-memory on Dispatcher**: `Map<eventType, RetryMetrics>` with totalRetries, successAfterRetry, dlqCount, totalEvents. No persistence needed.
- **`start()` increments retryCount before re-dispatch**: Crashed attempt counts as a failed attempt.
- **`storeOp()` wrapper**: All store calls in `dispatch()` go through try-catch that silently swallows "database not open" errors.

## SURPRISE
- `Promise.race` for shutdown means losing promise is abandoned but still runs. The handlers are orphaned; their store calls fail silently via `storeOp()`.
- `vi.useFakeTimers()` works with `Date.now()` in vitest, simplifying circuit breaker tests.
- `Promise.all` with two concurrent dispatches is the correct way to test single-probe enforcement — both dispatches race to check `isCircuitOpen`, but only the first gets `probeInFlight=false`.

## DEBT
- **No cleanup of abandoned handlers**: If shutdown times out, handlers continue in background. Acceptable for single-process bus.
- **Circuit breaker window pruning**: Outcomes outside 1-minute window are pruned on every `recordOutcome()` call. No background cleanup.
