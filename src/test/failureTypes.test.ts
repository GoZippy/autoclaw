import * as assert from 'assert';

import {
  WORKFLOW_FAILURE_TYPES,
  failureTypeFromGateResult,
  failureTypeFromToolError,
  isEscalationCandidate,
  isHumanRequired,
  isRetryableFailure,
  normalizeFailureType,
  type FailureType,
} from '../diagnostics/failureTypes';

suite('failureTypes', () => {
  test('normalizes every canonical failure type', () => {
    for (const type of WORKFLOW_FAILURE_TYPES) {
      assert.deepStrictEqual(normalizeFailureType(type), { type });
    }
  });

  test('preserves unknown external failure strings', () => {
    assert.deepStrictEqual(normalizeFailureType('vendor_rate_limit'), {
      type: 'unknown_external',
      original: 'vendor_rate_limit',
    });
  });

  test('classifies retry, escalation, and human-required failures', () => {
    const retryable: FailureType[] = ['context_missing', 'test_failure', 'tool_format_invalid'];
    for (const type of retryable) {
      assert.strictEqual(isRetryableFailure(type), true, `${type} should be retryable`);
    }

    assert.strictEqual(isEscalationCandidate('compile_error'), true);
    assert.strictEqual(isEscalationCandidate('unknown_external'), true);
    assert.strictEqual(isHumanRequired('scope_conflict'), true);
    assert.strictEqual(isHumanRequired('irreducible_or_needs_human'), true);
    assert.strictEqual(isHumanRequired('test_failure'), false);
  });

  test('maps gate results for compile, test, schema, budget, scope, and context failures', () => {
    assert.strictEqual(failureTypeFromGateResult({ kind: 'compile', passed: false }).type, 'compile_error');
    assert.strictEqual(failureTypeFromGateResult({ kind: 'test', passed: false }).type, 'test_failure');
    assert.strictEqual(failureTypeFromGateResult({ kind: 'schema', passed: false }).type, 'tool_format_invalid');
    assert.strictEqual(failureTypeFromGateResult({ kind: 'budget', passed: false }).type, 'budget_exhausted');
    assert.strictEqual(failureTypeFromGateResult({ kind: 'scope lease', passed: false }).type, 'scope_conflict');
    assert.strictEqual(failureTypeFromGateResult({ kind: 'context retrieval', passed: false }).type, 'context_missing');
  });

  test('maps tool errors for common deterministic failure classes', () => {
    assert.strictEqual(failureTypeFromToolError({ message: 'invalid JSON schema output' }).type, 'tool_format_invalid');
    assert.strictEqual(failureTypeFromToolError({ message: 'action not allowed by policy' }).type, 'tool_action_illegal');
    assert.strictEqual(failureTypeFromToolError({ stderr: 'tsc compile failed' }).type, 'compile_error');
    assert.strictEqual(failureTypeFromToolError({ stderr: 'mocha test failed' }).type, 'test_failure');
    assert.strictEqual(failureTypeFromToolError({ message: 'scope lease overlap' }).type, 'scope_conflict');
    assert.strictEqual(failureTypeFromToolError({ code: 'ETIMEDOUT' }).type, 'budget_exhausted');
  });
});
