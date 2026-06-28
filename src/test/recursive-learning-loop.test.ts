/**
 * recursive-learning-loop.test.ts
 *
 * End-to-end integration test for the multi-agent RECURSIVE LEARNING LOOP:
 *
 *   task outcomes → reputation ledger → aggregateReputation → reputationFactor
 *   → buildReputationPreference → dispatchPreferredByReputation (getPreferred
 *     §5.5 `reputation` criterion) → ROUTING DECISION
 *
 * The test proves the loop closes by seeding two agents, asserting one wins,
 * then feeding NEW outcomes that flip the relative reputation and asserting
 * the dispatch re-routes — i.e. the system learned from results and changed
 * its behaviour without any code change.
 *
 * PHASE 1 — initial state:  kilocode leads  (4 wins / 0 losses  = 1.00 → factor 1.00)
 *                            claude-code lags (0 wins / 4 losses  = 0.00 → factor 0.50)
 * PHASE 2 — after learning: 8 new claude-code successes, 8 new kilocode failures appended
 *                            claude-code: 8W / 4L  = 0.667 → factor 0.833
 *                            kilocode:    4W / 8L  = 0.333 → factor 0.667
 *            → Selection flips to claude-code.  delta = 16 new outcome records (8+8 split).
 *
 * Why these counts?
 *   reputationFactor requires >= 3 samples to leave the neutral prior.
 *   highestScored requires a STRICT winner (tie → next criterion).
 *   With the numbers above, phase-1 gap is 0.50 and phase-2 gap is 0.167 — both unambiguous.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordTaskOutcome, type TaskOutcome } from '../reputation/ledger';
import { RunnerRegistry } from '../runners/registry';
import { buildReputationPreference, dispatchPreferredByReputation } from '../runners/reputationPreference';
import type { Runner } from '../runners/types';

// ---------------------------------------------------------------------------
// Helpers — mirror runner-reputation-wiring.test.ts conventions
// ---------------------------------------------------------------------------

function mkws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-rll-'));
}

/** Append `ok` successful outcomes then `fail` failed outcomes to the ledger. */
async function seedOutcomes(
  ws: string,
  agentId: string,
  okCount: number,
  failCount: number,
  taskPrefix: string,
): Promise<void> {
  for (let i = 0; i < okCount; i++) {
    const o: TaskOutcome = {
      task_id: `${taskPrefix}-${agentId}-ok-${i}`,
      agent_id: agentId,
      verdict: 'approved',
      gate_passed: true,
      timestamp: new Date().toISOString(),
    };
    await recordTaskOutcome(ws, o);
  }
  for (let i = 0; i < failCount; i++) {
    const o: TaskOutcome = {
      task_id: `${taskPrefix}-${agentId}-fail-${i}`,
      agent_id: agentId,
      verdict: 'needs_changes',
      gate_passed: false,
      timestamp: new Date().toISOString(),
    };
    await recordTaskOutcome(ws, o);
  }
}

/** Minimal Runner stub — records dispatches to the `dispatched` array. */
function fakeRunner(id: string, dispatched: string[]): Runner {
  return {
    id,
    capabilities: {},
    detect: async () => ({ found: true }),
    dispatch: async () => { dispatched.push(id); return { ok: true, sessionId: 's', exitCode: 0, finishedAt: new Date().toISOString(), durationMs: 1 }; },
  } as unknown as Runner;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Recursive Learning Loop — end-to-end', () => {
  test('dispatch selection flips after recording reversed outcomes (loop closes)', async () => {
    const ws = mkws();
    try {
      // -----------------------------------------------------------------------
      // PHASE 1: Seed the ledger so kilocode leads
      //   kilocode:    4 wins, 0 losses  → success_rate = 1.00 → factor = 1.00
      //   claude-code: 0 wins, 4 losses  → success_rate = 0.00 → factor = 0.50
      // -----------------------------------------------------------------------
      await seedOutcomes(ws, 'kilocode',    4, 0, 'p1');
      await seedOutcomes(ws, 'claude-code', 0, 4, 'p1');

      const dispatched1: string[] = [];
      const reg1 = new RunnerRegistry();
      reg1.register(fakeRunner('claude-code', dispatched1));
      reg1.register(fakeRunner('kilocode',    dispatched1));

      const out1 = await dispatchPreferredByReputation(reg1, {
        prompt: 'do-work-phase-1',
        workingDir: ws,
        workspaceRoot: ws,
      });

      assert.ok(out1, 'Phase 1: a runner was selected');
      assert.strictEqual(
        out1!.runnerId,
        'kilocode',
        'Phase 1: kilocode (factor 1.00) should be preferred over claude-code (factor 0.50)',
      );

      // Verify reputation scores directly via buildReputationPreference
      const pref1 = await buildReputationPreference(ws);
      assert.ok(pref1.reputationByRunnerId, 'Phase 1: reputation map exists');
      const kilo1   = pref1.reputationByRunnerId!['kilocode'];
      const claude1 = pref1.reputationByRunnerId!['claude-code'];
      assert.ok(
        kilo1 > claude1,
        `Phase 1: kilocode (${kilo1}) should score higher than claude-code (${claude1})`,
      );
      // factor bounds: success_rate 1.0 → 0.5 + 0.5*1.0 = 1.0; 0.0 → 0.5
      assert.strictEqual(kilo1,   1.0, 'Phase 1: kilocode factor = 1.0 (perfect record)');
      assert.strictEqual(claude1, 0.5, 'Phase 1: claude-code factor = 0.5 (zero wins)');

      // -----------------------------------------------------------------------
      // PHASE 2: Record new outcomes — the learning step.
      //   claude-code wins 8, kilocode fails 8.
      //   Aggregate after both phases:
      //     claude-code: 8W + 4L → 12 samples, 8 wins  → rate 0.667 → factor ≈ 0.833
      //     kilocode:    4W + 8L → 12 samples, 4 wins  → rate 0.333 → factor ≈ 0.667
      //   delta = 16 new records (8 per agent) — sufficient for a robust flip
      // -----------------------------------------------------------------------
      await seedOutcomes(ws, 'claude-code', 8, 0, 'p2');
      await seedOutcomes(ws, 'kilocode',    0, 8, 'p2');

      const dispatched2: string[] = [];
      const reg2 = new RunnerRegistry();
      reg2.register(fakeRunner('claude-code', dispatched2));
      reg2.register(fakeRunner('kilocode',    dispatched2));

      const out2 = await dispatchPreferredByReputation(reg2, {
        prompt: 'do-work-phase-2',
        workingDir: ws,
        workspaceRoot: ws,
      });

      assert.ok(out2, 'Phase 2: a runner was selected');
      assert.strictEqual(
        out2!.runnerId,
        'claude-code',
        'Phase 2: claude-code should now be preferred — the loop learned from reversed outcomes',
      );

      // Verify updated reputation scores
      const pref2 = await buildReputationPreference(ws);
      assert.ok(pref2.reputationByRunnerId, 'Phase 2: reputation map exists');
      const kilo2   = pref2.reputationByRunnerId!['kilocode'];
      const claude2 = pref2.reputationByRunnerId!['claude-code'];
      assert.ok(
        claude2 > kilo2,
        `Phase 2: claude-code (${claude2}) should now score higher than kilocode (${kilo2})`,
      );
      // Exact factor values (minSamples=3, both have 12 samples — above threshold)
      //   0.5 + 0.5 * (8/12) = 0.5 + 0.5 * 0.6667 ≈ 0.8333
      //   0.5 + 0.5 * (4/12) = 0.5 + 0.5 * 0.3333 ≈ 0.6667
      const expectedClaude2 = 0.5 + 0.5 * (8 / 12);
      const expectedKilo2   = 0.5 + 0.5 * (4 / 12);
      assert.ok(
        Math.abs(claude2 - expectedClaude2) < 1e-9,
        `Phase 2: claude-code factor ${claude2} should equal ${expectedClaude2}`,
      );
      assert.ok(
        Math.abs(kilo2 - expectedKilo2) < 1e-9,
        `Phase 2: kilocode factor ${kilo2} should equal ${expectedKilo2}`,
      );

      // Confirm the selection FLIPPED (phase 1 → phase 2)
      assert.notStrictEqual(
        out1!.runnerId,
        out2!.runnerId,
        'The recursive learning loop CLOSED: dispatch selection flipped after observing reversed outcomes',
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('cold-start (no ledger): dispatches without error, falls through to stable default', async () => {
    const ws = mkws();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode',    dispatched));

      // With empty ledger, buildReputationPreference returns {} → reputation
      // criterion is a no-op → falls through to registration-order tiebreaker
      const out = await dispatchPreferredByReputation(reg, {
        prompt: 'cold-start',
        workingDir: ws,
        workspaceRoot: ws,
      });
      assert.ok(out, 'Cold-start: still selects a runner with empty ledger');
      // No specific runner assertion — stable fallback is implementation-defined
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('newcomer gets neutral prior (0.9) — never penalised for cold start', async () => {
    const ws = mkws();
    try {
      // Only 2 outcomes for 'newbie' — below minSamples=3, must return neutral 0.9
      await seedOutcomes(ws, 'newbie', 0, 2, 'newcomer');
      const pref = await buildReputationPreference(ws);
      assert.ok(pref.reputationByRunnerId, 'reputation map produced for newcomer');
      assert.strictEqual(
        pref.reputationByRunnerId!['newbie'],
        0.9,
        'newcomer with <3 samples gets the neutral prior (0.9) — never penalised',
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
