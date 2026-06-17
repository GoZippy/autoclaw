import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  vacancies, surplus, recallPlan, recallMessage, planRecallFromDisk, dismiss,
  type StandingRoster,
} from '../fleet/recall';
import { emptyResume, upsertWorker, readWorker, type Worker } from '../fleet/workforce';
import { createTemplate } from '../fleet/templates';
import type { AgentTemplate } from '../fleet/templates';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');

function worker(over: Partial<Worker> & { agent_id: string }): Worker {
  return {
    roles_can_play: [], skills: [], llms: [], tools: [],
    resume: emptyResume(), status: 'available', trust: 'off',
    created_at: new Date(T0).toISOString(), ...over,
  };
}
function tmpl(over: Partial<AgentTemplate> & { template_id: string; base_role: string }): AgentTemplate {
  return {
    agent_type: 'coder', skills: [], tools: [], spawn_via: 'openclaw',
    version: '1.0', created_at: new Date(T0).toISOString(), ...over,
  };
}

const ROSTER: StandingRoster = { project: 'autoclaw', want: { coder: 2, reviewer: 1 } };

suite('Recall / standing roster (HR-4)', () => {

  test('vacancies = want minus live (case-insensitive), only shortfalls', () => {
    const v = vacancies(ROSTER, { Coder: 1 }); // 1 coder live, 0 reviewers
    assert.deepStrictEqual(v, [
      { role: 'coder', need: 1 },
      { role: 'reviewer', need: 1 },
    ]);
  });

  test('no vacancies when fully staffed', () => {
    assert.deepStrictEqual(vacancies(ROSTER, { coder: 2, reviewer: 1 }), []);
  });

  test('surplus is the inverse (over-staffed roles)', () => {
    assert.deepStrictEqual(surplus(ROSTER, { coder: 3 }), [{ role: 'coder', need: 1 }]);
  });

  test('recallPlan prefers higher-reputation available pooled workers', () => {
    const proven = worker({ agent_id: 'veteran', roles_can_play: ['coder'],
      resume: { ...emptyResume(), tasks_completed: 10, reviews_passed: 5 } });
    const rookie = worker({ agent_id: 'rookie', roles_can_play: ['coder'] });
    const plan = recallPlan([{ role: 'coder', need: 1 }], [rookie, proven], []);
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].kind, 'recall');
    assert.strictEqual((plan[0] as any).agent_id, 'veteran');
  });

  test('recallPlan hires fresh from a template when the pool is short', () => {
    const one = worker({ agent_id: 'c1', roles_can_play: ['coder'] });
    const template = tmpl({ template_id: 'ts-coder', base_role: 'coder' });
    const plan = recallPlan([{ role: 'coder', need: 2 }], [one], [template]);
    // one recall + one hire
    assert.strictEqual(plan.filter(a => a.kind === 'recall').length, 1);
    const hire = plan.find(a => a.kind === 'hire');
    assert.ok(hire && (hire as any).template_id === 'ts-coder');
  });

  test('recallPlan emits a gap when neither a worker nor a template exists', () => {
    const plan = recallPlan([{ role: 'security', need: 1 }], [], []);
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].kind, 'gap');
  });

  test('a pooled worker is assigned at most once across the plan', () => {
    const flex = worker({ agent_id: 'flex', roles_can_play: ['coder', 'reviewer'] });
    const plan = recallPlan(
      [{ role: 'coder', need: 1 }, { role: 'reviewer', need: 1 }],
      [flex], [],
    );
    const recalls = plan.filter(a => a.kind === 'recall') as Array<{ agent_id: string }>;
    assert.strictEqual(recalls.length, 1, 'flex can only be recalled once');
    // the reviewer slot becomes a gap (no other worker/template)
    assert.ok(plan.some(a => a.kind === 'gap' && (a as any).role === 'reviewer'));
  });

  test('recallMessage builds a task_assign recall envelope', () => {
    const m = recallMessage('hermes', 'coder', { project: 'autoclaw', task_id: 'B7' }) as any;
    assert.strictEqual(m.type, 'task_assign');
    assert.strictEqual(m.to, 'hermes');
    assert.strictEqual(m.payload.recall, true);
    assert.strictEqual(m.payload.role, 'coder');
    assert.strictEqual(m.payload.task_id, 'B7');
  });

  test('planRecallFromDisk reads pool + templates and dismiss retires (keeps résumé)', async () => {
    const home = makeHome();
    await upsertWorker({ agent_id: 'veteran', roles_can_play: ['coder'] }, { now: T0, homeDir: home });
    await createTemplate({ template_id: 'ts-coder', base_role: 'coder', agent_type: 'coder', skills: [], tools: [], spawn_via: 'openclaw' }, { now: T0, homeDir: home });

    const plan = await planRecallFromDisk(ROSTER, { coder: 1 }, home);
    // coder needs 1 more (recall veteran), reviewer needs 1 (no worker/template → gap)
    assert.ok(plan.some(a => a.kind === 'recall' && (a as any).agent_id === 'veteran'));
    assert.ok(plan.some(a => a.kind === 'gap' && (a as any).role === 'reviewer'));

    const retired = await dismiss('veteran', home);
    assert.strictEqual(retired!.status, 'retired');
    // résumé preserved (still readable, record kept)
    assert.ok(await readWorker('veteran', home));
  });
});
