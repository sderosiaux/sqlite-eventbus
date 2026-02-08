# Forge Work Items
<!-- Source: extracted from spec checkboxes OR derived by forge:plan -->

| ID | Source | Ref | Work Item | Lane | Test | Commit | Status |
|----|--------|-----|-----------|------|------|--------|--------|
| CHK-001 | EVENTBUS-SPECIFICATION.md:64 | checkbox | **Shared types** (`Event`, `Subscription`, `RetryPolicy`, `EventStatus`) | - | - | - | PENDING |
| CHK-002 | EVENTBUS-SPECIFICATION.md:65 | checkbox | **SQLiteStore** with WAL mode, auto-migration, and CRUD for events + subscriptions | - | - | - | PENDING |
| CHK-003 | EVENTBUS-SPECIFICATION.md:66 | checkbox | **EventBus.publish()** persists event then dispatches | - | - | - | PENDING |
| CHK-004 | EVENTBUS-SPECIFICATION.md:67 | checkbox | **EventBus.subscribe()** registers handler with optional filter by event type | - | - | - | PENDING |
| CHK-005 | EVENTBUS-SPECIFICATION.md:68 | checkbox | **EventBus.unsubscribe()** removes handler by subscription ID | - | - | - | PENDING |
| CHK-006 | EVENTBUS-SPECIFICATION.md:69 | checkbox | **Dispatcher** invokes handlers with timeout protection | - | - | - | PENDING |
| CHK-007 | EVENTBUS-SPECIFICATION.md:70 | checkbox | **Dispatcher retry** with exponential backoff (base delay, max delay, max retries) | - | - | - | PENDING |
| CHK-008 | EVENTBUS-SPECIFICATION.md:71 | checkbox | **Dispatcher DLQ routing** after max retries exhausted, with failure context | - | - | - | PENDING |
| CHK-009 | EVENTBUS-SPECIFICATION.md:72 | checkbox | **DLQInspector.list()** returns dead events with pagination | - | - | - | PENDING |
| CHK-010 | EVENTBUS-SPECIFICATION.md:73 | checkbox | **DLQInspector.retry()** re-enqueues a single dead event for reprocessing | - | - | - | PENDING |
| CHK-011 | EVENTBUS-SPECIFICATION.md:74 | checkbox | **DLQInspector.purge()** deletes dead events older than N days | - | - | - | PENDING |
| CHK-012 | EVENTBUS-SPECIFICATION.md:75 | checkbox | **EventBus.shutdown()** graceful: wait for in-flight, reject new publishes | - | - | - | PENDING |
| CHK-013 | EVENTBUS-SPECIFICATION.md:76 | checkbox | **Startup recovery** re-dispatches events stuck in `processing` state (crash recovery) | - | - | - | PENDING |
| CHK-014 | RETRY-POLICY.md:44 | checkbox | **Jitter**: Add ±10% random jitter to prevent thundering herd | - | - | - | PENDING |
| CHK-015 | RETRY-POLICY.md:45 | checkbox | **Circuit breaker**: If > 50% of events for a subscription fail in a 1-minute window, pause that subscription for 30 seconds before resuming | - | - | - | PENDING |
| CHK-016 | RETRY-POLICY.md:64 | checkbox | **Retry metrics**: Track total retries, success-after-retry rate, DLQ rate per event type | - | - | - | PENDING |
| CHK-017 | RETRY-POLICY.md:65 | checkbox | **Handler timeout**: Default 30s, configurable per subscription. Kill handler execution after timeout. | - | - | - | PENDING |
