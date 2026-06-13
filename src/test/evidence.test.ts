/**
 * evidence.test.ts — Evidence capsules (crabbox run-handle + replay pattern).
 *
 * Covers: run-handle minting (stable, collision-resistant), buildCapsule
 * derivation (timing/gates_passed), write/read/list round-trip in the comms
 * tree, and replayFailedGates (replays only the red gates; reports pass/fail).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  newRunId,
  buildCapsule,
  captureCapsule,
  captureFromChecks,
  writeCapsule,
  readCapsule,
  listCapsules,
  replayFailedGates,
  summarizeCapsule,
  RESULTS_SUBDIR,
} from '../evidence';
import type { ConsensusResult, GateCheckResult } from '../orchestrate';

function makeCommsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-cap-'));
}

function result(overrides: Partial<ConsensusResult> = {}): ConsensusResult {
  return {
    task_id: 'B1',
    sprint: 2,
    status: 'consensus_reached',
    final_verdict: 'approved',
    votes: [],
    rounds: 1,
    max_rounds: 3,
    unresolved_findings: [],
    resolved_findings: [],
    consensus_threshold: 0.66,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const gate = (command: string, passed: boolean, dur = 10): GateCheckResult => ({
  command, exit_code: passed ? 0 : 1, passed, duration_ms: dur,
});

suite('Evidence — run handles', () => {
  test('newRunId is run-prefixed, sortable, and collision-resistant', () => {
    const fixed = new Date('2026-06-13T10:15:00.000Z');
    assert.strictEqual(newRunId(fixed, () => 0), 'run-20260613T101500Z-000000');
    // Same timestamp, different entropy ⇒ different handle.
    const a = newRunId(fixed, () => 0.1);
    const b = newRunId(fixed, () => 0.9);
    assert.notStrictEqual(a, b);
  });
});

suite('Evidence — buildCapsule', () => {
  test('derives gates_passed and gate timing from gate_checks', () => {
    const c = buildCapsule(result({ gate_checks: [gate('npm test', true, 30), gate('go vet', true, 12)] }));
    assert.strictEqual(c.gates_passed, true);
    assert.strictEqual(c.timing?.gate_ms, 42);
  });

  test('a single red gate makes gates_passed false', () => {
    const c = buildCapsule(result({ gate_checks: [gate('npm test', true), gate('lint', false)] }));
    assert.strictEqual(c.gates_passed, false);
  });

  test('no gate ⇒ gates_passed undefined (no-gate is not a failure)', () => {
    const c = buildCapsule(result());
    assert.strictEqual(c.gates_passed, undefined);
  });

  test('carries verdict, vote count, and review context', () => {
    const c = buildCapsule(
      result({ final_verdict: 'needs_changes', votes: [{} as never, {} as never], excluded_self_review: ['kilocode'] }),
      { author_agent_id: 'kilocode', evaluated_by: 'claude-code' }
    );
    assert.strictEqual(c.final_verdict, 'needs_changes');
    assert.strictEqual(c.votes_count, 2);
    assert.deepStrictEqual(c.excluded_self_review, ['kilocode']);
    assert.strictEqual(c.author_agent_id, 'kilocode');
    assert.strictEqual(c.evaluated_by, 'claude-code');
  });
});

suite('Evidence — persistence round-trip', () => {
  test('writeCapsule + readCapsule round-trips by run handle', async () => {
    const comms = makeCommsDir();
    const c = buildCapsule(result({ task_id: 'T9' }), { run_id: 'run-fixed-abc123' });
    const file = await writeCapsule(comms, c);
    assert.ok(fs.existsSync(file));
    assert.ok(file.includes(path.join(RESULTS_SUBDIR, 'T9-run-fixed-abc123.json')));
    const back = await readCapsule(comms, 'run-fixed-abc123');
    assert.strictEqual(back?.task_id, 'T9');
    assert.strictEqual(back?.run_id, 'run-fixed-abc123');
  });

  test('task ids with path-unsafe chars are sanitized in the filename', async () => {
    const comms = makeCommsDir();
    const c = buildCapsule(result({ task_id: 'feat/x:y' }), { run_id: 'run-z' });
    await writeCapsule(comms, c);
    const back = await readCapsule(comms, 'run-z');
    assert.strictEqual(back?.task_id, 'feat/x:y'); // original id preserved in the body
  });

  test('listCapsules returns newest first and filters by task', async () => {
    const comms = makeCommsDir();
    await writeCapsule(comms, buildCapsule(result({ task_id: 'A' }), { run_id: 'r1', now: new Date('2026-06-13T01:00:00Z') }));
    await writeCapsule(comms, buildCapsule(result({ task_id: 'A' }), { run_id: 'r2', now: new Date('2026-06-13T02:00:00Z') }));
    await writeCapsule(comms, buildCapsule(result({ task_id: 'B' }), { run_id: 'r3', now: new Date('2026-06-13T03:00:00Z') }));
    const all = await listCapsules(comms);
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].run_id, 'r3'); // newest first
    const justA = await listCapsules(comms, 'A');
    assert.strictEqual(justA.length, 2);
  });

  test('missing store ⇒ [] / undefined, never throws', async () => {
    const comms = makeCommsDir();
    assert.deepStrictEqual(await listCapsules(comms), []);
    assert.strictEqual(await readCapsule(comms, 'nope'), undefined);
  });
});

suite('Evidence — replayFailedGates', () => {
  test('replays only the failed gates and reports pass when fixed', async () => {
    const c = buildCapsule(result({
      gate_checks: [gate('npm test', true), gate('lint', false)],
    }));
    c.acceptance_checks = [{ command: 'npm test' }, { command: 'lint' }];
    const replayed: string[] = [];
    const r = await replayFailedGates(c, {
      exec: async (command) => { replayed.push(command); return { exit_code: 0, stdout: 'ok' }; },
    });
    assert.deepStrictEqual(replayed, ['lint']); // only the red one
    assert.strictEqual(r?.passed, true);
  });

  test('still-red replay reports passed=false', async () => {
    const c = buildCapsule(result({ gate_checks: [gate('lint', false)] }));
    c.acceptance_checks = [{ command: 'lint' }];
    const r = await replayFailedGates(c, { exec: async () => ({ exit_code: 1, stdout: 'still broken' }) });
    assert.strictEqual(r?.passed, false);
  });

  test('no recipe ⇒ undefined; all-green ⇒ nothing replayed', async () => {
    const noRecipe = buildCapsule(result({ gate_checks: [gate('lint', false)] }));
    assert.strictEqual(await replayFailedGates(noRecipe), undefined);

    const allGreen = buildCapsule(result({ gate_checks: [gate('npm test', true)] }));
    allGreen.acceptance_checks = [{ command: 'npm test' }];
    const r = await replayFailedGates(allGreen, { exec: async () => ({ exit_code: 0, stdout: '' }) });
    assert.deepStrictEqual(r, { replayed: [], passed: true });
  });
});

suite('Evidence — summary', () => {
  test('summarizeCapsule reflects gate state', () => {
    const fail = buildCapsule(result({ final_verdict: 'blocked', gate_checks: [gate('t', false)] }));
    assert.ok(summarizeCapsule(fail).includes('GATE-FAIL'));
    const none = buildCapsule(result());
    assert.ok(summarizeCapsule(none).includes('no-gate'));
  });

  test('buildCapsule stamps source=consensus', () => {
    assert.strictEqual(buildCapsule(result()).source, 'consensus');
  });
});

suite('Evidence — captureCapsule (from-actions)', () => {
  test('derives a failing verdict from a red gate', () => {
    const c = captureCapsule({ task_id: 'CI-1', source: 'ci', gate_checks: [gate('build', false)] });
    assert.strictEqual(c.source, 'ci');
    assert.strictEqual(c.gates_passed, false);
    assert.strictEqual(c.final_verdict, 'needs_changes');
    assert.strictEqual(c.votes_count, 0);
    assert.strictEqual(c.status, 'consensus_pending');
  });

  test('all-green gate ⇒ approved; no gate ⇒ abstain', () => {
    assert.strictEqual(captureCapsule({ task_id: 'X', source: 'manual', gate_checks: [gate('t', true)] }).final_verdict, 'approved');
    assert.strictEqual(captureCapsule({ task_id: 'X', source: 'manual' }).final_verdict, 'abstain');
  });

  test('explicit verdict overrides the derivation', () => {
    const c = captureCapsule({ task_id: 'X', source: 'manual', gate_checks: [gate('t', false)], final_verdict: 'blocked' });
    assert.strictEqual(c.final_verdict, 'blocked');
  });
});

suite('Evidence — captureFromChecks (run + persist)', () => {
  test('runs the checks, captures a replayable capsule, and writes it', async () => {
    const comms = makeCommsDir();
    const c = await captureFromChecks(comms, {
      task_id: 'BUILD-7',
      source: 'autobuild',
      checks: [{ command: 'npm run build' }],
      exec: async () => ({ exit_code: 1, stdout: 'tsc error' }),
    });
    assert.strictEqual(c.gates_passed, false);
    assert.strictEqual(c.source, 'autobuild');
    assert.deepStrictEqual(c.acceptance_checks, [{ command: 'npm run build' }]);
    // Persisted and re-readable by run handle.
    const back = await readCapsule(comms, c.run_id);
    assert.strictEqual(back?.task_id, 'BUILD-7');
    // And the captured failure is replayable.
    const replay = await replayFailedGates(back!, { exec: async () => ({ exit_code: 0, stdout: 'fixed' }) });
    assert.strictEqual(replay?.passed, true);
  });
});
