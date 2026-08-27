import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import BetterDatabase from 'better-sqlite3';

const isBunRuntime: boolean =
  typeof process !== 'undefined' && !!(process as unknown as { versions?: { bun?: string } }).versions?.bun;

type BunStatementHandle = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

type BunDbHandle = {
  query(sql: string): BunStatementHandle;
  prepare?(sql: string): BunStatementHandle;
  exec(sql: string): void;
  transaction<T>(fn: T): T;
  close(): void;
};

let BunDatabaseCtor: (new (path: string) => BunDbHandle) | null = null;
if (isBunRuntime) {
  try {
    const require = createRequire(import.meta.url);
    const bunSqlite = require('bun:sqlite') as { Database: new (path: string) => BunDbHandle };
    BunDatabaseCtor = bunSqlite.Database;
  } catch {
    BunDatabaseCtor = null;
  }
}
const useBun: boolean = isBunRuntime && BunDatabaseCtor !== null;

class BunStatementWrapper {
  constructor(private readonly stmt: BunStatementHandle, private readonly db: BunDbHandle) {}
  get(...params: unknown[]): unknown {
    const r = this.stmt.get(...params);
    return r === null ? undefined : r;
  }
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const res = this.stmt.run(...params);
    // Bun's `changes` counts FTS trigger writes (often 7); better-sqlite3 uses sqlite3_changes()
    // which excludes trigger effects. Normalize by reading `SELECT changes()`.
    try {
      const row = this.db.query('SELECT changes() as c').get() as { c: number } | undefined;
      if (row && typeof row.c === 'number') {
        return { changes: row.c, lastInsertRowid: res.lastInsertRowid };
      }
    } catch {
      // best-effort fallback to Bun's original
    }
    return res;
  }
}
class BunDatabaseWrapper {
  constructor(private readonly db: BunDbHandle) {}
  prepare(sql: string): BunStatementWrapper {
    const stmt = typeof this.db.query === 'function' ? this.db.query(sql) : (this.db.prepare as (sql: string) => BunStatementHandle)(sql);
    return new BunStatementWrapper(stmt, this.db);
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  pragma(source: string, opts?: { simple?: boolean }): unknown {
    const trimmed = source.trim();
    if (trimmed.includes('=')) {
      this.db.exec(`PRAGMA ${trimmed}`);
      return undefined;
    }
    const rows = this.db.query(`PRAGMA ${trimmed}`).all() as Record<string, unknown>[];
    if (opts?.simple) {
      if (rows.length === 0) return undefined;
      return Object.values(rows[0])[0];
    }
    return rows;
  }
  transaction<T>(fn: T): T {
    return this.db.transaction(fn);
  }
  close(): void {
    this.db.close();
  }
}

export interface HermesDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } };
  exec(sql: string): void;
  pragma(source: string, opts?: { simple?: boolean }): unknown;
  transaction<T>(fn: T): T;
  close(): void;
}

export class DatabaseManager {
  private db: HermesDatabase | null = null;
  private readonly dbPath: string;
  constructor(memoryDir: string) {
    this.dbPath = path.join(memoryDir, 'sessions.db');
  }
  getDb(): HermesDatabase {
    if (!this.db) {
      this.db = this.open();
    }
    return this.db;
  }
  private open(): HermesDatabase {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db: HermesDatabase = useBun
      ? new BunDatabaseWrapper(new (BunDatabaseCtor as new (p: string) => BunDbHandle)(this.dbPath))
      : (new (BetterDatabase as unknown as new (p: string) => HermesDatabase)(this.dbPath) as HermesDatabase);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 100');
    db.pragma('journal_size_limit = 5242880');
    db.pragma('foreign_keys = ON');
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacyMemoriesCategoryError(err)) {
        throw err;
      }
      this.ensureMemoriesColumns(db);
      db.exec(SCHEMA_SQL);
    }
    this.ensureMemoriesColumns(db);
    return db;
  }
  private isLegacyMemoriesCategoryError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category') || msg.includes('memories(category)');
  }
  private ensureMemoriesColumns(db: HermesDatabase): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;
    const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));
    if (!names.has('category')) {
      db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    }
    if (!names.has('failure_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN failure_reason TEXT');
    }
    if (!names.has('tool_state')) {
      db.exec('ALTER TABLE memories ADD COLUMN tool_state TEXT');
    }
    if (!names.has('corrected_to')) {
      db.exec('ALTER TABLE memories ADD COLUMN corrected_to TEXT');
    }
  }
  close(): void {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      this.db.close();
      this.db = null;
    }
  }
  getPath(): string {
    return this.dbPath;
  }
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }
  getStats(): { sessions: number; messages: number; memories: number } {
    const db = this.getDb();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    return {
      sessions: sessions.count,
      messages: messages.count,
      memories: memories.count,
    };
  }
}
