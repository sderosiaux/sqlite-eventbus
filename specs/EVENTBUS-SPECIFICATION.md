# EventBus — Persistent Event Bus with Retry & Dead-Letter Queue

> **Status**: V1 — Initial specification
> **Language**: TypeScript (Node.js, ESM)
> **Test framework**: Vitest

A lightweight, in-process event bus with SQLite-backed persistence, configurable retry policies, and a dead-letter queue for undeliverable events. Designed for CLI tools and small services that need reliable event processing without external infrastructure.

## North Star

Events published are never lost. Every event is either successfully processed or lands in the dead-letter queue with full diagnostic context.

## Non-Goals

- Not a distributed message broker (no networking, no clustering)
- No event schema registry
- No consumer groups or partitioning
- No pub/sub across processes

---

## Architecture

```
Publisher
   │
   ▼
EventBus ──→ SQLiteStore (WAL mode)
   │              │
   │              ├── events table (pending, processing, done, dlq)
   │              └── subscriptions table
   │
   ├──→ Dispatcher
   │       │
   │       ├── invoke handler
   │       ├── retry on failure (exponential backoff)
   │       └── move to DLQ after max retries
   │
   └──→ DLQ Inspector
           │
           ├── list dead events
           ├── retry single event
           └── purge old events
```

---

## Module Overview

| Module | Responsibility | Public API |
|--------|---------------|------------|
| `event-bus` | Publish, subscribe, unsubscribe | `EventBus` class |
| `store` | SQLite persistence layer | `SQLiteStore` class |
| `dispatcher` | Event delivery + retry logic | `Dispatcher` class |
| `dlq` | Dead-letter queue inspection | `DLQInspector` class |
| `types` | Shared types and interfaces | `Event`, `Subscription`, `RetryPolicy` |

(→ see **RETRY-POLICY.md** for retry configuration details)

---

## Quick-Start Rebuild Checklist

- [ ] **Shared types** (`Event`, `Subscription`, `RetryPolicy`, `EventStatus`)
- [ ] **SQLiteStore** with WAL mode, auto-migration, and CRUD for events + subscriptions
- [ ] **EventBus.publish()** persists event then dispatches
- [ ] **EventBus.subscribe()** registers handler with optional filter by event type
- [ ] **EventBus.unsubscribe()** removes handler by subscription ID
- [ ] **Dispatcher** invokes handlers with timeout protection
- [ ] **Dispatcher retry** with exponential backoff (base delay, max delay, max retries)
- [ ] **Dispatcher DLQ routing** after max retries exhausted, with failure context
- [ ] **DLQInspector.list()** returns dead events with pagination
- [ ] **DLQInspector.retry()** re-enqueues a single dead event for reprocessing
- [ ] **DLQInspector.purge()** deletes dead events older than N days
- [ ] **EventBus.shutdown()** graceful: wait for in-flight, reject new publishes
- [ ] **Startup recovery** re-dispatches events stuck in `processing` state (crash recovery)

---

## Detailed Specifications

### Types

```typescript
interface Event {
  id: string;          // UUID v4
  type: string;        // e.g. "user.created", "order.shipped"
  payload: unknown;    // JSON-serializable
  createdAt: Date;
  status: EventStatus;
  retryCount: number;
  lastError?: string;
  metadata?: Record<string, string>;
}

type EventStatus = 'pending' | 'processing' | 'done' | 'dlq';

interface Subscription {
  id: string;          // UUID v4
  eventType: string;   // glob pattern: "user.*" matches "user.created"
  handler: EventHandler;
  createdAt: Date;
}

type EventHandler = (event: Event) => Promise<void>;

interface RetryPolicy {
  maxRetries: number;      // default: 3
  baseDelayMs: number;     // default: 1000
  maxDelayMs: number;      // default: 30000
  backoffMultiplier: number; // default: 2
}
```

### SQLiteStore

The storage layer must:

1. Use WAL mode for concurrent reads during writes
2. Auto-create tables on first connection (`events`, `subscriptions`)
3. Serialize `payload` as JSON text
4. Index on `status` and `type` for query performance
5. Support atomic status transitions: `pending → processing → done | dlq`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,      -- JSON
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT,              -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Event Type Matching

Subscriptions use glob patterns:

| Pattern | Matches | Doesn't Match |
|---------|---------|---------------|
| `user.created` | `user.created` | `user.updated` |
| `user.*` | `user.created`, `user.updated` | `order.created` |
| `*` | everything | (nothing excluded) |
| `order.*.shipped` | `order.123.shipped` | `order.shipped` |

Use a simple glob matcher — no regex, no wildcards beyond `*`.

### Dispatcher Retry Logic

```
attempt 1: immediate
attempt 2: wait baseDelayMs
attempt 3: wait baseDelayMs * backoffMultiplier
attempt N: wait min(baseDelayMs * backoffMultiplier^(N-2), maxDelayMs)

After maxRetries + 1 total attempts → move to DLQ with:
  - All error messages from each attempt
  - Original event preserved
  - Timestamp of final failure
```

### Graceful Shutdown

`EventBus.shutdown()` must:

1. Stop accepting new publishes (throw `EventBusShutdownError`)
2. Wait for all in-flight dispatches to complete (with timeout)
3. Close SQLite connection
4. Return a promise that resolves when fully stopped

### Crash Recovery

On `EventBus.start()`:

1. Query all events with status `processing`
2. Reset them to `pending` (increment retry_count)
3. Re-dispatch them through normal flow

This handles the case where the process crashed mid-dispatch.

---

## Performance Expectations

| Metric | Target |
|--------|--------|
| Publish throughput | > 1000 events/sec (SQLite WAL) |
| Dispatch latency (p99) | < 10ms (excluding handler time) |
| DLQ query | < 50ms for 10k dead events |
| Startup recovery | < 500ms for 100 stuck events |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Handler throws | Retry per policy, then DLQ |
| Handler timeout | Treat as failure, retry |
| SQLite lock | Retry with backoff (WAL should minimize) |
| Invalid payload (not JSON-serializable) | Reject publish with `InvalidPayloadError` |
| Subscribe after shutdown | Throw `EventBusShutdownError` |
| Publish after shutdown | Throw `EventBusShutdownError` |
