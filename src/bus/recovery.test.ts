import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from './index.js';
import { SQLiteStore } from '../store/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

describe('EventBus.start() — crash recovery (CHK-013)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTmpDbPath();
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it('re-dispatches events stuck in processing status', async () => {
    // Simulate crash: insert event in 'processing' state directly via store
    const store = new SQLiteStore(dbPath);
    const eventId = crypto.randomUUID();
    store.insertEvent({
      id: eventId,
      type: 'order.created',
      payload: { orderId: 123 },
      status: 'processing',
      retryCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: '["previous error"]',
    });
    store.close();

    // Create bus and register handler, then start recovery
    const received: string[] = [];
    const bus = new EventBus(dbPath, { delayFn: async () => {} });
    bus.subscribe('order.*', async (event) => {
      received.push(event.id);
    });

    await bus.start();

    // Handler should have been called with the stuck event
    expect(received).toContain(eventId);
    // Event should now be 'done'
    const row = bus.getStore().getEvent(eventId)!;
    expect(row.status).toBe('done');

    bus.destroy();
  });

  it('increments retry_count for recovered events', async () => {
    const store = new SQLiteStore(dbPath);
    const eventId = crypto.randomUUID();
    store.insertEvent({
      id: eventId,
      type: 'test',
      payload: {},
      status: 'processing',
      retryCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.close();

    const bus = new EventBus(dbPath, { delayFn: async () => {} });
    bus.subscribe('test', async () => {});
    await bus.start();

    const row = bus.getStore().getEvent(eventId)!;
    // retryCount was 2, start() increments to 3 before re-dispatch
    expect(row.retry_count).toBeGreaterThanOrEqual(3);

    bus.destroy();
  });

  it('handles no stuck events gracefully', async () => {
    const bus = new EventBus(dbPath, { delayFn: async () => {} });
    await expect(bus.start()).resolves.toBeUndefined();
    bus.destroy();
  });

  it('resets stuck events to pending before re-dispatch', async () => {
    const store = new SQLiteStore(dbPath);
    const eventId = crypto.randomUUID();
    store.insertEvent({
      id: eventId,
      type: 'test',
      payload: {},
      status: 'processing',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.close();

    // Create bus with a handler that checks status during dispatch
    let statusDuringHandler: string | undefined;
    const bus = new EventBus(dbPath, { delayFn: async () => {} });
    bus.subscribe('test', async (event) => {
      // During dispatch, the event should be in 'processing' again (dispatcher sets it)
      statusDuringHandler = bus.getStore().getEvent(event.id)?.status;
    });
    await bus.start();

    // The dispatcher transitions pending→processing→done
    expect(statusDuringHandler).toBe('processing');
    expect(bus.getStore().getEvent(eventId)!.status).toBe('done');

    bus.destroy();
  });
});
