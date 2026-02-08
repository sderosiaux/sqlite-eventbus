import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../bus/index.js';
import { Dispatcher } from './index.js';
import type { Event, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';

const FAST_RETRY: RetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 10,
  backoffMultiplier: 1,
};

function makeEvent(id: string, type = 'order.placed'): Event {
  return {
    id,
    type,
    payload: {},
    createdAt: new Date(),
    status: 'pending',
    retryCount: 0,
  };
}

describe('CHK-015: Circuit breaker', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), {
      defaultRetryPolicy: FAST_RETRY,
    });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('opens circuit when >50% of events fail in 1-minute window', async () => {
    let callCount = 0;
    bus.subscribe('order.placed', async () => {
      callCount++;
      throw new Error('fail');
    }, { retry: { maxRetries: 0 } });

    // Dispatch enough events to trigger >50% failure in the window.
    // We need at least a few events to meet the threshold.
    for (let i = 0; i < 4; i++) {
      const ev = makeEvent(`evt-cb-${i}`);
      bus.getStore().insertEvent(ev);
      await dispatcher.dispatch(ev);
    }

    // Now dispatch another event — circuit should be open, handler should NOT be called
    const prevCount = callCount;
    const ev = makeEvent('evt-cb-after');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    // The handler should not have been invoked because the circuit is open
    // The event goes through without the paused subscription participating
    expect(callCount).toBe(prevCount);
  });

  it('resumes subscription after 30s pause', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    bus.subscribe('order.placed', async () => {
      callCount++;
      if (callCount <= 4) throw new Error('fail');
    }, { retry: { maxRetries: 0 } });

    // Trigger circuit open
    for (let i = 0; i < 4; i++) {
      const ev = makeEvent(`evt-resume-${i}`);
      bus.getStore().insertEvent(ev);
      await dispatcher.dispatch(ev);
    }

    // Advance time by 30 seconds to close the circuit
    vi.advanceTimersByTime(30_000);

    // Now handler should be called again
    const ev = makeEvent('evt-after-resume');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    // Handler should have been called (callCount > 4)
    expect(callCount).toBeGreaterThan(4);

    vi.useRealTimers();
  });

  it('only pauses the failing subscription, not others', async () => {
    let failCount = 0;
    let successCount = 0;

    bus.subscribe('order.placed', async () => {
      failCount++;
      throw new Error('fail');
    }, { retry: { maxRetries: 0 } });

    bus.subscribe('order.placed', async () => {
      successCount++;
    });

    // Trigger circuit on the failing subscription
    for (let i = 0; i < 4; i++) {
      const ev = makeEvent(`evt-mixed-${i}`);
      bus.getStore().insertEvent(ev);
      await dispatcher.dispatch(ev);
    }

    // Both should have been called for the first 4
    expect(successCount).toBe(4);

    // Now dispatch another — only the healthy subscription should run
    const ev = makeEvent('evt-mixed-after');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    expect(successCount).toBe(5); // healthy sub still called
    expect(failCount).toBe(4);   // failing sub paused
  });

  it('tracks failure rate per subscription independently', async () => {
    let failCountA = 0;
    let failCountB = 0;

    bus.subscribe('order.placed', async () => {
      failCountA++;
      throw new Error('fail-a');
    }, { retry: { maxRetries: 0 } });

    bus.subscribe('user.created', async () => {
      failCountB++;
      throw new Error('fail-b');
    }, { retry: { maxRetries: 0 } });

    // Trigger circuit on order.placed subscription
    for (let i = 0; i < 4; i++) {
      const ev = makeEvent(`evt-indep-${i}`, 'order.placed');
      bus.getStore().insertEvent(ev);
      await dispatcher.dispatch(ev);
    }

    // user.created subscription should still work (its circuit is not tripped)
    const ev = makeEvent('evt-indep-user', 'user.created');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    expect(failCountB).toBe(1); // Called normally
    expect(failCountA).toBe(4); // Paused after 4 failures
  });
});
