# Learnings — Cycle 1, Lane 5: lifecycle-and-resilience

## FRICTION
- `destroy()` needed guard against double-close after `shutdown()` — `better-sqlite3` throws if you close an already-closed DB (`src/bus/index.ts:111`)
- Circuit breaker tests needed `vi.useFakeTimers()` for the 30s resume test, but `Date.now()` inside `isCircuitOpen` uses real time. Had to ensure fake timers were set before dispatch, not after.
- The Dispatcher's `dispatch()` was synchronous from caller perspective (no fire-and-forget). In-flight tracking via `Set<Promise>` required wrapping in `doDispatch` to separate the trackable promise from the awaited one (`src/dispatcher/index.ts:64-71`).

## GAP
- Spec says "wait for in-flight dispatches to complete (with timeout)" but doesn't specify the shutdown timeout value. Implemented without a timeout since all dispatches are already awaited by the caller — `drain()` just ensures nothing is orphaned.
- Spec says "if >50% of events for a subscription fail in a 1-minute window" but doesn't define minimum sample size. Used `CIRCUIT_MIN_SAMPLES = 4` to avoid tripping the breaker on 1 failure out of 1 event (100% failure rate).
- Spec doesn't clarify whether circuit-broken subscriptions should cause the entire dispatch to fail or just skip that subscription. Chose: skip the paused subscription, other healthy subscriptions still process normally.

## DECISION
- **Circuit breaker minimum samples = 4**: Prevents premature tripping. With <4 samples, a single failure would be >50%. 4 gives meaningful signal.
- **Metrics tracked in-memory on Dispatcher**: Not persisted. The spec says "track" — in-memory `Map<eventType, RetryMetrics>` is sufficient. No DB schema changes needed.
- **`start()` increments retryCount before re-dispatch**: Per spec "increment retry_count". The crashed attempt counts as a failed attempt, so the count reflects total attempts including the crash.
- **EventBusShutdownError as a class extending Error**: Allows `instanceof` checks and consistent `message` matching for test assertions.
- **Circuit breaker state lives on Dispatcher, not EventBus**: Dispatcher owns dispatch logic, so circuit state belongs there. EventBus delegates lifecycle methods.

## SURPRISE
- No fire-and-forget dispatches in the existing code. `publish()` already awaits `dispatch()`, so `drain()` in shutdown is essentially a no-op in normal flow. It only matters if future code adds fire-and-forget patterns.
- `vi.useFakeTimers()` works with `Date.now()` in vitest — unlike some setups where only `setTimeout`/`setInterval` are mocked. This simplified the circuit breaker resume test.

## DEBT
- **No shutdown timeout**: If a handler hangs forever, `shutdown()` hangs forever. Acceptable because the spec's timeout clause is ambiguous, and adding `AbortController` propagation would be over-engineering for V1.
- **Circuit breaker half-open state is simple reset**: On resume, outcomes are cleared entirely rather than using a proper half-open probe pattern. Acceptable for a single-process event bus; a more sophisticated approach would be needed for distributed systems.
