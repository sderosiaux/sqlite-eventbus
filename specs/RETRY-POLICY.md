# Retry Policy — Configuration & Behavior

> Referenced by **EVENTBUS-SPECIFICATION.md** (→ Dispatcher Retry Logic)

## Default Policy

```typescript
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};
```

## Per-Subscription Override

Subscriptions can optionally override the global retry policy:

```typescript
bus.subscribe('order.*', handler, {
  retry: { maxRetries: 5, baseDelayMs: 500 }
});
```

Partial overrides merge with defaults (spread, not replace).

### Multi-Subscription Merge <!-- forge:cycle-1 -->

When an event matches N subscriptions with different retry overrides, the Dispatcher merges all overrides into a single **most-permissive** policy for that dispatch:

| Field | Merge strategy |
|-------|---------------|
| `maxRetries` | `Math.max` across all overrides |
| `baseDelayMs` | `Math.min` across all overrides |
| `maxDelayMs` | `Math.max` across all overrides |
| `backoffMultiplier` | `Math.max` across all overrides |

If no subscriptions have overrides, `DEFAULT_RETRY_POLICY` is used. The merge starts from the first override's values (not from defaults) to avoid defaults overriding intentionally lower per-subscription values.

## Delay Calculation

```
delay(attempt) = min(baseDelayMs * backoffMultiplier^(attempt - 1), maxDelayMs)
```

| Attempt | Base=1000, Mult=2, Max=30000 |
|---------|------------------------------|
| 1 | 0ms (immediate) |
| 2 | 1000ms |
| 3 | 2000ms |
| 4 | 4000ms |
| 5 | 8000ms |
| 6 | 16000ms |
| 7 | 30000ms (capped) |

- [ ] **Jitter**: Add ±10% random jitter to prevent thundering herd
- [ ] **Circuit breaker**: If > 50% of events for a subscription fail in a 1-minute window (minimum 4 samples to avoid premature tripping), pause that subscription for 30 seconds before resuming. Circuit-broken subscriptions are **skipped** during dispatch; other healthy subscriptions process normally. Circuit breaker state lives on Dispatcher (in-memory `Map<subId, CircuitBreakerState>`, not persisted). <!-- forge:cycle-1 -->

#### Circuit Breaker State Machine <!-- forge:cycle-1 -->

```
closed ──(>50% fail, ≥4 samples in 1min)──→ open
open ──(30s elapsed)──→ half-open
half-open ──(probe succeeds)──→ closed
half-open ──(probe fails)──→ open
```

**Half-open probe enforcement**: A `probeInFlight` flag per subscription ensures only one probe dispatch runs at a time. Set synchronously during dispatch filtering; cleared on outcome recording. If a half-open sub is skipped because an earlier sub in sequential dispatch failed first, the `probeInFlight` flag must be cleared explicitly to prevent permanent deadlock.

**Per-sub outcome recording**: When sequential `runHandlers` fails, record `success` for each sub that completed before the failure, then `failure` for the failed sub. Subs after the failure point get no outcome (they were not executed).

## Retry Observability

Each retry attempt must emit a structured log entry:

```typescript
{
  level: 'warn',
  event_id: string,
  event_type: string,
  subscription_id: string,
  attempt: number,
  max_attempts: number,
  delay_ms: number,
  error: string,
}
```

- [ ] **Retry metrics**: Track total retries, success-after-retry rate, DLQ rate per event type
- [ ] **Handler timeout**: Default 30s, configurable per subscription via `SubscribeOptions.timeoutMs`. Kill is best-effort via `Promise.race` — timed-out handler may continue in background. <!-- forge:cycle-1 -->
