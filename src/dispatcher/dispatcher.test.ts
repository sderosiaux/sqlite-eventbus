import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dispatcher } from './index.js';
import { EventBus } from '../bus/index.js';
import type { Event, EventHandler } from '../types/index.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    type: 'user.created',
    payload: { name: 'Alice' },
    createdAt: new Date(),
    status: 'pending',
    retryCount: 0,
    ...overrides,
  };
}

describe('CHK-006: Dispatcher invokes handlers with timeout protection', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers());
  });

  afterEach(() => {
    bus.destroy();
  });

  it('invokes a matching handler for an event', async () => {
    const called = vi.fn();
    const handler: EventHandler = async (evt) => { called(evt.id); };
    bus.subscribe('user.created', handler);

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).toHaveBeenCalledWith('evt-1');
  });

  it('invokes multiple matching handlers', async () => {
    const calls: string[] = [];
    bus.subscribe('user.created', async () => { calls.push('h1'); });
    bus.subscribe('user.*', async () => { calls.push('h2'); });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(calls).toContain('h1');
    expect(calls).toContain('h2');
    expect(calls).toHaveLength(2);
  });

  it('does not invoke non-matching handlers', async () => {
    const called = vi.fn();
    bus.subscribe('order.*', async () => { called(); });

    const event = makeEvent({ type: 'user.created' });
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).not.toHaveBeenCalled();
  });

  it('sets event status to processing then done on success', async () => {
    const statuses: string[] = [];
    bus.subscribe('user.created', async () => {
      // Capture status during handler execution
      const e = bus.getStore().getEvent('evt-1');
      if (e) statuses.push(e.status);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(statuses).toContain('processing');
    const final = bus.getStore().getEvent('evt-1');
    expect(final?.status).toBe('done');
  });

  it('records error on handler failure', async () => {
    bus.subscribe('user.created', async () => {
      throw new Error('handler exploded');
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const updated = bus.getStore().getEvent('evt-1');
    expect(updated?.lastError).toContain('handler exploded');
    expect(updated?.retryCount).toBe(1);
  });

  it('matches wildcard * subscription to any event type', async () => {
    const called = vi.fn();
    bus.subscribe('*', async () => { called(); });

    const event = makeEvent({ type: 'anything.at.all' });
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).toHaveBeenCalled();
  });

  it('matches multi-segment glob pattern', async () => {
    const called = vi.fn();
    bus.subscribe('order.*.shipped', async () => { called(); });

    const event = makeEvent({ id: 'evt-2', type: 'order.123.shipped' });
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).toHaveBeenCalled();
  });

  it('does not match partial glob pattern', async () => {
    const called = vi.fn();
    bus.subscribe('order.*.shipped', async () => { called(); });

    const event = makeEvent({ id: 'evt-3', type: 'order.shipped' });
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).not.toHaveBeenCalled();
  });
});

describe('CHK-017: Handler timeout', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers());
  });

  afterEach(() => {
    bus.destroy();
  });

  it('times out a slow handler with default timeout', async () => {
    // Override default to a short timeout for testing
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), { defaultTimeoutMs: 50 });

    bus.subscribe('user.created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const updated = bus.getStore().getEvent('evt-1');
    expect(updated?.lastError).toContain('timeout');
  });

  it('respects per-subscription timeout override', async () => {
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), { defaultTimeoutMs: 5000 });

    // Subscribe with a short per-subscription timeout
    bus.subscribe('user.created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }, { timeoutMs: 50 });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const updated = bus.getStore().getEvent('evt-1');
    expect(updated?.lastError).toContain('timeout');
  });

  it('does not time out a fast handler', async () => {
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), { defaultTimeoutMs: 5000 });

    const called = vi.fn();
    bus.subscribe('user.created', async () => { called(); });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(called).toHaveBeenCalled();
    const updated = bus.getStore().getEvent('evt-1');
    expect(updated?.status).toBe('done');
  });
});
