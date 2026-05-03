import * as assert from 'assert';
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
} from '../orchestrate';
import type {
  ManifestTask,
  Manifest,
  PlannerConfig,
  DAG,
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
} from '../orchestrate';
import type {
  ValidationVote,
  ValidationFinding,
  ConsensusConfig,
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
});
