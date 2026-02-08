import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dispatcher } from './index.js';
import { SQLiteStore } from '../store/index.js';
import type { Event, Subscription } from '../types/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
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
  opts?: { timeoutMs?: number; retry?: { maxRetries?: number; baseDelayMs?: number } },
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

describe('Circuit Breaker (CHK-018)', () => {
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

  it('trips circuit after >50% failure rate with minimum 4 samples in 1-minute window', async () => {
    const subs = new Map<string, Subscription>();
    let calls = 0;
    const s = makeSub('test.*', async () => {
      calls++;
      throw new Error('fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
    subs.set(s.id, s);

    // Dispatch 4 events — all fail → 100% failure rate → circuit opens
    for (let i = 0; i < 4; i++) {
      const event = makeEvent(store);
      await dispatcher.dispatch(event, subs);
    }
    expect(calls).toBe(4);

    // 5th dispatch should skip the circuit-broken subscription
    const event5 = makeEvent(store);
    await dispatcher.dispatch(event5, subs);
    // Handler was NOT called again (circuit is open)
    expect(calls).toBe(4);
    // Event goes to done (no matching active subs)
    expect(store.getEvent(event5.id)!.status).toBe('done');
  });

  it('does not trip circuit with <4 samples', async () => {
    const subs = new Map<string, Subscription>();
    let calls = 0;
    const s = makeSub('test.*', async () => {
      calls++;
      throw new Error('fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
    subs.set(s.id, s);

    // Only 3 failures — below minimum samples
    for (let i = 0; i < 3; i++) {
      await dispatcher.dispatch(makeEvent(store), subs);
    }
    expect(calls).toBe(3);

    // 4th dispatch still invokes the handler (circuit not yet open)
    await dispatcher.dispatch(makeEvent(store), subs);
    expect(calls).toBe(4);
  });

  it('does not trip circuit when failure rate is <= 50%', async () => {
    const subs = new Map<string, Subscription>();
    let callCount = 0;
    const s = makeSub('test.*', async () => {
      callCount++;
      // Fail on odd calls, succeed on even
      if (callCount % 2 !== 0) throw new Error('fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
    subs.set(s.id, s);

    // 4 events: 2 fail, 2 succeed → 50% → should NOT trip
    for (let i = 0; i < 4; i++) {
      await dispatcher.dispatch(makeEvent(store), subs);
    }
    expect(callCount).toBe(4);

    // 5th should still be handled
    await dispatcher.dispatch(makeEvent(store), subs);
    expect(callCount).toBe(5);
  });

  it('records per-sub success outcomes even when a later sub fails in same dispatch', async () => {
    const subs = new Map<string, Subscription>();
    let healthyCalls = 0;
    let failCalls = 0;

    // Healthy sub first (always succeeds)
    const sHealthy = makeSub('test.*', async () => {
      healthyCalls++;
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });

    // Failing sub second (always fails)
    const sFail = makeSub('test.*', async () => {
      failCalls++;
      throw new Error('fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });

    subs.set(sHealthy.id, sHealthy);
    subs.set(sFail.id, sFail);

    // Dispatch 4 events: healthy succeeds, failing fails each time
    // Healthy sub should get 4 success outcomes → NOT tripped
    // Failing sub should get 4 failure outcomes → tripped
    for (let i = 0; i < 4; i++) {
      await dispatcher.dispatch(makeEvent(store), subs);
    }
    expect(healthyCalls).toBe(4);
    expect(failCalls).toBe(4);

    // 5th dispatch: failing sub circuit-broken, healthy still runs
    await dispatcher.dispatch(makeEvent(store), subs);
    expect(healthyCalls).toBe(5); // still active — success outcomes prevent tripping
    expect(failCalls).toBe(4); // skipped — circuit open
  });

  it('only affects the specific subscription, not others', async () => {
    const subs = new Map<string, Subscription>();
    let failCalls = 0;
    let healthyCalls = 0;

    // Healthy sub added first → runs first in sequential execution
    const sHealthy = makeSub('test.*', async () => {
      healthyCalls++;
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });

    const sFail = makeSub('test.*', async () => {
      failCalls++;
      throw new Error('always fail');
    }, { retry: { maxRetries: 0, baseDelayMs: 1 } });

    subs.set(sHealthy.id, sHealthy);
    subs.set(sFail.id, sFail);

    // 4 dispatches — healthy runs first (succeeds), then failing sub fails → DLQ
    // Sequential execution: healthy runs, then failing runs and errors
    for (let i = 0; i < 4; i++) {
      await dispatcher.dispatch(makeEvent(store), subs);
    }
    expect(failCalls).toBe(4);
    expect(healthyCalls).toBe(4);

    // 5th dispatch: failing sub is circuit-broken (skipped), healthy still runs
    await dispatcher.dispatch(makeEvent(store), subs);
    expect(failCalls).toBe(4); // not called — circuit open
    expect(healthyCalls).toBe(5); // still called
  });

  it('resumes subscription after 30s pause', async () => {
    vi.useFakeTimers();
    try {
      const subs = new Map<string, Subscription>();
      let calls = 0;
      const s = makeSub('test.*', async () => {
        calls++;
        throw new Error('fail');
      }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
      subs.set(s.id, s);

      // Trip the circuit
      for (let i = 0; i < 4; i++) {
        await dispatcher.dispatch(makeEvent(store), subs);
      }
      expect(calls).toBe(4);

      // Advance time by 30s + 1ms
      vi.advanceTimersByTime(30_001);

      // Should resume (half-open)
      await dispatcher.dispatch(makeEvent(store), subs);
      expect(calls).toBe(5); // handler was called again
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Circuit Breaker Half-Open Probe (CHK-016)', () => {
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

  it('sends single probe event in half-open state before fully reopening', async () => {
    vi.useFakeTimers();
    try {
      const subs = new Map<string, Subscription>();
      let calls = 0;
      // Handler that fails first 4 times (trips circuit), then succeeds
      const s = makeSub('test.*', async () => {
        calls++;
        if (calls <= 4) throw new Error('fail');
      }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
      subs.set(s.id, s);

      // Trip the circuit (4 failures)
      for (let i = 0; i < 4; i++) {
        await dispatcher.dispatch(makeEvent(store), subs);
      }
      expect(calls).toBe(4);

      // Advance past 30s → enters half-open
      vi.advanceTimersByTime(30_001);

      // First dispatch after pause: probe event → handler succeeds → circuit closes
      await dispatcher.dispatch(makeEvent(store), subs);
      expect(calls).toBe(5);

      // Second dispatch: circuit is closed, handler should run normally
      await dispatcher.dispatch(makeEvent(store), subs);
      expect(calls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows only single probe in half-open state; concurrent dispatches are blocked', async () => {
    vi.useFakeTimers();
    try {
      const subs = new Map<string, Subscription>();
      let calls = 0;
      // Handler: fails first 4 (trips circuit), then succeeds (probe)
      const s = makeSub('test.*', async () => {
        calls++;
        if (calls <= 4) throw new Error('fail');
      }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
      subs.set(s.id, s);

      // Trip circuit
      for (let i = 0; i < 4; i++) {
        await dispatcher.dispatch(makeEvent(store), subs);
      }
      expect(calls).toBe(4);

      // Advance past 30s → half-open
      vi.advanceTimersByTime(30_001);

      // Fire two dispatches concurrently — only the first should be the probe
      const event1 = makeEvent(store);
      const event2 = makeEvent(store);
      const [, ] = await Promise.all([
        dispatcher.dispatch(event1, subs),
        dispatcher.dispatch(event2, subs),
      ]);

      // Only probe (event1) should have called the handler; event2 should be skipped
      expect(calls).toBe(5); // probe handler ran once, not twice
      // event2 was skipped (no active subs while probe in flight)
      expect(store.getEvent(event2.id)!.status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-opens circuit if probe fails', async () => {
    vi.useFakeTimers();
    try {
      const subs = new Map<string, Subscription>();
      let calls = 0;
      // Handler that always fails
      const s = makeSub('test.*', async () => {
        calls++;
        throw new Error('fail');
      }, { retry: { maxRetries: 0, baseDelayMs: 1 } });
      subs.set(s.id, s);

      // Trip the circuit (4 failures)
      for (let i = 0; i < 4; i++) {
        await dispatcher.dispatch(makeEvent(store), subs);
      }
      expect(calls).toBe(4);

      // Advance past 30s → enters half-open
      vi.advanceTimersByTime(30_001);

      // Probe fails → circuit re-opens
      await dispatcher.dispatch(makeEvent(store), subs);
      expect(calls).toBe(5);

      // Next dispatch: circuit is open again, handler skipped
      await dispatcher.dispatch(makeEvent(store), subs);
      expect(calls).toBe(5); // not called
    } finally {
      vi.useRealTimers();
    }
  });
});
