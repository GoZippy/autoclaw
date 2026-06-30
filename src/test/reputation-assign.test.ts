/**
 * reputation-assign.test.ts — BL-7b Part 2: reputation-aware default assignment.
 *
 * Proves the selection helper ranks by reputation, and — end to end — that
 * dispatchWork addresses a no-explicit-target ('other') task_claim to the
 * higher-reputation capable agent while leaving an explicit vendor untouched.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dispatchWork, LOOP_SIDE_CAR_DIR } from '../orchestratorLoop';
import { recordTaskOutcome, type TaskOutcome } from '../reputation/ledger';
import {
  selectReputationPreferredVendor,
  selectPreferredVendorByReputation,
  NEUTRAL_REPUTATION_PRIOR,
} from '../runners/reputationAssign';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-repassign-'));
}

function seedRegistry(ws: string, agents: Array<{ id: string; agent_type?: string }>): void {
  const commsDir = path.join(ws, '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(commsDir, { recursive: true });
  fs.writeFileSync(path.join(commsDir, 'registry.json'), JSON.stringify({ agents }, null, 2), 'utf8');
}

async function seedReputation(
  ws: string,
  agent: string,
  verdict: 'approved' | 'needs_changes',
  n = 4,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const o: TaskOutcome = {
      task_id: `${agent}-${verdict}-${i}`,
      agent_id: agent,
      verdict,
      gate_passed: verdict === 'approved',
      timestamp: '2026-06-27T00:00:00.000Z',
    };
    await recordTaskOutcome(ws, o);
  }
}

let taskSeq = 0;
function makePkg(assignToVendor: string): any {
  taskSeq += 1;
  return {
    type: 'work_package' as const,
    taskId: `t-${taskSeq}`,
    taskName: 'test task',
    description: 'desc',
    filePaths: [] as string[],
    successCriteria: ['ok'],
    sprint: 1,
    assignToVendor,
    priority: 'low' as const,
    timeBudgetMs: 0,
  };
}

/** Read the dispatch sidecar record for a task and return the vendor it landed on. */
function dispatchedVendor(ws: string, taskId: string): string | null {
  const dir = path.join(ws, LOOP_SIDE_CAR_DIR);
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return null; }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r.taskId === taskId) { return r.vendor; }
    } catch { /* skip */ }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Pure ranking                                                               */
/* -------------------------------------------------------------------------- */

suite('BL-7b selectReputationPreferredVendor — pure ranking', () => {
  test('picks the higher-reputation candidate', () => {
    assert.strictEqual(selectReputationPreferredVendor(['a', 'b'], { a: 0.6, b: 0.9 }), 'b');
    assert.strictEqual(selectReputationPreferredVendor(['a', 'b'], { a: 0.9, b: 0.6 }), 'a');
  });

  test('a newcomer (no record) uses the neutral prior — beats a proven-poor agent', () => {
    assert.ok(0.55 < NEUTRAL_REPUTATION_PRIOR, 'sanity: poor < neutral');
    assert.strictEqual(selectReputationPreferredVendor(['poor', 'newcomer'], { poor: 0.55 }), 'newcomer');
  });

  test('a proven-good agent beats a newcomer', () => {
    assert.strictEqual(selectReputationPreferredVendor(['good', 'newcomer'], { good: 0.95 }), 'good');
  });

  test('ties resolve to the first candidate (deterministic)', () => {
    assert.strictEqual(selectReputationPreferredVendor(['x', 'y'], { x: 0.8, y: 0.8 }), 'x');
    assert.strictEqual(selectReputationPreferredVendor(['p', 'q'], {}), 'p'); // both neutral
  });

  test('empty candidate set → null', () => {
    assert.strictEqual(selectReputationPreferredVendor([], { a: 1 }), null);
  });
});

suite('BL-7b selectPreferredVendorByReputation — injected map', () => {
  test('selects via an injected reputation map (no ledger read)', async () => {
    const r = await selectPreferredVendorByReputation('/does-not-exist', ['a', 'b'], {
      reputationByRunnerId: { a: 0.9, b: 0.6 },
    });
    assert.strictEqual(r, 'a');
  });

  test('empty candidates → null', async () => {
    assert.strictEqual(await selectPreferredVendorByReputation('/x', []), null);
  });
});

/* -------------------------------------------------------------------------- */
/*  End-to-end through dispatchWork                                            */
/* -------------------------------------------------------------------------- */

suite('BL-7b Part 2 — dispatchWork reputation-aware default assignment', () => {
  test("no explicit target ('other') → claim routed to the higher-reputation capable agent", async () => {
    const ws = tmpWs();
    seedRegistry(ws, [{ id: 'claude-code', agent_type: 'coder' }, { id: 'kilocode', agent_type: 'coder' }]);
    await seedReputation(ws, 'kilocode', 'approved');         // high reputation
    await seedReputation(ws, 'claude-code', 'needs_changes'); // low reputation

    const pkg = makePkg('other');
    const res = await dispatchWork(ws, pkg);

    assert.notStrictEqual(res, null, 'dispatch must not be gated/halted');
    assert.strictEqual(dispatchedVendor(ws, pkg.taskId), 'kilocode',
      "no-target 'other' should be routed to the higher-reputation agent");
  });

  test('explicit target is NEVER overridden by reputation (even when it is the lower-rep agent)', async () => {
    const ws = tmpWs();
    seedRegistry(ws, [{ id: 'claude-code', agent_type: 'coder' }, { id: 'kilocode', agent_type: 'coder' }]);
    await seedReputation(ws, 'kilocode', 'approved');
    await seedReputation(ws, 'claude-code', 'needs_changes'); // explicitly target the LOWER-rep one

    const pkg = makePkg('claude-code');
    await dispatchWork(ws, pkg);

    assert.strictEqual(dispatchedVendor(ws, pkg.taskId), 'claude-code',
      'an explicit vendor must pass through unchanged');
  });

  test("no registry.json → 'other' stays 'other' (degrade-safe; queue semantics preserved)", async () => {
    const ws = tmpWs();
    // intentionally NO registry.json
    const pkg = makePkg('other');
    await dispatchWork(ws, pkg);

    assert.strictEqual(dispatchedVendor(ws, pkg.taskId), 'other',
      "no registry → unchanged 'other' broadcast");
  });

  test("only CAPABLE agents are considered (a human-in-loop type is skipped)", async () => {
    const ws = tmpWs();
    // 'reviewer' is a governance/assistant-style type the dispatch gate holds;
    // even if it had stellar reputation it must not be auto-selected.
    seedRegistry(ws, [{ id: 'governor', agent_type: 'governance' }, { id: 'kilocode', agent_type: 'coder' }]);
    await seedReputation(ws, 'governor', 'approved', 8);  // very high but not dispatchable
    await seedReputation(ws, 'kilocode', 'approved');

    const pkg = makePkg('other');
    await dispatchWork(ws, pkg);

    assert.strictEqual(dispatchedVendor(ws, pkg.taskId), 'kilocode',
      'a non-dispatchable (governance) agent must be excluded from reputation selection');
  });
});
