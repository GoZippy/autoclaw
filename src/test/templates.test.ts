import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTemplate, readTemplate, writeTemplate, listTemplates,
  mutateTemplate, bestTemplateForRole, spawnWorkerSpec, reLifeWorker,
  bumpVersion, templatePath, type AgentTemplate,
} from '../fleet/templates';
import { emptyResume, applyOutcome, type Worker } from '../fleet/workforce';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'templates-test-'));
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');

suite('Templates — agent DNA store (HR-2)', () => {

  test('createTemplate + readTemplate round-trip', async () => {
    const home = makeHome();
    const t = await createTemplate({
      template_id: 'ts-coder-v2', base_role: 'coder', agent_type: 'coder',
      default_llm: 'claude-sonnet-4-6', skills: ['typescript', 'node'],
      tools: ['bash', 'edit'], context_seed: 'persona/ts-coder.md', spawn_via: 'claude-code',
    }, { now: T0, homeDir: home });
    assert.strictEqual(t.version, '1.0');
    assert.strictEqual(t.created_at, new Date(T0).toISOString());
    assert.ok(fs.existsSync(templatePath('ts-coder-v2', home)));

    const read = await readTemplate('ts-coder-v2', home);
    assert.deepStrictEqual(read, t);
    assert.strictEqual(await readTemplate('absent', home), null);
  });

  test('listTemplates skips malformed files', async () => {
    const home = makeHome();
    await createTemplate({ template_id: 'a', base_role: 'coder', agent_type: 'coder', spawn_via: 'hermes' }, { now: T0, homeDir: home });
    await createTemplate({ template_id: 'b', base_role: 'reviewer', agent_type: 'reviewer', spawn_via: 'hermes' }, { now: T0, homeDir: home });
    fs.writeFileSync(templatePath('junk', home), '{ not json', 'utf8');
    const all = await listTemplates(home);
    assert.strictEqual(all.length, 2);
  });

  test('bumpVersion: minor bump, else append .1', () => {
    assert.strictEqual(bumpVersion('1.0'), '1.1');
    assert.strictEqual(bumpVersion('1.3'), '1.4');
    assert.strictEqual(bumpVersion('2.9'), '2.10');
    assert.strictEqual(bumpVersion('weird'), 'weird.1');
  });

  test('mutateTemplate adds a skill + bumps version; null if absent', async () => {
    const home = makeHome();
    await createTemplate({
      template_id: 'ts-coder', base_role: 'coder', agent_type: 'coder',
      skills: ['typescript'], tools: ['bash'], spawn_via: 'claude-code',
    }, { now: T0, homeDir: home });

    const updated = await mutateTemplate('ts-coder', { add_skills: ['react', 'typescript'], default_llm: 'opus' }, { homeDir: home });
    assert.ok(updated);
    assert.deepStrictEqual(updated!.skills, ['typescript', 'react']); // de-duped, retained
    assert.strictEqual(updated!.default_llm, 'opus');
    assert.strictEqual(updated!.version, '1.1');
    // persisted
    const read = await readTemplate('ts-coder', home);
    assert.strictEqual(read!.version, '1.1');
    assert.deepStrictEqual(read!.skills, ['typescript', 'react']);

    assert.strictEqual(await mutateTemplate('ghost', { add_skills: ['x'] }, { homeDir: home }), null);
  });

  test('bestTemplateForRole picks by role then skill coverage', () => {
    const mk = (id: string, role: string, skills: string[]): AgentTemplate => ({
      template_id: id, base_role: role, agent_type: role, skills, tools: [],
      spawn_via: 'hermes', version: '1.0', created_at: new Date(T0).toISOString(),
    });
    const templates = [
      mk('coder-a', 'Coder', ['typescript']),
      mk('coder-b', 'coder', ['typescript', 'react']),
      mk('reviewer-a', 'reviewer', []),
    ];
    // role match is case-insensitive; skill coverage breaks the tie toward coder-b
    const best = bestTemplateForRole(templates, 'coder', { skills: ['typescript', 'react'] });
    assert.strictEqual(best!.template_id, 'coder-b');
    // no skill hint → deterministic tie-break by template_id
    assert.strictEqual(bestTemplateForRole(templates, 'coder')!.template_id, 'coder-a');
    // unknown role → null
    assert.strictEqual(bestTemplateForRole(templates, 'painter'), null);
  });

  test('spawnWorkerSpec produces a fresh Worker (empty résumé + spun_from_template)', () => {
    const tpl: AgentTemplate = {
      template_id: 'ts-coder-v2', base_role: 'coder', agent_type: 'coder',
      default_llm: 'claude-sonnet-4-6', skills: ['typescript', 'node'],
      tools: ['bash', 'edit'], spawn_via: 'claude-code', version: '2.0',
      created_at: new Date(T0).toISOString(),
    };
    const w = spawnWorkerSpec(tpl, 'coder-7', { now: T0 });
    assert.strictEqual(w.agent_id, 'coder-7');
    assert.deepStrictEqual(w.roles_can_play, ['coder']);
    assert.deepStrictEqual(w.skills, ['typescript', 'node']);
    assert.deepStrictEqual(w.tools, ['bash', 'edit']);
    assert.deepStrictEqual(w.llms, ['claude-sonnet-4-6']);
    assert.strictEqual(w.spun_from_template, 'ts-coder-v2');
    assert.strictEqual(w.origin_tool, 'claude-code');
    assert.strictEqual(w.status, 'available');
    assert.strictEqual(w.trust, 'off');
    assert.strictEqual(w.created_at, new Date(T0).toISOString());
    assert.deepStrictEqual(w.resume, emptyResume());

    // no default_llm → empty llms
    const w2 = spawnWorkerSpec({ ...tpl, default_llm: undefined }, 'coder-8', { now: T0 });
    assert.deepStrictEqual(w2.llms, []);
  });

  test('reLifeWorker preserves the résumé but refreshes skills', () => {
    const tpl: AgentTemplate = {
      template_id: 'ts-coder-v3', base_role: 'coder', agent_type: 'coder',
      default_llm: 'opus', skills: ['typescript', 'rust'], tools: ['bash'],
      spawn_via: 'hermes', version: '3.0', created_at: new Date(T0).toISOString(),
    };
    // a seasoned worker with earned history
    const seasoned: Worker = {
      agent_id: 'veteran-1', roles_can_play: ['coder'], skills: ['typescript'],
      llms: ['old-llm'], tools: ['edit'], spun_from_template: 'ts-coder-v1',
      resume: applyOutcome(emptyResume(), { kind: 'task_complete', project: 'autoclaw' }),
      status: 'benched', trust: 'auto', created_at: new Date(T0).toISOString(),
    };
    const reborn = reLifeWorker(seasoned, tpl, { now: T0 });
    assert.strictEqual(reborn.agent_id, 'veteran-1'); // identity carried forward
    assert.strictEqual(reborn.resume.tasks_completed, 1); // résumé preserved
    assert.deepStrictEqual(reborn.skills, ['typescript', 'rust']); // refreshed
    assert.deepStrictEqual(reborn.llms, ['opus']);
    assert.strictEqual(reborn.spun_from_template, 'ts-coder-v3');
    assert.strictEqual(reborn.status, 'available');
    assert.strictEqual(reborn.trust, 'auto'); // trust not reset by re-life
  });

  test('writeTemplate persists arbitrary template', async () => {
    const home = makeHome();
    const tpl: AgentTemplate = {
      template_id: 'manual', base_role: 'auditor', agent_type: 'auditor',
      skills: [], tools: [], spawn_via: 'openclaw', version: '1.0',
      created_at: new Date(T0).toISOString(),
    };
    await writeTemplate(tpl, home);
    assert.deepStrictEqual(await readTemplate('manual', home), tpl);
  });
});
