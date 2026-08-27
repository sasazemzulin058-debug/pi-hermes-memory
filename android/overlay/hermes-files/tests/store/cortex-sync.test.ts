import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncToCortex } from '../../src/cortex-sync.js';

describe('syncToCortex', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('is a no-op when the vault path does not exist', () => {
    const missing = path.join(vault, 'does-not-exist');
    // Must not throw and must not create anything.
    assert.doesNotThrow(() => syncToCortex(missing, 'a fact', 'memory', 'work'));
    assert.ok(!fs.existsSync(missing));
  });

  it('creates a new concept page under 20-Wiki/concepts for a memory target', () => {
    syncToCortex(vault, 'prefers pnpm over npm', 'memory', 'tooling');

    const page = path.join(vault, '20-Wiki', 'concepts', 'tooling.md');
    assert.ok(fs.existsSync(page), 'concept page should be created');
    const content = fs.readFileSync(page, 'utf-8');
    assert.ok(content.startsWith('---\n'), 'page should start with frontmatter');
    assert.ok(content.includes('type: "concept"'), 'frontmatter should tag type: concept');
    assert.ok(content.includes('source: "pi-hermes-memory"'));
    assert.ok(content.includes('# tooling'), 'page should have the concept heading');
    assert.ok(content.includes('prefers pnpm over npm'), 'page should contain the fact');
    assert.ok(content.includes('Memory note ('), 'page should contain a dated memory note');
  });

  it('creates a person page under 20-Wiki/persons for a user target', () => {
    syncToCortex(vault, 'lives in Sydney', 'user', 'profile');

    const page = path.join(vault, '20-Wiki', 'persons', 'profile.md');
    assert.ok(fs.existsSync(page), 'person page should be created');
    const content = fs.readFileSync(page, 'utf-8');
    assert.ok(content.includes('type: "person"'), 'frontmatter should tag type: person');
    assert.ok(content.includes('lives in Sydney'));
  });

  it('appends a new memory note when the page already exists', () => {
    syncToCortex(vault, 'first fact', 'memory', 'tooling');
    syncToCortex(vault, 'second fact', 'memory', 'tooling');

    const page = path.join(vault, '20-Wiki', 'concepts', 'tooling.md');
    const content = fs.readFileSync(page, 'utf-8');
    assert.ok(content.includes('first fact'));
    assert.ok(content.includes('second fact'));
    // Two appended notes => two "Memory note" markers.
    const noteCount = (content.match(/Memory note \(/g) || []).length;
    assert.strictEqual(noteCount, 2, 'should append a note for each sync, not overwrite');
  });

  it('defaults the concept to "general" when no domain is given', () => {
    syncToCortex(vault, 'a general fact', 'memory');

    const page = path.join(vault, '20-Wiki', 'concepts', 'general.md');
    assert.ok(fs.existsSync(page), 'general concept page should be created');
    assert.ok(fs.readFileSync(page, 'utf-8').includes('a general fact'));
  });

  it('slugifies the domain for the filename', () => {
    syncToCortex(vault, 'fact', 'memory', 'Continuous Integration');
    assert.ok(fs.existsSync(path.join(vault, '20-Wiki', 'concepts', 'continuous-integration.md')));
  });
});