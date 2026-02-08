import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../bus/index.js';
import { Dispatcher } from './index.js';
import type { Event, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';

const FAST_RETRY: RetryPolicy = {
  maxRetries: 2,
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

describe('CHK-016: Retry metrics', () => {
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

  it('tracks total retries per event type', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      if (attempts <= 1) throw new Error('fail');
    });

    const ev = makeEvent('evt-m1');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    const metrics = dispatcher.getMetrics();
    const orderMetrics = metrics.get('order.placed');
    expect(orderMetrics).toBeDefined();
    expect(orderMetrics!.totalRetries).toBe(1); // 1 retry before success
  });

  it('tracks success-after-retry rate', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      if (attempts <= 1) throw new Error('transient');
    });

    const ev = makeEvent('evt-m2');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    const metrics = dispatcher.getMetrics();
    const orderMetrics = metrics.get('order.placed');
    expect(orderMetrics!.successAfterRetry).toBe(1);
  });

  it('tracks DLQ rate per event type', async () => {
    bus.subscribe('order.placed', async () => {
      throw new Error('permanent');
    });

    const ev = makeEvent('evt-m3');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    const metrics = dispatcher.getMetrics();
    const orderMetrics = metrics.get('order.placed');
    expect(orderMetrics!.dlqCount).toBe(1);
  });

  it('tracks metrics independently per event type', async () => {
    bus.subscribe('order.placed', async () => {
      throw new Error('fail');
    });

    bus.subscribe('user.created', async () => {
      // succeeds immediately
    });

    const ev1 = makeEvent('evt-m4', 'order.placed');
    bus.getStore().insertEvent(ev1);
    await dispatcher.dispatch(ev1);

    const ev2 = makeEvent('evt-m5', 'user.created');
    bus.getStore().insertEvent(ev2);
    await dispatcher.dispatch(ev2);

    const metrics = dispatcher.getMetrics();

    const orderMetrics = metrics.get('order.placed');
    expect(orderMetrics!.dlqCount).toBe(1);
    expect(orderMetrics!.totalRetries).toBe(2); // 2 retries (maxRetries=2)

    const userMetrics = metrics.get('user.created');
    expect(userMetrics!.totalRetries).toBe(0);
    expect(userMetrics!.dlqCount).toBe(0);
  });

  it('returns empty map when no dispatches have occurred', () => {
    const metrics = dispatcher.getMetrics();
    expect(metrics.size).toBe(0);
  });

  it('counts zero retries for events that succeed on first attempt', async () => {
    bus.subscribe('order.placed', async () => {
      // succeeds immediately
    });

    const ev = makeEvent('evt-m6');
    bus.getStore().insertEvent(ev);
    await dispatcher.dispatch(ev);

    const metrics = dispatcher.getMetrics();
    const orderMetrics = metrics.get('order.placed');
    expect(orderMetrics!.totalRetries).toBe(0);
    expect(orderMetrics!.successAfterRetry).toBe(0);
    expect(orderMetrics!.dlqCount).toBe(0);
  });
});
