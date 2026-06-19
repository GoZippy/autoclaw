import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { messageToOutcome, ingestWorkforceSignals } from '../fleet/workforceIngest';
import { readWorker } from '../fleet/workforce';

function makeWs(): { ws: string; home: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfingest-test-'));
  const ws = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared'), { recursive: true });
  return { ws, home };
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');
const sharedDir = (ws: string) => path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');

function dropMsg(ws: string, name: string, msg: unknown) {
  fs.writeFileSync(path.join(sharedDir(ws), name), JSON.stringify(msg));
}

suite('Workforce ingestion — messageToOutcome (HRW-1)', () => {

  test('task_complete from a real agent → task_complete outcome', () => {
    const m = messageToOutcome({ from: 'hermes', type: 'task_complete' }, 'autoclaw');
    assert.deepStrictEqual(m, { agentId: 'hermes', outcome: { kind: 'task_complete', project: 'autoclaw' } });
  });

  test('infrastructure senders are ignored (no mis-attribution)', () => {
    assert.strictEqual(messageToOutcome({ from: 'orchestrator-loop', type: 'task_complete' }), null);
    assert.strictEqual(messageToOutcome({ from: 'autobuild', type: 'task_complete' }), null);
    assert.strictEqual(messageToOutcome({ from: '', type: 'task_complete' }), null);
  });

  test('scope_violation attributes to payload.agent, else sender', () => {
    assert.strictEqual(
      messageToOutcome({ from: 'supervisor', type: 'scope_violation', payload: { agent: 'rogue' } })!.agentId,
      'rogue',
    );
    assert.strictEqual(
      messageToOutcome({ from: 'kilocode', type: 'scope_violation' })!.agentId,
      'kilocode',
    );
  });

  test('unrelated message types map to null', () => {
    assert.strictEqual(messageToOutcome({ from: 'x', type: 'question' }), null);
  });
});

suite('Workforce ingestion — ingestWorkforceSignals (idempotent)', () => {

  test('folds task_complete + scope_violation into résumés', async () => {
    const { ws, home } = makeWs();
    dropMsg(ws, '2026-06-17T10-00-00-000Z-task_complete-hermes-aa.json',
      { id: 'm1', from: 'hermes', type: 'task_complete' });
    dropMsg(ws, '2026-06-17T10-01-00-000Z-task_complete-hermes-bb.json',
      { id: 'm2', from: 'hermes', type: 'task_complete' });
    dropMsg(ws, '2026-06-17T10-02-00-000Z-scope_violation-supervisor-cc.json',
      { id: 'm3', from: 'supervisor', type: 'scope_violation', payload: { agent: 'rogue' } });

    const r1 = await ingestWorkforceSignals(ws, { homeDir: home, project: 'autoclaw', now: T0 });
    assert.strictEqual(r1.ingested, 3);
    assert.strictEqual(r1.byAgent['hermes'], 2);

    const hermes = await readWorker('hermes', home);
    assert.strictEqual(hermes!.resume.tasks_completed, 2);
    assert.deepStrictEqual(hermes!.resume.projects, ['autoclaw']);
    const rogue = await readWorker('rogue', home);
    assert.strictEqual(rogue!.resume.scope_violations, 1);
  });

  test('re-running is idempotent — already-folded messages are not double-counted', async () => {
    const { ws, home } = makeWs();
    dropMsg(ws, '2026-06-17T10-00-00-000Z-task_complete-hermes-aa.json',
      { id: 'm1', from: 'hermes', type: 'task_complete' });

    const r1 = await ingestWorkforceSignals(ws, { homeDir: home, now: T0 });
    assert.strictEqual(r1.ingested, 1);
    const r2 = await ingestWorkforceSignals(ws, { homeDir: home, now: T0 + 1000 });
    assert.strictEqual(r2.ingested, 0, 'second pass folds nothing new');

    assert.strictEqual((await readWorker('hermes', home))!.resume.tasks_completed, 1);

    // A NEW message after the watermark is still picked up.
    dropMsg(ws, '2026-06-17T10-05-00-000Z-task_complete-hermes-dd.json',
      { id: 'm9', from: 'hermes', type: 'task_complete' });
    const r3 = await ingestWorkforceSignals(ws, { homeDir: home, now: T0 + 2000 });
    assert.strictEqual(r3.ingested, 1);
    assert.strictEqual((await readWorker('hermes', home))!.resume.tasks_completed, 2);
  });

  test('missing shared inbox → no-op', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfingest-empty-'));
    const r = await ingestWorkforceSignals(base, { now: T0 });
    assert.strictEqual(r.ingested, 0);
    assert.strictEqual(r.scanned, 0);
  });
});
