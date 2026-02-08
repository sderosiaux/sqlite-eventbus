import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from './index.js';
import type { Event, EventHandler } from '../types/index.js';

describe('CHK-004: EventBus.subscribe()', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('registers a handler and returns a subscription ID', () => {
    const handler: EventHandler = async () => {};
    const subId = bus.subscribe('user.created', handler);
    expect(subId).toBeDefined();
    expect(typeof subId).toBe('string');
    expect(subId.length).toBeGreaterThan(0);
  });

  it('registers multiple handlers for different event types', () => {
    const h1: EventHandler = async () => {};
    const h2: EventHandler = async () => {};
    const id1 = bus.subscribe('user.*', h1);
    const id2 = bus.subscribe('order.*', h2);
    expect(id1).not.toBe(id2);
  });

  it('registers handler with glob pattern filter', () => {
    const handler: EventHandler = async () => {};
    const subId = bus.subscribe('order.*', handler);
    expect(subId).toBeDefined();
    // The subscription should be persisted in the store
    const subs = bus.getSubscriptions();
    expect(subs.some(s => s.id === subId && s.eventType === 'order.*')).toBe(true);
  });

  it('registers handler for wildcard * (all events)', () => {
    const handler: EventHandler = async () => {};
    const subId = bus.subscribe('*', handler);
    expect(subId).toBeDefined();
  });
});

describe('CHK-005: EventBus.unsubscribe()', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('removes a handler by subscription ID', () => {
    const handler: EventHandler = async () => {};
    const subId = bus.subscribe('user.created', handler);
    const removed = bus.unsubscribe(subId);
    expect(removed).toBe(true);
    const subs = bus.getSubscriptions();
    expect(subs.find(s => s.id === subId)).toBeUndefined();
  });

  it('returns false when unsubscribing a non-existent ID', () => {
    const removed = bus.unsubscribe('non-existent-id');
    expect(removed).toBe(false);
  });

  it('unsubscribed handler no longer appears in subscription list', () => {
    const h1: EventHandler = async () => {};
    const h2: EventHandler = async () => {};
    const id1 = bus.subscribe('user.*', h1);
    const id2 = bus.subscribe('order.*', h2);
    bus.unsubscribe(id1);
    const subs = bus.getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(id2);
  });
});
