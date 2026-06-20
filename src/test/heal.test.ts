import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherRecoverySignals, runHealPhase } from '../orchestrator/heal';

function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms', 'claims'), { recursive: true });
  return root;
}
const orch = (r: string) => path.join(r, '.autoclaw', 'orchestrator');
const claimsDir = (r: string) => path.join(orch(r), 'comms', 'claims');
const sharedInbox = (r: string) => path.join(orch(r), 'comms', 'inboxes', 'shared');

const T0 = Date.parse('2026-06-17T12:00:00.000Z');
const writeJson = (p: string, o: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

suite('HEAL phase — gatherRecoverySignals (SH-1 wiring)', () => {

  test('a stale-owner in_flight claim past TTL → staleClaim {owner_healthy:false, expired:true}', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'board.json'), {
      in_flight: [{ task_id: 'B4', claimed_by: 'ghost', owner_healthy: false }],
    });
    writeJson(path.join(claimsDir(ws), 'B4.json'), { task_id: 'B4', expires_at: new Date(T0 - 1000).toISOString() });

    const sig = await gatherRecoverySignals(ws, { now: T0 });
    assert.strictEqual(sig.staleClaims!.length, 1);
    assert.deepStrictEqual(sig.staleClaims![0], { task_id: 'B4', owner: 'ghost', owner_healthy: false, expired: true });
  });

  test('a healthy owner produces NO stale claim', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'board.json'), {
      in_flight: [{ task_id: 'B5', claimed_by: 'alice', owner_healthy: true }],
    });
    writeJson(path.join(claimsDir(ws), 'B5.json'), { task_id: 'B5', expires_at: new Date(T0 - 1000).toISOString() });
    const sig = await gatherRecoverySignals(ws, { now: T0 });
    assert.strictEqual((sig.staleClaims ?? []).length, 0);
  });

  test('a stale owner whose claim is NOT yet expired → expired:false', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'board.json'), {
      in_flight: [{ task_id: 'B6', claimed_by: 'ghost', owner_healthy: false }],
    });
    writeJson(path.join(claimsDir(ws), 'B6.json'), { task_id: 'B6', expires_at: new Date(T0 + 3600_000).toISOString() });
    const sig = await gatherRecoverySignals(ws, { now: T0 });
    assert.strictEqual(sig.staleClaims![0].expired, false);
  });

  test('reconcile drifts become driftFindings', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'reconcile-report.json'), {
      drifts: [{ type: 'task_status_mismatch', task_id: 'C1', description: 'status differs' }],
    });
    const sig = await gatherRecoverySignals(ws, { now: T0 });
    assert.strictEqual(sig.driftFindings!.length, 1);
    assert.strictEqual(sig.driftFindings![0].task_id, 'C1');
  });
});

suite('HEAL phase — runHealPhase (act-then-report)', () => {

  test('act mode steals a stale+expired claim (deletes the file) and emits a finding', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'board.json'), {
      in_flight: [{ task_id: 'B4', claimed_by: 'ghost', owner_healthy: false }],
    });
    const claimFile = path.join(claimsDir(ws), 'B4.json');
    writeJson(claimFile, { task_id: 'B4', expires_at: new Date(T0 - 1000).toISOString() });

    const res = await runHealPhase(ws, { mode: 'act', now: T0 });
    assert.deepStrictEqual(res.stolen, ['B4']);
    assert.strictEqual(fs.existsSync(claimFile), false, 'stale claim file should be deleted');
    assert.ok(res.findingsEmitted >= 1);
    // A finding_report landed in the shared inbox.
    const files = fs.readdirSync(sharedInbox(ws)).filter(f => f.includes('finding_report'));
    assert.ok(files.length >= 1);
  });

  test('propose mode emits findings but does NOT delete the claim', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'board.json'), {
      in_flight: [{ task_id: 'B4', claimed_by: 'ghost', owner_healthy: false }],
    });
    const claimFile = path.join(claimsDir(ws), 'B4.json');
    writeJson(claimFile, { task_id: 'B4', expires_at: new Date(T0 - 1000).toISOString() });

    const res = await runHealPhase(ws, { mode: 'propose', now: T0 });
    assert.strictEqual(res.stolen.length, 0);
    assert.strictEqual(fs.existsSync(claimFile), true, 'propose mode must not mutate');
    assert.ok(res.findingsEmitted >= 1);
  });

  test('drift surfaces a finding but never deletes a claim', async () => {
    const ws = makeWs();
    writeJson(path.join(orch(ws), 'reconcile-report.json'), {
      drifts: [{ type: 'task_status_mismatch', task_id: 'C1', description: 'x' }],
    });
    const res = await runHealPhase(ws, { mode: 'act', now: T0 });
    assert.strictEqual(res.stolen.length, 0);
    assert.ok(res.actions.some(a => a.kind === 'surface_finding'));
    assert.ok(res.findingsEmitted >= 1);
  });

  test('no signals → no actions, no findings', async () => {
    const ws = makeWs();
    const res = await runHealPhase(ws, { mode: 'act', now: T0 });
    assert.strictEqual(res.actions.length, 0);
    assert.strictEqual(res.findingsEmitted, 0);
    assert.strictEqual(res.stolen.length, 0);
  });
});
