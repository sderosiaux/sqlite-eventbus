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
   └──→ DLQ Inspector (depends only on SQLiteStore, not Dispatcher) <!-- forge:cycle-1 -->
           │
           ├── list dead events
           ├── retry single event
           └── purge old events
```

---

## Module Overview

| Module | Responsibility | Public API |
|--------|---------------|------------|
| `event-bus` | Publish (returns event ID), subscribe (returns subscription ID), unsubscribe | `EventBus` class |
| `store` | SQLite persistence layer | `SQLiteStore` class |
| `dispatcher` | Event delivery + retry logic | `Dispatcher` class |
| `dlq` | Dead-letter queue inspection | `DLQInspector` class |
| `types` | Shared types and interfaces | `Event`, `Subscription`, `RetryPolicy` |

(→ see **RETRY-POLICY.md** for retry configuration details)

---

## Quick-Start Rebuild Checklist

- [ ] **Shared types** (`Event`, `Subscription`, `RetryPolicy`, `EventStatus`)
- [ ] **SQLiteStore** with WAL mode, auto-migration, and CRUD for events + subscriptions
- [ ] **EventBus.publish()** persists event then dispatches; awaits dispatch completion; returns event ID <!-- forge:cycle-1 -->
- [ ] **EventBus.subscribe()** registers handler with optional filter by event type; accepts optional `SubscribeOptions`; returns subscription ID <!-- forge:cycle-1 -->
- [ ] **EventBus.unsubscribe()** removes handler by subscription ID
- [ ] **Dispatcher** invokes handlers with timeout protection
- [ ] **Dispatcher retry** with exponential backoff (base delay, max delay, max retries)
- [ ] **Dispatcher DLQ routing** after max retries exhausted, with failure context
- [ ] **DLQInspector.list()** returns dead events with offset/limit pagination (default limit: 100), descending by `created_at` <!-- forge:cycle-1 -->
- [ ] **DLQInspector.retry()** re-enqueues a single dead event: full reset (`status→pending`, `retry_count→0`, `last_error→NULL`) <!-- forge:cycle-1 -->
- [ ] **DLQInspector.purge()** deletes dead events older than N days (inclusive: `created_at <= cutoff`) <!-- forge:cycle-1 -->
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
  lastError?: string;  // JSON array of error strings from each failed attempt <!-- forge:cycle-1 -->
  metadata?: Record<string, string>;
}

type EventStatus = 'pending' | 'processing' | 'done' | 'dlq';

// In-memory representation (with handler)
interface Subscription {
  id: string;          // UUID v4
  eventType: string;   // glob pattern: "user.*" matches "user.created"
  handler: EventHandler;
  createdAt: Date;
  timeoutMs?: number;  // per-subscription handler timeout override
}

// DB representation (handler is not serializable) <!-- forge:cycle-1 -->
interface SubscriptionRow {
  id: string;
  eventType: string;
  createdAt: Date;
}

type EventHandler = (event: Event) => Promise<void>;

interface SubscribeOptions {  // <!-- forge:cycle-1 -->
  timeoutMs?: number;       // per-subscription handler timeout (default: 30s)
  retry?: Partial<RetryPolicy>;  // per-subscription retry override (merges with defaults)
}

interface RetryPolicy {
  maxRetries: number;      // default: 3
  baseDelayMs: number;     // default: 1000
  maxDelayMs: number;      // default: 30000
  backoffMultiplier: number; // default: 2
}
```

### SQLiteStore

The storage layer must:

1. Use WAL mode for concurrent reads during writes (requires file-based DB; `:memory:` silently ignores WAL) <!-- forge:cycle-1 -->
2. Auto-create tables on first connection (`events`, `subscriptions`)
3. Serialize `payload` as JSON text
4. Index on `status` and `type` for query performance
5. Support atomic status transitions: `pending → processing → done | dlq`
6. Store `SubscriptionRow` (metadata only, no handler). Handlers live in an in-memory `Map<string, Subscription>` on EventBus. <!-- forge:cycle-1 -->

> **Note**: `better-sqlite3` operations are synchronous. The entire store layer is sync; async only enters at the handler level. <!-- forge:cycle-1 -->

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

<!-- forge:cycle-1: clarified multi-subscription, sequential, error storage -->

When an event matches multiple subscriptions, handlers are invoked **sequentially** (not concurrently). Failure tracking is **per-event**, not per-subscription: if any handler fails, the event's `retryCount` increments and `lastError` captures the error. The event stays in `processing` for retry.

```
attempt 1: immediate
attempt 2: wait baseDelayMs
attempt 3: wait baseDelayMs * backoffMultiplier
attempt N: wait min(baseDelayMs * backoffMultiplier^(N-2), maxDelayMs)

After maxRetries + 1 total attempts → move to DLQ with:
  - All error messages from each attempt (stored as JSON array in lastError TEXT column)
  - Original event preserved
  - Timestamp of final failure
```

Each failed attempt **including the final one** emits a structured log entry (→ see **RETRY-POLICY.md**).

### Graceful Shutdown

`EventBus.shutdown()` must:

1. Stop accepting new publishes (throw `EventBusShutdownError`)
2. Wait for all in-flight dispatches to complete (timeout: default 30s, configurable via `shutdownTimeoutMs` in `EventBusOptions`) <!-- forge:cycle-1 -->
3. Close SQLite connection (guard against double-close if `destroy()` was called) <!-- forge:cycle-1 -->
4. Return a promise that resolves when fully stopped

> **Note**: Timeout uses `Promise.race`. If drain exceeds timeout, shutdown proceeds to close the DB. Abandoned handlers continue running in the background (best-effort kill — no true cancellation in single-threaded Node.js). <!-- forge:cycle-1 -->

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
| Handler timeout | Treat as failure, retry. Timeout via `Promise.race` — best-effort; handler may continue in background. <!-- forge:cycle-1 --> |
| SQLite lock | Retry with backoff (WAL should minimize) |
| Invalid payload (not JSON-serializable) | Reject publish with `InvalidPayloadError` |
| Subscribe after shutdown | Throw `EventBusShutdownError` |
| Publish after shutdown | Throw `EventBusShutdownError` |

---

## Future Work (derived from cycle 1) <!-- forge:cycle-1 -->

- [ ] **Prepared statement caching** in SQLiteStore — cache as class properties instead of per-call creation
- [ ] **Add `dlq_at` timestamp** to events table — `purge()` uses `created_at`, not DLQ entry time
- [ ] **Circuit breaker half-open probe** — send single probe event before fully reopening (current: simple reset)

---

## Architectural Decisions (Forge)

### AD-1: SubscriptionRow vs Subscription split (cycle 1)
**Context**: Handlers are JS functions and cannot be serialized to SQLite.
**Decision**: DB stores `SubscriptionRow` (metadata only). Handlers live in an in-memory `Map<string, Subscription>` on EventBus.
**Alternatives**: Serialize handler reference/name for cross-process lookup — rejected; spec explicitly says "no pub/sub across processes".
**Status**: Accepted

### AD-2: Event-level failure tracking (cycle 1)
**Context**: When an event matches multiple subscriptions and one handler fails, the system needs to decide the tracking granularity.
**Decision**: Track failures at the event level (single `retryCount`, single `lastError`). If any handler fails, the entire event retries.
**Alternatives**: Per-subscription delivery table with independent retry tracking — rejected as over-engineering for v1.
**Status**: Accepted

### AD-3: Sequential handler invocation (cycle 1)
**Context**: Multiple handlers matching the same event could run concurrently or sequentially.
**Decision**: Sequential invocation via `for-of` loop. Simplifies error handling and prevents resource exhaustion.
**Alternatives**: Concurrent via `Promise.all`/`Promise.allSettled` — rejected; complicates per-event failure semantics.
**Status**: Accepted

### AD-4: Error history as JSON array in lastError (cycle 1)
**Context**: Spec requires "all error messages from each attempt" but the schema has a single `last_error TEXT` column.
**Decision**: Accumulate errors in `string[]`, serialize as `JSON.stringify` into the existing column. Array length = number of failed attempts.
**Alternatives**: Separate `error_history` table — rejected; single column is sufficient for diagnostics.
**Status**: Accepted

### AD-5: DLQInspector depends only on SQLiteStore (cycle 1)
**Context**: DLQInspector needs access to dead-lettered events for list/retry/purge operations.
**Decision**: DLQInspector takes `SQLiteStore` directly — no dependency on EventBus or Dispatcher. Can be used independently for admin tooling.
**Alternatives**: Depend on EventBus for store access — rejected; unnecessary coupling.
**Status**: Accepted

### AD-6: Shutdown timeout via Promise.race (cycle 1)
**Context**: Graceful shutdown must wait for in-flight handlers but cannot wait indefinitely.
**Decision**: `shutdown()` races `drain()` against a configurable timeout (default 30s via `shutdownTimeoutMs`). On timeout, proceeds to close DB. Abandoned handlers continue running but store calls will throw on the closed DB.
**Alternatives**: Hardcoded timeout — rejected; shutdown tolerance varies by use case.
**Status**: Accepted
