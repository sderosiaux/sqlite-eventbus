import { SQLiteStore } from '../store/index.js';
import type { Event, Subscription, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';
import { matchGlob } from '../bus/glob.js';

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

export interface DispatcherOptions {
  /** Injectable delay for testing (default: real setTimeout-based delay) */
  delayFn?: (ms: number) => Promise<void>;
  /** Injectable log function for testing (default: console.warn) */
  logFn?: (entry: RetryLogEntry) => void;
}

export interface RetryLogEntry {
  level: 'warn';
  event_id: string;
  event_type: string;
  subscription_id: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  error: string;
}

export class Dispatcher {
  private store: SQLiteStore;
  private delayFn: (ms: number) => Promise<void>;
  private logFn: (entry: RetryLogEntry) => void;

  constructor(store: SQLiteStore, options?: DispatcherOptions) {
    this.store = store;
    this.delayFn = options?.delayFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logFn = options?.logFn ?? ((entry) => console.warn(JSON.stringify(entry)));
  }

  /**
   * Dispatch an event to matching subscriptions with retry, timeout, and DLQ routing.
   * Handlers are invoked sequentially. Failure tracking is per-event.
   */
  async dispatch(event: Event, subscriptions: Map<string, Subscription>): Promise<void> {
    // Find matching subscriptions
    const matching: Subscription[] = [];
    for (const sub of subscriptions.values()) {
      if (matchGlob(sub.eventType, event.type)) {
        matching.push(sub);
      }
    }

    if (matching.length === 0) {
      this.store.updateEventStatus(event.id, 'done');
      return;
    }

    // Transition to processing
    this.store.updateEventStatus(event.id, 'processing');

    // Resolve retry policy: merge all matching subscriptions' overrides (most permissive wins)
    const policy = this.mergeRetryPolicies(matching);

    const maxAttempts = policy.maxRetries + 1;
    const errorHistory: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait before retry (not before first attempt)
      if (attempt > 1) {
        const delay = this.calculateDelay(attempt, policy);
        await this.delayFn(delay);
      }

      const result = await this.runHandlers(event, matching);

      if (result.success) {
        // Update retry count and errors if we had previous failures
        if (errorHistory.length > 0) {
          this.store.updateEventRetry(event.id, errorHistory.length, JSON.stringify(errorHistory));
        }
        this.store.updateEventStatus(event.id, 'done');
        return;
      }

      // Record failure
      errorHistory.push(result.error!);
      this.store.updateEventRetry(event.id, attempt, JSON.stringify(errorHistory));

      // Calculate delay for log (0 for final attempt since no next retry)
      const nextDelay = attempt < maxAttempts
        ? this.calculateDelay(attempt + 1, policy)
        : 0;

      // Emit structured log for this attempt (including final)
      this.logFn({
        level: 'warn',
        event_id: event.id,
        event_type: event.type,
        subscription_id: result.failedSubscriptionId!,
        attempt,
        max_attempts: maxAttempts,
        delay_ms: nextDelay,
        error: result.error!,
      });
    }

    // All attempts exhausted → DLQ
    this.store.moveEventToDlq(event.id, JSON.stringify(errorHistory));
  }

  /** Run all matching handlers sequentially. Returns on first failure. */
  private async runHandlers(
    event: Event,
    subscriptions: Subscription[],
  ): Promise<{ success: boolean; error?: string; failedSubscriptionId?: string }> {
    for (const sub of subscriptions) {
      const timeoutMs = sub.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;

      try {
        await this.withTimeout(sub.handler(event), timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, failedSubscriptionId: sub.id };
      }
    }
    return { success: true };
  }

  /** Race handler promise against a timeout. Best-effort kill via Promise.race. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Handler timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Merge retry policies from all matching subscriptions.
   * Each sub's partial override merges with defaults first, then across subs
   * the most permissive value wins per field:
   *   maxRetries: max, baseDelayMs: min, maxDelayMs: max, backoffMultiplier: max.
   * If no subs have overrides, returns DEFAULT_RETRY_POLICY.
   */
  private mergeRetryPolicies(subscriptions: Subscription[]): RetryPolicy {
    const overrides = subscriptions.filter((s) => s.retry);
    if (overrides.length === 0) return { ...DEFAULT_RETRY_POLICY };

    // Start from first override merged with defaults
    const first = { ...DEFAULT_RETRY_POLICY, ...overrides[0].retry };
    const result: RetryPolicy = { ...first };

    // Merge remaining overrides — most permissive wins
    for (let i = 1; i < overrides.length; i++) {
      const merged = { ...DEFAULT_RETRY_POLICY, ...overrides[i].retry };
      result.maxRetries = Math.max(result.maxRetries, merged.maxRetries);
      result.baseDelayMs = Math.min(result.baseDelayMs, merged.baseDelayMs);
      result.maxDelayMs = Math.max(result.maxDelayMs, merged.maxDelayMs);
      result.backoffMultiplier = Math.max(result.backoffMultiplier, merged.backoffMultiplier);
    }

    return result;
  }

  /**
   * Calculate delay with exponential backoff and ±10% jitter (CHK-017).
   * delay(attempt) = min(baseDelayMs * backoffMultiplier^(attempt - 2), maxDelayMs) ± 10%
   * attempt is 1-indexed; delay is for wait before this attempt.
   */
  private calculateDelay(attempt: number, policy: RetryPolicy): number {
    // attempt 2 → exponent 0 → baseDelayMs
    // attempt 3 → exponent 1 → baseDelayMs * multiplier
    const exponent = attempt - 2;
    const rawDelay = Math.min(
      policy.baseDelayMs * Math.pow(policy.backoffMultiplier, exponent),
      policy.maxDelayMs,
    );

    // Add ±10% jitter
    const jitter = rawDelay * 0.1 * (2 * Math.random() - 1);
    return Math.max(0, Math.round(rawDelay + jitter));
  }
}
