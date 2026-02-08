import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import type { Event, EventHandler, Subscription, SubscribeOptions } from '../types/index.js';
import { matchGlob } from './glob.js';

export class EventBus {
  private store: SQLiteStore;
  private handlers = new Map<string, Subscription>();

  constructor(dbPath: string) {
    this.store = new SQLiteStore(dbPath);
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

    // Find matching subscriptions
    const matching = this.getMatchingSubscriptions(eventType);

    if (matching.length === 0) {
      this.store.updateEventStatus(id, 'done');
      return id;
    }

    // Transition to processing
    this.store.updateEventStatus(id, 'processing');

    // Dispatch sequentially (learning from cycle-1-lane-2)
    let failed = false;
    for (const sub of matching) {
      try {
        await sub.handler(event);
      } catch {
        failed = true;
        // Event stays in processing for retry logic (lane 3)
        break;
      }
    }

    if (!failed) {
      this.store.updateEventStatus(id, 'done');
    }

    return id;
  }

  /** Get matching subscriptions for an event type using glob matching. */
  private getMatchingSubscriptions(eventType: string): Subscription[] {
    const result: Subscription[] = [];
    for (const sub of this.handlers.values()) {
      if (matchGlob(sub.eventType, eventType)) {
        result.push(sub);
      }
    }
    return result;
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
