/**
 * vsix-guard.test.ts — pure packaging-guard logic (size cap + contamination).
 */

import * as assert from 'assert';
import {
  evaluateVsix,
  formatBytes,
  DEFAULT_MAX_BYTES,
  DEFAULT_FORBIDDEN_PREFIXES,
} from '../packaging/vsixGuard';

const MB = 1024 * 1024;

suite('vsixGuard — evaluateVsix', () => {
  test('a clean, small artifact passes', () => {
    const r = evaluateVsix({
      sizeBytes: 1.5 * MB,
      entryNames: ['extension/out/extension.js', 'extension/package.json', 'extension/README.md'],
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reasons.length, 0);
    assert.strictEqual(r.offenders.length, 0);
  });

  test('a legitimate CI-sized artifact (~4.5 MB) is under the default cap', () => {
    const r = evaluateVsix({ sizeBytes: 4.5 * MB, entryNames: ['extension/out/extension.js'] });
    assert.strictEqual(r.ok, true);
  });

  test('over the size cap fails with a size reason', () => {
    const r = evaluateVsix({ sizeBytes: 680 * MB, entryNames: ['extension/out/extension.js'] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reasons.length, 1);
    assert.match(r.reasons[0], /exceeds the .* cap/);
  });

  test('contamination by a scratch path fails with the offending prefix', () => {
    const r = evaluateVsix({
      sizeBytes: 2 * MB,
      entryNames: ['extension/out/extension.js', 'extension/research/notes.md'],
    });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.offenders, ['extension/research/']);
    assert.match(r.reasons[0], /scratch\/never-ship paths/);
  });

  test('size and contamination both reported (one reason each)', () => {
    const r = evaluateVsix({
      sizeBytes: 700 * MB,
      entryNames: ['extension/research/big.bin', 'extension/semantic-review/x.json'],
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reasons.length, 2);
    assert.strictEqual(r.offenders.length, 2);
  });

  test('every default forbidden prefix is detected', () => {
    for (const p of DEFAULT_FORBIDDEN_PREFIXES) {
      const r = evaluateVsix({ sizeBytes: 1 * MB, entryNames: [`${p}something`] });
      assert.strictEqual(r.ok, false, `expected ${p} to be flagged`);
      assert.ok(r.offenders.includes(p));
    }
  });

  test('a path that merely contains a forbidden word but is not under it passes', () => {
    // `src/research-helper.ts` is fine; only the `research/` directory is scratch.
    const r = evaluateVsix({
      sizeBytes: 1 * MB,
      entryNames: ['extension/out/intelligence/researchSources.js'],
    });
    assert.strictEqual(r.ok, true);
  });

  test('custom cap is respected', () => {
    const r = evaluateVsix({ sizeBytes: 5 * MB, entryNames: [], maxBytes: 4 * MB });
    assert.strictEqual(r.ok, false);
  });

  test('default cap is 20 MB', () => {
    assert.strictEqual(DEFAULT_MAX_BYTES, 20 * MB);
  });
});

suite('vsixGuard — formatBytes', () => {
  test('formats common magnitudes', () => {
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1024), '1 KB');
    assert.strictEqual(formatBytes(1.5 * MB), '1.5 MB');
    assert.strictEqual(formatBytes(20 * MB), '20 MB');
  });
});
