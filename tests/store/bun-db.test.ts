import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseManager } from '../../src/store/db.js';

describe('DatabaseManager on Bun', () => {
  it('opens and queries SQLite through Bun native database', () => {
    if (!process.versions.bun) {
      console.log('Skipping Bun-only test under Node');
      return;
    }
    const base = path.join(process.env.HOME ?? os.tmpdir(), '.cache');
    const tmpDir = fs.mkdtempSync(path.join(base, 'hermes-bun-db-'));
    const manager = new DatabaseManager(tmpDir);

    try {
      const db = manager.getDb();

      // basic query + pragma
      assert.deepStrictEqual(db.prepare('SELECT 1 AS ok').get(), { ok: 1 });
      assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);

      // schema — tables created by SCHEMA_SQL
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const names = tables.map((t) => t.name);
      assert.ok(names.includes('sessions'), `sessions table missing: ${names.join(',')}`);
      assert.ok(names.includes('messages'), `messages table missing: ${names.join(',')}`);
      assert.ok(names.includes('memories'), `memories table missing: ${names.join(',')}`);

      // pragma driven by DatabaseManager.open() is effective for file DB
      const journalMode = db.pragma('journal_mode', { simple: true }) as string;
      assert.ok(typeof journalMode === 'string' && journalMode.length > 0, 'journal_mode pragma should return string');

      // one insert/select through DatabaseManager — prepared statement contract
      const today = new Date().toISOString().split('T')[0];
      const res = db.prepare('INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)').run(null, 'memory', 'bun-test-content', today, today);
      assert.strictEqual(res.changes, 1);
      assert.ok(Number(res.lastInsertRowid) > 0, `lastInsertRowid should be >0 got ${String(res.lastInsertRowid)}`);

      const row = db.prepare('SELECT content, target FROM memories WHERE content = ?').get('bun-test-content') as { content: string; target: string } | undefined;
      assert.strictEqual(row?.content, 'bun-test-content');
      assert.strictEqual(row?.target, 'memory');

      // missing row returns undefined (bun:sqlite null -> undefined mapping)
      assert.strictEqual(db.prepare('SELECT content FROM memories WHERE content = ?').get('no-such'), undefined);

      // transaction callback preserves call signatures/results
      const insertMem = db.prepare('INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)');
      const insertMany = db.transaction((items: string[]) => {
        for (const it of items) insertMem.run(null, 'memory', it, today, today);
      });
      insertMany(['tx-a', 'tx-b']);
      const cnt = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
      assert.strictEqual(cnt.c, 3);

      // exec path + all()
      db.exec("DELETE FROM memories WHERE content = 'tx-a'");
      const remaining = db.prepare('SELECT content FROM memories ORDER BY content').all() as { content: string }[];
      assert.deepStrictEqual(remaining.map((r) => r.content), ['bun-test-content', 'tx-b']);

      // file creation side-effect of open()
      assert.ok(fs.existsSync(path.join(tmpDir, 'sessions.db')));
    } finally {
      manager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
