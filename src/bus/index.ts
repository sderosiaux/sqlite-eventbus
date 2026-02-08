import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import type { EventHandler, Subscription, SubscriptionRow } from '../types/index.js';

export interface EventBusOptions {
  dbPath: string;
}

export class EventBus {
  private store: SQLiteStore;
  /** In-memory handler registry keyed by subscription ID. */
  private handlers: Map<string, Subscription> = new Map();

  constructor(opts: EventBusOptions) {
    this.store = new SQLiteStore(opts.dbPath);
    // Hydrate in-memory handlers from persisted subscriptions is not possible
    // because handlers are functions (not serializable). On restart, subscribe must
    // be called again. We keep the DB subscriptions table for traceability and
    // for future lanes that need subscription metadata.
  }

  subscribe(eventType: string, handler: EventHandler): string {
    const id = randomUUID();
    const now = new Date();

    const sub: Subscription = { id, eventType, handler, createdAt: now };
    this.handlers.set(id, sub);

    // Persist subscription metadata (handler is memory-only)
    this.store.insertSubscription({ id, eventType, createdAt: now });

    return id;
  }

  unsubscribe(id: string): boolean {
    const existed = this.handlers.delete(id);
    const dbDeleted = this.store.deleteSubscription(id);
    return existed || dbDeleted;
  }

  /** Returns subscription metadata (no handler exposed). */
  getSubscriptions(): SubscriptionRow[] {
    return this.store.getAllSubscriptions();
  }

  /** Get the underlying store — needed by Dispatcher and other modules in later lanes. */
  getStore(): SQLiteStore {
    return this.store;
  }

  /** Get in-memory handler map — needed by Dispatcher. */
  getHandlers(): Map<string, Subscription> {
    return this.handlers;
  }

  /** Tear down — closes DB. For tests and shutdown. */
  destroy(): void {
    this.store.close();
  }
}
