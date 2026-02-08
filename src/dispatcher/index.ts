import type { Event, RetryPolicy, RetryMetrics, Subscription } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';
import type { SQLiteStore } from '../store/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_PAUSE_MS = 30_000;
const CIRCUIT_FAILURE_THRESHOLD = 0.5;
const CIRCUIT_MIN_SAMPLES = 4;

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

interface CircuitState {
  outcomes: Array<{ timestamp: number; failed: boolean }>;
  pausedUntil: number; // 0 = not paused
}

export class Dispatcher {
  private store: SQLiteStore;
  private handlers: Map<string, Subscription>;
  private defaultTimeoutMs: number;
  private defaultRetryPolicy: RetryPolicy;

  /** Track in-flight dispatch promises for graceful shutdown. */
  private inFlight: Set<Promise<void>> = new Set();

  /** Circuit breaker state per subscription ID. */
  private circuits: Map<string, CircuitState> = new Map();

  /** Retry metrics per event type. */
  private metrics: Map<string, RetryMetrics> = new Map();

  constructor(store: SQLiteStore, handlers: Map<string, Subscription>, opts?: DispatcherOptions) {
    this.store = store;
    this.handlers = handlers;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultRetryPolicy = opts?.defaultRetryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  async dispatch(event: Event): Promise<void> {
    const promise = this.doDispatch(event);
    this.inFlight.add(promise);
    try {
      await promise;
    } finally {
      this.inFlight.delete(promise);
    }
  }

  /** Wait for all in-flight dispatches to complete. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  getMetrics(): Map<string, RetryMetrics> {
    return new Map(this.metrics);
  }

  private ensureMetrics(eventType: string): RetryMetrics {
    let m = this.metrics.get(eventType);
    if (!m) {
      m = { totalRetries: 0, successAfterRetry: 0, dlqCount: 0 };
      this.metrics.set(eventType, m);
    }
    return m;
  }

  private async doDispatch(event: Event): Promise<void> {
    const allMatching = this.findMatchingSubscriptions(event.type);

    // Filter out circuit-broken subscriptions
    const matching = allMatching.filter(sub => !this.isCircuitOpen(sub.id));

    if (matching.length === 0) {
      this.store.updateEventStatus(event.id, 'done');
      return;
    }

    this.store.updateEventStatus(event.id, 'processing');

    const effectivePolicy = this.resolveRetryPolicy(matching);
    const maxAttempts = effectivePolicy.maxRetries + 1;

    const errorHistory: string[] = [];
    const m = this.ensureMetrics(event.type);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const delayMs = computeDelay(attempt, effectivePolicy);
      await sleep(delayMs);

      let failed = false;
      let attemptError = '';
      const failedSubIds: string[] = [];
      const succeededSubIds: string[] = [];

      for (const sub of matching) {
        if (this.isCircuitOpen(sub.id)) {
          // Skip paused subscriptions during retry loop too
          continue;
        }
        const timeoutMs = sub.timeoutMs ?? this.defaultTimeoutMs;
        try {
          await this.invokeWithTimeout(sub, event, timeoutMs);
          succeededSubIds.push(sub.id);
        } catch (err) {
          failed = true;
          attemptError = err instanceof Error ? err.message : String(err);
          failedSubIds.push(sub.id);
        }
      }

      // Record circuit breaker outcomes
      const now = Date.now();
      for (const subId of succeededSubIds) {
        this.recordCircuitOutcome(subId, now, false);
      }
      for (const subId of failedSubIds) {
        this.recordCircuitOutcome(subId, now, true);
      }

      if (failed) {
        errorHistory.push(attemptError);
      }

      const serializedErrors = JSON.stringify(errorHistory);
      this.store.updateEventRetry(event.id, attempt, serializedErrors);

      if (!failed) {
        this.store.updateEventStatus(event.id, 'done');
        if (attempt > 1) {
          m.totalRetries += attempt - 1;
          m.successAfterRetry += 1;
        }
        return;
      }

      // Emit structured retry log
      const nextDelay = attempt < maxAttempts ? computeDelay(attempt + 1, effectivePolicy) : 0;
      console.warn(JSON.stringify({
        level: 'warn',
        event_id: event.id,
        event_type: event.type,
        subscription_id: matching.map(s => s.id).join(','),
        attempt,
        max_attempts: maxAttempts,
        delay_ms: nextDelay,
        error: attemptError,
      }));
    }

    // All attempts exhausted -> DLQ
    this.store.updateEventStatus(event.id, 'dlq');
    m.totalRetries += effectivePolicy.maxRetries;
    m.dlqCount += 1;
  }

  // --- Circuit Breaker ---

  private getCircuit(subId: string): CircuitState {
    let c = this.circuits.get(subId);
    if (!c) {
      c = { outcomes: [], pausedUntil: 0 };
      this.circuits.set(subId, c);
    }
    return c;
  }

  private isCircuitOpen(subId: string): boolean {
    const c = this.circuits.get(subId);
    if (!c || c.pausedUntil === 0) return false;
    if (Date.now() >= c.pausedUntil) {
      // Half-open: allow traffic again
      c.pausedUntil = 0;
      c.outcomes = [];
      return false;
    }
    return true;
  }

  private recordCircuitOutcome(subId: string, timestamp: number, failed: boolean): void {
    const c = this.getCircuit(subId);
    c.outcomes.push({ timestamp, failed });

    // Prune outcomes outside the 1-minute window
    const cutoff = timestamp - CIRCUIT_WINDOW_MS;
    c.outcomes = c.outcomes.filter(o => o.timestamp > cutoff);

    // Check threshold
    if (c.outcomes.length >= CIRCUIT_MIN_SAMPLES) {
      const failures = c.outcomes.filter(o => o.failed).length;
      const rate = failures / c.outcomes.length;
      if (rate > CIRCUIT_FAILURE_THRESHOLD) {
        c.pausedUntil = timestamp + CIRCUIT_PAUSE_MS;
      }
    }
  }

  // --- Retry policy resolution ---

  private resolveRetryPolicy(subs: Subscription[]): RetryPolicy {
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
