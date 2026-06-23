/**
 * claimReaper.test.ts — CL-3 dead-session claim reaper.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  planReap, reapDeadClaims, liveFromHeartbeats,
  type ReapableClaim, type HeartbeatLite,
} from '../orchestrator/claimReaper';

const NOW = new Date('2026-06-23T12:00:00Z').getTime();
const fresh = new Date(NOW - 30_000).toISOString();        // 30s ago → live
const staleHb = new Date(NOW - 10 * 60_000).toISOString(); // 10min ago → dead
const expiredAt = new Date(NOW - 1000).toISOString();      // claim expired
const futureAt = new Date(NOW + 60 * 60_000).toISOString(); // not expired

function claim(over: Partial<ReapableClaim> & { task_id: string }): ReapableClaim {
  return { claimed_by: 'claude-code', file: `${over.task_id}.json`, expires_at: expiredAt, ...over };
}

suite('claimReaper — planReap (pure)', () => {
  test('dead session + expired → reaped', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', session_id: 'live', timestamp: fresh }];
    const d = planReap([claim({ task_id: 'T1', session_id: 'dead' })], hbs, NOW);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].task_id, 'T1');
  });

  test('dead session but NOT expired → skipped (grace window)', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', session_id: 'live', timestamp: fresh }];
    const d = planReap([claim({ task_id: 'T1', session_id: 'dead', expires_at: futureAt })], hbs, NOW);
    assert.strictEqual(d.length, 0);
  });

  test('live session + expired → skipped (owner is working)', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', session_id: 'sess-A', timestamp: fresh }];
    const d = planReap([claim({ task_id: 'T1', session_id: 'sess-A' })], hbs, NOW);
    assert.strictEqual(d.length, 0);
  });

  test('agent keeps a fresh heartbeat under a DIFFERENT session → dead-session claim still reaped', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', session_id: 'live-now', timestamp: fresh }];
    const d = planReap([claim({ task_id: 'T1', session_id: 'old-dead' })], hbs, NOW);
    assert.strictEqual(d.length, 1);
  });

  test('legacy claim (no session) + agent offline + expired → reaped', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', timestamp: staleHb }];
    const d = planReap([claim({ task_id: 'T1', session_id: undefined })], hbs, NOW);
    assert.strictEqual(d.length, 1);
  });

  test('legacy claim (no session) + agent live → skipped', () => {
    const hbs: HeartbeatLite[] = [{ agent_id: 'claude-code', timestamp: fresh }];
    const d = planReap([claim({ task_id: 'T1', session_id: undefined })], hbs, NOW);
    assert.strictEqual(d.length, 0);
  });

  test('missing task_id / file → skipped', () => {
    const d = planReap([{ task_id: '', claimed_by: 'x', file: '' } as ReapableClaim], [], NOW);
    assert.strictEqual(d.length, 0);
  });

  test('liveFromHeartbeats: halted/offline + stale excluded', () => {
    const live = liveFromHeartbeats([
      { agent_id: 'a', session_id: 's1', timestamp: fresh },
      { agent_id: 'b', session_id: 's2', timestamp: fresh, status: 'halted' },
      { agent_id: 'c', session_id: 's3', timestamp: staleHb },
    ], NOW);
    assert.ok(live.sessions.has('s1'));
    assert.ok(!live.sessions.has('s2'));
    assert.ok(!live.sessions.has('s3'));
  });
});

suite('claimReaper — reapDeadClaims (IO)', () => {
  let dir: string;
  const C = () => path.join(dir, '.autoclaw', 'orchestrator', 'comms');
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeClaim(file: string, obj: unknown): void {
    const cd = path.join(C(), 'claims');
    fs.mkdirSync(cd, { recursive: true });
    fs.writeFileSync(path.join(cd, file), JSON.stringify(obj));
  }
  function writeHb(file: string, obj: unknown): void {
    const hd = path.join(C(), 'heartbeats');
    fs.mkdirSync(hd, { recursive: true });
    fs.writeFileSync(path.join(hd, file), JSON.stringify(obj));
  }

  test('apply:false is a dry run — nothing moved', async () => {
    writeClaim('T1.json', { task_id: 'T1', claimed_by: 'claude-code', session_id: 'dead', expires_at: expiredAt });
    writeHb('claude-code.json', { agent_id: 'claude-code', session_id: 'live', timestamp: fresh });
    const r = await reapDeadClaims(dir, { now: NOW, apply: false });
    assert.strictEqual(r.reaped.length, 1);
    assert.strictEqual(r.applied, false);
    assert.ok(fs.existsSync(path.join(C(), 'claims', 'T1.json')));
  });

  test('apply:true archives the claim, emits a finding, frees the task', async () => {
    writeClaim('T1.json', { task_id: 'T1', claimed_by: 'claude-code', session_id: 'dead', expires_at: expiredAt });
    writeHb('claude-code.json', { agent_id: 'claude-code', session_id: 'live', timestamp: fresh });
    const r = await reapDeadClaims(dir, { now: NOW, apply: true });
    assert.strictEqual(r.reaped.length, 1);
    assert.ok(!fs.existsSync(path.join(C(), 'claims', 'T1.json')), 'original claim removed');
    const archived = fs.readdirSync(path.join(C(), 'claims', '_reaped'));
    assert.ok(archived.some(f => f.endsWith('T1.json')), 'claim archived to _reaped/');
    const findings = fs.readdirSync(path.join(C(), 'inboxes', 'shared')).filter(f => f.includes('claim-reaper'));
    assert.strictEqual(findings.length, 1, 'one finding_report emitted');
  });

  test('a live-session claim is left untouched', async () => {
    writeClaim('T1.json', { task_id: 'T1', claimed_by: 'claude-code', session_id: 'sess-A', expires_at: expiredAt });
    writeHb('claude-code-sessA.json', { agent_id: 'claude-code', session_id: 'sess-A', timestamp: fresh });
    const r = await reapDeadClaims(dir, { now: NOW, apply: true });
    assert.strictEqual(r.reaped.length, 0);
    assert.ok(fs.existsSync(path.join(C(), 'claims', 'T1.json')));
  });

  test('missing comms tree → no-op, never throws', async () => {
    const r = await reapDeadClaims(dir, { now: NOW, apply: true });
    assert.strictEqual(r.scanned, 0);
    assert.strictEqual(r.reaped.length, 0);
  });
});
