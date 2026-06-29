import * as assert from 'assert';

import {
  mutateScaffoldVariant,
  parseScaffoldVariant,
  type ScaffoldMutationKind,
  type ScaffoldVariant,
} from '../workflows/scaffolds';

function baseScaffold(overrides: Partial<ScaffoldVariant> = {}): ScaffoldVariant {
  return {
    schema: 'autoclaw.scaffold.v1',
    id: 'scaffold-base',
    workflowId: 'wf-review',
    taskIntent: 'review',
    routerProfile: 'balanced',
    toolLaneIds: ['filesystem', 'mocha'],
    createdAt: '2026-06-29T00:00:00.000Z',
    review: {
      tier: 'tier1-local',
      reviewerIndependence: 'same-model',
      gatesFirst: true,
    },
    metadata: { existing: true },
    ...overrides,
  };
}

suite('workflow scaffold mutations', () => {
  test('supports the required mutation kinds and emits parseable child scaffolds', () => {
    const cases: Array<{ kind: ScaffoldMutationKind; input: Parameters<typeof mutateScaffoldVariant>[0]; assertChild: (child: ScaffoldVariant) => void }> = [
      {
        kind: 'context_mode',
        input: { base: baseScaffold(), kind: 'context_mode', contextMode: 'kg-heavy', createdAt: '2026-06-29T01:00:00.000Z' },
        assertChild: (child) => {
          assert.strictEqual(child.contextPlanId, 'context:kg-heavy');
          assert.strictEqual(child.metadata?.contextMode, 'kg-heavy');
        },
      },
      {
        kind: 'loop_policy',
        input: {
          base: baseScaffold(),
          kind: 'loop_policy',
          loopPolicy: { kind: 'best-of-N', maxIterations: 4, maxDepth: 2, noProgressAfter: 3 },
        },
        assertChild: (child) => {
          assert.strictEqual(child.loopPolicyId, 'loop:best-of-N:4:2:3');
          assert.deepStrictEqual(child.metadata?.loopPolicy, {
            kind: 'best-of-N',
            maxIterations: 4,
            maxDepth: 2,
            noProgressAfter: 3,
          });
        },
      },
      {
        kind: 'router_profile',
        input: { base: baseScaffold(), kind: 'router_profile', routerProfile: 'quality' },
        assertChild: (child) => assert.strictEqual(child.routerProfile, 'quality'),
      },
      {
        kind: 'best_of_n',
        input: { base: baseScaffold(), kind: 'best_of_n', bestOfN: 3 },
        assertChild: (child) => assert.strictEqual(child.metadata?.bestOfN, 3),
      },
      {
        kind: 'tool_lane',
        input: { base: baseScaffold(), kind: 'tool_lane', toolLaneIds: ['filesystem', 'vitest'] },
        assertChild: (child) => assert.deepStrictEqual(child.toolLaneIds, ['filesystem', 'vitest']),
      },
      {
        kind: 'reviewer_independence',
        input: { base: baseScaffold(), kind: 'reviewer_independence', reviewerIndependence: 'different-provider' },
        assertChild: (child) => assert.strictEqual(child.review?.reviewerIndependence, 'different-provider'),
      },
    ];

    for (const item of cases) {
      const result = mutateScaffoldVariant(item.input);
      assert.strictEqual(result.ok, true, item.kind);
      assert.ok(result.scaffold, item.kind);
      assert.strictEqual(result.scaffold!.parentScaffoldId, 'scaffold-base');
      assert.strictEqual(result.scaffold!.mutation?.kind, item.kind);
      assert.strictEqual(result.scaffold!.mutation?.parentScaffoldId, 'scaffold-base');
      assert.notStrictEqual(result.scaffold!.id, 'scaffold-base');
      parseScaffoldVariant(result.scaffold);
      item.assertChild(result.scaffold!);
    }
  });

  test('does not mutate the parent scaffold', () => {
    const parent = baseScaffold();
    const result = mutateScaffoldVariant({ base: parent, kind: 'router_profile', routerProfile: 'quality' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(parent.routerProfile, 'balanced');
    assert.deepStrictEqual(parent.metadata, { existing: true });
  });

  test('bounds best-of-N, loop policy, and tool lane outputs before execution', () => {
    const invalidBestOfN = mutateScaffoldVariant({ base: baseScaffold(), kind: 'best_of_n', bestOfN: 12 });
    const invalidLoop = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'loop_policy',
      loopPolicy: { kind: 'retry', maxIterations: 20, maxDepth: 1, noProgressAfter: 2 },
    });
    const invalidLane = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'tool_lane',
      toolLaneIds: ['filesystem', 'filesystem'],
    });

    assert.strictEqual(invalidBestOfN.ok, false);
    assert.strictEqual(invalidBestOfN.diagnostics[0].code, 'invalid_best_of_n');
    assert.strictEqual(invalidLoop.ok, false);
    assert.strictEqual(invalidLoop.diagnostics[0].code, 'invalid_loop_policy');
    assert.strictEqual(invalidLane.ok, false);
    assert.strictEqual(invalidLane.diagnostics[0].code, 'invalid_tool_lane');
  });

  test('blocks file-scope widening unless human-approved', () => {
    const blocked = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'tool_lane',
      toolLaneIds: ['filesystem'],
      currentScopeGlobs: ['src/workflows/**'],
      proposedScopeGlobs: ['src/workflows/**', 'src/llm/**'],
    });
    const approved = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'tool_lane',
      toolLaneIds: ['filesystem'],
      currentScopeGlobs: ['src/workflows/**'],
      proposedScopeGlobs: ['src/workflows/**', 'src/llm/**'],
      humanApproved: true,
    });

    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.diagnostics[0].code, 'scope_widening_requires_human');
    assert.strictEqual(approved.ok, true);
  });

  test('blocks policy bypasses unless human-approved', () => {
    const blocked = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'router_profile',
      routerProfile: 'quality',
      currentPolicies: { allowWrites: false, requireHumanApproval: true, maxIterations: 2 },
      proposedPolicies: { allowWrites: true, requireHumanApproval: false, maxIterations: 5 },
    });
    const approved = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'router_profile',
      routerProfile: 'quality',
      currentPolicies: { allowWrites: false, requireHumanApproval: true, maxIterations: 2 },
      proposedPolicies: { allowWrites: true, requireHumanApproval: false, maxIterations: 5 },
      humanApproved: true,
    });

    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.diagnostics[0].code, 'policy_bypass_requires_human');
    assert.ok(blocked.diagnostics[0].reason.includes('allowWrites'));
    assert.ok(blocked.diagnostics[0].reason.includes('requireHumanApproval'));
    assert.ok(blocked.diagnostics[0].reason.includes('maxIterations'));
    assert.strictEqual(approved.ok, true);
  });

  test('reviewer_independence=human forces the human review tier', () => {
    const result = mutateScaffoldVariant({
      base: baseScaffold(),
      kind: 'reviewer_independence',
      reviewerIndependence: 'human',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scaffold?.review?.reviewerIndependence, 'human');
    assert.strictEqual(result.scaffold?.review?.tier, 'human');
  });
});
