import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dispatcher } from './index.js';
import { SQLiteStore } from '../store/index.js';
import type { Event, Subscription, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';
import { matchGlob } from '../bus/glob.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

function makeEvent(store: SQLiteStore, overrides: Partial<{ type: string; payload: unknown; status: string }> = {}): Event {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const type = overrides.type ?? 'test.event';
  const payload = overrides.payload ?? { data: 1 };
  store.insertEvent({
    id,
    type,
    payload,
    status: overrides.status ?? 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    type,
    payload,
    createdAt: new Date(now),
    status: 'pending',
    retryCount: 0,
  };
}

function makeSub(
  eventType: string,
  handler: (e: Event) => Promise<void>,
  opts?: { timeoutMs?: number; retry?: Partial<RetryPolicy> },
): Subscription {
  return {
    id: crypto.randomUUID(),
    eventType,
    handler,
    createdAt: new Date(),
    timeoutMs: opts?.timeoutMs,
    retry: opts?.retry,
  };
}

describe('Dispatcher', () => {
  let store: SQLiteStore;
  let dbPath: string;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    store = new SQLiteStore(dbPath);
    dispatcher = new Dispatcher(store);
  });

  afterEach(() => {
    store?.close();
    cleanupDb(dbPath);
  });

  // --- CHK-006: Dispatcher invokes handlers with timeout protection ---

  describe('handler invocation with timeout (CHK-006)', () => {
    it('invokes matching handlers sequentially', async () => {
      const calls: string[] = [];
      const subs = new Map<string, Subscription>();
      const s1 = makeSub('test.*', async () => { calls.push('h1'); });
      const s2 = makeSub('test.event', async () => { calls.push('h2'); });
      subs.set(s1.id, s1);
      subs.set(s2.id, s2);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      expect(calls).toEqual(['h1', 'h2']);
      expect(store.getEvent(event.id)!.status).toBe('done');
    });

    it('enforces timeout protection on handler invocation', async () => {
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        await new Promise((r) => setTimeout(r, 5000)); // would hang without timeout
      }, { timeoutMs: 50, retry: { maxRetries: 0 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      expect(row.status).toBe('dlq');
      expect(row.last_error).toContain('timeout');
    });

    it('skips non-matching subscriptions', async () => {
      const calls: string[] = [];
      const subs = new Map<string, Subscription>();
      const s1 = makeSub('order.*', async () => { calls.push('order'); });
      const s2 = makeSub('test.*', async () => { calls.push('test'); });
      subs.set(s1.id, s1);
      subs.set(s2.id, s2);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      expect(calls).toEqual(['test']);
    });
  });

  // --- CHK-020: Handler timeout ---

  describe('handler timeout (CHK-020)', () => {
    it('kills handler after default 30s timeout via Promise.race (fast test with override)', async () => {
      const subs = new Map<string, Subscription>();
      // Use 50ms timeout for test speed
      const s = makeSub('test.*', async () => {
        await new Promise((r) => setTimeout(r, 5000)); // would hang without timeout
      }, { timeoutMs: 50, retry: { maxRetries: 0 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      // Handler timed out → event should be in DLQ (maxRetries: 0 → 1 attempt → DLQ)
      const row = store.getEvent(event.id)!;
      expect(row.status).toBe('dlq');
      expect(row.last_error).toContain('timeout');
    });

    it('succeeds when handler completes within timeout', async () => {
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        await new Promise((r) => setTimeout(r, 10));
      }, { timeoutMs: 5000 });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      expect(store.getEvent(event.id)!.status).toBe('done');
    });

    it('uses per-subscription timeoutMs over default', async () => {
      const subs = new Map<string, Subscription>();
      // Short timeout that will fire
      const s = makeSub('test.*', async () => {
        await new Promise((r) => setTimeout(r, 5000));
      }, { timeoutMs: 30, retry: { maxRetries: 0 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      expect(row.status).toBe('dlq');
    });
  });

  // --- CHK-007: Retry with exponential backoff ---

  describe('retry with exponential backoff (CHK-007)', () => {
    it('retries failed handler up to maxRetries times', async () => {
      let attempts = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        attempts++;
        if (attempts <= 3) throw new Error(`fail-${attempts}`);
      }, { retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      // 1 initial + 3 retries = 4 total attempts; succeeds on 4th
      expect(attempts).toBe(4);
      expect(store.getEvent(event.id)!.status).toBe('done');
    });

    it('applies exponential backoff delays', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;

      // Spy on delay function
      const dispatcherWithSpy = new Dispatcher(store, {
        delayFn: async (ms: number) => {
          delays.push(ms);
          // Don't actually wait
        },
      });

      let attempts = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        attempts++;
        throw new Error(`fail-${attempts}`);
      }, { retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcherWithSpy.dispatch(event, subs);

      // 4 total attempts (1 initial + 3 retries), delays before retries 2-4
      // delay(2) = 100, delay(3) = 200, delay(4) = 400
      // With ±10% jitter, check approximate ranges
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBeGreaterThanOrEqual(90);  // 100 - 10%
      expect(delays[0]).toBeLessThanOrEqual(110);     // 100 + 10%
      expect(delays[1]).toBeGreaterThanOrEqual(180);  // 200 - 10%
      expect(delays[1]).toBeLessThanOrEqual(220);     // 200 + 10%
      expect(delays[2]).toBeGreaterThanOrEqual(360);  // 400 - 10%
      expect(delays[2]).toBeLessThanOrEqual(440);     // 400 + 10%
    });

    it('caps delay at maxDelayMs', async () => {
      const delays: number[] = [];
      const dispatcherWithSpy = new Dispatcher(store, {
        delayFn: async (ms: number) => { delays.push(ms); },
      });

      let attempts = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        attempts++;
        throw new Error('always-fail');
      }, { retry: { maxRetries: 6, baseDelayMs: 1000, maxDelayMs: 5000, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcherWithSpy.dispatch(event, subs);

      // Delay sequence (without jitter): 1000, 2000, 4000, 5000(cap), 5000(cap), 5000(cap)
      // Last 3 delays should be capped at ~5000 (±10%)
      expect(delays[delays.length - 1]).toBeLessThanOrEqual(5500);
      expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(4500);
    });

    it('accumulates error messages as JSON array in lastError', async () => {
      let attempts = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        attempts++;
        throw new Error(`error-${attempts}`);
      }, { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      const errors: string[] = JSON.parse(row.last_error!);
      expect(errors).toHaveLength(3); // 1 initial + 2 retries
      expect(errors[0]).toContain('error-1');
      expect(errors[1]).toContain('error-2');
      expect(errors[2]).toContain('error-3');
    });

    it('emits structured log entry on each failed attempt', async () => {
      const logs: unknown[] = [];
      const dispatcherWithLogger = new Dispatcher(store, {
        delayFn: async () => {},
        logFn: (entry) => { logs.push(entry); },
      });

      let attempts = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => {
        attempts++;
        throw new Error(`fail-${attempts}`);
      }, { retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcherWithLogger.dispatch(event, subs);

      // 3 total attempts → 3 log entries (all failures including final)
      expect(logs).toHaveLength(3);
      const firstLog = logs[0] as Record<string, unknown>;
      expect(firstLog.level).toBe('warn');
      expect(firstLog.event_id).toBe(event.id);
      expect(firstLog.event_type).toBe(event.type);
      expect(firstLog.attempt).toBe(1);
      expect(firstLog.max_attempts).toBe(3);
      expect(typeof firstLog.delay_ms).toBe('number');
      expect(typeof firstLog.error).toBe('string');
      expect(typeof firstLog.subscription_id).toBe('string');
    });

    it('uses per-subscription retry override merged with defaults', async () => {
      let attempts = 0;
      const subs = new Map<string, Subscription>();
      // Override only maxRetries; baseDelayMs/maxDelayMs/backoffMultiplier use defaults
      const s = makeSub('test.*', async () => {
        attempts++;
        throw new Error('fail');
      }, { retry: { maxRetries: 1, baseDelayMs: 1 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      // maxRetries=1 → 2 total attempts
      expect(attempts).toBe(2);
    });

    it('merges conflicting retry overrides from multiple matching subscriptions (most permissive wins)', async () => {
      let attempts = 0;
      const subs = new Map<string, Subscription>();

      // Sub 1: maxRetries=1 (lenient on delay)
      const s1 = makeSub('test.*', async () => {
        attempts++;
        throw new Error(`fail-${attempts}`);
      }, { retry: { maxRetries: 1, baseDelayMs: 1 } });
      subs.set(s1.id, s1);

      // Sub 2: maxRetries=4 (more retries)
      const s2 = makeSub('test.event', async () => {
        throw new Error('s2-fail');
      }, { retry: { maxRetries: 4, baseDelayMs: 1 } });
      subs.set(s2.id, s2);

      const dispatcherFast = new Dispatcher(store, { delayFn: async () => {} });
      const event = makeEvent(store);
      await dispatcherFast.dispatch(event, subs);

      // Most permissive: maxRetries=4 → 5 total attempts
      // s1 increments `attempts` on each call → should be 5
      expect(attempts).toBe(5);
      expect(store.getEvent(event.id)!.status).toBe('dlq');
    });
  });

  // --- CHK-008: DLQ routing ---

  describe('DLQ routing after max retries (CHK-008)', () => {
    it('moves event to DLQ after maxRetries + 1 total attempts', async () => {
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => { throw new Error('always-fail'); },
        { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      expect(row.status).toBe('dlq');
      expect(row.dlq_at).toBeDefined();
    });

    it('preserves original event data in DLQ', async () => {
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => { throw new Error('fail'); },
        { retry: { maxRetries: 0, baseDelayMs: 1 } });
      subs.set(s.id, s);

      const event = makeEvent(store, { payload: { important: 'data' } });
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      expect(JSON.parse(row.payload)).toEqual({ important: 'data' });
      expect(row.status).toBe('dlq');
    });

    it('stores all error messages from each attempt in lastError', async () => {
      let n = 0;
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => { n++; throw new Error(`attempt-${n}`); },
        { retry: { maxRetries: 1, baseDelayMs: 1 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);

      const row = store.getEvent(event.id)!;
      const errors: string[] = JSON.parse(row.last_error!);
      expect(errors).toHaveLength(2);
      expect(errors).toContain('attempt-1');
      expect(errors).toContain('attempt-2');
    });
  });

  // --- CHK-017: Jitter ---

  describe('jitter ±10% (CHK-017)', () => {
    it('adds ±10% random jitter to retry delays', async () => {
      const delays: number[] = [];
      const dispatcherWithSpy = new Dispatcher(store, {
        delayFn: async (ms: number) => { delays.push(ms); },
      });

      // Run many retries to get statistical signal
      const subs = new Map<string, Subscription>();
      const s = makeSub('test.*', async () => { throw new Error('fail'); },
        { retry: { maxRetries: 20, baseDelayMs: 1000, maxDelayMs: 1000, backoffMultiplier: 1 } });
      subs.set(s.id, s);

      const event = makeEvent(store);
      await dispatcherWithSpy.dispatch(event, subs);

      // All delays should be capped at 1000, so base = 1000
      // With ±10% jitter: [900, 1100]
      // All values should be in range
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(900);
        expect(d).toBeLessThanOrEqual(1100);
      }

      // Not all values should be exactly the same (statistical — jitter adds randomness)
      const unique = new Set(delays);
      expect(unique.size).toBeGreaterThan(1);
    });
  });
});
