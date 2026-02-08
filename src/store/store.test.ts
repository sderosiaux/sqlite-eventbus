import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStore } from './index.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { EventStatus } from '../types/index.js';

// WAL requires file-based DB (learning from cycle-1-lane-1)
function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe('SQLiteStore', () => {
  let store: SQLiteStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    store = new SQLiteStore(dbPath);
  });

  afterEach(() => {
    store?.close();
    cleanupDb(dbPath);
  });

  // --- WAL mode ---

  it('uses WAL journal mode for file-based DB', () => {
    // Learning from cycle-1-lane-1: pragma returns array
    const result = store.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  // --- Auto-migration ---

  it('auto-creates events table on construction', () => {
    const tables = store.pragma("table_info('events')") as Array<{ name: string }>;
    const columns = tables.map((t) => t.name);
    expect(columns).toContain('id');
    expect(columns).toContain('type');
    expect(columns).toContain('payload');
    expect(columns).toContain('status');
    expect(columns).toContain('retry_count');
    expect(columns).toContain('last_error');
    expect(columns).toContain('metadata');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');
    expect(columns).toContain('dlq_at'); // CHK-015
  });

  it('auto-creates subscriptions table on construction', () => {
    const tables = store.pragma("table_info('subscriptions')") as Array<{ name: string }>;
    const columns = tables.map((t) => t.name);
    expect(columns).toContain('id');
    expect(columns).toContain('event_type');
    expect(columns).toContain('created_at');
  });

  it('creates indexes on events.status and events.type', () => {
    const indexes = store.pragma('index_list(events)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_events_status');
    expect(names).toContain('idx_events_type');
  });

  // --- Event CRUD ---

  it('inserts and retrieves an event', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'user.created',
      payload: { name: 'Alice' },  // raw object — store serializes
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const event = store.getEvent(id);
    expect(event).toBeDefined();
    expect(event!.id).toBe(id);
    expect(event!.type).toBe('user.created');
    expect(event!.status).toBe('pending');
    expect(JSON.parse(event!.payload)).toEqual({ name: 'Alice' });
  });

  it('serializes payload as JSON text (spec: EVENTBUS-SPECIFICATION.md:135)', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const rawPayload = { items: [1, 2, 3], nested: { key: 'value' } };
    store.insertEvent({
      id,
      type: 'test',
      payload: rawPayload,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const event = store.getEvent(id);
    // payload must be stored as a JSON string, not [object Object]
    expect(typeof event!.payload).toBe('string');
    expect(JSON.parse(event!.payload)).toEqual(rawPayload);
  });

  it('serializes metadata as JSON text when provided', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'test',
      payload: {},
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: { source: 'api', traceId: 'abc-123' },
    });

    const event = store.getEvent(id);
    expect(typeof event!.metadata).toBe('string');
    expect(JSON.parse(event!.metadata!)).toEqual({ source: 'api', traceId: 'abc-123' });
  });

  it('returns undefined for non-existent event', () => {
    expect(store.getEvent('nonexistent')).toBeUndefined();
  });

  it('updates event status', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'test',
      payload: '{}',
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    store.updateEventStatus(id, 'processing');
    expect(store.getEvent(id)!.status).toBe('processing');

    store.updateEventStatus(id, 'done');
    expect(store.getEvent(id)!.status).toBe('done');
  });

  it('updates event retry info (retryCount, lastError)', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'test',
      payload: '{}',
      status: 'processing',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const errors = JSON.stringify(['Error 1']);
    store.updateEventRetry(id, 1, errors);
    const event = store.getEvent(id)!;
    expect(event.retry_count).toBe(1);
    expect(event.last_error).toBe(errors);
  });

  it('moves event to DLQ with dlq_at timestamp (CHK-015)', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'test',
      payload: '{}',
      status: 'processing',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    store.moveEventToDlq(id, JSON.stringify(['final error']));
    const event = store.getEvent(id)!;
    expect(event.status).toBe('dlq');
    expect(event.dlq_at).toBeDefined();
    expect(event.last_error).toBe(JSON.stringify(['final error']));
  });

  // --- Events by status ---

  it('queries events by status', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      store.insertEvent({
        id: randomUUID(),
        type: 'test',
        payload: '{}',
        status: i < 2 ? 'pending' : 'done',
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    expect(store.getEventsByStatus('pending')).toHaveLength(2);
    expect(store.getEventsByStatus('done')).toHaveLength(1);
    expect(store.getEventsByStatus('dlq')).toHaveLength(0);
  });

  // --- DLQ queries (for lane 4, but store methods needed) ---

  it('getDlqEvents returns events with offset/limit pagination', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      store.insertEvent({
        id: randomUUID(),
        type: 'test',
        payload: '{}',
        status: 'processing',
        retryCount: 3,
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        updatedAt: now,
      });
    }
    // Move all to DLQ
    const events = store.getEventsByStatus('processing');
    for (const e of events) {
      store.moveEventToDlq(e.id, '"error"');
    }

    const page1 = store.getDlqEvents(0, 2);
    expect(page1).toHaveLength(2);

    const page2 = store.getDlqEvents(2, 2);
    expect(page2).toHaveLength(2);

    const page3 = store.getDlqEvents(4, 2);
    expect(page3).toHaveLength(1);
  });

  it('resetDlqEvent resets status, retry_count, last_error, and dlq_at', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertEvent({
      id,
      type: 'test',
      payload: '{}',
      status: 'processing',
      retryCount: 3,
      createdAt: now,
      updatedAt: now,
      lastError: JSON.stringify(['e1', 'e2', 'e3']),
    });
    store.moveEventToDlq(id, JSON.stringify(['e1', 'e2', 'e3']));

    store.resetDlqEvent(id);
    const event = store.getEvent(id)!;
    expect(event.status).toBe('pending');
    expect(event.retry_count).toBe(0);
    expect(event.last_error).toBeNull();
    expect(event.dlq_at).toBeNull();
  });

  it('purgeDlqEvents deletes DLQ events with created_at older than cutoff (inclusive)', () => {
    const oldCreatedAt = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
    const recentCreatedAt = new Date().toISOString();

    store.insertEvent({
      id: 'old-event',
      type: 'test',
      payload: {},
      status: 'processing',
      retryCount: 3,
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
    });
    store.insertEvent({
      id: 'recent-event',
      type: 'test',
      payload: {},
      status: 'processing',
      retryCount: 3,
      createdAt: recentCreatedAt,
      updatedAt: recentCreatedAt,
    });

    store.moveEventToDlq('old-event', '"err"');
    store.moveEventToDlq('recent-event', '"err"');

    // Purge DLQ events with created_at <= 7 days ago (spec: purge uses created_at)
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const deleted = store.purgeDlqEvents(cutoff);
    expect(deleted).toBe(1);
    expect(store.getEvent('old-event')).toBeUndefined();
    expect(store.getEvent('recent-event')).toBeDefined();
  });

  it('purgeDlqEvents uses created_at not dlq_at for cutoff', () => {
    // Event created recently but moved to DLQ with backdated dlq_at
    const recentCreatedAt = new Date().toISOString();
    store.insertEvent({
      id: 'recent-but-old-dlq',
      type: 'test',
      payload: {},
      status: 'processing',
      retryCount: 3,
      createdAt: recentCreatedAt,
      updatedAt: recentCreatedAt,
    });
    store.moveEventToDlq('recent-but-old-dlq', '"err"');
    // Backdate dlq_at to 10 days ago — but created_at is recent
    const oldDlqAt = new Date(Date.now() - 10 * 86400000).toISOString();
    store.rawExec('UPDATE events SET dlq_at = ? WHERE id = ?', oldDlqAt, 'recent-but-old-dlq');

    // Purge with 7-day cutoff: event has old dlq_at but recent created_at
    // Since purge uses created_at, this event should NOT be deleted
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const deleted = store.purgeDlqEvents(cutoff);
    expect(deleted).toBe(0);
    expect(store.getEvent('recent-but-old-dlq')).toBeDefined();
  });

  // --- Subscription CRUD ---

  it('inserts and retrieves a subscription', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertSubscription({ id, eventType: 'user.*', createdAt: now });

    const sub = store.getSubscription(id);
    expect(sub).toBeDefined();
    expect(sub!.id).toBe(id);
    expect(sub!.event_type).toBe('user.*');
  });

  it('deletes a subscription', () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    store.insertSubscription({ id, eventType: 'user.*', createdAt: now });

    store.deleteSubscription(id);
    expect(store.getSubscription(id)).toBeUndefined();
  });

  it('lists all subscriptions', () => {
    const now = new Date().toISOString();
    store.insertSubscription({ id: randomUUID(), eventType: 'user.*', createdAt: now });
    store.insertSubscription({ id: randomUUID(), eventType: 'order.*', createdAt: now });

    expect(store.getAllSubscriptions()).toHaveLength(2);
  });

  // --- Prepared statement caching (CHK-014) ---

  it('caches prepared statements and reuses them across calls (CHK-014)', () => {
    const now = new Date().toISOString();
    const hitsBefore = store.getCacheHits();

    // First insert: creates the INSERT statement (cache miss)
    store.insertEvent({
      id: randomUUID(),
      type: 'test',
      payload: {},
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const cacheSizeAfterFirst = store.getCacheSize();
    expect(cacheSizeAfterFirst).toBeGreaterThan(0);

    // Subsequent inserts reuse the cached INSERT statement (cache hits)
    for (let i = 0; i < 9; i++) {
      store.insertEvent({
        id: randomUUID(),
        type: 'test',
        payload: {},
        status: 'pending',
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Cache size should NOT grow — same SQL is reused
    expect(store.getCacheSize()).toBe(cacheSizeAfterFirst);

    // Cache hits must have increased: 9 subsequent inserts reused the statement
    const hitsAfter = store.getCacheHits();
    expect(hitsAfter - hitsBefore).toBeGreaterThanOrEqual(9);

    // Verify data integrity
    expect(store.getEventsByStatus('pending')).toHaveLength(10);
  });

  // --- Close ---

  it('close() is idempotent', () => {
    store.close();
    // Second close should not throw
    expect(() => store.close()).not.toThrow();
  });
});
