/**
 * fabricRouter.test.ts — AF-9 capability-aware score router.
 */

import * as assert from 'assert';

import {
  scoreAgent,
  routeTask,
  routeTasks,
  capabilityMatch,
  languageMatch,
  trustScore,
  idleFactor,
  costFactor,
  agentsFromOffers,
  type SchedulableAgent,
  type SchedulableTask,
} from '../fabric/router';

const fleet: SchedulableAgent[] = [
  { id: 'kiro', agent_type: 'supervisor', capabilities: ['spec', 'design', 'code', 'review', 'orchestrate'], languages_supported: ['typescript', 'markdown'], trust_level: 'high', max_parallel_tasks: 1 },
  { id: 'claude-code', agent_type: 'coder', capabilities: ['code', 'review', 'security-review', 'refactor'], languages_supported: ['typescript', 'go', 'rust'], trust_level: 'high', max_parallel_tasks: 2 },
  { id: 'kilocode', agent_type: 'coder', capabilities: ['code', 'execute'], languages_supported: ['typescript', 'python'], trust_level: 'medium', max_parallel_tasks: 1 },
];

suite('AF-9 scoring primitives', () => {
  test('capabilityMatch: empty requirements ⇒ 1; partial ⇒ fraction', () => {
    assert.strictEqual(capabilityMatch(fleet[0], []), 1);
    assert.strictEqual(capabilityMatch(fleet[2], ['code', 'security-review']), 0.5);
  });

  test('capabilityMatch includes agent-type tags', () => {
    // supervisor type adds 'dispatch'/'aggregate'/'orchestrate' tags.
    assert.ok(capabilityMatch({ id: 's', agent_type: 'supervisor' }, ['orchestrate']) === 1);
  });

  test('languageMatch: supported=1, unsupported=0.25, none-declared=0.6, no-req=1', () => {
    assert.strictEqual(languageMatch(fleet[1], 'go'), 1);
    assert.strictEqual(languageMatch(fleet[1], 'python'), 0.25);
    assert.strictEqual(languageMatch({ id: 'x' }, 'go'), 0.6);
    assert.strictEqual(languageMatch(fleet[1], undefined), 1);
  });

  test('trustScore weights; idleFactor and costFactor behave', () => {
    assert.strictEqual(trustScore({ id: 'x', trust_level: 'high' }), 1);
    assert.strictEqual(trustScore({ id: 'x', trust_level: 'untrusted' }), 0);
    assert.strictEqual(idleFactor({ id: 'x', max_parallel_tasks: 2, current_load: 1 }), 0.5);
    assert.strictEqual(idleFactor({ id: 'x', max_parallel_tasks: 1, current_load: 1 }), 0);
    assert.strictEqual(costFactor({ id: 'x' }), 1);
    assert.ok(costFactor({ id: 'x', estimated_cost_usd: 1 }) === 0.5);
  });
});

suite('AF-9 scoreAgent eligibility gate', () => {
  test('untrusted agent is ineligible', () => {
    const s = scoreAgent({ id: 'u', trust_level: 'untrusted', capabilities: ['code'] }, { id: 't', required_capabilities: ['code'] });
    assert.strictEqual(s.eligible, false);
    assert.strictEqual(s.score, 0);
  });

  test('busy agent (at capacity) is ineligible', () => {
    const s = scoreAgent({ id: 'b', trust_level: 'high', capabilities: ['code'], max_parallel_tasks: 1, current_load: 1 }, { id: 't', required_capabilities: ['code'] });
    assert.strictEqual(s.eligible, false);
    assert.match(s.reason, /capacity/);
  });

  test('criticality-1 requires trust >= medium', () => {
    const low = scoreAgent({ id: 'l', trust_level: 'low', capabilities: ['code'] }, { id: 't', required_capabilities: ['code'], criticality: 1 });
    assert.strictEqual(low.eligible, false);
    const med = scoreAgent({ id: 'm', trust_level: 'medium', capabilities: ['code'] }, { id: 't', required_capabilities: ['code'], criticality: 1 });
    assert.strictEqual(med.eligible, true);
  });

  test('no required capability covered ⇒ ineligible', () => {
    // agent_type 'runner' adds execute/callable/task tags — none cover 'deploy'.
    const s = scoreAgent({ id: 'x', agent_type: 'runner', trust_level: 'high', capabilities: ['paint'] }, { id: 't', required_capabilities: ['deploy'] });
    assert.strictEqual(s.eligible, false);
  });

  test('capability_offer available=false ⇒ ineligible', () => {
    const s = scoreAgent({ id: 'x', trust_level: 'high', capabilities: ['code'], available: false }, { id: 't', required_capabilities: ['code'] });
    assert.strictEqual(s.eligible, false);
  });
});

suite('AF-9 routeTask', () => {
  test('security-review task routes to the only agent with that capability', () => {
    const task: SchedulableTask = { id: 'task-8', required_capabilities: ['code', 'security-review'], criticality: 1, language: 'typescript' };
    const r = routeTask(fleet, task);
    assert.strictEqual(r.chosen, 'claude-code');
    assert.strictEqual(r.fallback, false);
  });

  test('no eligible agent ⇒ fallback with a notes warning', () => {
    const task: SchedulableTask = { id: 'task-x', required_capabilities: ['quantum'] };
    const r = routeTask(fleet, task);
    assert.strictEqual(r.chosen, undefined);
    assert.strictEqual(r.fallback, true);
    assert.strictEqual(r.notes.length, 1);
    assert.match(r.notes[0], /round-robin/);
  });

  test('phase=plan favours the higher-trust agent on a tie of capability', () => {
    const agents: SchedulableAgent[] = [
      { id: 'lo', agent_type: 'coder', capabilities: ['code'], trust_level: 'medium' },
      { id: 'hi', agent_type: 'coder', capabilities: ['code'], trust_level: 'high' },
    ];
    const r = routeTask(agents, { id: 't', required_capabilities: ['code'], phase: 'plan' });
    assert.strictEqual(r.chosen, 'hi');
  });
});

suite('AF-9 routeTasks capacity spreading', () => {
  test('a single strong agent does not absorb every task past capacity', () => {
    const agents: SchedulableAgent[] = [
      { id: 'strong', agent_type: 'coder', capabilities: ['code'], trust_level: 'high', max_parallel_tasks: 1 },
      { id: 'ok', agent_type: 'coder', capabilities: ['code'], trust_level: 'medium', max_parallel_tasks: 1 },
    ];
    const tasks: SchedulableTask[] = [
      { id: 't1', required_capabilities: ['code'] },
      { id: 't2', required_capabilities: ['code'] },
    ];
    const results = routeTasks(agents, tasks);
    const chosen = results.map(r => r.chosen);
    assert.deepStrictEqual([...chosen].sort(), ['ok', 'strong']);
  });
});

suite('AF-9 agentsFromOffers', () => {
  test('builds agents from capability_offer payloads; newest wins', () => {
    const agents = agentsFromOffers([
      { agent_id: 'a', capabilities: ['code'], trust_level: 'low' },
      { agent_id: 'a', capabilities: ['code', 'review'], trust_level: 'high' },
      { capabilities: ['nope'] }, // skipped: no agent_id
    ]);
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].trust_level, 'high');
    assert.deepStrictEqual(agents[0].capabilities, ['code', 'review']);
  });
});
