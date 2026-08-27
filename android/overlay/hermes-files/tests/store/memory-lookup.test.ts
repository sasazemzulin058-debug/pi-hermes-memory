import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryLookupText, memoryLookupCandidates } from '../../src/store/memory-lookup.js';

describe('normalizeMemoryLookupText', () => {
  it('returns empty string for empty/whitespace input', () => {
    assert.equal(normalizeMemoryLookupText(''), '');
    assert.equal(normalizeMemoryLookupText('   '), '');
    assert.equal(normalizeMemoryLookupText('\n\n'), '');
  });

  it('leaves plain entry text unchanged', () => {
    assert.equal(normalizeMemoryLookupText('prefers pnpm over npm'), 'prefers pnpm over npm');
  });

  it('strips a leading emoji + scope tag from a memory_search line', () => {
    assert.equal(
      normalizeMemoryLookupText('🧠 [global] prefers pnpm over npm'),
      'prefers pnpm over npm'
    );
  });

  it('strips the user-profile emoji + scope tag', () => {
    assert.equal(
      normalizeMemoryLookupText('👤 [global] lives in Sydney'),
      'lives in Sydney'
    );
  });

  it('strips a failure/warning emoji + tag', () => {
    assert.equal(
      normalizeMemoryLookupText('⚠️ [global] retry with --force'),
      'retry with --force'
    );
  });

  it('collapses a doubled leading tag when an emoji+scope prefix was stripped first', () => {
    // Realistic render: emoji + scope, then a doubled category tag.
    assert.equal(
      normalizeMemoryLookupText('⚠️ [global] [correction] [correction] retry with --force'),
      '[correction] retry with --force'
    );
  });

  it('strips both tags when a doubled leading tag has no emoji prefix', () => {
    // Without an emoji+scope prefix, the first regex eats both bracketed tags.
    // The result is still a substring of the stored entry, so remove/replace match.
    assert.equal(
      normalizeMemoryLookupText('[correction] [correction] retry with --force'),
      'retry with --force'
    );
  });

  it('collapses to the first non-empty line for multi-line pastes', () => {
    const pasted = '🧠 [global] prefers pnpm over npm\n\n  (other context lines)';
    assert.equal(normalizeMemoryLookupText(pasted), 'prefers pnpm over npm');
  });

  it('does not strip a leading word without a bracketed scope tag', () => {
    // No bracketed scope tag → the prefix-stripping regex must not fire
    assert.equal(normalizeMemoryLookupText('user prefers vim'), 'user prefers vim');
  });

  it('returns empty for whitespace-only after trimming', () => {
    assert.equal(normalizeMemoryLookupText('   \n\t  '), '');
  });
});

describe('memoryLookupCandidates', () => {
  it('returns an empty array for empty/whitespace input', () => {
    assert.deepEqual(memoryLookupCandidates(''), []);
    assert.deepEqual(memoryLookupCandidates('   '), []);
  });

  it('returns the normalized line as the sole candidate when there is no leading [category] tag', () => {
    assert.deepEqual(
      memoryLookupCandidates('🧠 [global] prefers pnpm over npm'),
      ['prefers pnpm over npm'],
    );
  });

  it('adds a second candidate with the leading [category] tag stripped (memory/user target)', () => {
    // memory_search renders `🧠 [global] [tool-quirk] <content>` for a memory
    // entry that carries a category. The flat-file body has no [tool-quirk], so
    // the primary candidate won't match — the stripped candidate must.
    const cands = memoryLookupCandidates('🧠 [global] [tool-quirk] Pi sandbox quirks');
    assert.equal(cands[0], '[tool-quirk] Pi sandbox quirks');
    assert.equal(cands[1], 'Pi sandbox quirks');
  });

  it('keeps the [category] tag on the primary candidate for failure entries', () => {
    // Failure bodies DO store the [category] tag, so the primary candidate
    // (with the tag) matches; the stripped form is offered only as a fallback.
    const cands = memoryLookupCandidates('⚠️ [global] [correction] retry with --force');
    assert.equal(cands[0], '[correction] retry with --force');
    assert.ok(cands.includes('retry with --force'));
  });
});