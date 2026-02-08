import { SQLiteStore } from '../store/index.js';
import type { Event, Subscription, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';
import { matchGlob } from '../bus/glob.js';

export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const CIRCUIT_BREAKER_MIN_SAMPLES = 4;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 0.5;
const CIRCUIT_BREAKER_PAUSE_MS = 30_000;

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

export interface RetryMetrics {
  totalRetries: number;
  successAfterRetry: number;
  dlqCount: number;
  totalEvents: number;
}

interface CircuitBreakerState {
  outcomes: { timestamp: number; success: boolean }[];
  state: 'closed' | 'open' | 'half-open';
  openedAt: number;
  probeInFlight: boolean;
}

export class Dispatcher {
  private store: SQLiteStore;
  private delayFn: (ms: number) => Promise<void>;
  private logFn: (entry: RetryLogEntry) => void;
  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private metrics = new Map<string, RetryMetrics>();

  constructor(store: SQLiteStore, options?: DispatcherOptions) {
    this.store = store;
    this.delayFn = options?.delayFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logFn = options?.logFn ?? ((entry) => console.warn(JSON.stringify(entry)));
  }

  getMetrics(eventType: string): RetryMetrics | undefined {
    return this.metrics.get(eventType);
  }

  private ensureMetrics(eventType: string): RetryMetrics {
    let m = this.metrics.get(eventType);
    if (!m) {
      m = { totalRetries: 0, successAfterRetry: 0, dlqCount: 0, totalEvents: 0 };
      this.metrics.set(eventType, m);
    }
    return m;
  }

  private getCircuitBreaker(subId: string): CircuitBreakerState {
    let cb = this.circuitBreakers.get(subId);
    if (!cb) {
      cb = { outcomes: [], state: 'closed', openedAt: 0, probeInFlight: false };
      this.circuitBreakers.set(subId, cb);
    }
    return cb;
  }

  private recordOutcome(subId: string, success: boolean): void {
    const cb = this.getCircuitBreaker(subId);
    const now = Date.now();
    cb.outcomes.push({ timestamp: now, success });

    // Prune outcomes outside 1-minute window
    const cutoff = now - CIRCUIT_BREAKER_WINDOW_MS;
    cb.outcomes = cb.outcomes.filter((o) => o.timestamp > cutoff);

    if (cb.state === 'half-open') {
      cb.probeInFlight = false;
      // Probe result
      if (success) {
        cb.state = 'closed';
        cb.outcomes = [];
      } else {
        cb.state = 'open';
        cb.openedAt = now;
      }
      return;
    }

    // Check if circuit should trip
    if (cb.outcomes.length >= CIRCUIT_BREAKER_MIN_SAMPLES) {
      const failures = cb.outcomes.filter((o) => !o.success).length;
      const failureRate = failures / cb.outcomes.length;
      if (failureRate > CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
        cb.state = 'open';
        cb.openedAt = now;
      }
    }
  }

  private isCircuitOpen(subId: string): boolean {
    const cb = this.circuitBreakers.get(subId);
    if (!cb || cb.state === 'closed') return false;

    if (cb.state === 'open') {
      const elapsed = Date.now() - cb.openedAt;
      if (elapsed >= CIRCUIT_BREAKER_PAUSE_MS) {
        cb.state = 'half-open';
        cb.probeInFlight = true;
        return false; // allow single probe
      }
      return true;
    }

    // half-open: block if probe already in flight
    if (cb.probeInFlight) return true;
    cb.probeInFlight = true;
    return false;
  }

  /**
   * Dispatch an event to matching subscriptions with retry, timeout, and DLQ routing.
   * Handlers are invoked sequentially. Failure tracking is per-event.
   */
  async dispatch(event: Event, subscriptions: Map<string, Subscription>): Promise<void> {
    // Find matching subscriptions, filtering circuit-broken ones
    const matching: Subscription[] = [];
    for (const sub of subscriptions.values()) {
      if (matchGlob(sub.eventType, event.type)) {
        if (!this.isCircuitOpen(sub.id)) {
          matching.push(sub);
        }
      }
    }

    if (matching.length === 0) {
      this.storeOp(() => this.store.updateEventStatus(event.id, 'done'));
      return;
    }

    // Transition to processing
    this.storeOp(() => this.store.updateEventStatus(event.id, 'processing'));

    // Track metrics
    const m = this.ensureMetrics(event.type);
    m.totalEvents++;

    // Resolve retry policy: merge all matching subscriptions' overrides (most permissive wins)
    const policy = this.mergeRetryPolicies(matching);

    const maxAttempts = policy.maxRetries + 1;
    const errorHistory: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait before retry (not before first attempt)
      if (attempt > 1) {
        const delay = this.calculateDelay(attempt, policy);
        await this.delayFn(delay);
        m.totalRetries++;
      }

      const result = await this.runHandlers(event, matching);

      if (result.success) {
        // Record success outcome for circuit breaker on all matching subs
        for (const sub of matching) {
          this.recordOutcome(sub.id, true);
        }
        // Update retry count and errors if we had previous failures
        if (errorHistory.length > 0) {
          this.storeOp(() => this.store.updateEventRetry(event.id, errorHistory.length, JSON.stringify(errorHistory)));
          m.successAfterRetry++;
        }
        this.storeOp(() => this.store.updateEventStatus(event.id, 'done'));
        return;
      }

      // Record per-sub outcomes: success for subs that ran before the failure, failure for the failed sub
      const executedIds = new Set(result.succeededSubIds);
      if (result.failedSubscriptionId) executedIds.add(result.failedSubscriptionId);

      for (const succeededId of result.succeededSubIds) {
        this.recordOutcome(succeededId, true);
      }
      if (result.failedSubscriptionId) {
        this.recordOutcome(result.failedSubscriptionId, false);
      }

      // Release probeInFlight for half-open subs that were never executed
      for (const sub of matching) {
        if (!executedIds.has(sub.id)) {
          const cb = this.circuitBreakers.get(sub.id);
          if (cb && cb.state === 'half-open' && cb.probeInFlight) {
            cb.probeInFlight = false;
          }
        }
      }

      // Record failure
      errorHistory.push(result.error!);
      this.storeOp(() => this.store.updateEventRetry(event.id, attempt, JSON.stringify(errorHistory)));

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
    m.dlqCount++;
    this.storeOp(() => this.store.moveEventToDlq(event.id, JSON.stringify(errorHistory)));
  }

  /** Safely execute a store operation; silently ignores closed-DB errors (abandoned dispatch after shutdown). */
  private storeOp(fn: () => void): void {
    try { fn(); } catch (err) {
      if (err instanceof TypeError && (err as TypeError).message.includes('not open')) return;
      throw err;
    }
  }

  /** Run all matching handlers sequentially. Returns on first failure, with list of succeeded sub IDs. */
  private async runHandlers(
    event: Event,
    subscriptions: Subscription[],
  ): Promise<{ success: boolean; error?: string; failedSubscriptionId?: string; succeededSubIds: string[] }> {
    const succeededSubIds: string[] = [];
    for (const sub of subscriptions) {
      const timeoutMs = sub.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;

      try {
        await this.withTimeout(sub.handler(event), timeoutMs);
        succeededSubIds.push(sub.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, failedSubscriptionId: sub.id, succeededSubIds };
      }
    }
    return { success: true, succeededSubIds };
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
