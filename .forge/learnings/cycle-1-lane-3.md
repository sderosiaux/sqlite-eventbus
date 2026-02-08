# Learnings — Cycle 1, Lane 3: retry-and-dlq-routing

## FRICTION
- Existing lane-2 test `records error on handler failure` (`src/dispatcher/dispatcher.test.ts:85`) assumed single-attempt dispatch (retryCount=1). Adding retry logic changed the contract: a permanently failing handler now retries to exhaustion then DLQs (retryCount=4, status='dlq'). Had to update the test assertion to match new behavior.
- Timeout tests (`CHK-017`) now take much longer because each timeout triggers 3 retries with default 1s+ backoff delays. The test at `src/dispatcher/dispatcher.test.ts:146` uses 50ms timeout handlers but retries with DEFAULT_RETRY_POLICY (1s base delay). This makes the timeout test suite ~20s. Future improvement: pass fast retry policy in timeout tests.

## GAP
- Spec doesn't define behavior when **multiple subscriptions match** and they have **different retry policies**. Example: sub A has maxRetries=0, sub B has maxRetries=5. Decision documented below.
- Spec says "All error messages from each attempt" should be preserved in DLQ, but the `events` table only has a single `last_error TEXT` column. No array/history column. We store only the last error message.
- Spec's retry observability log structure (`RETRY-POLICY.md:49-61`) specifies `subscription_id` singular, but dispatch can match multiple subscriptions. We join IDs with comma.

## DECISION
- **Per-subscription retry override takes precedence over default** (`src/dispatcher/index.ts:113-126`): If any matching subscription has a custom `retryPolicy`, it is used instead of the dispatcher default. If multiple subscriptions have custom policies, the most permissive (highest maxRetries) is used. Rationale: a subscriber who explicitly sets maxRetries=0 should get exactly 1 attempt; this only works if there's a single matching subscription, which is the common case.
- **Event-level retry loop** (`src/dispatcher/index.ts:64-106`): Retry is at the event level, not per-subscription. All matching handlers are re-invoked on each retry attempt. This matches the spec's event-level `retryCount`/`status` model (no per-subscription delivery tracking). Trade-off: if handler A succeeds but handler B fails, handler A is re-invoked on retry. Acceptable for v1 in-process design.
- **`computeDelay` as exported pure function** (`src/dispatcher/index.ts:17-26`): Exported for direct unit testing of jitter bounds. Formula: `min(base * mult^(attempt-2), max)` with ±10% uniform random jitter. Attempt 1 returns 0 (immediate).
- **Structured log via `console.warn`** (`src/dispatcher/index.ts:93-105`): Spec requires structured retry log entries. Used `console.warn(JSON.stringify({...}))` rather than a logging framework — no external deps, sufficient for v1.

## SURPRISE
- The `resolveRetryPolicy` initially used "highest maxRetries wins" including the default, which caused the `maxRetries=0` subscription test to use the default policy (maxRetries=3) instead. Per-subscription override must unconditionally replace the default, even when more restrictive.

## DEBT
- DLQ events store only `lastError` string, not an array of all attempt errors. Spec says "All error messages from each attempt" — would need a `dlq_errors` JSON column or separate table. Acceptable shortcut: last error is most diagnostic.
- Timeout tests (`dispatcher.test.ts`) use default retry policy (1s base delay), making them slow (~20s). Should pass a fast retry policy to speed up the suite.
