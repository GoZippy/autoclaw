import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  computeNeeds, writeNeeds, readNeeds, gatherNeedsInput, needsPath,
  PlannedLane, LiveAgent,
} from '../fleet/needs';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'needs-test-'));
}

const T0 = Date.parse('2026-06-16T00:00:00.000Z');

suite('Project needs (SA-1)', () => {

  test('role_coverage_gap = wanted roles minus fresh live roles', () => {
    const lanes: PlannedLane[] = [
      { lane: 'SA', role: 'researcher', unclaimed: 1 },
      { lane: 'FF', role: 'coder', unclaimed: 0 },        // no open work → not wanted
    ];
    const live: LiveAgent[] = [
      { agent_id: 'a', role: 'coder', stale: false },
      { agent_id: 'b', role: 'researcher', stale: true }, // stale → does NOT cover
    ];
    const needs = computeNeeds({
      plannedLanes: lanes,
      declaredRoles: ['tester'],
      liveAgents: live,
    });
    // wanted = {researcher (open lane), tester (declared)}; covered = {coder}
    assert.deepStrictEqual(needs.role_coverage_gap, ['researcher', 'tester']);
    assert.strictEqual(needs.open_lanes.length, 1);
    assert.strictEqual(needs.open_lanes[0].lane, 'SA');
  });

  test('a fresh live agent covers its role (gap excludes it)', () => {
    const needs = computeNeeds({
      plannedLanes: [{ lane: 'X', role: 'tester', unclaimed: 2 }],
      liveAgents: [{ agent_id: 'q', role: 'tester', stale: false }],
    });
    assert.deepStrictEqual(needs.role_coverage_gap, []);
    assert.ok(needs.summary.includes('open lane'));
  });

  test('drained backlog with full coverage → no open needs', () => {
    const needs = computeNeeds({
      plannedLanes: [{ lane: 'X', role: 'coder', unclaimed: 0 }],
      declaredRoles: ['coder'],
      liveAgents: [{ agent_id: 'c', role: 'coder', stale: false }],
    });
    assert.deepStrictEqual(needs.role_coverage_gap, []);
    assert.strictEqual(needs.open_lanes.length, 0);
    assert.strictEqual(needs.summary, 'fully staffed — no open needs');
  });

  test('staleness pressure + findings surface in the vector + summary', () => {
    const needs = computeNeeds({
      staleClaims: [{ task_id: 'B4', owner: 'coder-2' }],
      unclaimedFindings: 3,
    });
    assert.strictEqual(needs.staleness_pressure.length, 1);
    assert.strictEqual(needs.unclaimed_findings, 3);
    assert.ok(needs.summary.includes('stalled claim'));
    assert.ok(needs.summary.includes('open finding'));
  });

  test('roles are case-insensitive when matching coverage', () => {
    const needs = computeNeeds({
      declaredRoles: ['Tester'],
      liveAgents: [{ agent_id: 'a', role: 'tester', stale: false }],
    });
    assert.deepStrictEqual(needs.role_coverage_gap, []);
  });

  test('writeNeeds stamps generated_at and readNeeds round-trips', async () => {
    const dir = makeTmp();
    const autoclaw = path.join(dir, '.autoclaw');
    const needs = computeNeeds({ declaredRoles: ['security'], liveAgents: [] });
    const file = await writeNeeds(autoclaw, needs, { now: T0 });
    assert.strictEqual(file, needsPath(autoclaw));
    const back = await readNeeds(autoclaw);
    assert.ok(back);
    assert.strictEqual(back!.generated_at, new Date(T0).toISOString());
    assert.deepStrictEqual(back!.role_coverage_gap, ['security']);
  });

  test('readNeeds returns null when absent', async () => {
    const dir = makeTmp();
    assert.strictEqual(await readNeeds(path.join(dir, '.autoclaw')), null);
  });

  test('gatherNeedsInput reads fleet.json roles, beacons, board stale claims, findings', async () => {
    const dir = makeTmp();
    const orch = path.join(dir, '.autoclaw', 'orchestrator');
    fs.mkdirSync(path.join(orch, 'comms', 'beacons'), { recursive: true });

    // fleet.json declares a coder + a security role.
    fs.writeFileSync(path.join(orch, 'fleet.json'), JSON.stringify({
      agents: { 'a': { role: 'coder' }, 'b': { role: 'security' } },
    }));
    // A fresh beacon for a coder (covers coder).
    fs.writeFileSync(path.join(orch, 'comms', 'beacons', 'a.json'), JSON.stringify({
      agent_id: 'a', role: 'coder', timestamp: new Date(T0).toISOString(),
    }));
    // board.json with a stale-owner in_flight claim.
    fs.writeFileSync(path.join(orch, 'board.json'), JSON.stringify({
      in_flight: [{ task_id: 'B4', claimed_by: 'ghost', owner_healthy: false }],
    }));
    // reconcile-report with 2 drifts.
    fs.writeFileSync(path.join(orch, 'reconcile-report.json'), JSON.stringify({
      drifts: [{ type: 'x' }, { type: 'y' }],
    }));

    const input = await gatherNeedsInput(path.join(dir, '.autoclaw'), { now: T0 });
    assert.deepStrictEqual(input.declaredRoles!.sort(), ['coder', 'security']);
    assert.ok(input.liveAgents!.some(a => a.agent_id === 'a' && !a.stale));
    assert.strictEqual(input.staleClaims!.length, 1);
    assert.strictEqual(input.unclaimedFindings, 2);

    // End-to-end: coder is covered (fresh beacon), security is the gap.
    const needs = computeNeeds(input);
    assert.deepStrictEqual(needs.role_coverage_gap, ['security']);
    assert.strictEqual(needs.staleness_pressure[0].task_id, 'B4');
  });
});
