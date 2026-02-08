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
- [ ] **Circuit breaker**: If > 50% of events for a subscription fail in a 1-minute window, pause that subscription for 30 seconds before resuming

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
- [ ] **Handler timeout**: Default 30s, configurable per subscription. Kill handler execution after timeout.
