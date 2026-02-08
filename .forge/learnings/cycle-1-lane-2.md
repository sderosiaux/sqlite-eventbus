# Learnings — Cycle 1, Lane 2: core-eventbus

## FRICTION
- `better-sqlite3` ABI mismatch recurred on session resume (NODE_MODULE_VERSION 141 vs 127). Required `npm rebuild better-sqlite3` before tests could run. The `postinstall` script doesn't help across Node version changes.

## GAP
- Spec doesn't specify what happens when `publish()` has no matching subscriptions. Decision: mark event as `done` immediately (no-op dispatch).
- Spec says "publish persists then dispatches" but doesn't say whether `publish()` awaits dispatch or fire-and-forgets. Decision: await dispatch — callers know when complete.
- Spec doesn't define `publish()` return value. Returns event ID (string) for symmetry with `subscribe()`.

## DECISION
- **publish() awaits dispatch** (`src/bus/index.ts:49`): Caller awaits dispatch completion. Fire-and-forget deferred to lane 5 (shutdown needs in-flight tracking).
- **Sequential handler invocation** (`src/bus/index.ts:86-93`): For-of loop over matching subscriptions. Failure on any handler breaks loop, event stays `processing`. Lane 3 adds retry logic.
- **Glob matcher as standalone function** (`src/bus/glob.ts:7-20`): Segment-by-segment comparison. `*` matches one segment. Standalone `*` matches everything. No regex.
- **EventBus.destroy() for test teardown** (`src/bus/index.ts:115`): Raw DB close. Graceful `shutdown()` is lane 5.
- **Handler failure leaves event in processing** (`src/bus/index.ts:91`): No retry/DLQ in lane 2 — just marks event as processing so lane 3 retry logic picks it up.
- **No matching subscriptions → done** (`src/bus/index.ts:79-82`): If no handlers match, event transitions directly to done. No point retrying something nobody listens to.

## SURPRISE
- All 24 bus tests passed on first implementation attempt (after ABI rebuild). The learnings from previous cycles about sequential dispatch, glob matching, and handler map reference were accurate and sufficient.

## DEBT
- `publish()` has no structured error recording on failure — just breaks and leaves event in `processing`. Lane 3 will add `retryCount` increment and `lastError` tracking.
- No handler timeout in lane 2. Default 30s timeout is a lane 3 concern (CHK-020).
