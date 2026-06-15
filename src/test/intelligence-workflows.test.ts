/**
 * intelligence-workflows.test.ts — unit tests for the workflow-sequence miner
 * (src/intelligence/workflows.ts).
 *
 * Pure-logic, fully offline: no `vscode`, no extension host, no I/O. Exercises:
 *  - tool-step extraction from `[tool_use NAME …]` markers, including
 *    consecutive-run collapsing and prose-only sessions (no markers).
 *  - outcome-aware n-gram tallying: a session is credited once per distinct
 *    sub-sequence; ship rate is shipped / (shipped + discarded).
 *  - successful vs anti-pattern classification by threshold + support.
 */

import * as assert from 'assert';

import {
  extractToolSteps,
  extractSessionWorkflow,
  mineWorkflows,
  workflowPatternLabel,
} from '../intelligence/workflows';
import { SessionMessage, SessionOutcome, UnifiedSession } from '../intelligence/types';

function msg(text: string): SessionMessage {
  return { role: 'assistant', text };
}

/** Build a session whose transcript runs `steps` as tool_use markers. */
function session(
  id: string,
  steps: string[],
  outcome: SessionOutcome,
  tool = 'Claude Code',
): UnifiedSession {
  // One marker per message keeps ordering explicit and mirrors real transcripts.
  const messages = steps.map((s) => msg(`thinking…\n[tool_use ${s} {"x":1}]`));
  const signals: UnifiedSession['signals'] = { keptCode: [] };
  if (outcome === 'shipped') {
    signals.gitKept = true;
  } else if (outcome === 'discarded') {
    signals.outcome = 'discarded';
  }
  return {
    id,
    source: 'claude-code',
    tool,
    project: '/repo/demo',
    startedAt: 1,
    messages,
    signals,
    provenance: { adapterId: 'claude-code', rawRef: id, extractedAt: 1 },
  };
}

suite('intelligence-workflows', function () {
  suite('extractToolSteps', function () {
    test('pulls ordered tool names from markers', function () {
      const s = session('s1', ['Read', 'Edit', 'Bash'], 'shipped');
      assert.deepStrictEqual(extractToolSteps(s), ['Read', 'Edit', 'Bash']);
    });

    test('collapses consecutive duplicate tools by default', function () {
      const s: UnifiedSession = {
        ...session('s2', [], 'unknown'),
        messages: [msg('[tool_use Read] [tool_use Read] [tool_use Edit] [tool_use Read]')],
      };
      assert.deepStrictEqual(extractToolSteps(s), ['Read', 'Edit', 'Read']);
      assert.deepStrictEqual(extractToolSteps(s, false), ['Read', 'Read', 'Edit', 'Read']);
    });

    test('handles dotted/namespaced tool names', function () {
      const s: UnifiedSession = {
        ...session('s3', [], 'unknown'),
        messages: [msg('[tool_use mcp__server__do_thing {"a":1}]')],
      };
      assert.deepStrictEqual(extractToolSteps(s), ['mcp__server__do_thing']);
    });

    test('prose-only session yields no steps', function () {
      const s: UnifiedSession = {
        ...session('s4', [], 'unknown'),
        messages: [msg('just talking, no tools here')],
      };
      assert.deepStrictEqual(extractToolSteps(s), []);
    });

    test('extractSessionWorkflow derives outcome', function () {
      const wf = extractSessionWorkflow(session('s5', ['Read', 'Edit'], 'shipped'));
      assert.strictEqual(wf.outcome, 'shipped');
      assert.deepStrictEqual(wf.steps, ['Read', 'Edit']);
    });
  });

  suite('mineWorkflows', function () {
    test('ranks a high-ship sequence as successful', function () {
      // Read → Edit → Bash ships in 4 sessions, discarded in 0.
      const sessions: UnifiedSession[] = [
        session('a', ['Read', 'Edit', 'Bash'], 'shipped'),
        session('b', ['Read', 'Edit', 'Bash'], 'shipped'),
        session('c', ['Read', 'Edit', 'Bash'], 'shipped'),
        session('d', ['Read', 'Edit', 'Bash'], 'shipped'),
      ];
      const out = mineWorkflows(sessions, { minSupport: 3 });
      assert.strictEqual(out.sessionsWithSteps, 4);
      const labels = out.successful.map((p) => p.label);
      assert.ok(labels.includes('Read → Edit'), 'bigram present');
      assert.ok(labels.includes('Read → Edit → Bash'), 'trigram present');
      const trigram = out.successful.find((p) => p.label === 'Read → Edit → Bash');
      assert.strictEqual(trigram?.shipped, 4);
      assert.strictEqual(trigram?.discarded, 0);
      assert.strictEqual(trigram?.shipRate, 1);
    });

    test('classifies a discard-prone sequence as an anti-pattern', function () {
      // Write → Bash gets discarded 3×, shipped 0× → shipRate 0.
      const sessions: UnifiedSession[] = [
        session('a', ['Write', 'Bash'], 'discarded'),
        session('b', ['Write', 'Bash'], 'discarded'),
        session('c', ['Write', 'Bash'], 'discarded'),
      ];
      const out = mineWorkflows(sessions, { minSupport: 3 });
      const anti = out.antiPatterns.find((p) => p.label === 'Write → Bash');
      assert.ok(anti, 'anti-pattern detected');
      assert.strictEqual(anti?.discarded, 3);
      assert.strictEqual(anti?.shipRate, 0);
      assert.strictEqual(out.successful.length, 0);
    });

    test('respects minSupport — rare sequences are dropped', function () {
      const sessions: UnifiedSession[] = [
        session('a', ['Grep', 'Read'], 'shipped'),
        session('b', ['Grep', 'Read'], 'shipped'),
      ];
      const out = mineWorkflows(sessions, { minSupport: 3 });
      assert.strictEqual(out.successful.length, 0, 'below support threshold');
    });

    test('counts a repeated sub-sequence once per session', function () {
      // The same session loops Read→Edit twice; it must count as 1, not 2.
      const looped: UnifiedSession = session(
        'loop',
        ['Read', 'Edit', 'Read', 'Edit'],
        'shipped',
      );
      const sessions = [
        looped,
        session('x', ['Read', 'Edit'], 'shipped'),
        session('y', ['Read', 'Edit'], 'shipped'),
      ];
      const out = mineWorkflows(sessions, { minSupport: 3 });
      const bigram = out.successful.find((p) => p.label === 'Read → Edit');
      assert.strictEqual(bigram?.shipped, 3, 'looped session credited once');
      assert.strictEqual(bigram?.total, 3);
    });

    test('stepFrequency is ranked by usage', function () {
      const out = mineWorkflows([
        session('a', ['Read', 'Read', 'Edit'], 'shipped'), // collapse → Read, Edit
        session('b', ['Read', 'Bash'], 'shipped'),
      ]);
      const top = out.stepFrequency[0];
      assert.strictEqual(top.tool, 'Read');
    });

    test('workflowPatternLabel formats ship rate and support', function () {
      const label = workflowPatternLabel({
        sequence: ['Read', 'Edit'],
        label: 'Read → Edit',
        shipped: 6,
        discarded: 1,
        unknown: 0,
        total: 7,
        shipRate: 6 / 7,
      });
      assert.strictEqual(label, 'Read → Edit (ships 86%, n=7)');
    });
  });
});
