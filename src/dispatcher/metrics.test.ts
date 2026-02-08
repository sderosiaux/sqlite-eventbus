import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Dispatcher } from './index.js';
import { SQLiteStore } from '../store/index.js';
import type { Event, Subscription } from '../types/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

function makeEvent(store: SQLiteStore, type = 'test.event'): Event {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  store.insertEvent({ id, type, payload: {}, status: 'pending', retryCount: 0, createdAt: now, updatedAt: now });
  return { id, type, payload: {}, createdAt: new Date(now), status: 'pending', retryCount: 0 };
}

function makeSub(
  eventType: string,
  handler: (e: Event) => Promise<void>,
  opts?: { retry?: { maxRetries?: number; baseDelayMs?: number } },
): Subscription {
  return {
    id: crypto.randomUUID(),
    eventType,
    handler,
    createdAt: new Date(),
    retry: opts?.retry,
  };
}

describe('Retry Metrics (CHK-019)', () => {
  let store: SQLiteStore;
  let dbPath: string;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    store = new SQLiteStore(dbPath);
    dispatcher = new Dispatcher(store, { delayFn: async () => {} });
  });

  afterEach(() => {
    store?.close();
    cleanupDb(dbPath);
  });

  it('tracks total retries per event type', async () => {
    const subs = new Map<string, Subscription>();
    let attempt = 0;
    const s = makeSub('test.*', async () => {
      attempt++;
      if (attempt <= 2) throw new Error('fail');
    }, { retry: { maxRetries: 3, baseDelayMs: 1 } });
    subs.set(s.id, s);

    await dispatcher.dispatch(makeEvent(store), subs);

    const metrics = dispatcher.getMetrics('test.event');
    expect(metrics).toBeDefined();
    expect(metrics!.totalRetries).toBe(2); // 2 retries before success on 3rd attempt
  });

  it('tracks success-after-retry rate', async () => {
    const subs = new Map<string, Subscription>();
    let callCount = 0;
    const s = makeSub('test.*', async () => {
      callCount++;
      // Fail first attempt, succeed on second
      if (callCount % 2 !== 0) throw new Error('fail');
    }, { retry: { maxRetries: 1, baseDelayMs: 1 } });
    subs.set(s.id, s);

    // Dispatch 2 events: both fail first, succeed on retry
    await dispatcher.dispatch(makeEvent(store, 'test.event'), subs);
    await dispatcher.dispatch(makeEvent(store, 'test.event'), subs);

    const metrics = dispatcher.getMetrics('test.event');
    expect(metrics!.successAfterRetry).toBe(2);
    expect(metrics!.totalEvents).toBe(2);
  });

  it('tracks DLQ rate per event type', async () => {
    const subs = new Map<string, Subscription>();
    const s = makeSub('test.*', async () => {
      throw new Error('always fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
    subs.set(s.id, s);

    // Dispatch 3 events — all go to DLQ
    for (let i = 0; i < 3; i++) {
      await dispatcher.dispatch(makeEvent(store, 'test.event'), subs);
    }

    const metrics = dispatcher.getMetrics('test.event');
    expect(metrics!.dlqCount).toBe(3);
    expect(metrics!.totalEvents).toBe(3);
  });

  it('returns undefined for untracked event types', () => {
    const metrics = dispatcher.getMetrics('unknown.type');
    expect(metrics).toBeUndefined();
  });

  it('tracks metrics separately per event type', async () => {
    const subs = new Map<string, Subscription>();
    const s = makeSub('*', async () => {
      throw new Error('fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
    subs.set(s.id, s);

    await dispatcher.dispatch(makeEvent(store, 'order.created'), subs);
    await dispatcher.dispatch(makeEvent(store, 'user.created'), subs);
    await dispatcher.dispatch(makeEvent(store, 'order.created'), subs);

    const orderMetrics = dispatcher.getMetrics('order.created');
    const userMetrics = dispatcher.getMetrics('user.created');

    expect(orderMetrics!.dlqCount).toBe(2);
    expect(orderMetrics!.totalEvents).toBe(2);
    expect(userMetrics!.dlqCount).toBe(1);
    expect(userMetrics!.totalEvents).toBe(1);
  });
});
