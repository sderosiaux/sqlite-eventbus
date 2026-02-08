---
verdict: VIOLATIONS
lane: 2
cycle: 1
---

## Violations

- CHK-003: Test evidence does not precisely verify full spec behavior for `publish()`.
  Expected (from spec): `EventBus.publish()` persists event then dispatches, awaits dispatch completion, and returns event ID (`specs/EVENTBUS-SPECIFICATION.md:66`).
  Actual (in code): `publish()` inserts the event before dispatch and awaits handler calls in sequence (`src/bus/index.ts:50`, `src/bus/index.ts:88`), but that required ordering/await guarantee is not tightly locked by the referenced test evidence.
  Test gap: `.forge/checkboxes.md` references `src/bus/bus.test.ts:93`, which is a `describe` block, and the await-focused test uses a synchronous side effect (`src/bus/bus.test.ts:110`), so a fire-and-forget implementation could still pass.

- CHK-004: Optional event-type filter behavior is not verified as optional.
  Expected (from spec): `EventBus.subscribe()` registers a handler with optional filter by event type, accepts optional `SubscribeOptions`, and returns subscription ID (`specs/EVENTBUS-SPECIFICATION.md:67`).
  Actual (in code): `subscribe(eventType: string, handler, options?)` requires an `eventType` argument (`src/bus/index.ts:15`).
  Test gap: tests only cover explicit pattern strings and do not exercise an unfiltered subscribe path (`src/bus/bus.test.ts:36`, `src/bus/bus.test.ts:42`, `src/bus/bus.test.ts:47`).

## Code Issues (if any)
- None beyond the blocking spec/test-compliance gaps above.
