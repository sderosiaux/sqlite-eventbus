import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from './index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Event } from '../types/index.js';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch { /* best effort */ }
}

describe('EventBus', () => {
  let bus: EventBus;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    bus = new EventBus(dbPath);
  });

  afterEach(() => {
    bus?.destroy();
    cleanupDb(dbPath);
  });

  // --- CHK-004: subscribe ---

  describe('subscribe()', () => {
    it('registers handler and returns subscription ID', () => {
      const subId = bus.subscribe('user.created', async () => {});
      expect(typeof subId).toBe('string');
      expect(subId).toHaveLength(36); // UUID v4
    });

    it('accepts optional SubscribeOptions with timeoutMs', () => {
      const subId = bus.subscribe('user.*', async () => {}, { timeoutMs: 5000 });
      expect(typeof subId).toBe('string');
    });

    it('accepts optional SubscribeOptions with retry override', () => {
      const subId = bus.subscribe('order.*', async () => {}, {
        retry: { maxRetries: 5, baseDelayMs: 500 },
      });
      expect(typeof subId).toBe('string');
    });

    it('persists subscription metadata to store', () => {
      const subId = bus.subscribe('user.created', async () => {});
      const row = bus.getStore().getSubscription(subId);
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('user.created');
    });

    it('stores handler in memory (not in DB)', () => {
      const handler = async () => {};
      const subId = bus.subscribe('user.created', handler);
      const handlers = bus.getHandlers();
      expect(handlers.get(subId)?.handler).toBe(handler);
    });
  });

  // --- CHK-005: unsubscribe ---

  describe('unsubscribe()', () => {
    it('removes handler by subscription ID', () => {
      const subId = bus.subscribe('user.created', async () => {});
      bus.unsubscribe(subId);
      expect(bus.getHandlers().has(subId)).toBe(false);
    });

    it('removes subscription from store', () => {
      const subId = bus.subscribe('user.created', async () => {});
      bus.unsubscribe(subId);
      expect(bus.getStore().getSubscription(subId)).toBeUndefined();
    });

    it('is idempotent (no error on double unsubscribe)', () => {
      const subId = bus.subscribe('user.created', async () => {});
      bus.unsubscribe(subId);
      expect(() => bus.unsubscribe(subId)).not.toThrow();
    });
  });

  // --- CHK-003: publish ---

  describe('publish()', () => {
    it('persists event and returns event ID', async () => {
      bus.subscribe('user.created', async () => {});
      const eventId = await bus.publish('user.created', { name: 'Alice' });
      expect(typeof eventId).toBe('string');
      expect(eventId).toHaveLength(36); // UUID v4
    });

    it('event is stored in DB with correct fields', async () => {
      bus.subscribe('test', async () => {});
      const eventId = await bus.publish('test', { data: 42 });
      const row = bus.getStore().getEvent(eventId);
      expect(row).toBeDefined();
      expect(row!.type).toBe('test');
      expect(JSON.parse(row!.payload)).toEqual({ data: 42 });
    });

    it('dispatches to matching handlers and awaits completion', async () => {
      const received: Event[] = [];
      bus.subscribe('user.created', async (event) => {
        received.push(event);
      });

      await bus.publish('user.created', { name: 'Bob' });
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('user.created');
      expect(received[0].payload).toEqual({ name: 'Bob' });
    });

    it('dispatches to multiple matching subscriptions', async () => {
      const calls: string[] = [];
      bus.subscribe('user.created', async () => { calls.push('handler1'); });
      bus.subscribe('user.*', async () => { calls.push('handler2'); });

      await bus.publish('user.created', {});
      expect(calls).toHaveLength(2);
      expect(calls).toContain('handler1');
      expect(calls).toContain('handler2');
    });

    it('does not dispatch to non-matching subscriptions', async () => {
      const calls: string[] = [];
      bus.subscribe('order.created', async () => { calls.push('order'); });
      bus.subscribe('user.*', async () => { calls.push('user'); });

      await bus.publish('user.created', {});
      expect(calls).toEqual(['user']);
    });

    it('marks event as done after successful dispatch', async () => {
      bus.subscribe('test', async () => {});
      const eventId = await bus.publish('test', {});
      const row = bus.getStore().getEvent(eventId);
      expect(row!.status).toBe('done');
    });

    it('event remains in processing on handler failure (for retry in lane 3)', async () => {
      bus.subscribe('test', async () => { throw new Error('boom'); });
      const eventId = await bus.publish('test', {});
      const row = bus.getStore().getEvent(eventId);
      // Event stays processing — retry logic (lane 3) will handle it
      expect(row!.status).toBe('processing');
    });

    it('publishes with no matching subscriptions marks event as done', async () => {
      const eventId = await bus.publish('unmatched.event', { data: 1 });
      const row = bus.getStore().getEvent(eventId);
      expect(row!.status).toBe('done');
    });

    it('handler receives deserialized Event object', async () => {
      let receivedEvent: Event | undefined;
      bus.subscribe('test', async (event) => {
        receivedEvent = event;
      });

      await bus.publish('test', { key: 'value' });
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent!.id).toHaveLength(36);
      expect(receivedEvent!.type).toBe('test');
      expect(receivedEvent!.payload).toEqual({ key: 'value' });
      expect(receivedEvent!.status).toBe('pending');
      expect(receivedEvent!.retryCount).toBe(0);
      expect(receivedEvent!.createdAt).toBeInstanceOf(Date);
    });
  });

  // --- Event type matching (glob) ---

  describe('glob matching', () => {
    it('exact match', async () => {
      const calls: string[] = [];
      bus.subscribe('user.created', async () => { calls.push('exact'); });
      await bus.publish('user.created', {});
      expect(calls).toEqual(['exact']);
    });

    it('wildcard * matches one segment', async () => {
      const calls: string[] = [];
      bus.subscribe('user.*', async () => { calls.push('wildcard'); });
      await bus.publish('user.created', {});
      await bus.publish('user.updated', {});
      expect(calls).toEqual(['wildcard', 'wildcard']);
    });

    it('wildcard * does not match across segments', async () => {
      const calls: string[] = [];
      bus.subscribe('user.*', async () => { calls.push('hit'); });
      await bus.publish('user.profile.updated', {});
      expect(calls).toEqual([]);
    });

    it('standalone * matches everything', async () => {
      const calls: string[] = [];
      bus.subscribe('*', async () => { calls.push('all'); });
      await bus.publish('user.created', {});
      await bus.publish('order.shipped', {});
      expect(calls).toEqual(['all', 'all']);
    });

    it('middle wildcard: order.*.shipped', async () => {
      const calls: string[] = [];
      bus.subscribe('order.*.shipped', async () => { calls.push('hit'); });
      await bus.publish('order.123.shipped', {});
      await bus.publish('order.shipped', {}); // should NOT match
      expect(calls).toEqual(['hit']);
    });
  });

  // --- destroy ---

  describe('destroy()', () => {
    it('closes the DB connection', () => {
      bus.destroy();
      // Accessing store after destroy should not work normally
      // but we mainly test no throw on destroy
    });

    it('is idempotent', () => {
      bus.destroy();
      expect(() => bus.destroy()).not.toThrow();
    });
  });
});
