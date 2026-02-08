import type { Event, RetryPolicy, Subscription } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';
import type { SQLiteStore } from '../store/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DispatcherOptions {
  defaultTimeoutMs?: number;
  defaultRetryPolicy?: RetryPolicy;
}

/**
 * Compute retry delay for a given attempt number.
 * Attempt 1 = immediate (0ms).
 * Attempt N >= 2: min(baseDelayMs * backoffMultiplier^(N-2), maxDelayMs) with ±10% jitter.
 */
export function computeDelay(attempt: number, policy: RetryPolicy): number {
  if (attempt <= 1) return 0;
  const raw = Math.min(
    policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt - 2),
    policy.maxDelayMs,
  );
  // ±10% jitter
  const jitter = raw * 0.1 * (2 * Math.random() - 1);
  return Math.max(0, Math.round(raw + jitter));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Dispatcher {
  private store: SQLiteStore;
  private handlers: Map<string, Subscription>;
  private defaultTimeoutMs: number;
  private defaultRetryPolicy: RetryPolicy;

  constructor(store: SQLiteStore, handlers: Map<string, Subscription>, opts?: DispatcherOptions) {
    this.store = store;
    this.handlers = handlers;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultRetryPolicy = opts?.defaultRetryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  async dispatch(event: Event): Promise<void> {
    const matching = this.findMatchingSubscriptions(event.type);

    if (matching.length === 0) {
      this.store.updateEventStatus(event.id, 'done');
      return;
    }

    this.store.updateEventStatus(event.id, 'processing');

    // Determine effective retry policy: use per-subscription if all matching have the same,
    // otherwise use the most permissive (highest maxRetries) among them.
    const effectivePolicy = this.resolveRetryPolicy(matching);
    const maxAttempts = effectivePolicy.maxRetries + 1;

    let attemptNumber = 0;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptNumber = attempt;

      // Delay before retry (attempt 1 is immediate)
      const delayMs = computeDelay(attempt, effectivePolicy);
      await sleep(delayMs);

      let failed = false;
      lastError = '';

      for (const sub of matching) {
        const timeoutMs = sub.timeoutMs ?? this.defaultTimeoutMs;
        try {
          await this.invokeWithTimeout(sub, event, timeoutMs);
        } catch (err) {
          failed = true;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // Update retry count in store
      this.store.updateEventRetry(event.id, attempt, lastError);

      if (!failed) {
        this.store.updateEventStatus(event.id, 'done');
        return;
      }

      // Emit structured retry log
      if (attempt < maxAttempts) {
        const nextDelay = computeDelay(attempt + 1, effectivePolicy);
        console.warn(JSON.stringify({
          level: 'warn',
          event_id: event.id,
          event_type: event.type,
          subscription_id: matching.map(s => s.id).join(','),
          attempt,
          max_attempts: maxAttempts,
          delay_ms: nextDelay,
          error: lastError,
        }));
      }
    }

    // All attempts exhausted → DLQ
    this.store.updateEventRetry(event.id, attemptNumber, lastError);
    this.store.updateEventStatus(event.id, 'dlq');
  }

  private resolveRetryPolicy(subs: Subscription[]): RetryPolicy {
    // Per-subscription override takes precedence over default.
    // If multiple subs have custom policies, use the most permissive (highest maxRetries)
    // so no subscription is cut short.
    let hasCustom = false;
    let policy = this.defaultRetryPolicy;
    for (const sub of subs) {
      if (sub.retryPolicy) {
        if (!hasCustom) {
          policy = sub.retryPolicy;
          hasCustom = true;
        } else if (sub.retryPolicy.maxRetries > policy.maxRetries) {
          policy = sub.retryPolicy;
        }
      }
    }
    return policy;
  }

  private findMatchingSubscriptions(eventType: string): Subscription[] {
    const result: Subscription[] = [];
    for (const sub of this.handlers.values()) {
      if (matchGlob(sub.eventType, eventType)) {
        result.push(sub);
      }
    }
    return result;
  }

  private invokeWithTimeout(sub: Subscription, event: Event, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Handler timeout after ${timeoutMs}ms (subscription ${sub.id})`));
      }, timeoutMs);

      sub.handler(event).then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

/**
 * Simple glob matcher for event type patterns.
 * - `*` as the entire pattern matches everything
 * - `*` as a segment matches exactly one segment (non-empty, no dots)
 * - Segments are separated by `.`
 */
function matchGlob(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;

  const patternParts = pattern.split('.');
  const typeParts = eventType.split('.');

  if (patternParts.length !== typeParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '*') continue;
    if (patternParts[i] !== typeParts[i]) return false;
  }

  return true;
}
