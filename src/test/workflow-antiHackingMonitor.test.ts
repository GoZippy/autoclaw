import * as assert from 'assert';

import { buildScaffoldScore, evaluateScaffoldMonitor, SCAFFOLD_SCHEMA, type ScaffoldVariant } from '../workflows/scaffolds';

function scaffold(): ScaffoldVariant {
  return {
    schema: SCAFFOLD_SCHEMA,
    id: 'scaffold-monitored',
    workflowId: 'wf-monitor',
    taskIntent: 'code',
    routerProfile: 'balanced',
    toolLaneIds: ['filesystem'],
    createdAt: '2026-06-29T00:00:00.000Z',
  };
}

suite('workflow scaffold anti-hacking monitor', () => {
  test('blocks reads of hidden verifier paths', () => {
    const result = evaluateScaffoldMonitor({
      reads: [{ path: '.autoclaw/verifiers/secret-gate.json', kind: 'read' }],
      now: '2026-06-29T00:00:00.000Z',
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.violations[0].kind, 'hidden_verifier_read');
    assert.strictEqual(result.rewardOverride, -1);
  });

  test('blocks writes to verifier, hidden test, ledgers, and policies', () => {
    const result = evaluateScaffoldMonitor({
      writes: [
        { path: 'src/__hidden_tests__/acceptance.test.ts' },
        { path: '.autoclaw/workflows/scaffolds/scores.jsonl' },
        { path: '.autoclaw/workflows/runs/run-1.jsonl' },
        { path: 'docs/policies/release.yaml' },
        { path: 'verifiers/hidden/check.json' },
      ],
    });

    assert.deepStrictEqual(
      result.violations.map((v) => v.kind).sort(),
      ['hidden_test_modified', 'policy_modified', 'run_ledger_modified', 'score_ledger_modified', 'verifier_modified'].sort(),
    );
  });

  test('allowedWriteGlobs can explicitly permit protected writes', () => {
    const result = evaluateScaffoldMonitor({
      writes: [{ path: 'docs/policies/release.yaml' }],
      allowedWriteGlobs: ['docs/policies/release.yaml'],
    });

    assert.strictEqual(result.allowed, true);
    assert.deepStrictEqual(result.violations, []);
  });

  test('out-of-scope writes map to scope_violation finding payloads', () => {
    const result = evaluateScaffoldMonitor({
      agentId: 'codex',
      taskId: 'OSL-5.1',
      scaffoldId: 'scaffold-monitored',
      scopeGlobs: ['src/workflows/scaffolds/**'],
      writes: [{ path: 'src/extension.ts' }],
    });

    assert.strictEqual(result.violations[0].kind, 'scope_violation');
    assert.strictEqual(result.findings[0].task_id, 'OSL-5.1');
    assert.strictEqual(result.findings[0].agent, 'codex');
    assert.ok(result.findings[0].finding.includes('outside declared scaffold scope'));
  });

  test('monitor violation feeds the scorer as negative reward', () => {
    const monitor = evaluateScaffoldMonitor({
      writes: [{ path: '.autoclaw/workflows/scaffolds/scores.jsonl' }],
    });
    const scored = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        runId: 'run-monitor',
        workflowId: 'wf-monitor',
        status: 'completed',
      },
      review: { verifierPass: true },
      antiHackingViolation: monitor.violations[0],
      createdAt: '2026-06-29T00:01:00.000Z',
    });

    assert.strictEqual(scored.score?.pass, false);
    assert.strictEqual(scored.score?.reward, -1);
    assert.strictEqual(scored.score?.scopeViolation, true);
  });
});
