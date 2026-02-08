import type { Event } from '../types/index.js';
import type { SQLiteStore } from '../store/index.js';

export interface DlqListOptions {
  limit?: number;
  offset?: number;
}

export interface DlqListResult {
  events: Event[];
  total: number;
}

export class DLQInspector {
  private store: SQLiteStore;

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  list(opts?: DlqListOptions): DlqListResult {
    const events = this.store.getDlqEvents(opts);
    const total = this.store.countDlqEvents();
    return { events, total };
  }

  retry(eventId: string): void {
    const event = this.store.getEvent(eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }
    if (event.status !== 'dlq') {
      throw new Error(`Event ${eventId} is not in DLQ (status: ${event.status})`);
    }
    this.store.resetDlqEvent(eventId);
  }

  purge(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    return this.store.purgeDlqEvents(cutoff);
  }
}
