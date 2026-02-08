import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import { Dispatcher } from '../dispatcher/index.js';
import type { Event, EventHandler, SubscribeOptions, Subscription, SubscriptionRow } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';

export interface EventBusOptions {
  dbPath: string;
  defaultTimeoutMs?: number;
}

export interface PublishOptions {
  metadata?: Record<string, string>;
}

export class EventBus {
  private store: SQLiteStore;
  private dispatcher: Dispatcher;
  /** In-memory handler registry keyed by subscription ID. */
  private handlers: Map<string, Subscription> = new Map();

  constructor(opts: EventBusOptions) {
    this.store = new SQLiteStore(opts.dbPath);
    this.dispatcher = new Dispatcher(this.store, this.handlers, {
      defaultTimeoutMs: opts.defaultTimeoutMs,
    });
  }

  async publish(type: string, payload: unknown, opts?: PublishOptions): Promise<string> {
    const id = randomUUID();
    const event: Event = {
      id,
      type,
      payload,
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
      metadata: opts?.metadata,
    };
    this.store.insertEvent(event);
    await this.dispatcher.dispatch(event);
    return id;
  }

  subscribe(eventType: string, handler: EventHandler, opts?: SubscribeOptions): string {
    const id = randomUUID();
    const now = new Date();

    const retryPolicy = opts?.retry
      ? { ...DEFAULT_RETRY_POLICY, ...opts.retry }
      : undefined;
    const sub: Subscription = { id, eventType, handler, createdAt: now, timeoutMs: opts?.timeoutMs, retryPolicy };
    this.handlers.set(id, sub);

    this.store.insertSubscription({ id, eventType, createdAt: now });

    return id;
  }

  unsubscribe(id: string): boolean {
    const existed = this.handlers.delete(id);
    const dbDeleted = this.store.deleteSubscription(id);
    return existed || dbDeleted;
  }

  getSubscriptions(): SubscriptionRow[] {
    return this.store.getAllSubscriptions();
  }

  getStore(): SQLiteStore {
    return this.store;
  }

  getHandlers(): Map<string, Subscription> {
    return this.handlers;
  }

  destroy(): void {
    this.store.close();
  }
}
