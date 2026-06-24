import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDAG,
  topologicalSort,
  globsOverlap,
  detectScopeConflicts,
  planSprints,
  buildPlanSummary,
  generatePlan,
  createInitialState,
  renderTemplate,
  toYAML,
  DEFAULT_PLANNER_CONFIG,
  renderSprintMarkdown,
  writeSprintArtifacts,
  writePlanArtifacts,
  scoreAgent,
  jaccardIndex,
  trustWeight,
  broadcastCapabilityQueries,
  resolveCapabilityOffers,
} from '../orchestrate';
import type {
  ManifestTask,
  Manifest,
  PlannerConfig,
  DAG,
  Sprint,
  ScorableAgent,
  PlannedTask,
  CapabilityPendingTask,
} from '../orchestrate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  id: string,
  deps: string[] = [],
  scope: string[] = [`internal/${id}/**`],
  effort: 'S' | 'M' | 'L' | 'XL' = 'M',
  subtasks: string[] = ['sub1', 'sub2']
): ManifestTask {
  return { id, name: `Task ${id}`, depends_on: deps, scope, effort, subtasks };
}

function makeManifest(tasks: ManifestTask[], constraints?: Manifest['constraints']): Manifest {
  return {
    project: { name: 'test-project', language: 'go' },
    tasks,
    constraints,
  };
}

// ---------------------------------------------------------------------------
// DAG Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — DAG', () => {
  test('buildDAG creates nodes for all tasks', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const dag = buildDAG(tasks);
    assert.strictEqual(dag.nodes.size, 3);
    assert.ok(dag.nodes.has('a'));
    assert.ok(dag.nodes.has('b'));
    assert.ok(dag.nodes.has('c'));
  });

  test('buildDAG sets inDegree from depends_on', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a', 'b'])];
    const dag = buildDAG(tasks);
    assert.strictEqual(dag.nodes.get('a')!.inDegree, 0);
    assert.strictEqual(dag.nodes.get('b')!.inDegree, 1);
    assert.strictEqual(dag.nodes.get('c')!.inDegree, 2);
  });

  test('buildDAG tracks dependents', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a'])];
    const dag = buildDAG(tasks);
    const aDeps = dag.nodes.get('a')!.dependents;
    assert.ok(aDeps.includes('b'));
    assert.ok(aDeps.includes('c'));
    assert.strictEqual(aDeps.length, 2);
  });

  test('buildDAG throws on duplicate task IDs', () => {
    const tasks = [makeTask('a'), makeTask('a')];
    assert.throws(() => buildDAG(tasks), /Duplicate task ID: "a"/);
  });

  test('buildDAG throws on missing dependency', () => {
    const tasks = [makeTask('a', ['nonexistent'])];
    assert.throws(() => buildDAG(tasks), /depends on "nonexistent" which does not exist/);
  });
});

// ---------------------------------------------------------------------------
// Topological Sort Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Topological Sort', () => {
  test('assigns level 0 to tasks with no dependencies', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    assert.strictEqual(dag.nodes.get('a')!.level, 0);
    assert.strictEqual(dag.nodes.get('b')!.level, 0);
    assert.strictEqual(dag.nodes.get('c')!.level, 0);
  });

  test('assigns correct levels for linear chain', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    assert.strictEqual(dag.nodes.get('a')!.level, 0);
    assert.strictEqual(dag.nodes.get('b')!.level, 1);
    assert.strictEqual(dag.nodes.get('c')!.level, 2);
    assert.strictEqual(dag.maxLevel, 2);
  });

  test('assigns correct levels for diamond dependency', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['b', 'c']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    assert.strictEqual(dag.nodes.get('a')!.level, 0);
    assert.strictEqual(dag.nodes.get('b')!.level, 1);
    assert.strictEqual(dag.nodes.get('c')!.level, 1);
    assert.strictEqual(dag.nodes.get('d')!.level, 2);
  });

  test('detects cycles', () => {
    const tasks = [makeTask('a', ['c']), makeTask('b', ['a']), makeTask('c', ['b'])];
    const dag = buildDAG(tasks);
    assert.throws(() => topologicalSort(dag), /Cycle detected/);
  });

  test('computes critical path length', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
      makeTask('d'),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    assert.strictEqual(dag.criticalPathLength, 3);
    assert.strictEqual(dag.nodes.get('a')!.criticalPathLength, 3);
    assert.strictEqual(dag.nodes.get('d')!.criticalPathLength, 1);
  });

  test('returns all task IDs in sorted order', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c')];
    const dag = buildDAG(tasks);
    const sorted = topologicalSort(dag);
    assert.strictEqual(sorted.length, 3);
    assert.ok(sorted.indexOf('a') < sorted.indexOf('b'));
  });
});

// ---------------------------------------------------------------------------
// Scope Conflict Detection Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Scope Conflicts', () => {
  test('globsOverlap detects exact match', () => {
    assert.ok(globsOverlap('internal/auth/**', 'internal/auth/**'));
  });

  test('globsOverlap detects prefix overlap', () => {
    assert.ok(globsOverlap('internal/auth/**', 'internal/auth/jwt.go'));
  });

  test('globsOverlap returns false for different packages', () => {
    assert.ok(!globsOverlap('internal/auth/**', 'internal/dns/**'));
  });

  test('globsOverlap handles double-star wildcard', () => {
    assert.ok(globsOverlap('internal/**', 'internal/auth/jwt.go'));
  });

  test('globsOverlap handles single-star wildcard', () => {
    assert.ok(globsOverlap('internal/*/handler.go', 'internal/auth/handler.go'));
  });

  test('detectScopeConflicts finds overlapping tasks', () => {
    const tasks = [
      makeTask('a', [], ['internal/auth/**']),
      makeTask('b', [], ['internal/auth/jwt.go']),
    ];
    const conflicts = detectScopeConflicts(tasks);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0][0], 'a');
    assert.strictEqual(conflicts[0][1], 'b');
  });

  test('detectScopeConflicts returns empty for non-overlapping tasks', () => {
    const tasks = [
      makeTask('a', [], ['internal/auth/**']),
      makeTask('b', [], ['internal/dns/**']),
    ];
    const conflicts = detectScopeConflicts(tasks);
    assert.strictEqual(conflicts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Sprint Planner Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Sprint Planner', () => {
  const config: PlannerConfig = {
    work_agents: 4,
    max_tasks_per_agent: 3,
    max_subtasks_per_sprint: 15,
    migration_range_size: 4,
    branch_prefix: 'feat/',
  };

  test('independent tasks are assigned to one sprint', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
      makeTask('c', [], ['internal/c/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config);
    assert.strictEqual(sprints.length, 1);
    assert.strictEqual(sprints[0].level, 0);
  });

  test('dependent tasks are in separate sprints', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', ['a'], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config);
    assert.strictEqual(sprints.length, 2);
    assert.strictEqual(sprints[0].sprint, 1);
    assert.strictEqual(sprints[1].sprint, 2);
  });

  test('scope conflicts prevent same-agent assignment', () => {
    const tasks = [
      makeTask('a', [], ['internal/shared/**']),
      makeTask('b', [], ['internal/shared/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config);
    const totalAssigned = sprints.reduce(
      (sum, s) => sum + s.assignments.reduce((a, asgn) => a + asgn.tasks.length, 0),
      0
    );
    assert.strictEqual(totalAssigned, 2);
  });

  test('mutual exclusion is respected', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config, {
      mutual_exclusion: [['a', 'b']],
    });
    assert.ok(sprints.length >= 2 || sprints[0].assignments.length === 1);
  });

  test('migration ranges are allocated for migration-scoped tasks', () => {
    const tasks = [
      makeTask('a', [], ['migrations/000*.sql', 'internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config);
    const migAssignment = sprints[0].assignments.find(a =>
      a.tasks.some(t => t.id === 'a')
    );
    assert.ok(migAssignment?.migration_range);
    assert.strictEqual(migAssignment!.migration_range!.start, 1);
    assert.strictEqual(migAssignment!.migration_range!.end, 4);
  });

  test('branch names include sprint number and agent', () => {
    const tasks = [makeTask('auth', [], ['internal/auth/**'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, config);
    const branch = sprints[0].assignments[0].branch;
    assert.ok(branch.startsWith('feat/sprint-1-wa-1-'));
    assert.ok(branch.includes('auth'));
  });

  test('respects max_tasks_per_agent', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      makeTask(`t${i}`, [], [`internal/t${i}/**`], 'S', ['sub1'])
    );
    const smallConfig = { ...config, max_tasks_per_agent: 2 };
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, smallConfig);
    for (const sprint of sprints) {
      for (const assignment of sprint.assignments) {
        assert.ok(assignment.tasks.length <= 2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Plan Summary Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Plan Summary', () => {
  test('buildPlanSummary produces correct totals', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', ['a'], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, DEFAULT_PLANNER_CONFIG);
    const summary = buildPlanSummary('test', tasks, sprints, 4, dag.criticalPathLength);

    assert.strictEqual(summary.project, 'test');
    assert.strictEqual(summary.total_tasks, 2);
    assert.strictEqual(summary.total_sprints, sprints.length);
    assert.strictEqual(summary.total_agents, 4);
  });
});

// ---------------------------------------------------------------------------
// Full Pipeline Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Full Pipeline', () => {
  test('generatePlan produces valid output for simple manifest', () => {
    const manifest = makeManifest([
      makeTask('auth', [], ['internal/auth/**']),
      makeTask('rbac', ['auth'], ['internal/rbac/**']),
      makeTask('dns', [], ['internal/dns/**']),
      makeTask('mail', [], ['internal/mail/**']),
    ]);

    const result = generatePlan(manifest, DEFAULT_PLANNER_CONFIG);

    assert.ok(result.sprints.length >= 2);
    assert.strictEqual(result.summary.total_tasks, 4);
    assert.strictEqual(result.state.tasks_total, 4);
    assert.strictEqual(result.state.tasks_complete, 0);
    assert.ok(result.dag.criticalPathLength >= 2);
  });

  test('generatePlan handles single task', () => {
    const manifest = makeManifest([makeTask('solo')]);
    const result = generatePlan(manifest, DEFAULT_PLANNER_CONFIG);
    assert.strictEqual(result.sprints.length, 1);
    assert.strictEqual(result.summary.total_tasks, 1);
  });

  test('generatePlan throws on cyclic dependencies', () => {
    const manifest = makeManifest([
      makeTask('a', ['b']),
      makeTask('b', ['a']),
    ]);
    assert.throws(() => generatePlan(manifest, DEFAULT_PLANNER_CONFIG), /Cycle detected/);
  });
});

// ---------------------------------------------------------------------------
// Agent registry resolution in planSprints (Item 2)
// ---------------------------------------------------------------------------

suite('Orchestrate — planSprints with AgentRegistry', () => {
  test('empty agents leaves platform/inbox undefined on every assignment', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(dag, { ...DEFAULT_PLANNER_CONFIG, work_agents: 2 });
    for (const s of sprints) {
      for (const a of s.assignments) {
        assert.strictEqual(a.platform, undefined);
        assert.strictEqual(a.inbox, undefined);
      }
    }
  });

  test('two registry entries stamp platform on WA-1 and WA-2', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kiro', inbox: '.autoclaw/orchestrator/comms/inboxes/kiro/', sprint: null, assigned_at: '2026-05-09T00:00:00Z' },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/', sprint: null, assigned_at: '2026-05-09T00:00:00Z' },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    const flat = sprints.flatMap(s => s.assignments);
    const wa1 = flat.find(a => a.agent === 'WA-1')!;
    const wa2 = flat.find(a => a.agent === 'WA-2')!;
    assert.strictEqual(wa1.platform, 'kiro');
    assert.strictEqual(wa2.platform, 'claude-code');
  });

  test('inbox path is stamped from the registry', () => {
    const tasks = [makeTask('only', [], ['internal/only/**'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kiro', inbox: '.autoclaw/orchestrator/comms/inboxes/kiro/', sprint: null, assigned_at: '2026-05-09T00:00:00Z' },
    ];
    const sprints = planSprints(dag, { ...DEFAULT_PLANNER_CONFIG, work_agents: 1 }, undefined, agents);
    const wa1 = sprints[0].assignments[0];
    assert.strictEqual(wa1.platform, 'kiro');
    assert.strictEqual(wa1.inbox, '.autoclaw/orchestrator/comms/inboxes/kiro/');
  });

  test('excludedSlots {WA-2} routes all tasks to WA-1', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      [],
      new Set(['WA-2'])
    );
    const flat = sprints.flatMap(s => s.assignments);
    assert.ok(flat.length > 0);
    assert.ok(flat.every(a => a.agent !== 'WA-2'));
  });

  test('excludedSlots {WA-1, WA-2} with 2 work agents produces no assignments', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2 },
      undefined,
      [],
      new Set(['WA-1', 'WA-2'])
    );
    // No agent slot is allowed to take work, so there are no sprints emitted.
    assert.strictEqual(sprints.length, 0);
  });

  test('empty excludedSlots is identical to default behaviour', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', ['a'], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const baseline = planSprints(dag, DEFAULT_PLANNER_CONFIG);
    const dag2 = buildDAG(tasks);
    topologicalSort(dag2);
    const withEmpty = planSprints(dag2, DEFAULT_PLANNER_CONFIG, undefined, [], new Set());
    assert.deepStrictEqual(
      withEmpty.map(s => s.assignments.map(a => a.agent)),
      baseline.map(s => s.assignments.map(a => a.agent))
    );
  });

  test('generatePlan threads agents into planSprints', () => {
    const manifest = makeManifest([
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ]);
    const agents = [
      { id: 'WA-1', platform: 'kiro', inbox: '.autoclaw/orchestrator/comms/inboxes/kiro/', sprint: null, assigned_at: '2026-05-09T00:00:00Z' },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/', sprint: null, assigned_at: '2026-05-09T00:00:00Z' },
    ];
    const result = generatePlan(
      manifest,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      agents
    );
    const flat = result.sprints.flatMap(s => s.assignments);
    assert.ok(flat.some(a => a.platform === 'kiro'));
    assert.ok(flat.some(a => a.platform === 'claude-code'));
  });
});

// ---------------------------------------------------------------------------
// Template Rendering Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — Template Rendering', () => {
  test('renderTemplate replaces simple keys', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'World' });
    assert.strictEqual(result, 'Hello World!');
  });

  test('renderTemplate uses fallback for missing keys', () => {
    const result = renderTemplate('{{missing | "default"}}', {});
    assert.strictEqual(result, 'default');
  });

  test('renderTemplate joins arrays', () => {
    const result = renderTemplate('Tasks: {{tasks}}', { tasks: ['a', 'b', 'c'] });
    assert.strictEqual(result, 'Tasks: a, b, c');
  });

  test('renderTemplate handles null values', () => {
    const result = renderTemplate('Value: {{val | "none"}}', { val: null });
    assert.strictEqual(result, 'Value: none');
  });

  test('renderTemplate handles numbers', () => {
    const result = renderTemplate('Sprint {{num}}', { num: 3 });
    assert.strictEqual(result, 'Sprint 3');
  });
});

// ---------------------------------------------------------------------------
// YAML Serializer Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — YAML Serializer', () => {
  test('toYAML serializes simple object', () => {
    const yaml = toYAML({ name: 'test', count: 5 });
    assert.ok(yaml.includes('name: test'));
    assert.ok(yaml.includes('count: 5'));
  });

  test('toYAML serializes arrays of scalars inline', () => {
    const yaml = toYAML({ items: ['a', 'b', 'c'] });
    assert.ok(yaml.includes('[a, b, c]'));
  });

  test('toYAML serializes null', () => {
    const yaml = toYAML({ value: null });
    assert.ok(yaml.includes('value: null'));
  });

  test('toYAML quotes strings with special characters', () => {
    const yaml = toYAML({ path: 'internal/auth/**' });
    assert.ok(yaml.includes('"internal/auth/**"'));
  });

  test('toYAML handles nested objects', () => {
    const yaml = toYAML({ outer: { inner: 'value' } });
    assert.ok(yaml.includes('outer:'));
    assert.ok(yaml.includes('inner: value'));
  });
});

// ---------------------------------------------------------------------------
// State Management Tests
// ---------------------------------------------------------------------------

suite('Orchestrate — State', () => {
  test('createInitialState sets all agents to idle', () => {
    const state = createInitialState('test', 5, 20, 4);
    assert.strictEqual(Object.keys(state.agents).length, 4);
    for (const agent of Object.values(state.agents)) {
      assert.strictEqual(agent.status, 'idle');
      assert.strictEqual(agent.sprint, null);
      assert.deepStrictEqual(agent.tasks, []);
    }
  });

  test('createInitialState sets correct totals', () => {
    const state = createInitialState('myproject', 9, 75, 4);
    assert.strictEqual(state.project, 'myproject');
    assert.strictEqual(state.total_sprints, 9);
    assert.strictEqual(state.tasks_total, 75);
    assert.strictEqual(state.tasks_complete, 0);
    assert.strictEqual(state.current_sprint, null);
  });
});


// ---------------------------------------------------------------------------
// Import consensus types
// ---------------------------------------------------------------------------

import {
  evaluateConsensus,
  mergeFindings,
  DEFAULT_CONSENSUS_CONFIG,
  consensusConfigForTask,
  runAcceptanceChecks,
  applyAcceptanceGate,
  acceptanceMet,
  tierFactor,
  parseManifestGateFields,
  readManifestTaskGates,
} from '../orchestrate';
import type {
  ValidationVote,
  ValidationFinding,
  ConsensusConfig,
  TaskCriticality,
  TaskPhase,
} from '../orchestrate';

// ---------------------------------------------------------------------------
// Consensus Validation Tests
// ---------------------------------------------------------------------------

function makeVote(
  agentId: string,
  provider: string,
  verdict: 'approved' | 'needs_changes' | 'blocked' | 'abstain',
  confidence: number = 0.9,
  findings: ValidationFinding[] = []
): ValidationVote {
  return {
    agent_id: agentId,
    provider,
    verdict,
    confidence,
    findings,
    timestamp: new Date().toISOString(),
  };
}

function makeFinding(
  category: ValidationFinding['category'],
  severity: ValidationFinding['severity'],
  description: string,
  file?: string,
  line?: number
): ValidationFinding {
  return { category, severity, description, file, line };
}

suite('Orchestrate — Consensus Validation', () => {
  test('consensus reached with 2/2 approvals', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'approved'),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.final_verdict, 'approved');
  });

  test('consensus reached with 2/3 approvals (above threshold)', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'approved'),
      makeVote('WA-3', 'claude-code', 'needs_changes'),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.final_verdict, 'approved');
  });

  test('consensus pending with insufficient voters', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_pending');
  });

  test('blocked vote vetoes consensus', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'blocked'),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.final_verdict, 'blocked');
  });

  test('deadlock after max rounds', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'needs_changes'),
    ];
    const result = evaluateConsensus(votes, 3); // max_rounds = 3
    assert.strictEqual(result.status, 'deadlocked');
  });

  test('low confidence votes are filtered out', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved', 0.9),
      makeVote('WA-2', 'kilocode', 'approved', 0.3), // below min_confidence
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_pending'); // only 1 qualified voter
  });

  test('abstain votes do not count toward threshold', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'approved'),
      makeVote('WA-3', 'claude-code', 'abstain'),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.final_verdict, 'approved');
  });

  test('security findings require unanimous approval', () => {
    const securityFinding = makeFinding('security', 'critical', 'SQL injection risk', 'store.go', 42);
    const votes = [
      makeVote('WA-1', 'kiro', 'approved', 0.9, [securityFinding]),
      makeVote('WA-2', 'kilocode', 'needs_changes', 0.9, [securityFinding]),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.final_verdict, 'needs_changes');
    assert.ok(result.unresolved_findings.length > 0);
  });

  test('block_is_veto can be disabled', () => {
    const config: ConsensusConfig = {
      ...DEFAULT_CONSENSUS_CONFIG,
      block_is_veto: false,
    };
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'approved'),
      makeVote('WA-3', 'claude-code', 'blocked'),
    ];
    const result = evaluateConsensus(votes, 1, config);
    // With veto disabled, 2/3 approvals should still pass
    assert.strictEqual(result.status, 'consensus_reached');
  });

  test('custom threshold requires more approvals', () => {
    const config: ConsensusConfig = {
      ...DEFAULT_CONSENSUS_CONFIG,
      approval_threshold: 1.0, // require 100% approval
    };
    const votes = [
      makeVote('WA-1', 'kiro', 'approved'),
      makeVote('WA-2', 'kilocode', 'needs_changes'),
    ];
    const result = evaluateConsensus(votes, 1, config);
    assert.strictEqual(result.final_verdict, 'needs_changes');
  });
});

suite('Orchestrate — Verifier Independence (reviewer ≠ author)', () => {
  test('author self-vote is excluded from the tally and can flip the outcome', () => {
    // Author "A" approves own work; reviewers split 1 approve / 1 needs_changes.
    // Counting the author (3 votes): 2/3 approvals ≥ 0.66 → consensus_reached.
    // Excluding the author (2 votes): 1/2 = 0.5 < 0.66 → not reached.
    const votes = [
      makeVote('A', 'fable', 'approved'),
      makeVote('B', 'opus', 'approved'),
      makeVote('C', 'sonnet', 'needs_changes'),
    ];

    const counted = evaluateConsensus(votes, 1);
    assert.strictEqual(counted.status, 'consensus_reached', 'sanity: counting the author reaches consensus');

    const excluded = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG, { author_agent_id: 'A' });
    assert.strictEqual(excluded.status, 'consensus_pending', 'excluding the author drops below threshold');
    assert.strictEqual(excluded.final_verdict, 'needs_changes');
    assert.deepStrictEqual(excluded.excluded_self_review, ['A']);
    assert.strictEqual(excluded.votes.length, 3, 'full vote list preserved on the result for audit');
  });

  test('an author who is the sole voter cannot self-approve', () => {
    const votes = [makeVote('A', 'fable', 'approved')];
    const result = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG, { author_agent_id: 'A' });
    assert.strictEqual(result.status, 'consensus_pending', '0 independent voters → cannot reach consensus');
    assert.deepStrictEqual(result.excluded_self_review, ['A']);
  });

  test('omitting author ctx is byte-identical to the 3-arg call (no-op)', () => {
    const votes = [
      makeVote('A', 'fable', 'approved'),
      makeVote('B', 'opus', 'approved'),
    ];
    const baseline = evaluateConsensus(votes, 1);
    const withEmptyCtx = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG, {});
    // Timestamps are generated per call; normalize before structural compare.
    baseline.timestamp = withEmptyCtx.timestamp = 'NORMALIZED';
    assert.deepStrictEqual(withEmptyCtx, baseline);
    assert.strictEqual(withEmptyCtx.excluded_self_review, undefined, 'no excluded field when no author given');
  });

  test('a non-author author_agent_id excludes nobody', () => {
    const votes = [
      makeVote('A', 'fable', 'approved'),
      makeVote('B', 'opus', 'approved'),
    ];
    const result = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG, { author_agent_id: 'Z' });
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.excluded_self_review, undefined, 'author not among voters → nothing excluded');
  });
});

suite('Orchestrate — Finding Merge', () => {
  test('deduplicates identical findings from multiple agents', () => {
    const finding = makeFinding('bug', 'major', 'nil pointer', 'handler.go', 55);
    const votes = [
      makeVote('WA-1', 'kiro', 'needs_changes', 0.9, [finding]),
      makeVote('WA-2', 'kilocode', 'needs_changes', 0.9, [finding]),
    ];
    const { unique, agreements } = mergeFindings(votes);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(agreements.length, 1);
    assert.deepStrictEqual(agreements[0].agreedBy, ['WA-1', 'WA-2']);
  });

  test('keeps distinct findings separate', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'needs_changes', 0.9, [
        makeFinding('bug', 'major', 'nil pointer', 'a.go', 10),
      ]),
      makeVote('WA-2', 'kilocode', 'needs_changes', 0.9, [
        makeFinding('style', 'minor', 'missing comment', 'b.go', 20),
      ]),
    ];
    const { unique, agreements } = mergeFindings(votes);
    assert.strictEqual(unique.length, 2);
    assert.strictEqual(agreements.length, 0);
  });

  test('upgrades severity when later voter rates higher', () => {
    const votes = [
      makeVote('WA-1', 'kiro', 'needs_changes', 0.9, [
        makeFinding('security', 'minor', 'weak validation', 'auth.go', 30),
      ]),
      makeVote('WA-2', 'kilocode', 'needs_changes', 0.9, [
        makeFinding('security', 'critical', 'weak validation', 'auth.go', 30),
      ]),
    ];
    const { unique } = mergeFindings(votes);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].severity, 'critical');
  });

  test('tolerates votes whose findings field is missing or non-array', () => {
    // Regression: vote records read from consensus/active/ are raw JSON and may
    // omit `findings` (an agent can approve with none). mergeFindings must not
    // throw "vote.findings is not iterable" on such records.
    const good = makeVote('WA-1', 'kiro', 'needs_changes', 0.9, [
      makeFinding('bug', 'major', 'nil pointer', 'a.go', 10),
    ]);
    const missing = { agent_id: 'WA-2', provider: 'kilocode', verdict: 'approved',
      confidence: 0.9, timestamp: new Date().toISOString() } as unknown as ValidationVote;
    const malformed = { ...makeVote('WA-3', 'kiro', 'approved', 0.9),
      findings: null as unknown as ValidationFinding[] };
    assert.doesNotThrow(() => {
      const { unique } = mergeFindings([good, missing, malformed]);
      assert.strictEqual(unique.length, 1);
    });
  });

  test('does NOT mutate the caller\'s vote findings on severity upgrade', () => {
    const minor = makeFinding('security', 'minor', 'weak validation', 'auth.go', 30);
    const critical = makeFinding('security', 'critical', 'weak validation', 'auth.go', 30);
    const votes = [
      makeVote('WA-1', 'kiro', 'needs_changes', 0.9, [minor]),
      makeVote('WA-2', 'kilocode', 'needs_changes', 0.9, [critical]),
    ];
    const { unique } = mergeFindings(votes);
    assert.strictEqual(unique[0].severity, 'critical');
    // Caller's original findings must remain untouched.
    assert.strictEqual(minor.severity, 'minor', 'first voter\'s finding was mutated');
    assert.strictEqual(critical.severity, 'critical');
    assert.strictEqual(votes[0].findings[0].severity, 'minor');
  });
});

// ---------------------------------------------------------------------------
// evaluateConsensus integrates mergeFindings (Item 5)
// ---------------------------------------------------------------------------

suite('Orchestrate — evaluateConsensus + mergeFindings', () => {
  test('dedupes identical findings reported by two voters', () => {
    // Use a non-security category so we land in the standard threshold path
    // (consensus_reached) where unresolved_findings is filtered to criticals.
    // We assert via the new merged_findings field which always reflects the
    // deduplicated union.
    const finding = makeFinding('bug', 'major', 'nil pointer', 'handler.go', 55);
    const votes = [
      makeVote('WA-1', 'kiro', 'approved', 0.9, [finding]),
      makeVote('WA-2', 'kilocode', 'approved', 0.9, [finding]),
    ];
    const result = evaluateConsensus(votes, 1);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.ok(result.merged_findings, 'merged_findings should be populated');
    assert.strictEqual(result.merged_findings!.length, 1);
  });

  test('upgrades severity when a later voter rates higher', () => {
    // Two distinct ValidationFinding objects with the same dedup key
    // (file:line:category:description) but different severities — Item 5
    // wires mergeFindings so the surviving entry is critical.
    const minor = makeFinding('security', 'minor', 'weak validation', 'auth.go', 30);
    const critical = makeFinding('security', 'critical', 'weak validation', 'auth.go', 30);
    const votes = [
      makeVote('WA-1', 'kiro', 'approved', 0.9, [minor]),
      makeVote('WA-2', 'kilocode', 'approved', 0.9, [critical]),
    ];
    const result = evaluateConsensus(votes, 1);
    // Security category is unanimous-required and a critical-severity finding
    // exists, so unanimous-approval check passes (both voted approved) and we
    // still hit consensus_reached. merged_findings holds the upgraded entry.
    assert.ok(result.merged_findings, 'merged_findings should be populated');
    assert.strictEqual(result.merged_findings!.length, 1);
    assert.strictEqual(result.merged_findings![0].severity, 'critical');
  });
});

// ---------------------------------------------------------------------------
// Sprint Markdown generation (COORDINATION_IMPROVEMENTS §2.4)
// ---------------------------------------------------------------------------

function makeSprint(): Sprint {
  return {
    sprint: 1,
    level: 0,
    status: 'assigned',
    dependencies_met: true,
    estimated_days: 4,
    assignments: [
      {
        agent: 'WA-1',
        platform: 'claude-code',
        inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
        tasks: [{ id: 'T1', name: 'Task 1', depends_on: [], scope: ['src/foo/**'], effort: 'M', subtasks: [] }],
        scope: ['src/foo/**'],
        branch: 'feat/sprint-1-wa-1-task-1',
        migration_range: { start: 100, end: 103 },
      },
      {
        agent: 'WA-2',
        platform: 'kiro',
        inbox: '.autoclaw/orchestrator/comms/inboxes/kiro/',
        tasks: [{ id: 'T2', name: 'Task 2', depends_on: [], scope: ['src/bar/**'], effort: 'S', subtasks: [] }],
        scope: ['src/bar/**'],
        branch: 'feat/sprint-1-wa-2-task-2',
        migration_range: null,
      },
    ],
  };
}

suite('Orchestrate — Sprint Markdown rendering', () => {
  test('renderSprintMarkdown produces a non-empty string for a minimal SprintPlan', () => {
    const sprint = makeSprint();
    const md = renderSprintMarkdown(sprint, 'demo');
    assert.ok(md.length > 0);
    assert.ok(md.includes('GENERATED'));
  });

  test('renderSprintMarkdown contains sprint number, status, and assignment branches', () => {
    const sprint = makeSprint();
    const md = renderSprintMarkdown(sprint, 'demo');
    assert.ok(md.includes('Sprint 1'));
    assert.ok(md.includes('assigned'));
    assert.ok(md.includes('feat/sprint-1-wa-1-task-1'));
    assert.ok(md.includes('feat/sprint-1-wa-2-task-2'));
    assert.ok(md.includes('claude-code'));
    assert.ok(md.includes('kiro'));
  });

  test('writeSprintArtifacts writes both yaml and md siblings', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-sprint-'));
    const sprint = makeSprint();
    const result = await writeSprintArtifacts(tmp, sprint, 'demo');
    assert.ok(fs.existsSync(result.yamlPath));
    assert.ok(fs.existsSync(result.mdPath));
    const md = fs.readFileSync(result.mdPath, 'utf8');
    assert.ok(md.startsWith('<!-- GENERATED'));
    const yaml = fs.readFileSync(result.yamlPath, 'utf8');
    assert.ok(yaml.includes('sprint: 1'));
  });

  test('writePlanArtifacts emits sprint-N.yaml + sprint-N.md for every sprint plus plan-summary.yaml', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-plan-'));
    // Two-level DAG → at least two sprints
    const tasks = [
      makeTask('a', [], ['src/a/**']),
      makeTask('b', [], ['src/b/**']),
      makeTask('c', ['a', 'b'], ['src/c/**']),
    ];
    const manifest = makeManifest(tasks);
    const plan = generatePlan(manifest, DEFAULT_PLANNER_CONFIG);
    assert.ok(plan.sprints.length >= 2, 'expected at least two sprints');

    const result = await writePlanArtifacts(tmp, plan, manifest.project.name);
    assert.strictEqual(result.sprintArtifacts.length, plan.sprints.length);

    for (const sprint of plan.sprints) {
      const yamlPath = path.join(tmp, `sprint-${sprint.sprint}.yaml`);
      const mdPath = path.join(tmp, `sprint-${sprint.sprint}.md`);
      assert.ok(fs.existsSync(yamlPath), `sprint-${sprint.sprint}.yaml exists`);
      assert.ok(fs.existsSync(mdPath), `sprint-${sprint.sprint}.md exists`);
      const md = fs.readFileSync(mdPath, 'utf8');
      assert.ok(md.startsWith('<!-- GENERATED'));
      assert.ok(md.includes(`Sprint ${sprint.sprint}`));
    }

    assert.ok(fs.existsSync(result.summaryPath), 'plan-summary.yaml exists');
    const summary = fs.readFileSync(result.summaryPath, 'utf8');
    assert.ok(summary.includes('total_sprints:'));
    assert.ok(summary.includes(manifest.project.name));
  });

  test('writePlanArtifacts regenerates sprint-N.md on every run (idempotent rewrite)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-plan-rerun-'));
    const tasks = [makeTask('a', [], ['src/a/**'])];
    const manifest = makeManifest(tasks);
    const plan = generatePlan(manifest, DEFAULT_PLANNER_CONFIG);

    await writePlanArtifacts(tmp, plan, manifest.project.name);
    const mdPath = path.join(tmp, 'sprint-1.md');
    const firstStat = fs.statSync(mdPath);
    // Second run must overwrite (no append, no error)
    await writePlanArtifacts(tmp, plan, manifest.project.name);
    const secondStat = fs.statSync(mdPath);
    assert.ok(secondStat.mtimeMs >= firstStat.mtimeMs, 'mtime non-decreasing');
    const md = fs.readFileSync(mdPath, 'utf8');
    // Single header — not duplicated by appending
    const headerCount = md.split('<!-- GENERATED').length - 1;
    assert.strictEqual(headerCount, 1, 'exactly one GENERATED header');
  });
});

// ---------------------------------------------------------------------------
// Capability-aware scorer (Phase 3 router)
// ---------------------------------------------------------------------------

suite('Orchestrate — jaccardIndex / trustWeight helpers', () => {
  test('jaccardIndex of two empty arrays is 1 (vacuously true)', () => {
    assert.strictEqual(jaccardIndex([], []), 1);
  });

  test('jaccardIndex of disjoint sets is 0', () => {
    assert.strictEqual(jaccardIndex(['go'], ['typescript']), 0);
  });

  test('jaccardIndex of identical sets is 1', () => {
    assert.strictEqual(jaccardIndex(['go', 'sql'], ['sql', 'go']), 1);
  });

  test('jaccardIndex of partial overlap is intersection / union', () => {
    // {a,b,c} vs {b,c,d} → intersection 2, union 4 → 0.5
    assert.strictEqual(jaccardIndex(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });

  test('trustWeight maps the four levels deterministically', () => {
    assert.strictEqual(trustWeight('untrusted'), 0);
    assert.strictEqual(trustWeight('low'), 0.4);
    assert.strictEqual(trustWeight('medium'), 0.7);
    assert.strictEqual(trustWeight('high'), 1.0);
    assert.strictEqual(trustWeight(undefined), 0.5);
  });
});

suite('Orchestrate — Acceptance Gate (C)', () => {
  test('acceptanceMet: exit_zero / exit_code / stdout_matches', () => {
    assert.strictEqual(acceptanceMet(undefined, 0, ''), true);
    assert.strictEqual(acceptanceMet('exit_zero', 1, ''), false);
    assert.strictEqual(acceptanceMet({ exit_code: 2 }, 2, ''), true);
    assert.strictEqual(acceptanceMet({ exit_code: 2 }, 0, ''), false);
    assert.strictEqual(acceptanceMet({ stdout_matches: 'PASS\\b' }, 0, 'all PASS here'), true);
    assert.strictEqual(acceptanceMet({ stdout_matches: 'PASS\\b' }, 0, 'nope'), false);
  });

  test('runAcceptanceChecks uses the injected runner and maps results', async () => {
    const exec = async (command: string) =>
      command.includes('fail') ? { exit_code: 1, stdout: 'boom' } : { exit_code: 0, stdout: 'ok' };
    const results = await runAcceptanceChecks([{ command: 'do pass' }, { command: 'do fail' }], { exec });
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].passed, true);
    assert.strictEqual(results[1].passed, false);
    assert.strictEqual(results[1].exit_code, 1);
  });

  test('a failing acceptance check blocks an otherwise-approved result', () => {
    const result = evaluateConsensus([
      makeVote('B', 'opus', 'approved'),
      makeVote('C', 'sonnet', 'approved'),
    ], 1);
    assert.strictEqual(result.status, 'consensus_reached');
    const gated = applyAcceptanceGate(result, [
      { command: 'npm test', exit_code: 1, passed: false, duration_ms: 12 },
    ]);
    assert.strictEqual(gated.final_verdict, 'needs_changes');
    assert.notStrictEqual(gated.status, 'consensus_reached');
    assert.strictEqual(gated.gate_checks!.length, 1);
    assert.ok(gated.unresolved_findings.some(f => f.severity === 'critical' && f.category === 'test_gap'));
  });

  test('CRITICAL task with a failing check becomes blocked', () => {
    const result = evaluateConsensus([
      makeVote('B', 'opus', 'approved'),
      makeVote('C', 'sonnet', 'approved'),
    ], 1);
    const gated = applyAcceptanceGate(
      result,
      [{ command: 'go vet', exit_code: 1, passed: false, duration_ms: 5 }],
      { criticality: 1 },
    );
    assert.strictEqual(gated.final_verdict, 'blocked');
  });

  test('all checks passing leaves the verdict intact (gate_checks attached)', () => {
    const result = evaluateConsensus([
      makeVote('B', 'opus', 'approved'),
      makeVote('C', 'sonnet', 'approved'),
    ], 1);
    const gated = applyAcceptanceGate(result, [
      { command: 'npm test', exit_code: 0, passed: true, duration_ms: 9 },
    ]);
    assert.strictEqual(gated.final_verdict, 'approved');
    assert.strictEqual(gated.status, 'consensus_reached');
    assert.strictEqual(gated.gate_checks!.length, 1);
  });
});

suite('Orchestrate — Tier × phase routing (B)', () => {
  const base: ScorableAgent = { capabilities: ['code'], trust_level: 'high', max_parallel_tasks: 1 };
  function task(phase?: TaskPhase): PlannedTask {
    return {
      id: 't', name: 't', depends_on: [], scope: ['internal/t/**'],
      effort: 'M', subtasks: [], required_capabilities: ['code'], phase,
    };
  }

  test('tierFactor is a no-op (1.0) when phase or llms_available is absent/unknown', () => {
    assert.strictEqual(tierFactor(undefined, 'review'), 1.0);
    assert.strictEqual(tierFactor(['claude-opus-4-8'], undefined), 1.0);
    assert.strictEqual(tierFactor([], 'review'), 1.0);
    assert.strictEqual(tierFactor(['totally-unknown-model'], 'review'), 1.0);
  });

  test('tierFactor peaks when the best model matches the phase preference', () => {
    assert.strictEqual(tierFactor(['claude-opus-4-8'], 'review'), 1.0); // opus(3) == review pref(3)
    assert.strictEqual(tierFactor(['claude-haiku-4-5'], 'grade'), 1.0);  // haiku(1) == grade pref(1)
    assert.ok(tierFactor(['claude-haiku-4-5'], 'review') < 1.0);         // haiku for review → penalized
    assert.ok(tierFactor(['claude-haiku-4-5'], 'review') >= 0.1);        // never reaches 0
  });

  test('grade prefers the cheap-tier agent; review prefers the strong-tier agent', () => {
    const haikuAgent: ScorableAgent = { ...base, llms_available: ['claude-haiku-4-5'] };
    const opusAgent: ScorableAgent = { ...base, llms_available: ['claude-opus-4-8'] };
    assert.ok(scoreAgent(haikuAgent, task('grade')) > scoreAgent(opusAgent, task('grade')), 'grade → cheap wins');
    assert.ok(scoreAgent(opusAgent, task('review')) > scoreAgent(haikuAgent, task('review')), 'review → strong wins');
  });

  test('phase unset → tier has no effect (identical scores across tiers)', () => {
    const haikuAgent: ScorableAgent = { ...base, llms_available: ['claude-haiku-4-5'] };
    const opusAgent: ScorableAgent = { ...base, llms_available: ['claude-opus-4-8'] };
    assert.strictEqual(scoreAgent(haikuAgent, task()), scoreAgent(opusAgent, task()));
  });
});

suite('Orchestrate — Manifest gate fields (scoped reader)', () => {
  test('parses criticality, phase and acceptance from a realistic manifest', () => {
    const yaml = [
      'manifest_version: "1.0"',
      'project: demo',
      '',
      'constraints:',
      '  mutual_exclusion:',
      '    - group: [A, B]',
      '',
      'tasks:',
      '',
      '  # lane one',
      '  - id: A',
      '    name: "Task A"',
      '    effort: M',
      '    depends_on: []',
      '    scope:',
      '      - "src/a/**"',
      '    criticality: 1',
      '    phase: review',
      '    acceptance:',
      '      - command: "npm test"',
      '        expect: exit_zero',
      '        timeout_seconds: 120',
      '      - command: "npm run lint"',
      '        expect:',
      '          stdout_matches: "0 problems"',
      '    subtasks:',
      '      - "do the thing: carefully"',
      '',
      '  - id: B',
      '    name: "Task B"',
      '    effort: S',
      '    depends_on: [A]',
      '    scope:',
      '      - "src/b/**"',
    ].join('\n');
    const { tasks, warnings } = parseManifestGateFields(yaml);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(tasks.length, 2);
    const a = tasks.find(t => t.id === 'A')!;
    assert.strictEqual(a.criticality, 1);
    assert.strictEqual(a.phase, 'review');
    assert.deepStrictEqual(a.acceptance, [
      { command: 'npm test', expect: 'exit_zero', timeout_seconds: 120 },
      { command: 'npm run lint', expect: { stdout_matches: '0 problems' } },
    ]);
    const b = tasks.find(t => t.id === 'B')!;
    assert.strictEqual(b.criticality, undefined);
    assert.strictEqual(b.phase, undefined);
    assert.strictEqual(b.acceptance, undefined);
  });

  test('zero-config manifest → no gate fields and no warnings', () => {
    const yaml = [
      'tasks:',
      '  - id: plain',
      '    name: "no opt-in fields here"',
      '    depends_on: []',
    ].join('\n');
    const { tasks, warnings } = parseManifestGateFields(yaml);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(tasks.length, 1);
    assert.deepStrictEqual(tasks[0], { id: 'plain' });
  });

  test('invalid phase/criticality are ignored with a warning; commandless checks are skipped', () => {
    const yaml = [
      'tasks:',
      '  - id: C',
      '    phase: deploy',
      '    criticality: 7',
      '    acceptance:',
      '      - expect: exit_zero',
      '      - command: ""',
      '      - command: "go vet ./..."',
    ].join('\n');
    const { tasks, warnings } = parseManifestGateFields(yaml);
    const c = tasks.find(t => t.id === 'C')!;
    assert.strictEqual(c.phase, undefined);
    assert.strictEqual(c.criticality, undefined);
    assert.deepStrictEqual(c.acceptance, [{ command: 'go vet ./...' }]);
    assert.ok(warnings.some(w => w.includes('phase "deploy"')), `phase warning missing: ${warnings}`);
    assert.ok(warnings.some(w => w.includes('criticality "7"')), `criticality warning missing: ${warnings}`);
    assert.strictEqual(warnings.filter(w => w.includes('missing a non-empty "command"')).length, 2);
  });

  test('expect supports inline flow maps and block exit_code', () => {
    const yaml = [
      'tasks:',
      '  - id: D',
      '    acceptance:',
      '      - command: "run-it"',
      '        expect: { exit_code: 3 }',
      '      - command: "check-out"',
      '        expect:',
      '          exit_code: 0',
    ].join('\n');
    const { tasks, warnings } = parseManifestGateFields(yaml);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(tasks.find(t => t.id === 'D')!.acceptance, [
      { command: 'run-it', expect: { exit_code: 3 } },
      { command: 'check-out', expect: { exit_code: 0 } },
    ]);
  });

  test('readManifestTaskGates merges files (first id wins) and tolerates a missing dir', async () => {
    const missing = await readManifestTaskGates(path.join(os.tmpdir(), 'autoclaw-no-such-dir-xyz'));
    assert.strictEqual(missing.tasks.size, 0);
    assert.deepStrictEqual(missing.warnings, []);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-manifests-'));
    fs.writeFileSync(path.join(dir, 'a-first.yaml'), [
      'tasks:',
      '  - id: T1',
      '    phase: grade',
      '  - id: T2',
      '    phase: nonsense',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'b-second.yaml'), [
      'tasks:',
      '  - id: T1',
      '    phase: review',
    ].join('\n'), 'utf8');

    const { tasks, warnings } = await readManifestTaskGates(dir);
    assert.strictEqual(tasks.size, 2);
    assert.strictEqual(tasks.get('T1')!.phase, 'grade', 'first definition (sorted filename) wins');
    assert.strictEqual(tasks.get('T2')!.phase, undefined);
    assert.ok(warnings.some(w => w.startsWith('a-first.yaml:') && w.includes('nonsense')),
      `expected filename-prefixed warning, got: ${warnings}`);
  });
});

suite('Orchestrate — scoreAgent', () => {
  function makePlanned(
    id: string,
    required: string[] = [],
    effort: 'S' | 'M' | 'L' | 'XL' = 'M'
  ): PlannedTask {
    return {
      id,
      name: id,
      depends_on: [],
      scope: [`internal/${id}/**`],
      effort,
      subtasks: [],
      required_capabilities: required,
    };
  }

  test('untrusted agent always scores 0 regardless of fit', () => {
    const agent: ScorableAgent = {
      capabilities: ['go'],
      trust_level: 'untrusted',
      max_parallel_tasks: 4,
    };
    const score = scoreAgent(agent, makePlanned('t', ['go']));
    assert.strictEqual(score, 0);
  });

  test('zero capability overlap on a typed task scores 0', () => {
    const agent: ScorableAgent = {
      capabilities: ['rust'],
      trust_level: 'high',
      max_parallel_tasks: 4,
    };
    const score = scoreAgent(agent, makePlanned('t', ['go']));
    assert.strictEqual(score, 0);
  });

  test('saturated agent (in_flight = max_parallel_tasks) scores 0', () => {
    const agent: ScorableAgent = {
      capabilities: ['go'],
      trust_level: 'high',
      max_parallel_tasks: 2,
      in_flight: 2,
    };
    const score = scoreAgent(agent, makePlanned('t', ['go']));
    assert.strictEqual(score, 0);
  });

  // AF-8 §4: agent_type tags can only BOOST capability_match, never lower it.
  test('agent_type never lowers a score, and boosts when a type tag matches', () => {
    const baseAgent: ScorableAgent = { capabilities: ['code'], trust_level: 'high', max_parallel_tasks: 1 };
    const typedAgent: ScorableAgent = { ...baseAgent, agent_type: 'auditor' };

    // Non-regression: on a task it already matches perfectly, the type adds nothing (max preserves 1.0).
    const t1 = makePlanned('t1', ['code']);
    assert.strictEqual(scoreAgent(typedAgent, t1), scoreAgent(baseAgent, t1), 'type never lowers a perfect match');

    // Boost: the task requires 'security-review' (an auditor type tag the agent didn't declare).
    const t2 = makePlanned('t2', ['security-review']);
    assert.strictEqual(scoreAgent(baseAgent, t2), 0, 'untyped agent has no overlap');
    assert.ok(scoreAgent(typedAgent, t2) > 0, 'auditor type lends the security-review capability');
  });

  test('higher trust agent outscores lower trust on identical capability fit', () => {
    const high: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      languages_supported: ['go'],
    };
    const low: ScorableAgent = {
      capabilities: ['go'], trust_level: 'low', max_parallel_tasks: 1,
      languages_supported: ['go'],
    };
    const task = makePlanned('t', ['go']);
    assert.ok(scoreAgent(high, task) > scoreAgent(low, task));
  });

  test('language overlap doubles capability_match relative to no-overlap', () => {
    const overlap: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      languages_supported: ['go'],
    };
    const noOverlap: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      languages_supported: ['rust'],
    };
    const task = makePlanned('t', ['go']);
    const sOverlap = scoreAgent(overlap, task);
    const sNo = scoreAgent(noOverlap, task);
    assert.ok(sOverlap > 0 && sNo > 0);
    // 1.0 vs 0.5 multiplier on capability_match
    assert.ok(Math.abs(sOverlap / sNo - 2) < 1e-9, `expected 2x ratio, got ${sOverlap / sNo}`);
  });

  test('idle_factor scales linearly with remaining capacity', () => {
    const idle: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 4,
      in_flight: 0, languages_supported: ['go'],
    };
    const half: ScorableAgent = { ...idle, in_flight: 2 };
    const task = makePlanned('t', ['go']);
    const sIdle = scoreAgent(idle, task);
    const sHalf = scoreAgent(half, task);
    // idle = (4-0)/4 = 1.0; half = (4-2)/4 = 0.5
    assert.ok(Math.abs(sIdle / sHalf - 2) < 1e-9, `expected 2x ratio, got ${sIdle / sHalf}`);
  });

  test('cheaper agent (lower hourly_usd) outscores expensive on equal fit', () => {
    const cheap: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      cost_budget: { hourly_usd: 0.5 }, languages_supported: ['go'],
    };
    const pricey: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      cost_budget: { hourly_usd: 5 }, languages_supported: ['go'],
    };
    const task = makePlanned('t', ['go']);
    assert.ok(scoreAgent(cheap, task) > scoreAgent(pricey, task));
  });

  test('all-default agent on a no-cap task still scores > 0 (registry under-populated)', () => {
    // No capabilities, no trust, no cost — but task has no required caps,
    // so jaccard({}, {}) = 1 and scoring still produces a positive value.
    const blank: ScorableAgent = {};
    const task = makePlanned('t', []);
    const score = scoreAgent(blank, task);
    assert.ok(score > 0, `expected positive score, got ${score}`);
  });

  test('higher-effort task lowers score (cost normalisation)', () => {
    const agent: ScorableAgent = {
      capabilities: ['go'], trust_level: 'high', max_parallel_tasks: 1,
      languages_supported: ['go'],
    };
    const small = scoreAgent(agent, makePlanned('s', ['go'], 'S'));
    const large = scoreAgent(agent, makePlanned('l', ['go'], 'XL'));
    // S = 2h, XL = 16h, ratio 8
    assert.ok(small > large);
    assert.ok(Math.abs(small / large - 8) < 1e-9, `expected 8x ratio, got ${small / large}`);
  });
});

// ---------------------------------------------------------------------------
// planSprints — capability-aware routing with a populated registry
// ---------------------------------------------------------------------------

suite('Orchestrate — planSprints with capability-aware registry', () => {
  function taskWithCaps(
    id: string,
    required: string[],
    scope: string[] = [`internal/${id}/**`]
  ): ManifestTask {
    return {
      id, name: `Task ${id}`, depends_on: [], scope,
      effort: 'M', subtasks: ['s1'],
      required_capabilities: required,
    };
  }

  test('Go-capable agent gets the Go task; TS-only agent does not', () => {
    const tasks = [taskWithCaps('go-task', ['go'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kilocode', inbox: '.autoclaw/orchestrator/comms/inboxes/kilocode/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['typescript'], trust_level: 'high' as const, max_parallel_tasks: 1,
        languages_supported: ['typescript'] },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['go'], trust_level: 'high' as const, max_parallel_tasks: 1,
        languages_supported: ['go'] },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    const flat = sprints.flatMap(s => s.assignments);
    const assignedAgent = flat.find(a => a.tasks.some(t => t.id === 'go-task'))!.agent;
    assert.strictEqual(assignedAgent, 'WA-2',
      `expected go-task to land on WA-2 (go-capable), got ${assignedAgent}`);
  });

  test('llms_available on the registry entry routes a grade-phase task to the cheap tier', () => {
    // Equal capability/trust/idle; only the advertised models differ. WA-1
    // (opus) would win the tie-break, so WA-2 winning proves tierFactor ran.
    const tasks: ManifestTask[] = [{ ...taskWithCaps('grader', ['code']), phase: 'grade' }];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kilocode', inbox: '.autoclaw/orchestrator/comms/inboxes/kilocode/',
        sprint: null, assigned_at: '2026-06-12T00:00:00Z',
        capabilities: ['code'], trust_level: 'high' as const, max_parallel_tasks: 1,
        llms_available: ['claude-opus-4-8'] },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
        sprint: null, assigned_at: '2026-06-12T00:00:00Z',
        capabilities: ['code'], trust_level: 'high' as const, max_parallel_tasks: 1,
        llms_available: ['claude-haiku-4-5'] },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    const winner = sprints.flatMap(s => s.assignments)
      .find(a => a.tasks.some(t => t.id === 'grader'))!.agent;
    assert.strictEqual(winner, 'WA-2', 'grade phase should prefer the haiku-advertising slot');
  });

  test('high-trust agent gets the security task over low-trust on equal capability fit', () => {
    const tasks = [taskWithCaps('audit', ['security-review'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kilocode', inbox: '.autoclaw/orchestrator/comms/inboxes/kilocode/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['security-review'], trust_level: 'low' as const, max_parallel_tasks: 1,
        languages_supported: ['security-review'] },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['security-review'], trust_level: 'high' as const, max_parallel_tasks: 1,
        languages_supported: ['security-review'] },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    const winner = sprints.flatMap(s => s.assignments)
      .find(a => a.tasks.some(t => t.id === 'audit'))!.agent;
    assert.strictEqual(winner, 'WA-2', 'high-trust slot should win the security task');
  });

  test('emits capability_pending and a notes warning when no agent has positive score for a capabilities task', () => {
    // Task requires "rust" — no agent has it, so jaccard is 0 for everyone.
    const tasks = [taskWithCaps('rusty', ['rust'])];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kiro', inbox: '.autoclaw/orchestrator/comms/inboxes/kiro/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['go'], trust_level: 'high' as const, max_parallel_tasks: 1,
        languages_supported: ['go'] },
      { id: 'WA-2', platform: 'claude-code', inbox: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        capabilities: ['typescript'], trust_level: 'high' as const, max_parallel_tasks: 1,
        languages_supported: ['typescript'] },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    // Task is still assigned (round-robin fallback) while awaiting a capability offer.
    const flat = sprints.flatMap(s => s.assignments);
    assert.ok(flat.some(a => a.tasks.some(t => t.id === 'rusty')),
      'rust task should be assigned via round-robin fallback while awaiting capability offers');
    // capability_pending recorded on the sprint.
    const sprintWithPending = sprints.find(s => s.capability_pending && s.capability_pending.length > 0);
    assert.ok(sprintWithPending, 'expected a sprint with capability_pending when no agent qualifies');
    assert.ok(
      sprintWithPending!.capability_pending!.some(p => p.task_id === 'rusty' && p.required_capabilities.includes('rust')),
      `expected capability_pending entry for rusty, got: ${JSON.stringify(sprintWithPending!.capability_pending)}`
    );
    // Notes also mention the capability query broadcast.
    const sprintWithNotes = sprints.find(s => s.notes && s.notes.length > 0);
    assert.ok(sprintWithNotes, 'expected a sprint with notes when capability_pending fired');
    assert.ok(
      sprintWithNotes!.notes!.some(n => n.includes('rusty') && n.includes('capability_query')),
      `expected notes to mention rusty + capability_query, got: ${JSON.stringify(sprintWithNotes!.notes)}`
    );
  });

  test('no registry → output identical to legacy round-robin (regression)', () => {
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
      makeTask('c', ['a'], ['internal/c/**']),
    ];
    const dag1 = buildDAG(tasks);
    topologicalSort(dag1);
    const baseline = planSprints(dag1, DEFAULT_PLANNER_CONFIG);

    const dag2 = buildDAG(tasks);
    topologicalSort(dag2);
    // Legacy AgentRegistryEntry rows (no scoring fields) → still round-robin.
    const legacyAgents = [
      { id: 'WA-1', platform: 'kiro', inbox: 'inboxes/kiro/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z' },
    ];
    const withLegacyRegistry = planSprints(dag2, DEFAULT_PLANNER_CONFIG, undefined, legacyAgents);

    assert.deepStrictEqual(
      withLegacyRegistry.map(s => s.assignments.map(a => ({ agent: a.agent, tasks: a.tasks.map(t => t.id) }))),
      baseline.map(s => s.assignments.map(a => ({ agent: a.agent, tasks: a.tasks.map(t => t.id) })))
    );
    // No notes emitted in the legacy path.
    for (const s of withLegacyRegistry) {
      assert.ok(s.notes === undefined || s.notes.length === 0,
        `legacy path should not emit notes; got ${JSON.stringify(s.notes)}`);
    }
  });

  test('registry with empty capabilities/trust still triggers scoring path safely', () => {
    // One agent populates max_parallel_tasks (truthy scoring field) but no
    // capabilities — every task should still be assignable because jaccard
    // of ([], []) = 1 when the task has no required_capabilities.
    const tasks = [
      makeTask('a', [], ['internal/a/**']),
      makeTask('b', [], ['internal/b/**']),
    ];
    const dag = buildDAG(tasks);
    topologicalSort(dag);
    const agents = [
      { id: 'WA-1', platform: 'kiro', inbox: 'inboxes/kiro/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        max_parallel_tasks: 3 },
      { id: 'WA-2', platform: 'claude-code', inbox: 'inboxes/claude-code/',
        sprint: null, assigned_at: '2026-05-10T00:00:00Z',
        max_parallel_tasks: 3 },
    ];
    const sprints = planSprints(
      dag,
      { ...DEFAULT_PLANNER_CONFIG, work_agents: 2, max_tasks_per_agent: 1 },
      undefined,
      agents
    );
    const totalAssigned = sprints
      .flatMap(s => s.assignments)
      .reduce((sum, a) => sum + a.tasks.length, 0);
    assert.strictEqual(totalAssigned, 2, 'both tasks should be assigned');
  });
});

// ---------------------------------------------------------------------------
// Capability Query / Offer round-trip
// ---------------------------------------------------------------------------

suite('Orchestrate — broadcastCapabilityQueries + resolveCapabilityOffers', () => {
  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'capq-test-'));
    return d;
  }

  const pending: CapabilityPendingTask[] = [
    { task_id: 'rust-task', required_capabilities: ['rust'], sprint: 1, query_id: 'capq-rust-sp1' },
  ];

  test('broadcastCapabilityQueries writes a capability_query to shared inbox', async () => {
    const commsDir = makeTmpDir();
    await broadcastCapabilityQueries(commsDir, 'orchestrator', pending);
    const sharedInbox = path.join(commsDir, 'inboxes', 'shared');
    const files = fs.readdirSync(sharedInbox).filter(f => f.includes('capability_query'));
    assert.strictEqual(files.length, 1, 'one capability_query file written');
    const msg = JSON.parse(fs.readFileSync(path.join(sharedInbox, files[0]), 'utf8'));
    assert.strictEqual(msg.type, 'capability_query');
    assert.strictEqual(msg.payload.query_id, 'capq-rust-sp1');
    assert.deepStrictEqual(msg.payload.required_capabilities, ['rust']);
  });

  test('broadcastCapabilityQueries is a no-op for empty pending list', async () => {
    const commsDir = makeTmpDir();
    await broadcastCapabilityQueries(commsDir, 'orchestrator', []);
    assert.ok(!fs.existsSync(path.join(commsDir, 'inboxes', 'shared')), 'no inbox created for empty list');
  });

  test('resolveCapabilityOffers returns empty when no offers present', async () => {
    const commsDir = makeTmpDir();
    const resolutions = await resolveCapabilityOffers(commsDir, 'orchestrator', pending);
    assert.deepStrictEqual(resolutions, []);
  });

  test('resolveCapabilityOffers picks best offer by Jaccard score', async () => {
    const commsDir = makeTmpDir();
    const inboxDir = path.join(commsDir, 'inboxes', 'orchestrator');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Offer A: partial match (rust only)
    const offerA = {
      id: 'offer-a', from: 'remote-1', to: 'orchestrator', type: 'capability_offer',
      timestamp: new Date().toISOString(),
      payload: { for_query_id: 'capq-rust-sp1', agent_id: 'remote-1', capabilities: ['rust'], estimated_cost_usd: 5 },
    };
    // Offer B: full match + cheaper
    const offerB = {
      id: 'offer-b', from: 'remote-2', to: 'orchestrator', type: 'capability_offer',
      timestamp: new Date().toISOString(),
      payload: { for_query_id: 'capq-rust-sp1', agent_id: 'remote-2', capabilities: ['rust', 'wasm'], estimated_cost_usd: 1 },
    };
    fs.writeFileSync(path.join(inboxDir, '2026-01-01-capability_offer-remote-1.json'), JSON.stringify(offerA));
    fs.writeFileSync(path.join(inboxDir, '2026-01-01-capability_offer-remote-2.json'), JSON.stringify(offerB));

    const resolutions = await resolveCapabilityOffers(commsDir, 'orchestrator', pending);
    assert.strictEqual(resolutions.length, 1);
    assert.strictEqual(resolutions[0].task_id, 'rust-task');
    // Both have recall=1.0 (both have 'rust'), B has lower cost_usd (1 vs 5) → B wins
    assert.strictEqual(resolutions[0].winning_agent_id, 'remote-2');
  });

  test('resolveCapabilityOffers ignores offers for different query_id', async () => {
    const commsDir = makeTmpDir();
    const inboxDir = path.join(commsDir, 'inboxes', 'orchestrator');
    fs.mkdirSync(inboxDir, { recursive: true });
    const wrongOffer = {
      id: 'offer-x', from: 'remote-x', to: 'orchestrator', type: 'capability_offer',
      timestamp: new Date().toISOString(),
      payload: { for_query_id: 'capq-wrong-sp9', agent_id: 'remote-x', capabilities: ['rust'] },
    };
    fs.writeFileSync(path.join(inboxDir, '2026-01-01-capability_offer-remote-x.json'), JSON.stringify(wrongOffer));
    const resolutions = await resolveCapabilityOffers(commsDir, 'orchestrator', pending);
    assert.deepStrictEqual(resolutions, []);
  });
});

// ---------------------------------------------------------------------------
// Task criticality → consensus config mapping
// ---------------------------------------------------------------------------

suite('consensusConfigForTask — criticality tier routing', () => {
  const makeVotes = (approvals: number, total: number): ValidationVote[] => {
    const votes: ValidationVote[] = [];
    for (let i = 0; i < total; i++) {
      votes.push({
        agent_id: `agent-${i}`,
        provider: `provider-${i}`,
        verdict: i < approvals ? 'approved' : 'needs_changes',
        confidence: 0.9, findings: [], timestamp: '',
      });
    }
    return votes;
  };

  test('criticality 1 (CRITICAL) sets unanimous threshold (1.0)', () => {
    const cfg = consensusConfigForTask(1 as TaskCriticality);
    assert.strictEqual(cfg.approval_threshold, 1.0);
    assert.strictEqual(cfg.block_is_veto, true);
  });

  test('criticality 2 (MAJOR) returns default config (0.66)', () => {
    const cfg = consensusConfigForTask(2 as TaskCriticality);
    assert.strictEqual(cfg.approval_threshold, DEFAULT_CONSENSUS_CONFIG.approval_threshold);
  });

  test('criticality 3 (ROUTINE) sets simple majority threshold (0.501)', () => {
    const cfg = consensusConfigForTask(3 as TaskCriticality);
    assert.ok(cfg.approval_threshold < 0.51 && cfg.approval_threshold > 0.5);
  });

  test('undefined criticality returns default config', () => {
    const cfg = consensusConfigForTask(undefined);
    assert.strictEqual(cfg.approval_threshold, DEFAULT_CONSENSUS_CONFIG.approval_threshold);
  });

  test('CRITICAL task fails when one voter dissents (unanimous required)', () => {
    const cfg = consensusConfigForTask(1 as TaskCriticality);
    // 2 of 3 approve — not unanimous
    const result = evaluateConsensus(makeVotes(2, 3), 1, cfg);
    assert.notStrictEqual(result.status, 'consensus_reached', 'should not reach consensus with 2/3 for CRITICAL');
  });

  test('CRITICAL task succeeds when all voters approve', () => {
    const cfg = consensusConfigForTask(1 as TaskCriticality);
    const result = evaluateConsensus(makeVotes(3, 3), 1, cfg);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.final_verdict, 'approved');
  });

  test('ROUTINE task succeeds with simple majority (2 of 3)', () => {
    const cfg = consensusConfigForTask(3 as TaskCriticality);
    const result = evaluateConsensus(makeVotes(2, 3), 1, cfg);
    assert.strictEqual(result.status, 'consensus_reached');
    assert.strictEqual(result.final_verdict, 'approved');
  });

  test('MAJOR task fails with 1 of 3 approvals (below 2/3)', () => {
    const cfg = consensusConfigForTask(2 as TaskCriticality);
    const result = evaluateConsensus(makeVotes(1, 3), 1, cfg);
    assert.notStrictEqual(result.status, 'consensus_reached');
  });
});

