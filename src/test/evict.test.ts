import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  evictAgent, readIntent, intentsDir,
  EvictAuthError, EvictHardOnFreshError, EvictRemoteBlockedError,
  type EvictIntent,
} from '../fleet/evict';
import { upsertWorker, readWorker } from '../fleet/workforce';
import { createInvite, readInvite } from '../fleet/invites';
import { writeBeacon, machineBeaconDir, workspaceBeaconDir, BEACON_TTL_MS } from '../fleet/beacons';

const fsp = fs.promises;
const T0 = Date.parse('2026-06-23T12:00:00.000Z');

/** A fresh isolated machine-home + workspace comms tree per test. */
function makeEnv(): { home: string; commsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evict-test-'));
  const home = path.join(root, 'home');
  const commsDir = path.join(root, 'ws', '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(commsDir, { recursive: true });
  return { home, commsDir };
}

/** Write a claim file the way the orchestrator loop does. */
async function writeClaim(
  commsDir: string,
  taskId: string,
  claim: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(commsDir, 'claims');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify(claim, null, 2), 'utf8');
}

async function claimExists(commsDir: string, taskId: string): Promise<boolean> {
  try { await fsp.access(path.join(commsDir, 'claims', `${taskId}.json`)); return true; }
  catch { return false; }
}

suite('Evict — SAFE CORE transaction (LANE B)', () => {

  test('auth gate: rejects an unauthorized operator (deny-by-default)', async () => {
    const { home, commsDir } = makeEnv();
    await assert.rejects(
      () => evictAgent(
        { agentId: 'kilocode', operator: 'mallory', commsDir, homeDir: home },
        { authorizedOperators: ['eric'], now: T0 },
      ),
      (e: unknown) => e instanceof EvictAuthError,
    );
    // No intent record is created by a pre-gate rejection.
    let files: string[] = [];
    try { files = await fsp.readdir(intentsDir(commsDir)); } catch { /* none */ }
    assert.strictEqual(files.length, 0);
  });

  test('auth gate: rejects an empty operator', async () => {
    const { home, commsDir } = makeEnv();
    await assert.rejects(
      () => evictAgent({ agentId: 'kilocode', operator: '', commsDir, homeDir: home }, { now: T0 }),
      (e: unknown) => e instanceof EvictAuthError,
    );
  });

  test('cross-machine evict is BLOCKED (remote refusal, §5)', async () => {
    const { home, commsDir } = makeEnv();
    await assert.rejects(
      () => evictAgent(
        { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
        { remote: true, now: T0 },
      ),
      (e: unknown) => e instanceof EvictRemoteBlockedError,
    );
  });

  test('happy path: releases claims, revokes trust+invite, tears down presence, retires, intent done', async () => {
    const { home, commsDir } = makeEnv();
    // The target owns two claims + a sibling agent owns one.
    await writeClaim(commsDir, 'T1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'T1' });
    await writeClaim(commsDir, 'T2', { claimed_by: 'kilocode', session_id: 's1', task_id: 'T2' });
    await writeClaim(commsDir, 'T9', { claimed_by: 'claude-code', session_id: 'sx', task_id: 'T9' });
    // The target is a pooled worker arrived under an invite, with a live beacon.
    await upsertWorker({ agent_id: 'kilocode', trust: 'auto' }, { now: T0, homeDir: home });
    await createInvite(
      { issued_by: 'eric', project: 'autoclaw', token: 'tok-kilo' },
      { scope: 'machine', homeDir: home, now: T0 },
    );
    // Mark the invite consumed by the target (mirror consumeInvite's stamp).
    const invPath = path.join(home, '.autoclaw', 'invites', 'tok-kilo.json');
    const inv = JSON.parse(await fsp.readFile(invPath, 'utf8'));
    inv.consumed_by = { agent_id: 'kilocode', session_id: 's1', at: new Date(T0).toISOString() };
    await fsp.writeFile(invPath, JSON.stringify(inv, null, 2) + '\n', 'utf8');
    await writeBeacon(
      { agent_id: 'kilocode', session_id: 's1', timestamp: new Date(T0).toISOString() },
      { scope: 'machine', homeDir: home },
    );
    await writeBeacon(
      { agent_id: 'kilocode', session_id: 's1', timestamp: new Date(T0).toISOString() },
      { scope: 'workspace', commsDir },
    );
    // A registry row for the target.
    await fsp.writeFile(
      path.join(commsDir, 'registry.json'),
      JSON.stringify({ agents: [{ id: 'kilocode' }, { id: 'claude-code' }] }, null, 2),
      'utf8',
    );

    const intent = await evictAgent(
      { agentId: 'kilocode', sessionId: 's1', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );

    assert.strictEqual(intent.state, 'done');
    assert.strictEqual(intent.error, null);
    assert.ok(intent.released_tasks.includes('T1'));
    assert.ok(intent.released_tasks.includes('T2'));
    // Target claims gone, sibling's claim untouched.
    assert.strictEqual(await claimExists(commsDir, 'T1'), false);
    assert.strictEqual(await claimExists(commsDir, 'T2'), false);
    assert.strictEqual(await claimExists(commsDir, 'T9'), true);
    // Trust revoked, worker retired (résumé kept).
    const w = await readWorker('kilocode', home);
    assert.ok(w);
    assert.strictEqual(w!.trust, 'off');
    assert.strictEqual(w!.status, 'retired');
    // Invite revoked (single-use token can't be replayed).
    assert.strictEqual(await readInvite('tok-kilo', { scope: 'machine', homeDir: home }), null);
    // Beacons torn down in BOTH homes.
    assert.strictEqual(fs.existsSync(path.join(machineBeaconDir(home), 'kilocode-s1.json')), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceBeaconDir(commsDir), 'kilocode-s1.json')), false);
    // Registry row marked evicted; sibling untouched.
    const reg = JSON.parse(await fsp.readFile(path.join(commsDir, 'registry.json'), 'utf8'));
    assert.strictEqual(reg.agents.find((a: any) => a.id === 'kilocode').status, 'evicted');
    assert.strictEqual(reg.agents.find((a: any) => a.id === 'claude-code').status, undefined);
  });

  test('claim release only deletes the targeted session, not a sibling window', async () => {
    const { home, commsDir } = makeEnv();
    await writeClaim(commsDir, 'A1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'A1' });
    await writeClaim(commsDir, 'A2', { claimed_by: 'kilocode', session_id: 's2', task_id: 'A2' });
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });

    const intent = await evictAgent(
      { agentId: 'kilocode', sessionId: 's1', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );

    assert.strictEqual(intent.state, 'done');
    assert.deepStrictEqual(intent.released_tasks, ['A1']);
    assert.strictEqual(await claimExists(commsDir, 'A1'), false);
    assert.strictEqual(await claimExists(commsDir, 'A2'), true, "sibling session's claim survives");
  });

  test('evicting the whole agent (no session) releases every session claim', async () => {
    const { home, commsDir } = makeEnv();
    await writeClaim(commsDir, 'B1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'B1' });
    await writeClaim(commsDir, 'B2', { claimed_by: 'kilocode', session_id: 's2', task_id: 'B2' });
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    await writeBeacon({ agent_id: 'kilocode', session_id: 's1', timestamp: new Date(T0).toISOString() }, { scope: 'machine', homeDir: home });
    await writeBeacon({ agent_id: 'kilocode', session_id: 's2', timestamp: new Date(T0).toISOString() }, { scope: 'machine', homeDir: home });

    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );

    assert.strictEqual(intent.state, 'done');
    assert.ok(intent.released_tasks.includes('B1') && intent.released_tasks.includes('B2'));
    assert.strictEqual(await claimExists(commsDir, 'B1'), false);
    assert.strictEqual(await claimExists(commsDir, 'B2'), false);
    // Both session beacons swept.
    assert.strictEqual(fs.existsSync(path.join(machineBeaconDir(home), 'kilocode-s1.json')), false);
    assert.strictEqual(fs.existsSync(path.join(machineBeaconDir(home), 'kilocode-s2.json')), false);
  });

  test('hard mode is REFUSED on a fresh heartbeat', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    await writeClaim(commsDir, 'H1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'H1' });
    // Fresh beacon (same instant as `now`).
    await writeBeacon({ agent_id: 'kilocode', session_id: 's1', timestamp: new Date(T0).toISOString() }, { scope: 'machine', homeDir: home });

    await assert.rejects(
      () => evictAgent(
        { agentId: 'kilocode', sessionId: 's1', mode: 'hard', operator: 'eric', commsDir, homeDir: home },
        { now: T0 },
      ),
      (e: unknown) => e instanceof EvictHardOnFreshError,
    );
    // The claim is NOT yanked from under a live agent.
    assert.strictEqual(await claimExists(commsDir, 'H1'), true);
    // The intent is recorded as failed (resumable), not done.
    const files = await fsp.readdir(intentsDir(commsDir));
    assert.strictEqual(files.length, 1);
    const intent = JSON.parse(await fsp.readFile(path.join(intentsDir(commsDir), files[0]), 'utf8')) as EvictIntent;
    assert.strictEqual(intent.state, 'failed');
    assert.ok(intent.error && /fresh/i.test(intent.error));
  });

  test('hard mode is ALLOWED when the owner heartbeat is already stale', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    await writeClaim(commsDir, 'S1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'S1' });
    // Beacon older than BEACON_TTL_MS.
    const old = new Date(T0 - BEACON_TTL_MS - 60_000).toISOString();
    await writeBeacon({ agent_id: 'kilocode', session_id: 's1', timestamp: old }, { scope: 'machine', homeDir: home });

    const intent = await evictAgent(
      { agentId: 'kilocode', sessionId: 's1', mode: 'hard', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.state, 'done');
    assert.deepStrictEqual(intent.released_tasks, ['S1']);
    assert.strictEqual(await claimExists(commsDir, 'S1'), false);
  });

  test('hard mode is ALLOWED when there is no beacon at all (nothing live to protect)', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'ghost' }, { now: T0, homeDir: home });
    await writeClaim(commsDir, 'G1', { claimed_by: 'ghost', task_id: 'G1' });

    const intent = await evictAgent(
      { agentId: 'ghost', mode: 'hard', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.state, 'done');
    assert.strictEqual(await claimExists(commsDir, 'G1'), false);
  });

  test('graceful default records a drain_deadline', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0, drainMs: 90_000 },
    );
    assert.strictEqual(intent.mode, 'graceful');
    assert.strictEqual(intent.drain_deadline, new Date(T0 + 90_000).toISOString());
  });

  test('idempotent: re-running the same intent_id past "done" is a no-op', async () => {
    const { home, commsDir } = makeEnv();
    await writeClaim(commsDir, 'I1', { claimed_by: 'kilocode', task_id: 'I1' });
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });

    const first = await evictAgent(
      { agentId: 'kilocode', intentId: 'evict-fixed', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(first.state, 'done');
    assert.deepStrictEqual(first.released_tasks, ['I1']);

    // Re-run: claim already gone, trust already off, worker already retired.
    const second = await evictAgent(
      { agentId: 'kilocode', intentId: 'evict-fixed', operator: 'eric', commsDir, homeDir: home },
      { now: T0 + 1000 },
    );
    assert.strictEqual(second.state, 'done');
    // No duplicate task ids accumulated and no second teardown.
    assert.deepStrictEqual(second.released_tasks, ['I1']);
    assert.strictEqual(second.intent_id, 'evict-fixed');
    // Exactly one intent file on disk.
    const files = await fsp.readdir(intentsDir(commsDir));
    assert.strictEqual(files.length, 1);
  });

  test('failed → resume: a hard-on-fresh failure completes when re-run after the beacon goes stale', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    await writeClaim(commsDir, 'R1', { claimed_by: 'kilocode', session_id: 's1', task_id: 'R1' });
    await writeBeacon({ agent_id: 'kilocode', session_id: 's1', timestamp: new Date(T0).toISOString() }, { scope: 'machine', homeDir: home });

    // First run fails (fresh heartbeat).
    await assert.rejects(
      () => evictAgent(
        { agentId: 'kilocode', sessionId: 's1', mode: 'hard', intentId: 'evict-resume', operator: 'eric', commsDir, homeDir: home },
        { now: T0 },
      ),
      (e: unknown) => e instanceof EvictHardOnFreshError,
    );
    let intent = await readIntent(commsDir, 'evict-resume');
    assert.ok(intent && intent.state === 'failed');

    // Re-run later, after the beacon is stale → resumes the SAME intent to done.
    const later = T0 + BEACON_TTL_MS + 60_000;
    intent = await evictAgent(
      { agentId: 'kilocode', sessionId: 's1', mode: 'hard', intentId: 'evict-resume', operator: 'eric', commsDir, homeDir: home },
      { now: later },
    );
    assert.strictEqual(intent.state, 'done');
    assert.deepStrictEqual(intent.released_tasks, ['R1']);
    assert.strictEqual(await claimExists(commsDir, 'R1'), false);
  });

  test('dependents whose depends_on referenced a released task are surfaced as blocked', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    // Target holds D1; a survivor's claim D7 depends on D1.
    await writeClaim(commsDir, 'D1', { claimed_by: 'kilocode', task_id: 'D1' });
    await writeClaim(commsDir, 'D7', { claimed_by: 'claude-code', task_id: 'D7', depends_on: ['D1'] });

    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.ok(intent.released_tasks.includes('D1'));
    assert.ok(intent.blocked_dependents.includes('D7'));
    // The DAG is NOT rewritten — D7's claim survives untouched.
    assert.strictEqual(await claimExists(commsDir, 'D7'), true);
  });

  test('consensus reconcile records the target as evicted on an owed, uncast ballot', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    const activeDir = path.join(commsDir, 'consensus', 'active');
    await fsp.mkdir(activeDir, { recursive: true });
    await fsp.writeFile(
      path.join(activeDir, 'C9.json'),
      JSON.stringify({
        task_id: 'C9',
        expected_voters: ['kilocode', 'claude-code', 'reviewer'],
        votes: { 'claude-code': 'approve' },
      }, null, 2),
      'utf8',
    );

    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.ok(intent.reconciled_votes.includes('C9'));
    const item = JSON.parse(await fsp.readFile(path.join(activeDir, 'C9.json'), 'utf8'));
    assert.deepStrictEqual(item.evicted_voters, ['kilocode']);
    // We never forge a vote.
    assert.strictEqual(item.votes.kilocode, undefined);
  });

  test('consensus reconcile leaves an already-cast ballot alone', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    const activeDir = path.join(commsDir, 'consensus', 'active');
    await fsp.mkdir(activeDir, { recursive: true });
    await fsp.writeFile(
      path.join(activeDir, 'C5.json'),
      JSON.stringify({
        task_id: 'C5',
        expected_voters: ['kilocode', 'claude-code'],
        votes: { kilocode: 'approve' },
      }, null, 2),
      'utf8',
    );

    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.reconciled_votes.includes('C5'), false);
    const item = JSON.parse(await fsp.readFile(path.join(activeDir, 'C5.json'), 'utf8'));
    assert.strictEqual(item.evicted_voters, undefined);
  });

  test('intent state machine: requested → acting → done with a full step checklist', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.state, 'done');
    for (const step of Object.values(intent.steps)) {
      assert.strictEqual(step, 'done', 'every step converged');
    }
    // The on-disk record matches the returned envelope.
    const onDisk = await readIntent(commsDir, intent.intent_id);
    assert.ok(onDisk);
    assert.strictEqual(onDisk!.state, 'done');
    assert.strictEqual(onDisk!.requested_by, 'eric');
    assert.strictEqual(onDisk!.kind, 'evict');
  });

  test('evict succeeds with no worker / no claims / no presence (everything idempotent)', async () => {
    const { home, commsDir } = makeEnv();
    const intent = await evictAgent(
      { agentId: 'nobody', operator: 'eric', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.state, 'done');
    assert.deepStrictEqual(intent.released_tasks, []);
    assert.deepStrictEqual(intent.reconciled_votes, []);
  });

  test('default auth (no allowlist) admits any non-empty operator', async () => {
    const { home, commsDir } = makeEnv();
    await upsertWorker({ agent_id: 'kilocode' }, { now: T0, homeDir: home });
    const intent = await evictAgent(
      { agentId: 'kilocode', operator: 'claude-code', commsDir, homeDir: home },
      { now: T0 },
    );
    assert.strictEqual(intent.state, 'done');
    assert.strictEqual(intent.requested_by, 'claude-code');
  });
});
