---
verdict: VIOLATIONS
lane: 5
cycle: 1
---

## Coverage Matrix

| CHK-ID | Test exists | Test file:line recorded | Test passes | Test matches spec |
|--------|-------------|------------------------|-------------|-------------------|
| CHK-012 | Y | `src/bus/shutdown.test.ts:17` | Y | **PARTIAL** — missing timeout |
| CHK-013 | Y | `src/bus/recovery.test.ts:7` | Y | Y |
| CHK-015 | Y | `src/dispatcher/circuit-breaker.test.ts:34` | Y | Y |
| CHK-016 | Y | `src/dispatcher/metrics.test.ts:33` | Y | Y |

## Violations

- **CHK-012**: Shutdown missing timeout on in-flight drain
  Expected (from spec): `EVENTBUS-SPECIFICATION.md:182` — "Wait for all in-flight dispatches to complete **(with timeout)**"
  Actual (in code): `src/bus/index.ts:95` — `await this.dispatcher.drain()` calls `Promise.all([...this.inFlight])` with no timeout. If a handler never resolves, `shutdown()` hangs forever.
  Test gap: `src/bus/shutdown.test.ts:28` — "waits for in-flight dispatches to complete" uses a 100ms handler that always completes. No test supplies a hanging handler and asserts that shutdown resolves after a timeout.

## Code Issues

None blocking.
