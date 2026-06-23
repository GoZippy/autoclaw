/**
 * fleetBrief.test.ts — CL-5 one-read situational awareness.
 *
 * Seeds a temp comms tree (heartbeats carrying current_task/branch/file_scope,
 * a claims dir, a board.json with claimable/in_flight/stuck, two overlapping
 * leases, a shared inbox with a real question + an autobuild telemetry finding)
 * and asserts the brief folds them together correctly + tolerates a missing tree.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildFleetBrief,
  writeFleetBrief,
  type FleetBrief,
} from '../orchestrator/fleetBrief';

const NOW = new Date('2026-06-23T12:00:00Z').getTime();
const fresh = new Date(NOW - 10_000).toISOString();          // 10s ago → live
const stale = new Date(NOW - 10 * 60_000).toISOString();      // 10m ago → not live
const leaseExpires = new Date(NOW + 60 * 60_000).toISOString();

function commsDir(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms');
}
function write(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** Seed a representative comms tree under a temp root and return the root. */
function seedTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetbrief-'));
  const comms = commsDir(root);
  const orch = path.join(root, '.autoclaw', 'orchestrator');

  // --- Heartbeats: two sessions self-reporting current_task/branch/file_scope.
  const hbDir = path.join(comms, 'heartbeats');
  write(path.join(hbDir, 'claude-code.json'), {
    agent_id: 'claude-code', session_id: 'sess-cc', timestamp: fresh,
    status: 'active', current_task: 'CL-5 fleet.brief', branch: 'feat/coordination-runtime',
    file_scope: ['src/orchestrator/fleetBrief.ts'], sprint: 2,
  });
  write(path.join(hbDir, 'claude-code-sess-cc.json'), {
    agent_id: 'claude-code', session_id: 'sess-cc', timestamp: fresh,
    status: 'active', current_task: 'CL-5 fleet.brief', branch: 'feat/coordination-runtime',
    file_scope: ['src/orchestrator/fleetBrief.ts'], sprint: 2,
  });
  write(path.join(hbDir, 'kilocode-sess-kilo.json'), {
    agent_id: 'kilocode', session_id: 'sess-kilo', timestamp: fresh,
    status: 'active', current_task: 'CL-1 announce', branch: 'feat/coordination-runtime',
    file_scope: ['src/orchestrator/**'], sprint: 2,
  });
  // A stale session — present but not live.
  write(path.join(hbDir, 'gemini-sess-old.json'), {
    agent_id: 'gemini', session_id: 'sess-old', timestamp: stale,
    status: 'active', current_task: 'something old', sprint: 2,
  });

  // --- Claims dir (exists; the board snapshot is what carries lanes).
  write(path.join(comms, 'claims', 'CL-1.json'), {
    task_id: 'CL-1', claimed_by: 'kilocode', session_id: 'sess-kilo', claimed_at: fresh,
  });

  // --- Board snapshot: claimable / in_flight / awaiting_review / stuck lanes.
  write(path.join(orch, 'board.json'), {
    generated_at: fresh, generator: 'orchestrator-loop', fleet_size: 3, live_count: 2,
    claimable: [
      { task_id: 'CL-6', title: 'fleet.brief panel card', priority: 'high', sprint: 2, files: ['src/panel/x.ts'] },
      { task_id: 'CL-7', title: 'docs', priority: 'low', sprint: 2, files: [] },
    ],
    in_flight: [{ task_id: 'CL-1', claimed_by: 'kilocode' }],
    awaiting_review: [{ task_id: 'CL-2', author: 'claude-code' }],
    stuck: [{ task_id: 'CL-3', reason: 'owner_offline' }, { task_id: 'CL-4', reason: 'claim_expired' }],
  });

  // --- Two overlapping leases from DIFFERENT sessions → one conflict.
  const leasesDir = path.join(comms, 'leases');
  write(path.join(leasesDir, 'claude-code-sess-cc.json'), {
    agent_id: 'claude-code', session_id: 'sess-cc', globs: ['src/orchestrator/fleetBrief.ts'],
    branch: 'feat/coordination-runtime', created_at: fresh, expires_at: leaseExpires,
  });
  write(path.join(leasesDir, 'kilocode-sess-kilo.json'), {
    agent_id: 'kilocode', session_id: 'sess-kilo', globs: ['src/orchestrator/**'],
    branch: 'feat/coordination-runtime', created_at: fresh, expires_at: leaseExpires,
  });

  // --- Shared inbox: a real question (signal, awaiting me) + an autobuild
  //     telemetry finding (must be filtered out of awaiting_me).
  const shared = path.join(comms, 'inboxes', 'shared');
  write(path.join(shared, '2026-06-23T12-00-00-000Z-question-kilocode-abc.json'), {
    id: 'msg-q1', from: 'kilocode', session_id: 'sess-kilo', to: 'shared',
    type: 'question', timestamp: fresh, requires_response: true,
    payload: { question: 'Should fleet.brief cap claimable at 8?' },
  });
  write(path.join(shared, '2026-06-23T12-00-01-000Z-finding_report-autobuild-def.json'), {
    id: 'msg-f1', from: 'autobuild', to: 'shared',
    type: 'finding_report', timestamp: fresh, requires_response: true,
    payload: { finding: 'build tick ok' },
  });

  return root;
}

suite('fleetBrief — buildFleetBrief', () => {
  let root: string;
  let brief: FleetBrief;

  setup(async () => {
    root = seedTree();
    brief = await buildFleetBrief(root, { now: NOW, selfAgentId: 'claude-code', selfSessionId: 'sess-cc' });
  });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('echoes self identity', () => {
    assert.deepStrictEqual(brief.self, { agent_id: 'claude-code', session_id: 'sess-cc' });
  });

  test('sessions carry current_task / branch / file_scope', () => {
    const cc = brief.sessions.find(s => s.agent_id === 'claude-code');
    assert.ok(cc, 'claude-code session present');
    assert.strictEqual(cc!.current_task, 'CL-5 fleet.brief');
    assert.strictEqual(cc!.branch, 'feat/coordination-runtime');
    assert.deepStrictEqual(cc!.file_scope, ['src/orchestrator/fleetBrief.ts']);
    assert.strictEqual(cc!.live, true);
  });

  test('dedupes a session across its primary + sidecar heartbeat files', () => {
    const ccRows = brief.sessions.filter(s => s.agent_id === 'claude-code' && s.session_id === 'sess-cc');
    assert.strictEqual(ccRows.length, 1, 'one row per (agent, session)');
  });

  test('a stale heartbeat is present but not live', () => {
    const old = brief.sessions.find(s => s.agent_id === 'gemini');
    assert.ok(old, 'stale session still surfaced');
    assert.strictEqual(old!.live, false);
  });

  test('claimable_top populated from the board snapshot', () => {
    assert.ok(brief.claimable_top.length >= 2);
    assert.strictEqual(brief.claimable_top[0].task_id, 'CL-6');
    assert.strictEqual(brief.claimable_top[0].priority, 'high');
  });

  test('lane counts reflect the board', () => {
    assert.strictEqual(brief.in_flight_count, 1);
    assert.strictEqual(brief.awaiting_review_count, 1);
    assert.strictEqual(brief.stuck_count, 2);
  });

  test('scope_conflicts surfaces the overlap between the two sessions', () => {
    assert.strictEqual(brief.scope_conflicts.length, 1);
    const c = brief.scope_conflicts[0];
    const sessions = new Set([c.a.session_id, c.b.session_id]);
    assert.ok(sessions.has('sess-cc') && sessions.has('sess-kilo'));
  });

  test('awaiting_me contains the real question but NOT the autobuild telemetry', () => {
    const ids = brief.awaiting_me.map(m => m.id);
    assert.ok(ids.includes('msg-q1'), 'real question is awaiting me');
    assert.ok(!ids.includes('msg-f1'), 'autobuild telemetry filtered out');
  });

  test('topN caps claimable_top', async () => {
    const b = await buildFleetBrief(root, { now: NOW, selfAgentId: 'claude-code', topN: 1 });
    assert.strictEqual(b.claimable_top.length, 1);
  });

  test('no self identity → empty awaiting_me, no self block', async () => {
    const b = await buildFleetBrief(root, { now: NOW });
    assert.strictEqual(b.awaiting_me.length, 0);
    assert.strictEqual(b.self, undefined);
  });
});

suite('fleetBrief — resilience', () => {
  test('missing tree → empty brief, no throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetbrief-empty-'));
    try {
      const b = await buildFleetBrief(root, { now: NOW, selfAgentId: 'claude-code' });
      assert.deepStrictEqual(b.sessions, []);
      assert.deepStrictEqual(b.claimable_top, []);
      assert.strictEqual(b.in_flight_count, 0);
      assert.strictEqual(b.awaiting_review_count, 0);
      assert.strictEqual(b.stuck_count, 0);
      assert.deepStrictEqual(b.scope_conflicts, []);
      assert.deepStrictEqual(b.awaiting_me, []);
      assert.ok(typeof b.generated_at === 'string');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('fleetBrief — writeFleetBrief', () => {
  test('writes fleet-brief.json and returns its path', async () => {
    const root = seedTree();
    try {
      const dest = await writeFleetBrief(root, undefined);
      assert.strictEqual(dest, path.join(commsDir(root), 'fleet-brief.json'));
      const written = JSON.parse(fs.readFileSync(dest, 'utf8')) as FleetBrief;
      assert.ok(Array.isArray(written.sessions));
      assert.ok(typeof written.generated_at === 'string');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes a passed-in brief verbatim', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetbrief-w-'));
    try {
      const brief = await buildFleetBrief(root, { now: NOW });
      const dest = await writeFleetBrief(root, brief);
      const written = JSON.parse(fs.readFileSync(dest, 'utf8')) as FleetBrief;
      assert.strictEqual(written.generated_at, brief.generated_at);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
