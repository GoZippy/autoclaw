/**
 * intelligence-ragprompt.test.ts — unit tests for the RAG prompt service +
 * /scaffold builder (Phase-2 intelligence-signal-and-rag).
 *
 * Verifies, with INJECTED dependencies (no native vector backend / repo needed):
 *  - generateRAGPrompt assembles code + learnings + style + memory + instructions
 *    in order, sets usedCode=true, and reports hit counts (R2.1)
 *  - the task is redacted before rendering (R7.1)
 *  - degraded vector path: code is skipped, usedCode=false, a note is added, and
 *    the prompt is still produced from preference learnings + style + memory
 *    (R2.4)
 *  - buildScaffold emits agent-style.md, focused and unfocused (R3.1, R3.2)
 */

import * as assert from 'assert';

import {
  generateRAGPrompt,
  buildScaffold,
  RAGPromptDeps,
} from '../intelligence/ragPrompt';
import { CodeSearchResult } from '../intelligence/ragCode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STYLE = '# Agent Style Guide\n\n## Successful Patterns\n- Write focused changes';
const MEMORY = '## 2026-06-12 — /learn\nAnalyzed 3 sessions, shipped the parser.';

function codeHit(file: string, content: string, score = 0.9): CodeSearchResult {
  return { file, content, score };
}

/** Dependencies for the healthy (non-degraded) assembly path. */
function healthyDeps(overrides: Partial<RAGPromptDeps> = {}): RAGPromptDeps {
  return {
    vectorDegraded: async () => false,
    retrieveCode: async () => [codeHit('src/parser.ts', 'export function parse() { return 1; }')],
    retrieveLearnings: async () => [
      { content: 'Reuse the existing parser utility', score: 0.8 },
      { content: 'Validate inputs at the boundary', score: 0.7 },
    ],
    readPreferenceLearnings: () => ['file-based learning should not appear when vectors work'],
    readAgentStyle: () => STYLE,
    readMemorySummary: () => MEMORY,
    ...overrides,
  };
}

/** Dependencies for the degraded path: vectors unavailable, file fallback only. */
function degradedDeps(overrides: Partial<RAGPromptDeps> = {}): RAGPromptDeps {
  return {
    vectorDegraded: async () => true,
    retrieveCode: async () => {
      throw new Error('retrieveCode must not be called in degraded mode');
    },
    retrieveLearnings: async () => {
      throw new Error('retrieveLearnings must not be called in degraded mode');
    },
    readPreferenceLearnings: () => ['Prefer parameterized queries'],
    readAgentStyle: () => STYLE,
    readMemorySummary: () => MEMORY,
    ...overrides,
  };
}

const WS = '/tmp/rag-ws';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-ragprompt', function () {
  suite('generateRAGPrompt: assembly (R2.1)', function () {
    test('assembles all sections in order with usedCode=true', async function () {
      const res = await generateRAGPrompt('Add a JSON parser', {
        workspaceRoot: WS,
        deps: healthyDeps(),
      });

      assert.strictEqual(res.usedCode, true);
      assert.strictEqual(res.codeHits, 1);
      assert.strictEqual(res.learningHits, 2);

      const p = res.prompt;
      assert.ok(p.includes('**Task:** Add a JSON parser'), 'task header present');
      assert.ok(p.includes('Relevant Code from Your Project'), 'code section present');
      assert.ok(p.includes('src/parser.ts'), 'code file rendered');
      assert.ok(p.includes('Your Previously Successful Patterns'), 'learnings section present');
      assert.ok(p.includes('Reuse the existing parser utility'), 'learning rendered');
      assert.ok(p.includes('Learned Agent Style Guide'), 'style section present');
      assert.ok(p.includes('Project Memory Summary'), 'memory section present');
      assert.ok(p.includes('Instructions for the Agent'), 'instructions present');

      // Order: code < learnings < style < memory < instructions.
      const idx = (s: string) => p.indexOf(s);
      assert.ok(idx('Relevant Code') < idx('Previously Successful Patterns'));
      assert.ok(idx('Previously Successful Patterns') < idx('Agent Style Guide'));
      assert.ok(idx('Agent Style Guide') < idx('Project Memory Summary'));
      assert.ok(idx('Project Memory Summary') < idx('Instructions for the Agent'));
    });

    test('redacts secrets in the task before rendering (R7.1)', async function () {
      const res = await generateRAGPrompt('use key AKIAIOSFODNN7EXAMPLE for upload', {
        workspaceRoot: WS,
        deps: healthyDeps(),
      });
      assert.ok(!res.prompt.includes('AKIAIOSFODNN7EXAMPLE'), 'raw secret must not appear');
      assert.ok(res.prompt.includes('redacted'), 'a redaction marker should be present');
    });

    test('respects includeStyle / includeMemory toggles', async function () {
      const res = await generateRAGPrompt('task', {
        workspaceRoot: WS,
        includeStyle: false,
        includeMemory: false,
        deps: healthyDeps(),
      });
      assert.ok(!res.prompt.includes('Agent Style Guide'));
      assert.ok(!res.prompt.includes('Project Memory Summary'));
    });
  });

  suite('generateRAGPrompt: degraded mode (R2.4)', function () {
    test('skips code, sets usedCode=false, notes degradation, still builds from learnings/style/memory', async function () {
      const res = await generateRAGPrompt('Add a JSON parser', {
        workspaceRoot: WS,
        deps: degradedDeps(),
      });

      assert.strictEqual(res.usedCode, false, 'no code in degraded mode');
      assert.strictEqual(res.codeHits, 0);
      assert.ok(
        res.notes.some((n) => /degraded/i.test(n)),
        'a degraded note should be recorded',
      );

      const p = res.prompt;
      assert.ok(/unavailable/i.test(p), 'prompt should note code retrieval was unavailable');
      assert.ok(p.includes('Prefer parameterized queries'), 'file-based learnings still included');
      assert.ok(p.includes('Learned Agent Style Guide'), 'style still included');
      assert.ok(p.includes('Project Memory Summary'), 'memory still included');
      assert.ok(p.includes('Instructions for the Agent'), 'instructions still included');
      assert.ok(!p.includes('```'), 'no fenced code blocks should be emitted');
    });
  });

  suite('buildScaffold (R3.1/R3.2)', function () {
    test('emits the agent style guide unfocused', function () {
      const out = buildScaffold({ workspaceRoot: WS, readAgentStyle: () => STYLE });
      assert.ok(out.includes('AutoClaw Agent Scaffold'));
      assert.ok(out.includes('Successful Patterns'));
      assert.ok(!out.includes('**Focus:**'), 'no focus header when none given');
    });

    test('emphasizes the focus area when provided', function () {
      const out = buildScaffold({
        workspaceRoot: WS,
        focus: 'error handling',
        readAgentStyle: () => STYLE,
      });
      assert.ok(out.includes('**Focus:** error handling'));
      assert.ok(out.includes('emphasize learnings and patterns related to "error handling"'));
    });

    test('generates a default body when agent-style.md is absent', function () {
      const out = buildScaffold({ workspaceRoot: WS, readAgentStyle: () => undefined });
      assert.ok(out.includes('Agent Style Guide'), 'falls back to a generated style');
    });
  });
});
