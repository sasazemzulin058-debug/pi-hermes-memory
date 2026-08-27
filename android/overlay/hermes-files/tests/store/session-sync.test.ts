/**
 * Tests for session-sync.ts — disk/DB reconciliation and pruning.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseManager } from "../../src/store/db.js";
import {
  syncAllSessions,
  pruneOldSessions,
  pruneOldMemories,
} from "../../src/store/session-sync.js";

describe("session-sync", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Helpers ──

  function createJsonlFile(fileName: string, entries: unknown[]) {
    const projDir = path.join(sessionsDir, "test-project");
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, fileName), entries.map((e) => JSON.stringify(e)).join("\n"));
  }

  function makeSessionEntry(id: string, timestamp: string): Record<string, unknown> {
    return {
      type: "session",
      id,
      timestamp,
      cwd: "/test",
    };
  }

  function makeMessageEntry(id: string, timestamp: string, role: string, text: string): Record<string, unknown> {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp,
      message: {
        role,
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    };
  }

  // ── pruneOldSessions ──

  describe("pruneOldSessions", () => {
    it("should delete sessions older than retention days", () => {
      const db = dbManager.getDb();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1);

      db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)")
        .run("old-session", "test", "/test", oldDate.toISOString());
      db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)")
        .run("recent-session", "test", "/test", recentDate.toISOString());

      const deleted = pruneOldSessions(dbManager, 90);
      assert.strictEqual(deleted, 1);

      const remaining = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].id, "recent-session");
    });

    it("should do nothing when retentionDays is 0", () => {
      const db = dbManager.getDb();
      db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)")
        .run("session-1", "test", "/test", "2020-01-01T00:00:00Z");

      const deleted = pruneOldSessions(dbManager, 0);
      assert.strictEqual(deleted, 0);
    });
  });

  // ── pruneOldMemories ──

  describe("pruneOldMemories", () => {
    it("should delete memories older than retention days", () => {
      const db = dbManager.getDb();
      db.prepare(
        "INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)",
      ).run(null, "memory", "old entry", "2020-01-01", "2020-01-01");
      db.prepare(
        "INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)",
      ).run(null, "memory", "recent entry", new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));

      const deleted = pruneOldMemories(dbManager, 30);
      assert.strictEqual(deleted, 1);

      const remaining = db.prepare("SELECT content FROM memories").all() as Array<{ content: string }>;
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].content, "recent entry");
    });

    it("should do nothing when retentionDays is 0", () => {
      const db = dbManager.getDb();
      db.prepare(
        "INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)",
      ).run(null, "memory", "entry", "2020-01-01", "2020-01-01");

      const deleted = pruneOldMemories(dbManager, 0);
      assert.strictEqual(deleted, 0);
    });
  });

  // ── syncAllSessions ──

  describe("syncAllSessions", () => {
    it("should index new sessions from disk", () => {
      createJsonlFile("new.jsonl", [
        makeSessionEntry("session-new", new Date().toISOString()),
        makeMessageEntry("m1", new Date().toISOString(), "user", "hello"),
      ]);

      const result = syncAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.indexed, 1);
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.orphanedDeleted, 0);
      assert.strictEqual(result.oldDeleted, 0);

      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 1);
      assert.strictEqual(stats.messages, 1);
    });

    it("should skip sessions already in DB", () => {
      createJsonlFile("dup.jsonl", [
        makeSessionEntry("session-dup", new Date().toISOString()),
        makeMessageEntry("m1", new Date().toISOString(), "user", "hello"),
      ]);

      // First pass
      syncAllSessions(dbManager, sessionsDir);
      // Second pass
      const result = syncAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.indexed, 0);
      assert.strictEqual(result.skipped, 1);
    });

    it("should delete orphaned sessions (in DB but no file)", () => {
      // Seed DB with a session whose file no longer exists
      const db = dbManager.getDb();
      db.prepare("INSERT INTO sessions (id, project, cwd, started_at, message_count) VALUES (?, ?, ?, ?, ?)")
        .run("orphan-1", "test", "/test", new Date().toISOString(), 0);

      const result = syncAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.orphanedDeleted, 1);
      assert.strictEqual(result.indexed, 0);

      const remaining = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
      assert.strictEqual(remaining.length, 0);
    });

    it("should prune old sessions", () => {
      createJsonlFile("keep.jsonl", [
        makeSessionEntry("session-keep", new Date().toISOString()),
        makeMessageEntry("m1", new Date().toISOString(), "user", "hello"),
      ]);

      // Seed DB with old session (no corresponding file on disk)
      const db = dbManager.getDb();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      db.prepare("INSERT INTO sessions (id, project, cwd, started_at, message_count) VALUES (?, ?, ?, ?, ?)")
        .run("session-old", "test", "/test", oldDate.toISOString(), 0);

      const result = syncAllSessions(dbManager, sessionsDir, { retentionDays: 90 });
      assert.strictEqual(result.oldDeleted, 1);
      assert.strictEqual(result.orphanedDeleted, 0); // old session is already gone
      assert.strictEqual(result.indexed, 1);
    });

    it("should handle empty sessions directory", () => {
      const result = syncAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.indexed, 0);
      assert.strictEqual(result.orphanedDeleted, 0);
      assert.strictEqual(result.oldDeleted, 0);
    });

    it("should handle missing sessions directory", () => {
      const result = syncAllSessions(dbManager, path.join(sessionsDir, "nonexistent"));
      assert.strictEqual(result.indexed, 0);
      assert.strictEqual(result.orphanedDeleted, 0);
      assert.strictEqual(result.oldDeleted, 0);
    });

    it("should propagate errors for malformed files", () => {
      const projDir = path.join(sessionsDir, "test-project");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "bad.jsonl"), "not-json");

      const result = syncAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.indexed, 0);
      assert.ok(result.errors.length > 0); // parse error reported
    });
  });
});
