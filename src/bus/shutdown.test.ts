import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from './index.js';
import type { EventHandler } from '../types/index.js';

describe('CHK-012: EventBus.shutdown()', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('rejects new publishes after shutdown with EventBusShutdownError', async () => {
    await bus.shutdown();
    await expect(bus.publish('user.created', { name: 'test' }))
      .rejects.toThrow('EventBusShutdownError');
  });

  it('rejects subscribe after shutdown with EventBusShutdownError', async () => {
    await bus.shutdown();
    expect(() => bus.subscribe('user.*', async () => {}))
      .toThrow('EventBusShutdownError');
  });

  it('waits for in-flight dispatches to complete before resolving', async () => {
    let handlerCompleted = false;
    const handler: EventHandler = async () => {
      await new Promise(r => setTimeout(r, 100));
      handlerCompleted = true;
    };
    bus.subscribe('user.created', handler);

    // Start a publish (dispatch runs async)
    const publishPromise = bus.publish('user.created', { name: 'test' });

    // Immediately start shutdown — it should wait for the in-flight dispatch
    const shutdownPromise = bus.shutdown();

    await publishPromise;
    await shutdownPromise;

    expect(handlerCompleted).toBe(true);
  });

  it('returns a promise that resolves when fully stopped', async () => {
    const result = bus.shutdown();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('closes the SQLite connection after shutdown', async () => {
    await bus.shutdown();
    // Attempting to use the store after shutdown should throw
    expect(() => bus.getStore().getEventsByStatus('pending')).toThrow();
  });

  it('shutdown is idempotent — calling twice does not throw', async () => {
    await bus.shutdown();
    await expect(bus.shutdown()).resolves.toBeUndefined();
  });
});
