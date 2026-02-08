import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from './index.js';
import type { Event, EventHandler } from '../types/index.js';

describe('CHK-013: Startup crash recovery', () => {
  it('re-dispatches events stuck in processing state on start()', async () => {
    // Simulate a crash: insert an event directly in 'processing' state
    const bus = new EventBus({ dbPath: ':memory:' });
    const store = bus.getStore();

    const stuckEvent: Event = {
      id: 'evt-stuck-1',
      type: 'order.placed',
      payload: { orderId: 1 },
      createdAt: new Date(),
      status: 'processing',
      retryCount: 1,
    };
    store.insertEvent(stuckEvent);

    let dispatched = false;
    bus.subscribe('order.placed', async () => {
      dispatched = true;
    });

    await bus.start();

    // The stuck event should have been re-dispatched
    const recovered = store.getEvent('evt-stuck-1');
    expect(recovered?.status).toBe('done');
    expect(dispatched).toBe(true);
  });

  it('resets processing events to pending with incremented retryCount', async () => {
    const bus = new EventBus({ dbPath: ':memory:' });
    const store = bus.getStore();

    const stuckEvent: Event = {
      id: 'evt-stuck-2',
      type: 'order.placed',
      payload: {},
      createdAt: new Date(),
      status: 'processing',
      retryCount: 2,
    };
    store.insertEvent(stuckEvent);

    // No handler registered — event will go to 'done' with no subscribers
    await bus.start();

    const recovered = store.getEvent('evt-stuck-2');
    // retryCount should have been incremented from 2 to 3 before re-dispatch
    expect(recovered?.retryCount).toBeGreaterThanOrEqual(3);

    bus.destroy();
  });

  it('recovers multiple stuck events', async () => {
    const bus = new EventBus({ dbPath: ':memory:' });
    const store = bus.getStore();

    for (let i = 0; i < 5; i++) {
      store.insertEvent({
        id: `evt-multi-${i}`,
        type: 'order.placed',
        payload: {},
        createdAt: new Date(),
        status: 'processing',
        retryCount: 0,
      });
    }

    await bus.start();

    for (let i = 0; i < 5; i++) {
      const ev = store.getEvent(`evt-multi-${i}`);
      expect(ev?.status).not.toBe('processing');
    }

    bus.destroy();
  });

  it('does not touch events in other states', async () => {
    const bus = new EventBus({ dbPath: ':memory:' });
    const store = bus.getStore();

    store.insertEvent({
      id: 'evt-pending',
      type: 'order.placed',
      payload: {},
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
    });

    store.insertEvent({
      id: 'evt-done',
      type: 'order.placed',
      payload: {},
      createdAt: new Date(),
      status: 'done',
      retryCount: 0,
    });

    store.insertEvent({
      id: 'evt-dlq',
      type: 'order.placed',
      payload: {},
      createdAt: new Date(),
      status: 'dlq',
      retryCount: 3,
    });

    await bus.start();

    expect(store.getEvent('evt-pending')?.status).toBe('pending');
    expect(store.getEvent('evt-done')?.status).toBe('done');
    expect(store.getEvent('evt-dlq')?.status).toBe('dlq');

    bus.destroy();
  });
});
