import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SQLiteStore } from './index.js';
import type { Event, EventStatus } from '../types/index.js';

describe('CHK-002: SQLiteStore', () => {
  let store: SQLiteStore;

  beforeEach(() => {
    // In-memory database for test isolation
    store = new SQLiteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('initialization', () => {
    it('creates tables on construction (auto-migration)', () => {
      // If we can insert and query, tables exist
      const event = makeEvent('evt-1', 'test.init');
      store.insertEvent(event);
      const fetched = store.getEvent('evt-1');
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe('evt-1');
    });

    it('uses WAL mode on file-based database', () => {
      const dbPath = join(tmpdir(), `eventbus-test-${randomUUID()}.db`);
      const fileStore = new SQLiteStore(dbPath);
      try {
        expect(fileStore.getJournalMode()).toBe('wal');
      } finally {
        fileStore.close();
        for (const suffix of ['', '-wal', '-shm']) {
          const p = dbPath + suffix;
          if (existsSync(p)) unlinkSync(p);
        }
      }
    });
  });

  describe('event CRUD', () => {
    it('inserts and retrieves an event', () => {
      const event = makeEvent('evt-2', 'user.created', { name: 'Bob' });
      store.insertEvent(event);
      const fetched = store.getEvent('evt-2');
      expect(fetched).toBeDefined();
      expect(fetched!.type).toBe('user.created');
      expect(fetched!.payload).toEqual({ name: 'Bob' });
      expect(fetched!.status).toBe('pending');
      expect(fetched!.retryCount).toBe(0);
    });

    it('updates event status atomically', () => {
      const event = makeEvent('evt-3', 'order.placed');
      store.insertEvent(event);
      store.updateEventStatus('evt-3', 'processing');
      const fetched = store.getEvent('evt-3');
      expect(fetched!.status).toBe('processing');
    });

    it('updates event error and retry count', () => {
      const event = makeEvent('evt-4', 'order.placed');
      store.insertEvent(event);
      store.updateEventRetry('evt-4', 2, 'Handler timeout');
      const fetched = store.getEvent('evt-4');
      expect(fetched!.retryCount).toBe(2);
      expect(fetched!.lastError).toBe('Handler timeout');
    });

    it('queries events by status', () => {
      store.insertEvent(makeEvent('evt-a', 'x', {}, 'pending'));
      store.insertEvent(makeEvent('evt-b', 'x', {}, 'processing'));
      store.insertEvent(makeEvent('evt-c', 'x', {}, 'pending'));
      const pending = store.getEventsByStatus('pending');
      expect(pending).toHaveLength(2);
      expect(pending.map(e => e.id).sort()).toEqual(['evt-a', 'evt-c']);
    });

    it('serializes and deserializes payload as JSON', () => {
      const complex = { nested: { array: [1, 2, 3], flag: true } };
      store.insertEvent(makeEvent('evt-5', 'test.json', complex));
      const fetched = store.getEvent('evt-5');
      expect(fetched!.payload).toEqual(complex);
    });

    it('serializes and deserializes metadata as JSON', () => {
      const event = makeEvent('evt-6', 'test.meta');
      event.metadata = { traceId: 'abc', source: 'test' };
      store.insertEvent(event);
      const fetched = store.getEvent('evt-6');
      expect(fetched!.metadata).toEqual({ traceId: 'abc', source: 'test' });
    });
  });

  describe('subscription CRUD', () => {
    it('inserts and retrieves a subscription', () => {
      store.insertSubscription({ id: 'sub-1', eventType: 'user.*', createdAt: new Date() });
      const subs = store.getAllSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].eventType).toBe('user.*');
    });

    it('deletes a subscription by ID', () => {
      store.insertSubscription({ id: 'sub-2', eventType: 'order.*', createdAt: new Date() });
      store.deleteSubscription('sub-2');
      const subs = store.getAllSubscriptions();
      expect(subs).toHaveLength(0);
    });

    it('returns false when deleting non-existent subscription', () => {
      const deleted = store.deleteSubscription('non-existent');
      expect(deleted).toBe(false);
    });
  });
});

function makeEvent(
  id: string,
  type: string,
  payload: unknown = {},
  status: EventStatus = 'pending',
): Event {
  return {
    id,
    type,
    payload,
    createdAt: new Date(),
    status,
    retryCount: 0,
  };
}
