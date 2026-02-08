# Forge Work Items
<!-- Source: extracted from spec checkboxes OR derived by forge:plan -->

| ID | Source | Ref | Work Item | Lane | Test | Commit | Status |
|----|--------|-----|-----------|------|------|--------|--------|
| CHK-001 | EVENTBUS-SPECIFICATION.md:64 | checkbox | **Shared types** (`Event`, `Subscription`, `RetryPolicy`, `EventStatus`) | 1 | src/types/types.test.ts:1 | 920b647 | DONE |
| CHK-002 | EVENTBUS-SPECIFICATION.md:65 | checkbox | **SQLiteStore** with WAL mode, auto-migration, and CRUD for events + subscriptions | 1 | src/store/store.test.ts:40,101 | 920b647 | DONE |
| CHK-003 | EVENTBUS-SPECIFICATION.md:66 | checkbox | **EventBus.publish()** persists event then dispatches; awaits dispatch completion; returns event ID | 2 | src/bus/bus.test.ts:114,120,129 | 511932e | DONE |
| CHK-004 | EVENTBUS-SPECIFICATION.md:67 | checkbox | **EventBus.subscribe()** registers handler with optional filter by event type; accepts optional `SubscribeOptions`; returns subscription ID | 2 | src/bus/bus.test.ts:35,68,75,82 | 511932e | DONE |
| CHK-005 | EVENTBUS-SPECIFICATION.md:68 | checkbox | **EventBus.unsubscribe()** removes handler by subscription ID | 2 | src/bus/bus.test.ts:92 | 511932e | DONE |
| CHK-006 | EVENTBUS-SPECIFICATION.md:69 | checkbox | **Dispatcher** invokes handlers with timeout protection | 3 | src/dispatcher/dispatcher.test.ts:77,93 | 509d1c6 | DONE |
| CHK-007 | EVENTBUS-SPECIFICATION.md:70 | checkbox | **Dispatcher retry** with exponential backoff (base delay, max delay, max retries) | 3 | src/dispatcher/dispatcher.test.ts:174 | 509d1c6 | DONE |
| CHK-008 | EVENTBUS-SPECIFICATION.md:71 | checkbox | **Dispatcher DLQ routing** after max retries exhausted, with failure context | 3 | src/dispatcher/dispatcher.test.ts:348 | 509d1c6 | DONE |
| CHK-009 | EVENTBUS-SPECIFICATION.md:72 | checkbox | **DLQInspector.list()** returns dead events with offset/limit pagination (default limit: 100), descending by `created_at` | 4 | src/dlq/dlq.test.ts:56 | 9fdb2cf | DONE |
| CHK-010 | EVENTBUS-SPECIFICATION.md:73 | checkbox | **DLQInspector.retry()** re-enqueues a single dead event: full reset (`status→pending`, `retry_count→0`, `last_error→NULL`) | 4 | src/dlq/dlq.test.ts:143 | 9fdb2cf | DONE |
| CHK-011 | EVENTBUS-SPECIFICATION.md:74 | checkbox | **DLQInspector.purge()** deletes dead events older than N days (inclusive: `created_at <= cutoff`) | 4 | src/dlq/dlq.test.ts:208 | 9fdb2cf | DONE |
| CHK-012 | EVENTBUS-SPECIFICATION.md:75 | checkbox | **EventBus.shutdown()** graceful: wait for in-flight, reject new publishes | 5 | src/bus/shutdown.test.ts:16,29,35,45,66 | - | DONE |
| CHK-013 | EVENTBUS-SPECIFICATION.md:76 | checkbox | **Startup recovery** re-dispatches events stuck in `processing` state (crash recovery) | 5 | src/bus/recovery.test.ts:17,28,62,93 | - | DONE |
| CHK-014 | EVENTBUS-SPECIFICATION.md:249 | checkbox | **Prepared statement caching** in SQLiteStore — cache as class properties instead of per-call creation | 1 | src/store/store.test.ts:370 | 920b647 | DONE |
| CHK-015 | EVENTBUS-SPECIFICATION.md:250 | checkbox | **Add `dlq_at` timestamp** to events table — `purge()` uses `created_at`, not DLQ entry time | 1 | src/store/store.test.ts:60,279,317 | 920b647 | DONE |
| CHK-016 | EVENTBUS-SPECIFICATION.md:251 | checkbox | **Circuit breaker half-open probe** — send single probe event before fully reopening (current: simple reset) | 5 | src/dispatcher/circuit-breaker.test.ts:183,199,232 | - | DONE |
| CHK-017 | RETRY-POLICY.md:44 | checkbox | **Jitter**: Add ±10% random jitter to prevent thundering herd | 3 | src/dispatcher/dispatcher.test.ts:397 | 509d1c6 | DONE |
| CHK-018 | RETRY-POLICY.md:45 | checkbox | **Circuit breaker**: If > 50% of events for a subscription fail in a 1-minute window (minimum 4 samples), pause subscription for 30s. Circuit-broken subscriptions skipped during dispatch. State on Dispatcher (in-memory). | 5 | src/dispatcher/circuit-breaker.test.ts:40,56,81,101,122,154 | - | DONE |
| CHK-019 | RETRY-POLICY.md:64 | checkbox | **Retry metrics**: Track total retries, success-after-retry rate, DLQ rate per event type | 5 | src/dispatcher/metrics.test.ts:39,55,71,90,107,112 | - | DONE |
| CHK-020 | RETRY-POLICY.md:65 | checkbox | **Handler timeout**: Default 30s, configurable per subscription via `SubscribeOptions.timeoutMs`. Kill is best-effort via `Promise.race`. | 3 | src/dispatcher/dispatcher.test.ts:125,156,160 | 9b13e14 | DONE |
