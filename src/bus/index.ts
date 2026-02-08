import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import { Dispatcher } from '../dispatcher/index.js';
import type { DispatcherOptions } from '../dispatcher/index.js';
import type { Event, EventHandler, Subscription, SubscribeOptions } from '../types/index.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface EventBusOptions extends DispatcherOptions {
  shutdownTimeoutMs?: number; // default: 30s
}

export class EventBusShutdownError extends Error {
  constructor() {
    super('EventBusShutdownError');
    this.name = 'EventBusShutdownError';
  }
}

export class EventBus {
  private store: SQLiteStore;
  private handlers = new Map<string, Subscription>();
  private dispatcher: Dispatcher;
  private shuttingDown = false;
  private inFlight = new Set<Promise<void>>();
  private shutdownTimeoutMs: number;

  constructor(dbPath: string, options?: EventBusOptions) {
    this.store = new SQLiteStore(dbPath);
    this.dispatcher = new Dispatcher(this.store, options);
    this.shutdownTimeoutMs = options?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  /** CHK-004: Register handler with optional filter by event type. Returns subscription ID. */
  subscribe(eventType: string, handler: EventHandler, options?: SubscribeOptions): string;
  subscribe(handler: EventHandler, options?: SubscribeOptions): string;
  subscribe(
    eventTypeOrHandler: string | EventHandler,
    handlerOrOptions?: EventHandler | SubscribeOptions,
    maybeOptions?: SubscribeOptions,
  ): string {
    if (this.shuttingDown) throw new EventBusShutdownError();

    let eventType: string;
    let handler: EventHandler;
    let options: SubscribeOptions | undefined;

    if (typeof eventTypeOrHandler === 'string') {
      eventType = eventTypeOrHandler;
      handler = handlerOrOptions as EventHandler;
      options = maybeOptions;
    } else {
      eventType = '*';
      handler = eventTypeOrHandler;
      options = handlerOrOptions as SubscribeOptions | undefined;
    }

    const id = randomUUID();
    const now = new Date();

    this.store.insertSubscription({
      id,
      eventType,
      createdAt: now.toISOString(),
    });

    this.handlers.set(id, {
      id,
      eventType,
      handler,
      createdAt: now,
      timeoutMs: options?.timeoutMs,
      retry: options?.retry,
    });

    return id;
  }

  /** CHK-005: Remove handler by subscription ID. */
  unsubscribe(subscriptionId: string): void {
    this.handlers.delete(subscriptionId);
    this.store.deleteSubscription(subscriptionId);
  }

  /** CHK-003: Persist event then dispatch; await dispatch completion; return event ID. */
  async publish(eventType: string, payload: unknown, metadata?: Record<string, string>): Promise<string> {
    if (this.shuttingDown) throw new EventBusShutdownError();

    const id = randomUUID();
    const now = new Date().toISOString();

    this.store.insertEvent({
      id,
      type: eventType,
      payload,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: metadata ?? null,
    });

    const event: Event = {
      id,
      type: eventType,
      payload,
      createdAt: new Date(now),
      status: 'pending',
      retryCount: 0,
      metadata,
    };

    // Track in-flight dispatch for graceful shutdown
    const dispatchPromise = this.dispatcher.dispatch(event, this.handlers);
    this.inFlight.add(dispatchPromise);
    dispatchPromise.finally(() => this.inFlight.delete(dispatchPromise));

    await dispatchPromise;
    return id;
  }

  /**
   * CHK-012: Graceful shutdown.
   * 1. Stop accepting new publishes (throw EventBusShutdownError)
   * 2. Wait for in-flight dispatches (with timeout)
   * 3. Close SQLite connection
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return; // idempotent
    this.shuttingDown = true;

    // Wait for all in-flight dispatches, with timeout
    if (this.inFlight.size > 0) {
      const drain = Promise.allSettled([...this.inFlight]);
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, this.shutdownTimeoutMs),
      );
      await Promise.race([drain, timeout]);
    }

    this.store.close();
  }

  /**
   * CHK-013: Startup recovery — re-dispatch events stuck in 'processing'.
   * 1. Query events with status 'processing'
   * 2. Reset to 'pending' (increment retry_count)
   * 3. Re-dispatch through normal flow
   */
  async start(): Promise<void> {
    const stuckEvents = this.store.getEventsByStatus('processing');
    for (const row of stuckEvents) {
      // Increment retry count to account for the crashed attempt
      const newRetryCount = row.retry_count + 1;
      this.store.updateEventRetry(row.id, newRetryCount, row.last_error ?? '');
      // Reset to pending
      this.store.updateEventStatus(row.id, 'pending');

      // Build Event object and re-dispatch
      const event: Event = {
        id: row.id,
        type: row.type,
        payload: JSON.parse(row.payload),
        createdAt: new Date(row.created_at),
        status: 'pending',
        retryCount: newRetryCount,
      };
      await this.dispatcher.dispatch(event, this.handlers);
    }
  }

  getHandlers(): Map<string, Subscription> {
    return this.handlers;
  }

  getStore(): SQLiteStore {
    return this.store;
  }

  /** Raw close for test teardown. Guards double-close after shutdown(). */
  destroy(): void {
    this.store.close();
  }
}
