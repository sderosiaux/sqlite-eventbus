import { SQLiteStore, type EventRow } from '../store/index.js';

export interface DlqListOptions {
  limit?: number;   // default: 100
  offset?: number;  // default: 0
}

export interface DlqListResult {
  events: EventRow[];
  total: number;
}

/**
 * DLQInspector: list, retry, and purge dead-lettered events.
 * Depends only on SQLiteStore (AD-5). No runtime dependency on EventBus or Dispatcher.
 */
export class DLQInspector {
  constructor(private store: SQLiteStore) {}

  /** CHK-009: List DLQ events with offset/limit pagination, descending by created_at. */
  list(options?: DlqListOptions): DlqListResult {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const events = this.store.getDlqEvents(offset, limit);
    const total = this.store.countDlqEvents();
    return { events, total };
  }

  /** CHK-010: Re-enqueue a single dead event. Full reset: status→pending, retry_count→0, last_error→NULL, dlq_at→NULL. */
  retry(eventId: string): void {
    const row = this.store.getEvent(eventId);
    if (!row) {
      throw new Error(`Event not found: ${eventId}`);
    }
    if (row.status !== 'dlq') {
      throw new Error(`Event ${eventId} is not in DLQ (status: ${row.status})`);
    }
    this.store.resetDlqEvent(eventId);
  }

  /** CHK-011: Delete DLQ events older than N days (inclusive: created_at <= cutoff). Returns count deleted. */
  purge(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.store.purgeDlqEvents(cutoff);
  }
}
