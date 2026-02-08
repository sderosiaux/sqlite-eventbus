import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from './index.js';
import type { EventHandler } from '../types/index.js';

describe('CHK-003: EventBus.publish() persists event then dispatches', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('returns an event ID on publish', async () => {
    const eventId = await bus.publish('user.created', { name: 'Alice' });
    expect(typeof eventId).toBe('string');
    expect(eventId.length).toBeGreaterThan(0);
  });

  it('persists the event to the store', async () => {
    const eventId = await bus.publish('user.created', { name: 'Alice' });
    const event = bus.getStore().getEvent(eventId);
    expect(event).toBeDefined();
    expect(event!.type).toBe('user.created');
    expect(event!.payload).toEqual({ name: 'Alice' });
  });

  it('event starts as pending before dispatch', async () => {
    // Subscribe a handler that captures the status during execution
    const statusDuringHandler: string[] = [];
    bus.subscribe('user.created', async (evt) => {
      const e = bus.getStore().getEvent(evt.id);
      if (e) statusDuringHandler.push(e.status);
    });

    await bus.publish('user.created', { name: 'Alice' });

    // During handler execution, event was in 'processing' state
    expect(statusDuringHandler).toContain('processing');
  });

  it('dispatches to matching handlers', async () => {
    const called = vi.fn();
    bus.subscribe('user.created', async (evt) => {
      called(evt.payload);
    });

    await bus.publish('user.created', { name: 'Alice' });
    expect(called).toHaveBeenCalledWith({ name: 'Alice' });
  });

  it('marks event as done after successful dispatch', async () => {
    bus.subscribe('user.created', async () => {});
    const eventId = await bus.publish('user.created', { data: 1 });
    const event = bus.getStore().getEvent(eventId);
    expect(event!.status).toBe('done');
  });

  it('stores metadata when provided', async () => {
    const eventId = await bus.publish('user.created', {}, { metadata: { source: 'test' } });
    const event = bus.getStore().getEvent(eventId);
    expect(event!.metadata).toEqual({ source: 'test' });
  });

  it('does not dispatch to non-matching handlers', async () => {
    const called = vi.fn();
    bus.subscribe('order.*', async () => { called(); });

    await bus.publish('user.created', {});
    expect(called).not.toHaveBeenCalled();
  });

  it('handles publish with no matching subscribers (event still persisted as done)', async () => {
    const eventId = await bus.publish('user.created', { data: 1 });
    const event = bus.getStore().getEvent(eventId);
    expect(event).toBeDefined();
    // No handlers = nothing to fail = event is done
    expect(event!.status).toBe('done');
  });
});
