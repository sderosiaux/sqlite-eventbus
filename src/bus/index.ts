import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../store/index.js';
import { Dispatcher } from '../dispatcher/index.js';
import type { Event, EventHandler, SubscribeOptions, Subscription, SubscriptionRow } from '../types/index.js';
import { DEFAULT_RETRY_POLICY, EventBusShutdownError } from '../types/index.js';

export interface EventBusOptions {
  dbPath: string;
  defaultTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface PublishOptions {
  metadata?: Record<string, string>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export class EventBus {
  private store: SQLiteStore;
  private dispatcher: Dispatcher;
  /** In-memory handler registry keyed by subscription ID. */
  private handlers: Map<string, Subscription> = new Map();
  private isShutDown = false;
  private shutdownTimeoutMs: number;

  constructor(opts: EventBusOptions) {
    this.store = new SQLiteStore(opts.dbPath);
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.dispatcher = new Dispatcher(this.store, this.handlers, {
      defaultTimeoutMs: opts.defaultTimeoutMs,
    });
  }

  async publish(type: string, payload: unknown, opts?: PublishOptions): Promise<string> {
    if (this.isShutDown) throw new EventBusShutdownError();

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
    if (this.isShutDown) throw new EventBusShutdownError();

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

  /**
   * Crash recovery: re-dispatch events stuck in 'processing' state.
   * Call on startup before accepting new publishes.
   */
  async start(): Promise<void> {
    const stuck = this.store.getEventsByStatus('processing');
    for (const event of stuck) {
      // Increment retry count to reflect the crashed attempt
      const newRetryCount = event.retryCount + 1;
      this.store.updateEventRetry(event.id, newRetryCount, event.lastError ?? '');
      this.store.updateEventStatus(event.id, 'pending');

      // Re-read the updated event and dispatch
      const updated = this.store.getEvent(event.id)!;
      await this.dispatcher.dispatch(updated);
    }
  }

  /**
   * Graceful shutdown: reject new publishes, wait for in-flight (with timeout), close DB.
   */
  async shutdown(): Promise<void> {
    if (this.isShutDown) return;
    this.isShutDown = true;
    await Promise.race([
      this.dispatcher.drain(),
      new Promise<void>(resolve => setTimeout(resolve, this.shutdownTimeoutMs)),
    ]);
    this.store.close();
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
    if (!this.isShutDown) {
      this.store.close();
    }
  }
}
