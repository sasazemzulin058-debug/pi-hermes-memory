/**
 * Session sync — reconcile disk sessions with the SQLite database.
 *
 * Operations:
 * 1. Index new sessions (on disk but not in DB)
 * 2. Delete orphaned sessions (in DB but no file on disk)
 * 3. Delete old sessions (started_at older than retention threshold)
 */

import { DatabaseManager } from "./db.js";
import { indexSession } from "./session-indexer.js";
import { getSessionFiles, parseSessionFile } from "./session-parser.js";

export interface SyncResult {
  /** Newly indexed from disk */
  indexed: number;
  /** Already in DB, skipped */
  skipped: number;
  /** Deleted from DB (file gone on disk) */
  orphanedDeleted: number;
  /** Deleted from DB (older than retention threshold) */
  oldDeleted: number;
  /** Memory entries deleted from age pruning */
  memoriesDeleted: number;
  /** Errors encountered */
  errors: string[];
}

/**
 * Prune sessions older than the retention threshold.
 *
 * @returns Number of sessions deleted
 */
export function pruneOldSessions(
  dbManager: DatabaseManager,
  retentionDays: number,
): number {
  if (retentionDays <= 0) return 0;
  const db = dbManager.getDb();
  const result = db
    .prepare("DELETE FROM sessions WHERE started_at < date('now', ?)")
    .run(`-${retentionDays} days`);
  return result.changes;
}

/**
 * Prune memories older than the retention threshold.
 *
 * @returns Number of memory entries deleted
 */
export function pruneOldMemories(
  dbManager: DatabaseManager,
  retentionDays: number,
): number {
  if (retentionDays <= 0) return 0;
  const db = dbManager.getDb();
  const result = db
    .prepare("DELETE FROM memories WHERE created < date('now', ?)")
    .run(`-${retentionDays} days`);
  return result.changes;
}

/**
 * Reconcile disk sessions with the database.
 *
 * Scans the sessions directory, compares with DB contents, and performs
 * all three operations: indexing new, removing orphaned, and pruning old.
 */
export function syncAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: { retentionDays?: number; memoryRetentionDays?: number } = {},
): SyncResult {
  const result: SyncResult = {
    indexed: 0,
    skipped: 0,
    orphanedDeleted: 0,
    oldDeleted: 0,
    memoriesDeleted: 0,
    errors: [],
  };

  const retentionDays = options.retentionDays ?? 90;
  const memoryRetentionDays = options.memoryRetentionDays ?? 0; // disabled by default

  // ── Step 1: Scan disk ──
  const diskSessionMap = new Map<string, string>(); // id -> filePath
  const diskFiles = getSessionFiles(sessionsDir);
  for (const filePath of diskFiles) {
    try {
      const session = parseSessionFile(filePath);
      if (session) {
        diskSessionMap.set(session.id, filePath);
      } else {
        result.errors.push(`No session entry found in: ${filePath}`);
      }
    } catch (err) {
      result.errors.push(
        `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Step 2: Prune old sessions (by started_at) ──
  result.oldDeleted = pruneOldSessions(dbManager, retentionDays);

  // ── Step 3: Get remaining DB sessions ──
  const db = dbManager.getDb();
  const dbRows = db
    .prepare("SELECT id, started_at FROM sessions")
    .all() as Array<{ id: string; started_at: string }>;

  // ── Step 4: Delete orphaned (DB has, disk doesn't) ──
  for (const row of dbRows) {
    if (!diskSessionMap.has(row.id)) {
      try {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
        result.orphanedDeleted++;
      } catch (err) {
        result.errors.push(
          `Failed to delete orphaned session ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Step 5: Index new sessions (disk has, DB doesn't) ──
  // Re-fetch DB IDs after deletions
  const dbIds = new Set<string>();
  const refreshedRows = db
    .prepare("SELECT id FROM sessions")
    .all() as Array<{ id: string }>;
  for (const row of refreshedRows) {
    dbIds.add(row.id);
  }

  for (const [id, filePath] of diskSessionMap) {
    if (dbIds.has(id)) {
      result.skipped++;
      continue;
    }
    try {
      const session = parseSessionFile(filePath);
      if (session) {
        indexSession(dbManager, session);
        result.indexed++;
      }
    } catch (err) {
      result.errors.push(
        `Failed to index ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Step 6: Prune old memories ──
  result.memoriesDeleted = pruneOldMemories(dbManager, memoryRetentionDays);

  return result;
}
