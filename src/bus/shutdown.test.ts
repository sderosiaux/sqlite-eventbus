import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from './index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'));
  return path.join(dir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* */ }
}

describe('EventBus.shutdown() (CHK-012)', () => {
  let bus: EventBus;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTmpDbPath();
    bus = new EventBus(dbPath, { delayFn: async () => {} });
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it('returns a promise that resolves when stopped', async () => {
    const result = bus.shutdown();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('rejects new publishes after shutdown with EventBusShutdownError', async () => {
    await bus.shutdown();
    await expect(bus.publish('test', {})).rejects.toThrow('EventBusShutdownError');
  });

  it('rejects subscribe after shutdown', async () => {
    await bus.shutdown();
    expect(() => bus.subscribe('test', async () => {})).toThrow('EventBusShutdownError');
  });

  it('waits for in-flight dispatches before resolving', async () => {
    let handlerFinished = false;
    bus.subscribe('slow', async () => {
      await new Promise((r) => setTimeout(r, 50));
      handlerFinished = true;
    });

    // Fire publish without awaiting — it enters dispatch
    const publishPromise = bus.publish('slow', {});

    // Give a tick for publish to start dispatching
    await new Promise((r) => setTimeout(r, 5));

    // Now shutdown — should wait for the in-flight handler
    await bus.shutdown();

    expect(handlerFinished).toBe(true);
    // Clean up the publish promise
    await publishPromise.catch(() => {});
  });

  it('times out and closes DB if drain exceeds shutdownTimeoutMs', async () => {

    const fastBus = new EventBus(dbPath, {
      delayFn: async () => {},
      shutdownTimeoutMs: 50,
    });
    fastBus.subscribe('hang', async () => {
      await new Promise((r) => setTimeout(r, 5000)); // hangs
    }, { retry: { maxRetries: 0 } });

    // Fire publish without awaiting
    const publishPromise = fastBus.publish('hang', {});

    // Give a tick for publish to enter dispatch
    await new Promise((r) => setTimeout(r, 5));

    // Shutdown should timeout after 50ms, not wait 5s
    const start = Date.now();
    await fastBus.shutdown();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // well under the 5s handler time
    // Clean up
    await publishPromise.catch(() => {});
  });

  it('is idempotent (double shutdown does not throw)', async () => {
    await bus.shutdown();
    await expect(bus.shutdown()).resolves.toBeUndefined();
  });

  it('guards against double-close with destroy()', async () => {
    await bus.shutdown();
    expect(() => bus.destroy()).not.toThrow();
  });
});
