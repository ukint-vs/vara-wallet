import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getConfigDir } from './config';
import { verbose } from '../utils';

let db: Database.Database | null = null;

const DEFAULT_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface EventRow {
  id: number;
  type: string;
  event_id: string | null;
  data: string;
  block_number: number | null;
  block_hash: string | null;
  source: string | null;
  destination: string | null;
  program_id: string | null;
  created_at: number;
}

export interface EventInsert {
  type: string;
  event_id?: string;
  data: Record<string, unknown>;
  block_number?: number;
  block_hash?: string;
  source?: string;
  destination?: string;
  program_id?: string;
}

export interface EventQueryFilters {
  type?: string;
  since?: number; // Unix ms timestamp
  program?: string;
  destination?: string;
  limit?: number;
}

export function initEventStore(): void {
  if (db) return;

  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const dbPath = path.join(configDir, 'events.db');
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        event_id TEXT,
        data TEXT NOT NULL,
        block_number INTEGER,
        block_hash TEXT,
        source TEXT,
        destination TEXT,
        program_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
      CREATE INDEX IF NOT EXISTS idx_events_destination ON events(destination);
      CREATE INDEX IF NOT EXISTS idx_events_program_id ON events(program_id);
    `);

    // Auto-prune old events on startup
    pruneEvents(DEFAULT_PRUNE_AGE_MS);

    verbose(`Event store initialized at ${dbPath}`);
  } catch (err) {
    verbose(`Warning: Failed to initialize event store: ${err instanceof Error ? err.message : String(err)}`);
    db = null;
  }
}

export function insertEvent(event: EventInsert): void {
  if (!db) return;

  try {
    const stmt = db.prepare(`
      INSERT INTO events (type, event_id, data, block_number, block_hash, source, destination, program_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.type,
      event.event_id ?? null,
      JSON.stringify(event.data),
      event.block_number ?? null,
      event.block_hash ?? null,
      event.source ?? null,
      event.destination ?? null,
      event.program_id ?? null,
      Date.now(),
    );
  } catch (err) {
    verbose(`Warning: Failed to persist event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function queryMailbox(filters?: { since?: number; limit?: number }): EventRow[] {
  if (!db) return [];

  const conditions = ['type = ?'];
  const params: unknown[] = ['mailbox'];

  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const limit = filters?.limit ?? 50;
  const sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as EventRow[];
}

export function queryEvents(filters?: EventQueryFilters): EventRow[] {
  if (!db) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters?.program) {
    conditions.push('program_id = ?');
    params.push(filters.program);
  }
  if (filters?.destination) {
    conditions.push('destination = ?');
    params.push(filters.destination);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const sql = `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as EventRow[];
}

export function readEvent(eventId: string): EventRow | undefined {
  if (!db) return undefined;
  return db.prepare('SELECT * FROM events WHERE event_id = ? ORDER BY created_at DESC LIMIT 1').get(eventId) as EventRow | undefined;
}

export function pruneEvents(olderThanMs: number): number {
  if (!db) return 0;

  const cutoff = Date.now() - olderThanMs;
  const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) {
    verbose(`Pruned ${result.changes} events older than ${Math.round(olderThanMs / (1000 * 60 * 60))}h`);
  }
  return result.changes;
}

export function closeEventStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
    db = null;
  }
}
