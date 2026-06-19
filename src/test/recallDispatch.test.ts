import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dispatchRecallActions, liveByRoleFromDisk, runRecallSweep,
} from '../fleet/recallDispatch';
import type { RecallAction } from '../fleet/recall';
import { upsertWorker } from '../fleet/workforce';
import { createTemplate } from '../fleet/templates';

function makeWs(): { ws: string; home: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'recalld-test-'));
  const ws = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'heartbeats'), { recursive: true });
  return { ws, home };
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');
const orch = (ws: string) => path.join(ws, '.autoclaw', 'orchestrator');
const inbox = (ws: string, who: string) => path.join(orch(ws), 'comms', 'inboxes', who);
const sharedFiles = (ws: string) => {
  try { return fs.readdirSync(inbox(ws, 'shared')).filter(f => f.endsWith('.json')); } catch { return []; }
};

suite('Recall dispatch (HRW-3)', () => {

  test('dispatchRecallActions: recall → task_assign in the agent inbox', async () => {
    const { ws } = makeWs();
    const actions: RecallAction[] = [{ kind: 'recall', role: 'coder', agent_id: 'hermes', reputation: 0.7 }];
    const sum = await dispatchRecallActions(ws, actions, { now: T0, project: 'autoclaw' });
    assert.strictEqual(sum.recalled.length, 1);
    const files = fs.readdirSync(inbox(ws, 'hermes')).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);
    const msg = JSON.parse(fs.readFileSync(path.join(inbox(ws, 'hermes'), files[0]), 'utf8'));
    assert.strictEqual(msg.type, 'task_assign');
    assert.strictEqual(msg.payload.recall, true);
    assert.strictEqual(msg.payload.role, 'coder');
  });

  test('dispatchRecallActions: hire + gap → finding_report to shared', async () => {
    const { ws } = makeWs();
    const actions: RecallAction[] = [
      { kind: 'hire', role: 'tester', template_id: 'ts-tester' },
      { kind: 'gap', role: 'security', reason: 'no worker/template' },
    ];
    const sum = await dispatchRecallActions(ws, actions, { now: T0 });
    assert.strictEqual(sum.hires.length, 1);
    assert.strictEqual(sum.gaps.length, 1);
    const findings = sharedFiles(ws).filter(f => f.includes('finding_report'));
    assert.strictEqual(findings.length, 2);
  });

  test('liveByRoleFromDisk counts fresh heartbeats by fleet.json role', async () => {
    const { ws } = makeWs();
    fs.writeFileSync(path.join(orch(ws), 'fleet.json'), JSON.stringify({
      agents: { 'claude-code': { role: 'orchestrator' }, 'kilocode': { role: 'coder' } },
    }));
    const hb = (id: string, ageMs: number) => fs.writeFileSync(
      path.join(orch(ws), 'comms', 'heartbeats', `${id}.json`),
      JSON.stringify({ agent_id: id, timestamp: new Date(T0 - ageMs).toISOString() }),
    );
    hb('claude-code', 1000);          // fresh
    hb('kilocode', 1000);             // fresh
    hb('ghost', 10 * 60_000);         // stale → excluded
    const live = await liveByRoleFromDisk(ws, { now: T0 });
    assert.strictEqual(live['orchestrator'], 1);
    assert.strictEqual(live['coder'], 1);
    assert.strictEqual(live['generalist'] ?? 0, 0); // ghost stale, not counted
  });

  test('runRecallSweep is a no-op without roster.json', async () => {
    const { ws, home } = makeWs();
    const r = await runRecallSweep(ws, { homeDir: home, now: T0 });
    assert.strictEqual(r.skipped, true);
    assert.match(r.reason!, /no roster/);
  });

  test('runRecallSweep plans + dispatches against a roster', async () => {
    const { ws, home } = makeWs();
    // Roster wants 2 coders; 0 live. Pool has one available coder; a template covers the rest.
    fs.writeFileSync(path.join(orch(ws), 'roster.json'), JSON.stringify({ project: 'autoclaw', want: { coder: 2 } }));
    fs.writeFileSync(path.join(orch(ws), 'fleet.json'), JSON.stringify({ agents: {} }));
    await upsertWorker({ agent_id: 'vet', roles_can_play: ['coder'] }, { now: T0, homeDir: home });
    await createTemplate({ template_id: 'ts-coder', base_role: 'coder', agent_type: 'coder', skills: [], tools: [], spawn_via: 'openclaw' }, { now: T0, homeDir: home });

    const r = await runRecallSweep(ws, { homeDir: home, now: T0 });
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.dispatched!.recalled.length, 1, 'recall the pooled vet');
    assert.strictEqual(r.dispatched!.hires.length, 1, 'hire the remaining slot from a template');
    // vet got a task_assign
    assert.ok(fs.readdirSync(inbox(ws, 'vet')).some(f => f.includes('task_assign')));
  });
});
