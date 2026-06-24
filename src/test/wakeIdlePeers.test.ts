/**
 * wakeIdlePeers.test.ts — L3 board-grounded wake nudges.
 *
 * Pure tests for the claimable↔idle matcher, plus fs tests for the work_available
 * delivery + recently-woken dedup, the registry-backed idle profiles, and the
 * review_resolved author-notify with its _notified ledger dedup.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  matchClaimableToIdle,
  wakeIdlePeers,
  notifyReviewResolved,
  readRecentlyWoken,
  readIdleAgentProfiles,
  type IdleAgentProfile,
} from '../orchestrator/wakeIdlePeers';
import type { BoardClaimableItem } from '../orchestrator/board';
import type { Message } from '../comms';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function claimable(task_id: string, priority?: 'high' | 'medium' | 'low', files: string[] = []): BoardClaimableItem {
  return { task_id, priority, files, reason: 'open_no_claim' };
}
function idleP(agentId: string, extra: Partial<IdleAgentProfile> = {}): IdleAgentProfile {
  return { agentId, ...extra };
}
function makeWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-wake-'));
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared'), { recursive: true });
  return d;
}
function inboxMsgs(ws: string, agent: string): Message[] {
  const dir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', agent);
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Message);
}
function writeRegistry(ws: string, agents: unknown[]): void {
  fs.writeFileSync(
    path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'registry.json'),
    JSON.stringify({ agents }, null, 2), 'utf8',
  );
}

// ---------------------------------------------------------------------------
// matchClaimableToIdle (pure)
// ---------------------------------------------------------------------------

suite('wakeIdlePeers — matchClaimableToIdle (pure)', () => {
  test('matches idle agents to distinct claimable tasks, one per agent', () => {
    const m = matchClaimableToIdle([claimable('T1', 'high'), claimable('T2', 'medium')], [idleP('a'), idleP('b')]);
    assert.strictEqual(m.length, 2);
    assert.strictEqual(new Set(m.map((x) => x.agentId)).size, 2, 'distinct agents');
    assert.strictEqual(new Set(m.map((x) => x.task.task_id)).size, 2, 'distinct tasks');
  });

  test('more claimable than idle → at most idle-count matches (capacity 1 each)', () => {
    const m = matchClaimableToIdle([claimable('T1'), claimable('T2'), claimable('T3')], [idleP('a')]);
    assert.strictEqual(m.length, 1);
  });

  test('empty inputs → []', () => {
    assert.deepStrictEqual(matchClaimableToIdle([], [idleP('a')]), []);
    assert.deepStrictEqual(matchClaimableToIdle([claimable('T1')], []), []);
  });

  test('a task no idle agent can serve (required caps) is skipped', () => {
    const m = matchClaimableToIdle(
      [claimable('T1')],
      [idleP('a', { capabilities: ['python'] })],
      { requiredCapabilitiesByTask: { T1: ['rust'] } },
    );
    assert.strictEqual(m.length, 0, 'no capable agent → no match (left for capability_query)');
  });

  test('one task + two idle agents → exactly ONE match (no two agents told to claim it)', () => {
    const m = matchClaimableToIdle([claimable('T1')], [idleP('a'), idleP('b')]);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].task.task_id, 'T1');
  });

  test('a capable agent IS matched to a task requiring that capability', () => {
    const m = matchClaimableToIdle(
      [claimable('T1')],
      [idleP('a', { capabilities: ['rust'] })],
      { requiredCapabilitiesByTask: { T1: ['rust'] } },
    );
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].agentId, 'a');
  });
});

// ---------------------------------------------------------------------------
// wakeIdlePeers + readRecentlyWoken (fs)
// ---------------------------------------------------------------------------

suite('wakeIdlePeers — work_available delivery + dedup (fs)', () => {
  test('writes a work_available to the matched idle agent inbox', async () => {
    const ws = makeWs();
    try {
      const res = await wakeIdlePeers({
        workspaceRoot: ws, claimable: [claimable('T1', 'high', ['src/a.ts'])], idle: [idleP('kiro')],
      });
      assert.strictEqual(res.nudged.length, 1);
      const msgs = inboxMsgs(ws, 'kiro');
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].type, 'work_available');
      assert.strictEqual(msgs[0].task_id, 'T1');
      assert.ok(msgs[0].expires_at, 'carries an expiry so GC can reap it');
      assert.deepStrictEqual(msgs[0].payload.files, ['src/a.ts']);
      assert.strictEqual(msgs[0].payload.board_grounded, true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('skips an agent in recentlyWoken (no re-nudge)', async () => {
    const ws = makeWs();
    try {
      const res = await wakeIdlePeers({
        workspaceRoot: ws, claimable: [claimable('T1')], idle: [idleP('kiro')],
        recentlyWoken: new Set(['kiro']),
      });
      assert.strictEqual(res.nudged.length, 0);
      assert.strictEqual(inboxMsgs(ws, 'kiro').length, 0);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('readRecentlyWoken detects a fresh work_available, ignores it outside the window', async () => {
    const ws = makeWs();
    try {
      await wakeIdlePeers({ workspaceRoot: ws, claimable: [claimable('T1')], idle: [idleP('kiro')] });
      assert.ok((await readRecentlyWoken(ws)).has('kiro'), 'fresh nudge detected');
      // A window evaluated far in the future treats the same file as stale.
      const stale = await readRecentlyWoken(ws, 1000, Date.now() + 10_000_000);
      assert.ok(!stale.has('kiro'), 'outside the window → not recently woken');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// readIdleAgentProfiles (fs)
// ---------------------------------------------------------------------------

suite('wakeIdlePeers — readIdleAgentProfiles (fs)', () => {
  test('reads capabilities + trust from registry; unknown agents get a bare profile', async () => {
    const ws = makeWs();
    try {
      writeRegistry(ws, [{ id: 'kiro', agent_type: 'coder', capabilities: ['code', 'test'], trust_level: 'high' }]);
      const profs = await readIdleAgentProfiles(ws, ['kiro', 'ghost']);
      assert.strictEqual(profs.length, 2);
      const k = profs.find((p) => p.agentId === 'kiro')!;
      assert.deepStrictEqual(k.capabilities, ['code', 'test']);
      assert.strictEqual(k.trust_level, 'high');
      assert.strictEqual(k.agent_type, 'coder');
      const ghost = profs.find((p) => p.agentId === 'ghost')!;
      assert.strictEqual(ghost.capabilities, undefined, 'unknown agent → no caps, still a target');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// notifyReviewResolved (fs)
// ---------------------------------------------------------------------------

function writeResolved(ws: string, taskId: string, rec: Record<string, unknown>): void {
  const dir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'resolved');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify({ task_id: taskId, ...rec }, null, 2), 'utf8');
}
function notifiedExists(ws: string, taskId: string): boolean {
  return fs.existsSync(path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', '_notified', `${taskId}.json`));
}

suite('wakeIdlePeers — notifyReviewResolved (reconciliation, fs)', () => {
  test('notifies each resolved task author exactly once (ledger dedups); skips empty/self', async () => {
    const ws = makeWs();
    try {
      writeResolved(ws, 'T1', { author: 'kiro', verdict: 'approved', approvals: 2, panel_size: 3, rule: 'majority' });
      writeResolved(ws, 'T2', { verdict: 'rejected' });                  // no author → skip
      writeResolved(ws, 'T3', { author: 'orchestrator-loop', verdict: 'approved' }); // self → skip
      const r1 = await notifyReviewResolved({ workspaceRoot: ws });
      assert.deepStrictEqual(r1.notified, ['kiro']);
      const msgs = inboxMsgs(ws, 'kiro');
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].type, 'review_resolved');
      assert.strictEqual(msgs[0].task_id, 'T1');
      assert.strictEqual(msgs[0].payload.decision, 'approved');
      assert.ok(notifiedExists(ws, 'T2'), 'skipped task is still ledgered so it is not rescanned');

      // Reconciliation is idempotent — a second sweep delivers nothing new.
      const r2 = await notifyReviewResolved({ workspaceRoot: ws });
      assert.deepStrictEqual(r2.notified, []);
      assert.strictEqual(inboxMsgs(ws, 'kiro').length, 1, 'no duplicate notify');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('a delivery failure does NOT ledger the task, so a later sweep retries (no lost notify)', async () => {
    const ws = makeWs();
    try {
      writeResolved(ws, 'T4', { author: 'kiro2', verdict: 'approved' });
      // Make kiro2's inbox unwritable: a regular FILE where the inbox dir must be,
      // so sendMessage's mkdir(inboxes/kiro2, {recursive}) throws ENOTDIR.
      const inboxes = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes');
      fs.mkdirSync(inboxes, { recursive: true });
      fs.writeFileSync(path.join(inboxes, 'kiro2'), 'blocker', 'utf8');

      const r1 = await notifyReviewResolved({ workspaceRoot: ws });
      assert.deepStrictEqual(r1.notified, [], 'delivery failed → nobody notified');
      assert.ok(!notifiedExists(ws, 'T4'), 'ledger NOT written on delivery failure (slot released)');

      // Unblock and retry: the unledgered verdict is re-delivered exactly once.
      fs.rmSync(path.join(inboxes, 'kiro2'));
      const r2 = await notifyReviewResolved({ workspaceRoot: ws });
      assert.deepStrictEqual(r2.notified, ['kiro2'], 'retry succeeds');
      assert.strictEqual(inboxMsgs(ws, 'kiro2').length, 1, 'exactly one message, no double-send');
      assert.ok(notifiedExists(ws, 'T4'), 'ledgered after success');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});
