import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import { Dispatcher } from '../dispatcher/index.js';
import type { DispatcherOptions } from '../dispatcher/index.js';
import type { Event, EventHandler, Subscription, SubscribeOptions } from '../types/index.js';

export class EventBus {
  private store: SQLiteStore;
  private handlers = new Map<string, Subscription>();
  private dispatcher: Dispatcher;

  constructor(dbPath: string, dispatcherOptions?: DispatcherOptions) {
    this.store = new SQLiteStore(dbPath);
    this.dispatcher = new Dispatcher(this.store, dispatcherOptions);
  }

  /** CHK-004: Register handler with optional filter by event type. Returns subscription ID. */
  subscribe(eventType: string, handler: EventHandler, options?: SubscribeOptions): string;
  subscribe(handler: EventHandler, options?: SubscribeOptions): string;
  subscribe(
    eventTypeOrHandler: string | EventHandler,
    handlerOrOptions?: EventHandler | SubscribeOptions,
    maybeOptions?: SubscribeOptions,
  ): string {
    let eventType: string;
    let handler: EventHandler;
    let options: SubscribeOptions | undefined;

    if (typeof eventTypeOrHandler === 'string') {
      eventType = eventTypeOrHandler;
      handler = handlerOrOptions as EventHandler;
      options = maybeOptions;
    } else {
      // Unfiltered subscribe — matches all events
      eventType = '*';
      handler = eventTypeOrHandler;
      options = handlerOrOptions as SubscribeOptions | undefined;
    }

    const id = randomUUID();
    const now = new Date();

    // Persist metadata to store
    this.store.insertSubscription({
      id,
      eventType,
      createdAt: now.toISOString(),
    });

    // Store handler in memory
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
    const id = randomUUID();
    const now = new Date().toISOString();

    // Persist event
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

    // Build deserialized Event object for handlers
    const event: Event = {
      id,
      type: eventType,
      payload,
      createdAt: new Date(now),
      status: 'pending',
      retryCount: 0,
      metadata,
    };

    // Delegate to Dispatcher (handles matching, timeout, retry, DLQ)
    await this.dispatcher.dispatch(event, this.handlers);

    return id;
  }

  /** Expose handlers map (for Dispatcher in lane 3). */
  getHandlers(): Map<string, Subscription> {
    return this.handlers;
  }

  /** Expose store (for Dispatcher/DLQ in later lanes). */
  getStore(): SQLiteStore {
    return this.store;
  }

  /** Raw close for test teardown. Graceful shutdown is lane 5. */
  destroy(): void {
    this.store.close();
  }
}
