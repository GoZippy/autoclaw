/**
 * agentTypes.test.ts — the agent-type taxonomy (fabric layer).
 */

import * as assert from 'assert';

import {
  AGENT_TYPES,
  agentTypeProfile,
  consensusRuleForAgentType,
  requiresHumanApproval,
  agentTypeForPersona,
  type AgentType,
} from '../fabric/agentTypes';
import { SECURITY_TIER_PERSONAS, quorumRuleForPersona } from '../orchestrator/reviewSla';

suite('fabric agent-type taxonomy', () => {
  test('every type has a complete profile', () => {
    for (const t of AGENT_TYPES) {
      const p = agentTypeProfile(t);
      assert.strictEqual(p.type, t);
      assert.ok(p.description.length > 0);
      assert.ok(['off', 'auto', 'turbo'].includes(p.defaultTrust));
      assert.ok(['majority', 'unanimous', 'none'].includes(p.consensusRule));
      assert.ok(Array.isArray(p.capabilityTags) && p.capabilityTags.length > 0);
    }
  });

  test('auditors are read-only + unanimous; coders edit + majority', () => {
    const auditor = agentTypeProfile('auditor');
    assert.strictEqual(auditor.defaultTrust, 'off', 'auditor never edits');
    assert.strictEqual(auditor.consensusRule, 'unanimous');
    const coder = agentTypeProfile('coder');
    assert.strictEqual(coder.defaultTrust, 'auto');
    assert.strictEqual(coder.consensusRule, 'majority');
  });

  test('supervisor + governance can orchestrate; coder/runner/auditor cannot', () => {
    assert.strictEqual(agentTypeProfile('supervisor').canOrchestrate, true);
    assert.strictEqual(agentTypeProfile('governance').canOrchestrate, true);
    for (const t of ['coder', 'runner', 'auditor'] as AgentType[]) {
      assert.strictEqual(agentTypeProfile(t).canOrchestrate, false);
    }
  });

  test('assistant + governance are human-in-the-loop; coder/runner are not', () => {
    assert.strictEqual(requiresHumanApproval('assistant'), true);
    assert.strictEqual(requiresHumanApproval('governance'), true);
    assert.strictEqual(requiresHumanApproval('coder'), false);
    assert.strictEqual(requiresHumanApproval('runner'), false);
  });

  test('persona → agent type mapping', () => {
    assert.strictEqual(agentTypeForPersona('security-auditor'), 'auditor');
    assert.strictEqual(agentTypeForPersona('supply-chain-auditor'), 'auditor');
    assert.strictEqual(agentTypeForPersona('doc-writer'), 'coder', 'unknown/role persona ⇒ coder');
    assert.strictEqual(agentTypeForPersona(undefined), 'coder');
    assert.strictEqual(consensusRuleForAgentType(agentTypeForPersona('security-auditor')), 'unanimous');
  });

  test('taxonomy is consistent with reviewSla security-tier personas', () => {
    // Every security-tier persona must classify as an auditor (⇒ unanimous),
    // and the two review-rule derivations must agree.
    for (const persona of SECURITY_TIER_PERSONAS) {
      assert.strictEqual(agentTypeForPersona(persona), 'auditor', `${persona} ⇒ auditor`);
      assert.strictEqual(quorumRuleForPersona(persona), 'unanimous');
      assert.strictEqual(consensusRuleForAgentType('auditor'), 'unanimous');
    }
  });
});
