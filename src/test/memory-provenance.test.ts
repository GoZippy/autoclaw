/**
 * memory-provenance.test.ts — MEM-1 (V4_PLAN §P6).
 *
 * Provenance on memory writes: a distilled fact should carry *why we believe
 * it* ("a fact without provenance is a guess"; Fail → Investigate → Verify →
 * Distill → Consult). Every provenance field is optional and additive:
 *   (a) a fact written WITHOUT provenance serializes byte-identically to the
 *       pre-MEM-1 output and reads back as `unverified`;
 *   (b) a fact written WITH provenance round-trips method + evidence.
 */

import * as assert from 'assert';

import {
  createFact,
  isVerified,
  provenanceOf,
  type Provenance,
  type BitemporalFact,
} from '../memory/bitemporalFact';
import { extract, conflictResolve, type SessionTranscript } from '../skills/dream/pipeline';

// ---------------------------------------------------------------------------
// (a) backward-compatible: no provenance ⇒ unchanged output, reads unverified
// ---------------------------------------------------------------------------

suite('MEM-1 provenance — backward compatibility', () => {
  test('createFact without provenance omits verified_by entirely', () => {
    const f = createFact({ id: 'f1', subject: 's', content: 'c', recorded_at: '2026-01-01T00:00:00Z' });
    assert.strictEqual('verified_by' in f, false, 'verified_by must be absent, not undefined');
  });

  test('serialized output is byte-identical to the pre-MEM-1 shape', () => {
    const f = createFact({ id: 'f1', subject: 's', content: 'c', recorded_at: '2026-01-01T00:00:00Z' });
    const expected = JSON.stringify({
      id: 'f1',
      subject: 's',
      content: 'c',
      valid_from: '2026-01-01T00:00:00Z',
      valid_to: null,
      recorded_at: '2026-01-01T00:00:00Z',
      superseded_by: null,
      tier: 'recall',
    });
    assert.strictEqual(JSON.stringify(f), expected);
  });

  test('a fact without provenance reads back as unverified', () => {
    const f = createFact({ id: 'f1', subject: 's', content: 'c', recorded_at: '2026-01-01T00:00:00Z' });
    assert.strictEqual(isVerified(f), false);
    assert.deepStrictEqual(provenanceOf(f), { method: 'unverified' });
  });

  test('a fact whose verified_by is unverified is not "verified"', () => {
    const f = createFact({
      id: 'f1', subject: 's', content: 'c', recorded_at: '2026-01-01T00:00:00Z',
      verified_by: { method: 'unverified' },
    });
    assert.strictEqual(isVerified(f), false);
  });
});

// ---------------------------------------------------------------------------
// (b) provenance round-trips method + evidence through write → read → serialize
// ---------------------------------------------------------------------------

suite('MEM-1 provenance — round-trip', () => {
  test('createFact carries supplied provenance onto the fact', () => {
    const prov: Provenance = {
      method: 'command',
      evidence: 'npm run compile exited 0',
      verified_at: '2026-06-12T00:00:00Z',
    };
    const f = createFact({ id: 'f1', subject: 'build', content: 'compile passes', verified_by: prov });
    assert.deepStrictEqual(f.verified_by, prov);
    assert.strictEqual(isVerified(f), true);
    assert.strictEqual(provenanceOf(f).method, 'command');
  });

  test('provenance survives JSON serialize → parse', () => {
    const f = createFact({
      id: 'f1', subject: 'build', content: 'compile passes',
      verified_by: { method: 'tool_result', evidence: 'compile-task' },
    });
    const back = JSON.parse(JSON.stringify(f)) as BitemporalFact;
    assert.strictEqual(back.verified_by?.method, 'tool_result');
    assert.strictEqual(back.verified_by?.evidence, 'compile-task');
    assert.strictEqual(isVerified(back), true);
  });

  test('all five verification methods classify correctly', () => {
    const verified: Provenance['method'][] = ['session', 'tool_result', 'command', 'user'];
    for (const method of verified) {
      assert.strictEqual(isVerified({ verified_by: { method } }), true, `${method} is verified`);
    }
    assert.strictEqual(isVerified({ verified_by: { method: 'unverified' } }), false);
    assert.strictEqual(isVerified({}), false, 'absent ⇒ unverified');
  });
});

// ---------------------------------------------------------------------------
// dream pipeline — provenance is opt-in (default output unchanged)
// ---------------------------------------------------------------------------

suite('MEM-1 provenance — dream pipeline opt-in', () => {
  const transcript: SessionTranscript = {
    session_id: 'sess1',
    ended_at: '2026-05-20T12:00:00Z',
    text: 'FACT[build-command]: the build runs via npm run compile',
  };

  test('extract without the flag leaves candidates provenance-free', () => {
    const [c] = extract([transcript]);
    assert.strictEqual('verified_by' in c, false);
  });

  test('extract(withProvenance) stamps session provenance, threaded onto the fact', () => {
    const candidates = extract([transcript], true);
    assert.strictEqual(candidates[0].verified_by?.method, 'session');
    assert.strictEqual(candidates[0].verified_by?.evidence, 'session:sess1');

    const res = conflictResolve(candidates, []);
    assert.strictEqual(res.created[0].verified_by?.method, 'session');
    assert.strictEqual(isVerified(res.created[0]), true);
  });
});
