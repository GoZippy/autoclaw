/**
 * intelligence-contextpack.test.ts — unit tests for the orchestrator context
 * pack producer (Channel A delivery).
 *
 * Verifies:
 *  - buildContextPack assembles a single-H1 markdown that embeds the RAG body
 *    (its own H1 demoted) and appends durable KG facts.
 *  - the compact `summary` mirrors the counts/scope for the task_assign payload.
 *  - `generatedAt` is passed through (deterministic, no wall-clock dependency).
 *  - degraded RAG (note contains "degraded") propagates to `degraded: true`.
 *  - KG facts are capped at `maxKgFacts`; an empty KG renders the placeholder.
 *
 * All external access is injected, so the test runs fully offline with no
 * vector backend, embeddings, or KG/SQLite stack.
 */

import * as assert from 'assert';

import {
  buildContextPack,
  ContextPackDeps,
  KgFact,
} from '../intelligence/contextPack';
import { RAGPromptResult } from '../intelligence/ragPrompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = '/tmp/cp-ws';
const TS = '2026-06-21T00:00:00.000Z';

function ragResult(overrides: Partial<RAGPromptResult> = {}): RAGPromptResult {
  return {
    prompt:
      '# AutoClaw RAG-Augmented Context\n\n**Task:** demo\n\n' +
      '## Relevant Code from Your Project (RAG retrieved)\n\n```\n# not a heading — a code comment\nconst x = 1;\n```\n\n' +
      '## Your Learned Agent Style Guide\n\n# Agent Style Guide\n\nBe concise.\n\n' +
      '## Instructions for the Agent\n\n- do the thing\n',
    usedCode: true,
    codeHits: 1,
    learningHits: 2,
    notes: [],
    ...overrides,
  };
}

function healthyDeps(overrides: Partial<ContextPackDeps> = {}): ContextPackDeps {
  return {
    generateRAGPrompt: async () => ragResult(),
    searchKgFacts: async (): Promise<KgFact[]> => [
      { text: 'claim.task uses create-exclusive write semantics', kind: 'policy' },
      { text: 'consensus needs 2/3 approval for tasks', kind: 'semantic' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-contextpack', function () {
  test('assembles a single-H1 pack with RAG body + KG facts', async function () {
    const res = await buildContextPack(
      { task: 'Add pagination', agentId: 'claude-code', sprint: 2, role: 'coder', taskIds: ['B1', 'B2'] },
      { workspaceRoot: WS, generatedAt: TS, deps: healthyDeps() },
    );

    const md = res.markdown;
    // Exactly one top-level H1 OUTSIDE code fences (the RAG body's H1 and any
    // nested H1 must be demoted; `# `-looking lines inside fences don't count).
    let inFence = false;
    let h1Count = 0;
    for (const line of md.split('\n')) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence && /^# /.test(line)) {
        h1Count++;
      }
    }
    assert.strictEqual(h1Count, 1, 'pack must have a single H1 outside code fences');
    assert.ok(md.startsWith('# AutoClaw Context Pack — Sprint 2 — claude-code'), 'header rendered');
    assert.ok(md.includes('**Role / lane:** coder'), 'role rendered');
    assert.ok(md.includes('**Tasks:** B1, B2'), 'task ids rendered');
    assert.ok(md.includes('## Grounded Context (RAG-retrieved)'), 'RAG H1 demoted to H2');
    assert.ok(!md.includes('# AutoClaw RAG-Augmented Context'), 'original RAG H1 removed');
    assert.ok(md.includes('## Agent Style Guide'), 'nested style H1 demoted to H2');
    assert.ok(md.includes('const x = 1;'), 'RAG code body preserved');
    assert.ok(md.includes('# not a heading — a code comment'), 'H1-looking line inside a code fence is preserved');
    assert.ok(md.includes('## Durable Knowledge-Graph Facts'), 'KG section present');
    assert.ok(md.includes('*(policy)* claim.task uses create-exclusive'), 'KG fact with kind rendered');
  });

  test('summary mirrors counts + scope for the assignment payload', async function () {
    const res = await buildContextPack(
      { task: 'Add pagination', agentId: 'kilocode', sprint: 3, taskIds: ['C1'] },
      { workspaceRoot: WS, generatedAt: TS, deps: healthyDeps() },
    );
    assert.deepStrictEqual(res.summary, {
      task: 'Add pagination',
      agent_id: 'kilocode',
      role: undefined,
      sprint: 3,
      task_ids: ['C1'],
      used_code: true,
      code_hits: 1,
      learning_hits: 2,
      kg_hits: 2,
      degraded: false,
      notes: [],
      generated_at: TS,
    });
    assert.strictEqual(res.generatedAt, TS, 'generatedAt passthrough (no wall-clock)');
    assert.strictEqual(res.kgHits, 2);
  });

  test('degraded RAG propagates to degraded:true', async function () {
    const res = await buildContextPack(
      { task: 'x' },
      {
        workspaceRoot: WS,
        generatedAt: TS,
        deps: healthyDeps({
          generateRAGPrompt: async () =>
            ragResult({
              usedCode: false,
              codeHits: 0,
              notes: ['Code retrieval unavailable (vector backend degraded).'],
            }),
        }),
      },
    );
    assert.strictEqual(res.degraded, true, 'degraded note flips the flag');
    assert.strictEqual(res.usedCode, false);
  });

  test('caps KG facts at maxKgFacts and renders placeholder when empty', async function () {
    const many: KgFact[] = Array.from({ length: 10 }, (_, i) => ({ text: `fact ${i}` }));
    const capped = await buildContextPack(
      { task: 'x' },
      { workspaceRoot: WS, generatedAt: TS, maxKgFacts: 3, deps: healthyDeps({ searchKgFacts: async () => many }) },
    );
    assert.strictEqual(capped.kgHits, 3, 'KG facts capped to maxKgFacts');

    const empty = await buildContextPack(
      { task: 'x' },
      { workspaceRoot: WS, generatedAt: TS, deps: healthyDeps({ searchKgFacts: async () => [] }) },
    );
    assert.ok(
      empty.markdown.includes('_No durable facts recorded for this project yet._'),
      'empty KG renders placeholder',
    );
  });

  test('a throwing KG recall does not fail the pack', async function () {
    const res = await buildContextPack(
      { task: 'x' },
      {
        workspaceRoot: WS,
        generatedAt: TS,
        deps: healthyDeps({
          searchKgFacts: async () => {
            throw new Error('kg boom');
          },
        }),
      },
    );
    assert.strictEqual(res.kgHits, 0, 'KG failure degrades to zero facts');
    assert.ok(res.markdown.includes('## Grounded Context (RAG-retrieved)'), 'RAG section still present');
  });
});
