# EventBus

In-process event bus with SQLite persistence, retry with backoff, circuit breaker, and dead-letter queue.

For CLI tools and small services that need reliable event processing without external infrastructure.

Events published are never lost — either successfully processed or routed to the DLQ with full diagnostic context.

## Quick Start

```bash
npm install && npm run build
```

```ts
import { EventBus } from './src/bus/index.js';
import { DLQInspector } from './src/dlq/index.js';

const bus = new EventBus('./events.db');

// Subscribe — exact type
bus.subscribe('order.created', async (event) => {
  console.log('New order:', event.payload);
});

// Subscribe — glob pattern (* matches one segment)
bus.subscribe('order.*', async (event) => {
  console.log('Order activity:', event.type);
});

// Subscribe — all events
bus.subscribe(async (event) => {
  console.log(event.type, event.payload);
});

// Subscribe — with per-handler timeout and retry override
const subId = bus.subscribe('payment.process', handler, {
  timeoutMs: 5000,
  retry: { maxRetries: 5, baseDelayMs: 500 },
});

// Publish — persists to SQLite, then dispatches. Awaits completion.
const eventId = await bus.publish('order.created', { id: 42, amount: 99 });

// Publish — with metadata
await bus.publish('user.signup', { email: 'a@b.com' }, { source: 'web' });

// Unsubscribe
bus.unsubscribe(subId);

// Crash recovery — re-dispatches events stuck in 'processing'
await bus.start();

// DLQ inspection
const dlq = new DLQInspector(bus.getStore());
const { events, total } = dlq.list({ limit: 20, offset: 0 });
dlq.retry(eventId);   // re-enqueue (full reset: status→pending, retry_count→0)
dlq.purge(30);         // delete DLQ events older than 30 days

// Graceful shutdown — drains in-flight, rejects new publishes, closes DB
await bus.shutdown();
```

## Behavior

- **Persistence**: every event is written to SQLite (WAL mode) before dispatch
- **Retry**: 3 retries, exponential backoff with jitter (1s base, x2, 30s cap)
- **Circuit breaker**: per-subscription, trips at >50% failure rate over 4+ samples in 60s, pauses 30s, then single half-open probe before closing
- **Abort on first failure**: if a handler fails, remaining handlers skip for that attempt
- **Shutdown**: `Promise.allSettled` drain with configurable timeout (default 30s), then DB close
- **Recovery**: `start()` finds events stuck in `processing` and re-dispatches them

## Options

```ts
const bus = new EventBus('./events.db', {
  shutdownTimeoutMs: 10_000,            // default: 30s
  delayFn: (ms) => new Promise(r => setTimeout(r, ms)), // override for testing
  logFn: (entry) => console.log(entry), // structured retry/DLQ log entries
});
```

## Reference

| Module | Path | Purpose |
|--------|------|---------|
| `EventBus` | `src/bus/index.ts` | publish, subscribe, shutdown, recovery |
| `Dispatcher` | `src/dispatcher/index.ts` | timeout, retry, circuit breaker, DLQ routing |
| `DLQInspector` | `src/dlq/index.ts` | list, retry, purge dead-lettered events |
| `SQLiteStore` | `src/store/index.ts` | persistence, WAL, prepared statement cache |
| `Types` | `src/types/index.ts` | `Event`, `Subscription`, `RetryPolicy`, `EventStatus` |

## Non-Goals

Not a distributed broker. No schema registry, consumer groups, partitioning, or cross-process pub/sub.
