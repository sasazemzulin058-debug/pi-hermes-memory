import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFts5Query, buildFallbackFts5Query, isFts5QueryError } from '../../src/store/fts-query.js';

describe('normalizeFts5Query', () => {
  it('returns empty string for empty/whitespace input', () => {
    assert.equal(normalizeFts5Query(''), '');
    assert.equal(normalizeFts5Query('   '), '');
  });

  it('wraps a single term in quotes', () => {
    assert.equal(normalizeFts5Query('pnpm'), '"pnpm"');
  });

  it('tokenizes a multi-word query into per-term quoted AND', () => {
    // "gpu issue" (no quotes in input) becomes "gpu" "issue" — implicit AND
    assert.equal(normalizeFts5Query('gpu issue'), '"gpu" "issue"');
  });

  it('drops natural-language connectors in natural-language mode', () => {
    assert.equal(normalizeFts5Query('memory and search'), '"memory" "search"');
    assert.equal(normalizeFts5Query('gpu or timeout'), '"gpu" "timeout"');
  });

  it('preserves an explicit quoted phrase as one term', () => {
    assert.equal(normalizeFts5Query('"memory search"'), '"memory search"');
    // Mixed phrase + term
    assert.equal(normalizeFts5Query('"memory search" fallback'), '"memory search" "fallback"');
  });

  it('passes through raw uppercase FTS5 operators untouched', () => {
    assert.equal(normalizeFts5Query('gpu OR timeout'), 'gpu OR timeout');
    assert.equal(normalizeFts5Query('pnpm AND yarn'), 'pnpm AND yarn');
  });

  it('treats an embedded double quote as a phrase delimiter', () => {
    // say "hi" — the " starts a quoted phrase, so this becomes two terms
    assert.equal(normalizeFts5Query('say "hi"'), '"say" "hi"');
  });

  it('preserves apostrophes inside a word', () => {
    assert.equal(normalizeFts5Query("O'Brien"), '"O\'Brien"');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeFts5Query('  gpu issue  '), '"gpu" "issue"');
  });
});

describe('buildFallbackFts5Query', () => {
  it('returns null for empty input', () => {
    assert.equal(buildFallbackFts5Query(''), null);
    assert.equal(buildFallbackFts5Query('   '), null);
  });

  it('returns null for explicit operator queries', () => {
    assert.equal(buildFallbackFts5Query('gpu OR timeout'), null);
  });

  it('returns null for a single term (no broader query possible)', () => {
    assert.equal(buildFallbackFts5Query('pnpm'), null);
  });

  it('joins multi-term natural-language queries with OR', () => {
    assert.equal(buildFallbackFts5Query('gpu issue'), '"gpu" OR "issue"');
  });

  it('drops connectors when building the fallback', () => {
    assert.equal(buildFallbackFts5Query('memory and search'), '"memory" OR "search"');
  });

  it('differs from the strict AND query for multi-term input', () => {
    const strict = normalizeFts5Query('gpu timeout issue');
    const fallback = buildFallbackFts5Query('gpu timeout issue');
    assert.ok(fallback);
    assert.notEqual(strict, fallback);
  });
});

describe('isFts5QueryError', () => {
  it('recognizes FTS5 syntax errors', () => {
    assert.ok(isFts5QueryError(new Error('FTS5: syntax error near "AND"')));
  });

  it('recognizes unterminated string errors', () => {
    assert.ok(isFts5QueryError(new Error('unterminated string')));
  });

  it('returns false for non-FTS errors', () => {
    assert.ok(!isFts5QueryError(new Error('no such table: memories')));
    assert.ok(!isFts5QueryError('not an error object'));
    assert.ok(!isFts5QueryError(null));
  });
});