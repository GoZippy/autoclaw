/**
 * memory.test.ts — Unit tests for Sprint 3 WA-1 (Memory, Dream Pipeline &
 * Bi-temporal Facts): src/memory/** and src/skills/**.
 *
 * Tasks C2 (dream pipeline), C3 (memory tiers), C4 (bi-temporal facts).
 */

import * as assert from 'assert';

import {
  createFact,
  supersede,
  resolveChain,
  currentFact,
  buildTimeline,
  factAsOf,
  type BitemporalFact,
} from '../memory/bitemporalFact';
import {
  CORE_TIER_MAX_BYTES,
  coreTierFits,
  factBytes,
  planPromotions,
  applyTransitions,
  planCoreOverflow,
  defaultPromotionConfig,
  tierPath,
  type TierRecord,
} from '../memory/tiers';
import {
  extract,
  dedupe,
  conflictResolve,
  driftCheck,
  spider,
  preSummarize,
  selectMicroPr,
  runDreamPipeline,
  type SessionTranscript,
  type SourceFile,
} from '../skills/dream/pipeline';
import {
  recallQuery,
  recallAsOf,
  recallTimeline,
  recallCurrent,
  recallChain,
} from '../skills/recall/query';

// ---------------------------------------------------------------------------
// C4 — bi-temporal facts
// ---------------------------------------------------------------------------

suite('C4 bitemporalFact', () => {
  test('createFact defaults valid_from to recorded_at and leaves chain open', () => {
    const f = createFact({ id: 'f1', subject: 's', content: 'c', recorded_at: '2026-01-01T00:00:00Z' });
    assert.strictEqual(f.valid_from, '2026-01-01T00:00:00Z');
    assert.strictEqual(f.valid_to, null);
    assert.strictEqual(f.superseded_by, null);
    assert.strictEqual(f.tier, 'recall');
  });

  test('supersede closes predecessor window and links chain', () => {
    const a = createFact({ id: 'a', subject: 'build', content: 'use webpack', recorded_at: '2026-01-01T00:00:00Z' });
    const b = createFact({ id: 'b', subject: 'build', content: 'use esbuild', recorded_at: '2026-02-01T00:00:00Z' });
    const res = supersede(a, b);
    assert.strictEqual(res.superseded.superseded_by, 'b');
    assert.strictEqual(res.superseded.valid_to, '2026-02-01T00:00:00Z');
    assert.strictEqual(res.successor.id, 'b');
  });

  test('supersede rejects subject mismatch and double-supersession', () => {
    const a = createFact({ id: 'a', subject: 'x', content: 'c' });
    const b = createFact({ id: 'b', subject: 'y', content: 'c' });
    assert.throws(() => supersede(a, b), /subject mismatch/);
    const a2 = createFact({ id: 'a2', subject: 'x', content: 'c' });
    const c = createFact({ id: 'c', subject: 'x', content: 'c2' });
    const once = supersede(a2, c);
    assert.throws(() => supersede(once.superseded, c), /already superseded/);
  });

  test('resolveChain orders oldest to newest and detects cycles', () => {
    const a = { ...createFact({ id: 'a', subject: 's', content: '1' }), superseded_by: 'b' };
    const b = { ...createFact({ id: 'b', subject: 's', content: '2' }), superseded_by: 'c' };
    const c = createFact({ id: 'c', subject: 's', content: '3' });
    const chain = resolveChain([c, a, b], 'a');
    assert.deepStrictEqual(chain.map((f) => f.id), ['a', 'b', 'c']);

    const x = { ...createFact({ id: 'x', subject: 's', content: '1' }), superseded_by: 'y' };
    const y = { ...createFact({ id: 'y', subject: 's', content: '2' }), superseded_by: 'x' };
    assert.throws(() => resolveChain([x, y], 'x'), /cycle/);
  });

  test('currentFact returns the live head for a subject', () => {
    const a = { ...createFact({ id: 'a', subject: 's', content: '1' }), superseded_by: 'b' };
    const b = createFact({ id: 'b', subject: 's', content: '2', valid_from: '2026-03-01T00:00:00Z' });
    assert.strictEqual(currentFact([a, b], 's')?.id, 'b');
    assert.strictEqual(currentFact([a, b], 'unknown'), undefined);
  });

  test('buildTimeline orders facts and marks current', () => {
    const a = { ...createFact({ id: 'a', subject: 's', content: '1', valid_from: '2026-01-01T00:00:00Z' }), superseded_by: 'b', valid_to: '2026-02-01T00:00:00Z' };
    const b = createFact({ id: 'b', subject: 's', content: '2', valid_from: '2026-02-01T00:00:00Z' });
    const tl = buildTimeline([b, a], 's');
    assert.deepStrictEqual(tl.entries.map((e) => e.fact.id), ['a', 'b']);
    assert.strictEqual(tl.entries[0].isCurrent, false);
    assert.strictEqual(tl.entries[0].validUntil, '2026-02-01T00:00:00Z');
    assert.strictEqual(tl.entries[1].validUntil, 'open');
  });

  test('factAsOf answers bi-temporal point queries', () => {
    const a = { ...createFact({ id: 'a', subject: 's', content: 'old', valid_from: '2026-01-01T00:00:00Z', recorded_at: '2026-01-01T00:00:00Z' }), superseded_by: 'b', valid_to: '2026-03-01T00:00:00Z' };
    const b = createFact({ id: 'b', subject: 's', content: 'new', valid_from: '2026-03-01T00:00:00Z', recorded_at: '2026-03-01T00:00:00Z' });
    const facts = [a, b];
    // Valid in Feb -> old fact.
    assert.strictEqual(factAsOf(facts, 's', '2026-02-01T00:00:00Z')?.id, 'a');
    // Valid in April -> new fact.
    assert.strictEqual(factAsOf(facts, 's', '2026-04-01T00:00:00Z')?.id, 'b');
    // Valid in April but only knowing what we had by Feb -> still old fact.
    assert.strictEqual(factAsOf(facts, 's', '2026-04-01T00:00:00Z', '2026-02-15T00:00:00Z')?.id, 'a');
  });
});

// ---------------------------------------------------------------------------
// C3 — memory tiers
// ---------------------------------------------------------------------------

suite('C3 memory tiers', () => {
  test('tierPath forward-slashes and appends the tier dir', () => {
    assert.strictEqual(tierPath('C:\\repo\\.autoclaw\\memory\\', 'core'), 'C:/repo/.autoclaw/memory/core');
    assert.strictEqual(tierPath('/repo/.autoclaw/memory', 'archive'), '/repo/.autoclaw/memory/archive');
  });

  test('coreTierFits enforces the 10KB budget', () => {
    const small = [createFact({ id: 'a', subject: 's', content: 'x' })];
    assert.strictEqual(coreTierFits(small), true);
    const big = createFact({ id: 'b', subject: 's', content: 'y'.repeat(CORE_TIER_MAX_BYTES + 1) });
    assert.strictEqual(coreTierFits([big]), false);
    assert.ok(factBytes(big) > CORE_TIER_MAX_BYTES);
  });

  test('planPromotions: capture(core)->recall after a dream cycle', () => {
    const facts = [createFact({ id: 'f', subject: 's', content: 'c' })];
    const records: TierRecord[] = [
      { fact_id: 'f', tier: 'core', last_accessed_session: 1, entered_tier_session: 1 },
    ];
    const transitions = planPromotions(records, facts, defaultPromotionConfig(2));
    assert.strictEqual(transitions.length, 1);
    assert.strictEqual(transitions[0].to, 'recall');
  });

  test('planPromotions: recall->archive after N idle sessions', () => {
    const facts = [createFact({ id: 'f', subject: 's', content: 'c' })];
    const records: TierRecord[] = [
      { fact_id: 'f', tier: 'recall', last_accessed_session: 1, entered_tier_session: 1 },
    ];
    const cfg = { currentSession: 20, archiveAfterSessions: 8 };
    const transitions = planPromotions(records, facts, cfg);
    assert.strictEqual(transitions[0]?.to, 'archive');
  });

  test('planPromotions: superseded facts go straight to archive', () => {
    const facts: BitemporalFact[] = [
      { ...createFact({ id: 'f', subject: 's', content: 'c' }), superseded_by: 'g' },
    ];
    const records: TierRecord[] = [
      { fact_id: 'f', tier: 'recall', last_accessed_session: 20, entered_tier_session: 20 },
    ];
    const transitions = planPromotions(records, facts, defaultPromotionConfig(20));
    assert.strictEqual(transitions[0]?.to, 'archive');
    assert.match(transitions[0].because, /superseded/);
  });

  test('applyTransitions moves records and resets entered_tier_session', () => {
    const records: TierRecord[] = [
      { fact_id: 'f', tier: 'core', last_accessed_session: 1, entered_tier_session: 1 },
    ];
    const updated = applyTransitions(records, [{ fact_id: 'f', from: 'core', to: 'recall', because: 't' }], 5);
    assert.strictEqual(updated[0].tier, 'recall');
    assert.strictEqual(updated[0].entered_tier_session, 5);
  });

  test('planCoreOverflow evicts largest facts until core fits', () => {
    const big = createFact({ id: 'big', subject: 's', content: 'y'.repeat(CORE_TIER_MAX_BYTES) });
    const small = createFact({ id: 'small', subject: 's', content: 'tiny' });
    const transitions = planCoreOverflow([big, small]);
    assert.ok(transitions.length >= 1);
    assert.strictEqual(transitions[0].fact_id, 'big');
    assert.strictEqual(transitions[0].to, 'recall');
  });
});

// ---------------------------------------------------------------------------
// C2 — dream pipeline
// ---------------------------------------------------------------------------

suite('C2 dream pipeline', () => {
  const transcript: SessionTranscript = {
    session_id: 'sess1',
    ended_at: '2026-05-20T12:00:00Z',
    text: [
      'some chatter that should be ignored',
      'FACT[build-command]: the build runs via npm run compile',
      'NOTE: remember to bump the version before release',
      'more chatter',
    ].join('\n'),
  };

  test('extract pulls FACT[...] and NOTE: lines, ignores chatter', () => {
    const candidates = extract([transcript]);
    assert.strictEqual(candidates.length, 2);
    assert.strictEqual(candidates[0].subject, 'build-command');
    assert.strictEqual(candidates[0].recorded_at, '2026-05-20T12:00:00Z');
  });

  test('dedupe drops candidates already in memory and in-batch dups', () => {
    const candidates = extract([transcript, transcript]); // 4 candidates, 2 unique
    const existing = [createFact({ id: 'e', subject: 'build-command', content: 'the build runs via npm run compile' })];
    const out = dedupe(candidates, existing);
    assert.strictEqual(out.length, 1); // build-command known, only the NOTE survives
  });

  test('conflictResolve supersedes a contradicting existing fact', () => {
    const candidates = extract([transcript]);
    const existing = [createFact({ id: 'old', subject: 'build-command', content: 'the build runs via gulp', valid_from: '2026-01-01T00:00:00Z' })];
    const res = conflictResolve(candidates, existing);
    assert.strictEqual(res.superseded.length, 1);
    assert.strictEqual(res.successors.length, 1);
    assert.strictEqual(res.superseded[0].id, 'old');
  });

  test('conflictResolve creates fresh facts for unseen subjects', () => {
    const res = conflictResolve(extract([transcript]), []);
    assert.strictEqual(res.created.length, 2);
    assert.strictEqual(res.superseded.length, 0);
  });

  test('driftCheck flags broken file refs and renamed symbols', () => {
    const facts = [
      createFact({ id: 'd1', subject: 'src/gone.ts', content: 'logic lives in src/gone.ts and calls `oldFn`' }),
    ];
    const findings = driftCheck(facts, { files: ['src/here.ts'], symbols: ['newFn'] });
    const kinds = findings.map((f) => f.kind).sort();
    assert.deepStrictEqual(kinds, ['broken_file_ref', 'renamed_symbol']);
  });

  test('driftCheck ignores superseded facts', () => {
    const facts: BitemporalFact[] = [
      { ...createFact({ id: 'd', subject: 'src/gone.ts', content: 'in src/gone.ts' }), superseded_by: 'x' },
    ];
    assert.strictEqual(driftCheck(facts, { files: [], symbols: [] }).length, 0);
  });

  test('spider collects TODO-family markers and AI comments', () => {
    const files: SourceFile[] = [
      { path: 'src/a.ts', content: '// TODO: wire this up\n// AI: refactor the loop\ncode();\n// FIXME broken' },
    ];
    const items = spider(files);
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(items.map((i) => i.kind).sort(), ['AI', 'FIXME', 'TODO']);
  });

  test('preSummarize ranks files by open spider-item count', () => {
    const files: SourceFile[] = [
      { path: 'src/hot.ts', content: 'export function f() {}\n// TODO a\n// TODO b' },
      { path: 'src/cold.ts', content: 'export const x = 1;\n// TODO c' },
    ];
    const items = spider(files);
    const summaries = preSummarize(files, items);
    assert.strictEqual(summaries[0].file, 'src/hot.ts');
  });

  test('selectMicroPr picks a short TODO and skips AI directives', () => {
    const items = spider([{ path: 'src/a.ts', content: '// AI: big refactor\n// TODO: rename var' }]);
    const pr = selectMicroPr(items);
    assert.strictEqual(pr?.item.kind, 'TODO');
    assert.ok((pr?.estimated_lines ?? 0) <= 30);
  });

  test('runDreamPipeline threads every stage and produces a trace', () => {
    const result = runDreamPipeline({
      transcripts: [transcript],
      existingFacts: [],
      sourceFiles: [{ path: 'src/a.ts', content: '// TODO: x' }],
      codeIndex: { files: ['src/a.ts'], symbols: [] },
      microPr: true,
    });
    assert.strictEqual(result.candidates.length, 2);
    assert.strictEqual(result.resolution.created.length, 2);
    assert.strictEqual(result.spiderItems.length, 1);
    assert.ok(result.trace.length >= 6);
    assert.ok(result.microPr);
  });
});

// ---------------------------------------------------------------------------
// C3/C4 — recall query layer
// ---------------------------------------------------------------------------

suite('recall query layer', () => {
  const facts: BitemporalFact[] = [
    createFact({ id: 'r1', subject: 'build-command', content: 'build runs via npm run compile', tier: 'core' }),
    createFact({ id: 'r2', subject: 'release', content: 'publish to vscode marketplace', tier: 'recall' }),
    { ...createFact({ id: 'r3', subject: 'build-command', content: 'build runs via gulp' }), superseded_by: 'r1' },
  ];

  test('recallQuery scores by token overlap and excludes superseded by default', () => {
    const hits = recallQuery(facts, 'build compile');
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].fact.id, 'r1');
    assert.ok(hits.every((h) => h.fact.superseded_by === null));
  });

  test('recallQuery can scope to a tier', () => {
    const hits = recallQuery(facts, 'publish marketplace', { tier: 'core' });
    assert.strictEqual(hits.length, 0);
    const recallHits = recallQuery(facts, 'publish marketplace', { tier: 'recall' });
    assert.strictEqual(recallHits[0]?.fact.id, 'r2');
  });

  test('recallQuery includeSuperseded surfaces historical facts', () => {
    const hits = recallQuery(facts, 'gulp', { includeSuperseded: true });
    assert.strictEqual(hits[0]?.fact.id, 'r3');
  });

  test('recallCurrent / recallChain / recallTimeline delegate correctly', () => {
    assert.strictEqual(recallCurrent(facts, 'build-command')?.id, 'r1');
    assert.deepStrictEqual(recallChain(facts, 'r3').map((f) => f.id), ['r3', 'r1']);
    assert.strictEqual(recallTimeline(facts, 'build-command').entries.length, 2);
  });

  test('recallAsOf answers a time-travel query', () => {
    const tl: BitemporalFact[] = [
      { ...createFact({ id: 'a', subject: 's', content: 'old', valid_from: '2026-01-01T00:00:00Z', recorded_at: '2026-01-01T00:00:00Z' }), superseded_by: 'b', valid_to: '2026-03-01T00:00:00Z' },
      createFact({ id: 'b', subject: 's', content: 'new', valid_from: '2026-03-01T00:00:00Z', recorded_at: '2026-03-01T00:00:00Z' }),
    ];
    assert.strictEqual(recallAsOf(tl, { subject: 's', validAt: '2026-02-01T00:00:00Z' })?.id, 'a');
    assert.strictEqual(recallAsOf(tl, { subject: 's', validAt: '2026-04-01T00:00:00Z' })?.id, 'b');
  });
});
