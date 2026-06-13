import * as assert from 'assert';
import {
  normalizeRole, resolveAgentRole, summarizeRoles, pickSeniorRole, ROLE_META, ROLE_ORDER,
  type CanonicalRole,
} from '../roles';

suite('roles — normalizeRole', () => {
  test('maps exact synonyms to canonical roles', () => {
    assert.strictEqual(normalizeRole('developer'), 'coder');
    assert.strictEqual(normalizeRole('QA'), 'tester');
    assert.strictEqual(normalizeRole('product owner'), 'product');
    assert.strictEqual(normalizeRole('supervisor'), 'orchestrator');
    assert.strictEqual(normalizeRole('release-manager'), 'ops');
    assert.strictEqual(normalizeRole('UI/UX'), 'designer');
  });

  test('security beats audit so "security-auditor" is security', () => {
    assert.strictEqual(normalizeRole('security-auditor'), 'security');
    assert.strictEqual(normalizeRole('auditor'), 'reviewer');
  });

  test('falls back to substring hints', () => {
    assert.strictEqual(normalizeRole('lead-architect-ii'), 'architect');
    assert.strictEqual(normalizeRole('doc-writer'), 'docs');
    assert.strictEqual(normalizeRole('research-analyst'), 'researcher');
  });

  test('unknown / empty input is generalist', () => {
    assert.strictEqual(normalizeRole(''), 'generalist');
    assert.strictEqual(normalizeRole(null), 'generalist');
    assert.strictEqual(normalizeRole(undefined), 'generalist');
    assert.strictEqual(normalizeRole('???'), 'generalist');
    assert.strictEqual(normalizeRole('marketing'), 'generalist');
  });

  test('is case- and separator-insensitive', () => {
    assert.strictEqual(normalizeRole('Re_View-ER'), 'reviewer');
    assert.strictEqual(normalizeRole('TESTER'), 'tester');
  });
});

suite('roles — resolveAgentRole precedence', () => {
  test('explicit role wins over agent_type', () => {
    assert.strictEqual(
      resolveAgentRole({ role: 'reviewer', agent_type: 'coder' }), 'reviewer');
  });

  test('falls through to fabric agent_type when role is unknown', () => {
    assert.strictEqual(
      resolveAgentRole({ role: 'marketing', agent_type: 'runner' }), 'ops');
  });

  test('can_orchestrate implies orchestrator when nothing else resolves', () => {
    assert.strictEqual(resolveAgentRole({ can_orchestrate: true }), 'orchestrator');
  });

  test('nothing known → generalist', () => {
    assert.strictEqual(resolveAgentRole({}), 'generalist');
  });
});

suite('roles — summarizeRoles', () => {
  test('counts roles and returns them in ROLE_ORDER, dropping zeros', () => {
    const roles: CanonicalRole[] = ['coder', 'coder', 'orchestrator', 'reviewer'];
    const out = summarizeRoles(roles);
    assert.deepStrictEqual(out, [
      { role: 'orchestrator', count: 1 },
      { role: 'coder', count: 2 },
      { role: 'reviewer', count: 1 },
    ]);
  });

  test('empty input → empty array', () => {
    assert.deepStrictEqual(summarizeRoles([]), []);
  });
});

suite('roles — pickSeniorRole', () => {
  test('picks the most senior (earliest in ROLE_ORDER) non-generalist role', () => {
    assert.strictEqual(pickSeniorRole(['coder', 'orchestrator', 'reviewer']), 'orchestrator');
    assert.strictEqual(pickSeniorRole(['tester', 'coder']), 'coder');
  });

  test('tolerates label-prefixed role strings and unknown text', () => {
    assert.strictEqual(pickSeniorRole(['ia-2: primary-orchestrator-and-worker']), 'orchestrator');
    assert.strictEqual(pickSeniorRole(['ia-2: peer-worker']), 'generalist');
  });

  test('empty / all-generalist → generalist', () => {
    assert.strictEqual(pickSeniorRole([]), 'generalist');
    assert.strictEqual(pickSeniorRole([null, undefined, 'marketing']), 'generalist');
  });
});

suite('roles — metadata integrity', () => {
  test('every canonical role in ROLE_ORDER has metadata', () => {
    for (const r of ROLE_ORDER) {
      assert.ok(ROLE_META[r], `missing meta for ${r}`);
      assert.strictEqual(ROLE_META[r].id, r);
      assert.ok(ROLE_META[r].label.length > 0);
      assert.ok(ROLE_META[r].cssClass.startsWith('role-'));
    }
  });

  test('ROLE_ORDER covers exactly the metadata keys', () => {
    assert.strictEqual(ROLE_ORDER.length, Object.keys(ROLE_META).length);
  });
});
