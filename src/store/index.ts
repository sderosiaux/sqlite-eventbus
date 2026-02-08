import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

// Raw row types matching the DB schema
export interface EventRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  dlq_at: string | null;
}

export interface SubscriptionRowDb {
  id: string;
  event_type: string;
  created_at: string;
}

export interface InsertEventParams {
  id: string;
  type: string;
  payload: unknown;          // Store serializes to JSON text (spec: EVENTBUS-SPECIFICATION.md:135)
  status: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
  metadata?: Record<string, string> | null; // Store serializes to JSON text
}

export interface InsertSubscriptionParams {
  id: string;
  eventType: string;
  createdAt: string;
}

export class SQLiteStore {
  private db: Database.Database;
  private closed = false;

  // Prepared statement cache (CHK-014)
  private stmtCache = new Map<string, Statement>();
  private cacheHits = 0;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dlq_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** Get or create a cached prepared statement */
  private stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql);
    if (s) {
      this.cacheHits++;
      return s;
    }
    s = this.db.prepare(sql);
    this.stmtCache.set(sql, s);
    return s;
  }

  /** Expose cache size for testing (CHK-014) */
  getCacheSize(): number {
    return this.stmtCache.size;
  }

  /** Expose cache hit count — proves statements are reused, not re-created (CHK-014) */
  getCacheHits(): number {
    return this.cacheHits;
  }

  /** Execute a PRAGMA (for testing / config) */
  pragma(sql: string): unknown {
    return this.db.pragma(sql);
  }

  // --- Event CRUD ---

  insertEvent(params: InsertEventParams): void {
    const payloadJson = typeof params.payload === 'string'
      ? params.payload
      : JSON.stringify(params.payload);
    const metadataJson = params.metadata != null
      ? JSON.stringify(params.metadata)
      : null;
    this.stmt(
      `INSERT INTO events (id, type, payload, status, retry_count, last_error, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.type,
      payloadJson,
      params.status,
      params.retryCount,
      params.lastError ?? null,
      metadataJson,
      params.createdAt,
      params.updatedAt,
    );
  }

  getEvent(id: string): EventRow | undefined {
    return this.stmt('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  }

  updateEventStatus(id: string, status: string): void {
    this.stmt(
      'UPDATE events SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, new Date().toISOString(), id);
  }

  updateEventRetry(id: string, retryCount: number, lastError: string): void {
    this.stmt(
      'UPDATE events SET retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?'
    ).run(retryCount, lastError, new Date().toISOString(), id);
  }

  /** Move event to DLQ: sets status, last_error, and dlq_at timestamp (CHK-015) */
  moveEventToDlq(id: string, lastError: string): void {
    const now = new Date().toISOString();
    this.stmt(
      'UPDATE events SET status = ?, last_error = ?, dlq_at = ?, updated_at = ? WHERE id = ?'
    ).run('dlq', lastError, now, now, id);
  }

  getEventsByStatus(status: string): EventRow[] {
    return this.stmt('SELECT * FROM events WHERE status = ?').all(status) as EventRow[];
  }

  // --- DLQ queries (for lane 4) ---

  getDlqEvents(offset: number, limit: number): EventRow[] {
    return this.stmt(
      'SELECT * FROM events WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all('dlq', limit, offset) as EventRow[];
  }

  countDlqEvents(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM events WHERE status = ?').get('dlq') as { count: number };
    return row.count;
  }

  /** Reset a DLQ event back to pending: status→pending, retry_count→0, last_error→NULL, dlq_at→NULL */
  resetDlqEvent(id: string): void {
    this.stmt(
      'UPDATE events SET status = ?, retry_count = 0, last_error = NULL, dlq_at = NULL, updated_at = ? WHERE id = ?'
    ).run('pending', new Date().toISOString(), id);
  }

  /** Purge DLQ events with created_at <= cutoff (inclusive). Returns count deleted. */
  purgeDlqEvents(cutoff: string): number {
    const result = this.stmt(
      'DELETE FROM events WHERE status = ? AND created_at <= ?'
    ).run('dlq', cutoff);
    return result.changes;
  }

  // --- Subscription CRUD ---

  insertSubscription(params: InsertSubscriptionParams): void {
    this.stmt(
      'INSERT INTO subscriptions (id, event_type, created_at) VALUES (?, ?, ?)'
    ).run(params.id, params.eventType, params.createdAt);
  }

  getSubscription(id: string): SubscriptionRowDb | undefined {
    return this.stmt('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRowDb | undefined;
  }

  deleteSubscription(id: string): void {
    this.stmt('DELETE FROM subscriptions WHERE id = ?').run(id);
  }

  getAllSubscriptions(): SubscriptionRowDb[] {
    return this.stmt('SELECT * FROM subscriptions').all() as SubscriptionRowDb[];
  }

  /** Execute raw SQL with params (for testing) */
  rawExec(sql: string, ...params: unknown[]): void {
    this.stmt(sql).run(...params);
  }

  // --- Lifecycle ---

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    this.db.close();
  }
}
