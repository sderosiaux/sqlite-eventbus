import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DLQInspector } from './index.js';
import { SQLiteStore } from '../store/index.js';
import type { Event } from '../types/index.js';

function makeDlqEvent(overrides: Partial<Event> & { id: string }): Event {
  return {
    type: 'order.placed',
    payload: { orderId: 1 },
    createdAt: new Date(),
    status: 'dlq',
    retryCount: 4,
    lastError: JSON.stringify(['fail-1', 'fail-2', 'fail-3', 'fail-4']),
    ...overrides,
  };
}

describe('CHK-009: DLQInspector.list() returns dead events with pagination', () => {
  let store: SQLiteStore;
  let inspector: DLQInspector;

  beforeEach(() => {
    store = new SQLiteStore(':memory:');
    inspector = new DLQInspector(store);

    // Seed 5 DLQ events
    for (let i = 1; i <= 5; i++) {
      store.insertEvent(makeDlqEvent({ id: `dlq-${i}`, type: `order.type-${i}` }));
    }
  });

  afterEach(() => {
    store.close();
  });

  it('returns all DLQ events when no pagination is specified', () => {
    const result = inspector.list();
    expect(result.events).toHaveLength(5);
    expect(result.total).toBe(5);
    result.events.forEach(e => expect(e.status).toBe('dlq'));
  });

  it('returns paginated results with limit', () => {
    const result = inspector.list({ limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it('returns paginated results with offset and limit', () => {
    const page1 = inspector.list({ limit: 2, offset: 0 });
    const page2 = inspector.list({ limit: 2, offset: 2 });
    const page3 = inspector.list({ limit: 2, offset: 4 });

    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    expect(page3.events).toHaveLength(1);

    // No overlap between pages
    const allIds = [
      ...page1.events.map(e => e.id),
      ...page2.events.map(e => e.id),
      ...page3.events.map(e => e.id),
    ];
    expect(new Set(allIds).size).toBe(5);
  });

  it('returns empty list when no DLQ events exist', () => {
    const emptyStore = new SQLiteStore(':memory:');
    const emptyInspector = new DLQInspector(emptyStore);
    const result = emptyInspector.list();
    expect(result.events).toHaveLength(0);
    expect(result.total).toBe(0);
    emptyStore.close();
  });

  it('only returns events with dlq status, not pending/done/processing', () => {
    // Insert non-DLQ events
    store.insertEvent({ ...makeDlqEvent({ id: 'non-dlq-1' }), status: 'pending' });
    store.insertEvent({ ...makeDlqEvent({ id: 'non-dlq-2' }), status: 'done' });

    const result = inspector.list();
    expect(result.total).toBe(5); // only the original 5 DLQ events
    expect(result.events.every(e => e.status === 'dlq')).toBe(true);
  });
});

describe('CHK-010: DLQInspector.retry() re-enqueues a dead event for reprocessing', () => {
  let store: SQLiteStore;
  let inspector: DLQInspector;

  beforeEach(() => {
    store = new SQLiteStore(':memory:');
    inspector = new DLQInspector(store);
    store.insertEvent(makeDlqEvent({ id: 'dlq-retry-1' }));
  });

  afterEach(() => {
    store.close();
  });

  it('resets a DLQ event to pending status', () => {
    inspector.retry('dlq-retry-1');
    const event = store.getEvent('dlq-retry-1');
    expect(event?.status).toBe('pending');
  });

  it('resets retryCount to 0', () => {
    inspector.retry('dlq-retry-1');
    const event = store.getEvent('dlq-retry-1');
    expect(event?.retryCount).toBe(0);
  });

  it('clears lastError', () => {
    inspector.retry('dlq-retry-1');
    const event = store.getEvent('dlq-retry-1');
    expect(event?.lastError).toBeUndefined();
  });

  it('throws if event does not exist', () => {
    expect(() => inspector.retry('nonexistent')).toThrow();
  });

  it('throws if event is not in DLQ status', () => {
    store.insertEvent({ ...makeDlqEvent({ id: 'not-dlq' }), status: 'done' });
    expect(() => inspector.retry('not-dlq')).toThrow();
  });

  it('event appears in list before retry, disappears after', () => {
    expect(inspector.list().total).toBe(1);
    inspector.retry('dlq-retry-1');
    expect(inspector.list().total).toBe(0);
  });
});

describe('CHK-011: DLQInspector.purge() deletes dead events older than N days', () => {
  let store: SQLiteStore;
  let inspector: DLQInspector;

  beforeEach(() => {
    store = new SQLiteStore(':memory:');
    inspector = new DLQInspector(store);
  });

  afterEach(() => {
    store.close();
  });

  it('deletes DLQ events older than N days', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const recentDate = new Date(); // now

    store.insertEvent(makeDlqEvent({ id: 'old-1', createdAt: oldDate }));
    store.insertEvent(makeDlqEvent({ id: 'old-2', createdAt: oldDate }));
    store.insertEvent(makeDlqEvent({ id: 'recent-1', createdAt: recentDate }));

    const purged = inspector.purge(7); // purge older than 7 days
    expect(purged).toBe(2);

    const remaining = inspector.list();
    expect(remaining.total).toBe(1);
    expect(remaining.events[0].id).toBe('recent-1');
  });

  it('returns 0 when no events qualify for purge', () => {
    store.insertEvent(makeDlqEvent({ id: 'recent', createdAt: new Date() }));
    const purged = inspector.purge(30);
    expect(purged).toBe(0);
  });

  it('only purges dlq events, not events in other statuses', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    store.insertEvent({ ...makeDlqEvent({ id: 'old-pending' }), status: 'pending', createdAt: oldDate });
    store.insertEvent(makeDlqEvent({ id: 'old-dlq', createdAt: oldDate }));

    const purged = inspector.purge(7);
    expect(purged).toBe(1); // only the dlq event

    // Pending event still exists
    const pending = store.getEvent('old-pending');
    expect(pending).toBeDefined();
    expect(pending?.status).toBe('pending');
  });

  it('purges all DLQ events when olderThanDays is 0', () => {
    store.insertEvent(makeDlqEvent({ id: 'any-1', createdAt: new Date() }));
    store.insertEvent(makeDlqEvent({ id: 'any-2', createdAt: new Date() }));

    const purged = inspector.purge(0);
    expect(purged).toBe(2);
    expect(inspector.list().total).toBe(0);
  });
});
