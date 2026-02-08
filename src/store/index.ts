import Database from 'better-sqlite3';
import type { Event, EventStatus, SubscriptionRow } from '../types/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export class SQLiteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  getJournalMode(): string {
    const row = this.db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    return row[0].journal_mode;
  }

  // --- Events ---

  insertEvent(event: Event): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO events (id, type, payload, status, retry_count, last_error, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.type,
      JSON.stringify(event.payload),
      event.status,
      event.retryCount,
      event.lastError ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.createdAt.toISOString(),
      now,
    );
  }

  getEvent(id: string): Event | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  updateEventStatus(id: string, status: EventStatus): void {
    this.db.prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  updateEventRetry(id: string, retryCount: number, lastError: string): void {
    this.db.prepare('UPDATE events SET retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(retryCount, lastError, new Date().toISOString(), id);
  }

  getEventsByStatus(status: EventStatus): Event[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE status = ?').all(status) as EventRow[];
    return rows.map(rowToEvent);
  }

  // --- Subscriptions ---

  insertSubscription(sub: SubscriptionRow): void {
    this.db.prepare('INSERT INTO subscriptions (id, event_type, created_at) VALUES (?, ?, ?)')
      .run(sub.id, sub.eventType, sub.createdAt.toISOString());
  }

  deleteSubscription(id: string): boolean {
    const result = this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getAllSubscriptions(): SubscriptionRow[] {
    const rows = this.db.prepare('SELECT * FROM subscriptions').all() as SubRow[];
    return rows.map(r => ({
      id: r.id,
      eventType: r.event_type,
      createdAt: new Date(r.created_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}

// --- Internal row types ---

interface EventRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface SubRow {
  id: string;
  event_type: string;
  created_at: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    status: row.status as EventStatus,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at),
  };
}
