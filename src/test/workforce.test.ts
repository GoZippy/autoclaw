import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  emptyResume, applyOutcome, foldOutcomes,
  upsertWorker, readWorker, listWorkers, recordOutcome, setWorkerStatus,
  workerPath, type Resume,
} from '../fleet/workforce';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workforce-test-'));
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');

suite('Workforce — résumé (HR-1)', () => {

  test('applyOutcome increments counts + tracks projects/specialties', () => {
    let r = emptyResume();
    r = applyOutcome(r, { kind: 'task_complete', project: 'autoclaw', specialty: 'test-coverage' });
    r = applyOutcome(r, { kind: 'task_complete', project: 'autoclaw' }); // dup project not re-added
    r = applyOutcome(r, { kind: 'task_failed', project: 'zippypanel' });
    r = applyOutcome(r, { kind: 'scope_violation' });
    assert.strictEqual(r.tasks_completed, 2);
    assert.strictEqual(r.tasks_failed, 1);
    assert.strictEqual(r.scope_violations, 1);
    assert.deepStrictEqual(r.projects, ['autoclaw', 'zippypanel']);
    assert.deepStrictEqual(r.specialties_proven, ['test-coverage']);
  });

  test('review scores fold into a running mean', () => {
    let r = emptyResume();
    r = applyOutcome(r, { kind: 'review_passed', score: 4 });
    r = applyOutcome(r, { kind: 'review_passed', score: 5 });
    r = applyOutcome(r, { kind: 'review_failed', score: 3 });
    assert.strictEqual(r.reviews_passed, 2);
    assert.strictEqual(r.reviews_failed, 1);
    assert.strictEqual(r.reviews_scored, 3);
    assert.strictEqual(r.avg_review_score, (4 + 5 + 3) / 3);
  });

  test('applyOutcome is pure (does not mutate the input)', () => {
    const r0 = emptyResume();
    applyOutcome(r0, { kind: 'task_complete' });
    assert.strictEqual(r0.tasks_completed, 0);
  });

  test('foldOutcomes folds a list left-to-right', () => {
    const r = foldOutcomes(emptyResume(), [
      { kind: 'task_complete' }, { kind: 'task_complete' }, { kind: 'review_passed', score: 5 },
    ]);
    assert.strictEqual(r.tasks_completed, 2);
    assert.strictEqual(r.avg_review_score, 5);
  });

  test('upsertWorker creates then merges (résumé preserved)', async () => {
    const home = makeHome();
    await upsertWorker({ agent_id: 'hermes', roles_can_play: ['coder'], skills: ['ts'] }, { now: T0, homeDir: home });
    await recordOutcome('hermes', { kind: 'task_complete', project: 'autoclaw' }, { now: T0, homeDir: home });
    // Merge new skills — résumé must survive.
    const merged = await upsertWorker({ agent_id: 'hermes', skills: ['ts', 'react'] }, { now: T0, homeDir: home });
    assert.deepStrictEqual(merged.skills, ['ts', 'react']);
    assert.strictEqual(merged.resume.tasks_completed, 1);
    assert.deepStrictEqual(merged.roles_can_play, ['coder']);
    assert.ok(fs.existsSync(workerPath('hermes', home)));
  });

  test('recordOutcome creates a worker if absent + flips engaged→available', async () => {
    const home = makeHome();
    await upsertWorker({ agent_id: 'w', status: 'engaged' }, { now: T0, homeDir: home });
    const w = await recordOutcome('w', { kind: 'task_complete' }, { now: T0, homeDir: home });
    assert.strictEqual(w.status, 'available');
    assert.strictEqual(w.last_engaged, new Date(T0).toISOString());
    // absent worker is created on first outcome
    const fresh = await recordOutcome('newbie', { kind: 'review_passed', score: 5 }, { now: T0, homeDir: home });
    assert.strictEqual(fresh.resume.reviews_passed, 1);
  });

  test('setWorkerStatus + listWorkers', async () => {
    const home = makeHome();
    await upsertWorker({ agent_id: 'a' }, { now: T0, homeDir: home });
    await upsertWorker({ agent_id: 'b' }, { now: T0, homeDir: home });
    await setWorkerStatus('a', 'retired', home);
    const all = await listWorkers(home);
    assert.strictEqual(all.length, 2);
    assert.strictEqual((await readWorker('a', home))!.status, 'retired');
    assert.strictEqual(await setWorkerStatus('ghost', 'benched', home), null);
  });
});
