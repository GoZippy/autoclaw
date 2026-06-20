import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireSupervisorRole, releaseSupervisorRole, readSupervisorLease,
  supervisorLeasePath, SUPERVISOR_TTL_MS,
} from '../orchestrator/supervisorLease';

function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suplease-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return root;
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');

suite('Supervisor lease (SH-2 standby failover)', () => {

  test('acquiring an unheld lease makes the caller supervisor', async () => {
    const ws = makeWs();
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    assert.strictEqual(r.holder, 'loop-A');
    assert.ok(fs.existsSync(supervisorLeasePath(ws)));
  });

  test('the same holder renews (stays supervisor, no steal)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    const lease = await readSupervisorLease(ws);
    assert.strictEqual(lease!.heartbeat, new Date(T0 + 10_000).toISOString());
    // acquired_at preserved across renewal.
    assert.strictEqual(lease!.acquired_at, new Date(T0).toISOString());
  });

  test('another host stands by while the lease is fresh', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 5_000 });
    assert.strictEqual(r.isSupervisor, false);
    assert.strictEqual(r.holder, 'loop-A');
    // The holder is unchanged on disk.
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-A');
  });

  test('a standby steals a STALE lease and becomes supervisor', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    // Past the TTL with no renewal from A → B takes over.
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + SUPERVISOR_TTL_MS + 1 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, true);
    assert.strictEqual(r.holder, 'loop-B');
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-B');
  });

  test('release only succeeds for the owning holder', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.strictEqual(await releaseSupervisorRole(ws, 'loop-B'), false, 'non-owner cannot release');
    assert.strictEqual(await releaseSupervisorRole(ws, 'loop-A'), true);
    assert.strictEqual(await readSupervisorLease(ws), null);
  });

  test('after release, the next caller acquires cleanly (no steal)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    await releaseSupervisorRole(ws, 'loop-A');
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 1000 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
  });
});
