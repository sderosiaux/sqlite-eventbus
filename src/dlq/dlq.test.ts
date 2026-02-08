import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DLQInspector } from './index.js';
import { SQLiteStore } from '../store/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

/** Insert an event directly into the store for test setup */
function insertDlqEvent(
  store: SQLiteStore,
  overrides: Partial<{ id: string; type: string; payload: unknown; createdAt: string; lastError: string }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  const now = overrides.createdAt ?? new Date().toISOString();
  store.insertEvent({
    id,
    type: overrides.type ?? 'test.event',
    payload: overrides.payload ?? { data: 1 },
    status: 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  // Move to DLQ
  store.moveEventToDlq(id, overrides.lastError ?? '["test error"]');
  return id;
}

describe('DLQInspector', () => {
  let store: SQLiteStore;
  let dbPath: string;
  let dlq: DLQInspector;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    store = new SQLiteStore(dbPath);
    dlq = new DLQInspector(store);
  });

  afterEach(() => {
    store?.close();
    cleanupDb(dbPath);
  });

  // --- CHK-009: DLQInspector.list() ---

  describe('list() (CHK-009)', () => {
    it('returns empty array when no DLQ events exist', () => {
      const result = dlq.list();
      expect(result.events).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns DLQ events with default limit 100 and offset 0', () => {
      for (let i = 0; i < 3; i++) {
        insertDlqEvent(store, { type: `test.event.${i}` });
      }
      const result = dlq.list();
      expect(result.events).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('orders events descending by created_at (most recent first)', () => {
      const id1 = insertDlqEvent(store, { createdAt: '2024-01-01T00:00:00.000Z' });
      const id2 = insertDlqEvent(store, { createdAt: '2024-06-01T00:00:00.000Z' });
      const id3 = insertDlqEvent(store, { createdAt: '2024-03-01T00:00:00.000Z' });

      const result = dlq.list();
      expect(result.events[0].id).toBe(id2); // June — most recent
      expect(result.events[1].id).toBe(id3); // March
      expect(result.events[2].id).toBe(id1); // January — oldest
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertDlqEvent(store);
      }
      const result = dlq.list({ limit: 2 });
      expect(result.events).toHaveLength(2);
      expect(result.total).toBe(5); // total is still 5
    });

    it('respects offset parameter for pagination', () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(insertDlqEvent(store, {
          createdAt: `2024-0${i + 1}-01T00:00:00.000Z`,
        }));
      }
      // DESC order: id4 (May), id3 (Apr), id2 (Mar), id1 (Feb), id0 (Jan)
      const page1 = dlq.list({ limit: 2, offset: 0 });
      const page2 = dlq.list({ limit: 2, offset: 2 });
      const page3 = dlq.list({ limit: 2, offset: 4 });

      expect(page1.events).toHaveLength(2);
      expect(page1.events[0].id).toBe(ids[4]); // May
      expect(page2.events).toHaveLength(2);
      expect(page2.events[0].id).toBe(ids[2]); // March
      expect(page3.events).toHaveLength(1);
      expect(page3.events[0].id).toBe(ids[0]); // January
    });

    it('default limit is 100', () => {
      // Insert 101 events, verify only 100 returned with default params
      for (let i = 0; i < 101; i++) {
        insertDlqEvent(store);
      }
      const result = dlq.list();
      expect(result.events).toHaveLength(100);
      expect(result.total).toBe(101);
    });

    it('does not return non-DLQ events', () => {
      // Insert a pending event (not DLQ)
      store.insertEvent({
        id: crypto.randomUUID(),
        type: 'pending.event',
        payload: {},
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      insertDlqEvent(store);

      const result = dlq.list();
      expect(result.events).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // --- CHK-010: DLQInspector.retry() ---

  describe('retry() (CHK-010)', () => {
    it('resets event status to pending', () => {
      const id = insertDlqEvent(store);
      dlq.retry(id);
      const row = store.getEvent(id)!;
      expect(row.status).toBe('pending');
    });

    it('resets retry_count to 0', () => {
      const id = insertDlqEvent(store);
      // Manually set retry_count > 0 to prove reset
      store.updateEventRetry(id, 5, '["err"]');
      store.moveEventToDlq(id, '["final err"]');

      dlq.retry(id);
      const row = store.getEvent(id)!;
      expect(row.retry_count).toBe(0);
    });

    it('clears last_error to NULL', () => {
      const id = insertDlqEvent(store, { lastError: '["error1","error2"]' });
      dlq.retry(id);
      const row = store.getEvent(id)!;
      expect(row.last_error).toBeNull();
    });

    it('clears dlq_at timestamp', () => {
      const id = insertDlqEvent(store);
      // Verify dlq_at was set
      expect(store.getEvent(id)!.dlq_at).not.toBeNull();

      dlq.retry(id);
      const row = store.getEvent(id)!;
      expect(row.dlq_at).toBeNull();
    });

    it('throws on non-existent event ID', () => {
      expect(() => dlq.retry('non-existent-id')).toThrow();
    });

    it('throws when event is not in DLQ status', () => {
      const id = crypto.randomUUID();
      store.insertEvent({
        id,
        type: 'test',
        payload: {},
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(() => dlq.retry(id)).toThrow();
    });

    it('retried event disappears from DLQ listing', () => {
      const id = insertDlqEvent(store);
      expect(dlq.list().total).toBe(1);

      dlq.retry(id);
      expect(dlq.list().total).toBe(0);
    });
  });

  // --- CHK-011: DLQInspector.purge() ---

  describe('purge() (CHK-011)', () => {
    it('deletes DLQ events older than N days (inclusive cutoff)', () => {
      // Event created 10 days ago
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      insertDlqEvent(store, { createdAt: oldDate });

      // Event created now
      insertDlqEvent(store);

      const deleted = dlq.purge(7); // purge events older than 7 days
      expect(deleted).toBe(1);
      expect(dlq.list().total).toBe(1); // only the recent one remains
    });

    it('returns count of deleted events', () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 3; i++) {
        insertDlqEvent(store, { createdAt: oldDate });
      }
      const deleted = dlq.purge(7);
      expect(deleted).toBe(3);
    });

    it('does not delete DLQ events newer than N days', () => {
      insertDlqEvent(store); // created now
      const deleted = dlq.purge(7);
      expect(deleted).toBe(0);
      expect(dlq.list().total).toBe(1);
    });

    it('uses created_at for age comparison, NOT dlq_at', () => {
      // Event created 2 days ago but moved to DLQ just now
      const recentCreated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      insertDlqEvent(store, { createdAt: recentCreated });

      const deleted = dlq.purge(1); // purge events older than 1 day
      // created_at is 2 days ago → older than 1 day → should be purged
      expect(deleted).toBe(1);
    });

    it('does not delete non-DLQ events', () => {
      // Insert a pending event with old created_at
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      store.insertEvent({
        id: crypto.randomUUID(),
        type: 'old.pending',
        payload: {},
        status: 'pending',
        retryCount: 0,
        createdAt: oldDate,
        updatedAt: oldDate,
      });

      const deleted = dlq.purge(7);
      expect(deleted).toBe(0);
    });

    it('purge(0) deletes all DLQ events (cutoff is now)', () => {
      insertDlqEvent(store);
      insertDlqEvent(store);
      // Wait a tiny bit to ensure created_at <= cutoff
      const deleted = dlq.purge(0);
      expect(deleted).toBe(2);
    });
  });
});
