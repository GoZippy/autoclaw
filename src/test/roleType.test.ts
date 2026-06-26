/**
 * roleType.test.ts — the forward role → agent_type derivation (src/fleet/roleType.ts).
 *
 * Pure: no vscode, no fs. role → type is intentionally MANY-TO-ONE (reviewer and
 * security both → auditor), so these tests assert validity + the canonical inverse
 * pairs, NOT a bijective round-trip.
 */

import * as assert from 'assert';
import { ROLE_TO_AGENT_TYPE, agentTypeForRole, deriveAgentType, ROLE_TYPE_ALTERNATES } from '../fleet/roleType';
import { ROLE_ORDER } from '../roles';
import { AGENT_TYPES } from '../fabric/agentTypes';

suite('roleType — forward derivation', () => {
  test('every canonical role maps to a valid AgentType', () => {
    for (const role of ROLE_ORDER) {
      const t = agentTypeForRole(role);
      assert.ok(AGENT_TYPES.includes(t), `role "${role}" must derive a valid agent_type (got "${t}")`);
    }
  });

  test('the map covers exactly the 13 canonical roles', () => {
    assert.strictEqual(Object.keys(ROLE_TO_AGENT_TYPE).length, ROLE_ORDER.length);
    for (const role of ROLE_ORDER) {
      assert.ok(role in ROLE_TO_AGENT_TYPE, `missing derivation for "${role}"`);
    }
  });

  test('the four canonical inverse pairs round-trip', () => {
    // These four are the pairs ROLE_SYNONYMS inverts 1:1; the rest are lossy.
    assert.strictEqual(agentTypeForRole('orchestrator'), 'supervisor');
    assert.strictEqual(agentTypeForRole('reviewer'), 'auditor');
    assert.strictEqual(agentTypeForRole('ops'), 'runner');
    assert.strictEqual(agentTypeForRole('generalist'), 'assistant');
  });

  test('role → type is many-to-one: reviewer and security both → auditor', () => {
    assert.strictEqual(agentTypeForRole('reviewer'), 'auditor');
    assert.strictEqual(agentTypeForRole('security'), 'auditor');
  });

  test('researcher derives to runner (one job, returns findings, no session)', () => {
    // Pinned: the playbook + Research+Synthesis template both treat researcher as a
    // runner; this is the single source of truth they must agree with.
    assert.strictEqual(agentTypeForRole('researcher'), 'runner');
  });

  test('deriveAgentType normalises free-form role strings', () => {
    assert.strictEqual(deriveAgentType('Reviewer'), 'auditor');
    assert.strictEqual(deriveAgentType('security-auditor'), 'auditor'); // hint → security → auditor
    assert.strictEqual(deriveAgentType('supervisor'), 'supervisor');    // synonym → orchestrator → supervisor
    assert.strictEqual(deriveAgentType('runner'), 'runner');            // synonym → ops → runner
  });

  test('deriveAgentType falls back to assistant for unknown / empty input', () => {
    assert.strictEqual(deriveAgentType(undefined), 'assistant');
    assert.strictEqual(deriveAgentType(''), 'assistant');
    assert.strictEqual(deriveAgentType('???'), 'assistant');
  });

  test('every alternate is a valid AgentType and lists the default first', () => {
    for (const [role, alts] of Object.entries(ROLE_TYPE_ALTERNATES)) {
      assert.ok(alts && alts.length >= 2, `${role} alternates must offer a choice`);
      for (const t of alts!) {
        assert.ok(AGENT_TYPES.includes(t), `${role} alternate "${t}" must be valid`);
      }
      assert.strictEqual(alts![0], ROLE_TO_AGENT_TYPE[role as keyof typeof ROLE_TO_AGENT_TYPE],
        `${role} alternates must list the derived default first`);
    }
  });
});
