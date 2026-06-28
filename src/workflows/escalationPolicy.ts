import type { FailureType } from '../diagnostics/failureTypes';
import {
  WORKFLOW_RUN_EVENT_SCHEMA,
  type PremiumModelPolicy,
  type WorkflowRunEvent,
} from './types';
import type { CandidateModel } from './intentRouter';

export interface EscalationPolicyInput {
  runId: string;
  nodeId: string;
  timestamp: string;
  policy?: PremiumModelPolicy;
  attempts: number;
  previousFailures: FailureType[];
  candidate: CandidateModel;
  budgetRemainingCents?: number;
  releaseCritical?: boolean;
  securitySensitive?: boolean;
  humanApproved?: boolean;
}

export interface EscalationDecision {
  allowed: boolean;
  reason: EscalationReason;
  remediation?: string;
  selected?: CandidateModel;
  runEvent?: WorkflowRunEvent;
}

export type EscalationReason =
  | 'policy_missing'
  | 'threshold_not_met'
  | 'failure_trigger_not_allowed'
  | 'provider_not_allowed'
  | 'budget_exhausted'
  | 'human_approval_required'
  | 'release_or_security_override_requires_human'
  | 'allowed';

export function evaluatePremiumEscalation(input: EscalationPolicyInput): EscalationDecision {
  const policy = input.policy;
  if (!policy) {
    return deny('policy_missing', 'Premium escalation requires an explicit policy.');
  }

  const minAttempts = policy.minAttemptsBeforeEscalation ?? 1;
  if (input.attempts < minAttempts) {
    return deny('threshold_not_met', `Escalation requires ${minAttempts} attempt(s) before premium routing.`);
  }

  const allowedTriggers = policy.allowedFailureTriggers ?? [];
  const matchedTrigger = input.previousFailures.find((failure) => allowedTriggers.includes(failure));
  if (allowedTriggers.length > 0 && !matchedTrigger) {
    return deny('failure_trigger_not_allowed', 'Previous failures do not match premium escalation triggers.');
  }

  const allowedProviders = policy.allowedProviders ?? [];
  if (allowedProviders.length > 0 && !allowedProviders.includes(input.candidate.providerId)) {
    return deny('provider_not_allowed', `Provider ${input.candidate.providerId} is not allowed for premium escalation.`);
  }

  const candidateCost = input.candidate.costCents ?? 0;
  const policyBudget = policy.maxCostCents;
  if (policyBudget !== undefined && candidateCost > policyBudget) {
    return deny('budget_exhausted', `Candidate cost ${candidateCost}c exceeds policy max ${policyBudget}c.`);
  }
  if (input.budgetRemainingCents !== undefined && candidateCost > input.budgetRemainingCents) {
    return deny('budget_exhausted', `Candidate cost ${candidateCost}c exceeds remaining budget ${input.budgetRemainingCents}c.`);
  }

  if ((input.releaseCritical || input.securitySensitive) && !input.humanApproved) {
    return deny(
      'release_or_security_override_requires_human',
      'Release-critical or security-sensitive premium escalation requires human approval.',
    );
  }

  if (policy.requiresHumanApproval && !input.humanApproved) {
    return deny('human_approval_required', 'Premium escalation requires human approval.');
  }

  const failureReason = matchedTrigger ?? input.previousFailures[input.previousFailures.length - 1] ?? 'unknown_external';
  return {
    allowed: true,
    reason: 'allowed',
    selected: input.candidate,
    runEvent: {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: input.runId,
      nodeId: input.nodeId,
      event: 'escalated',
      timestamp: input.timestamp,
      failureType: failureReason,
      model: {
        provider: input.candidate.providerId,
        model: input.candidate.model,
        locality: input.candidate.locality,
        selectionReason: `premium escalation allowed after ${input.attempts} attempt(s): ${failureReason}`,
      },
      tokens: { costCents: candidateCost },
      retryCount: input.attempts,
      summary: `Premium escalation to ${input.candidate.providerId}:${input.candidate.model} allowed after ${input.attempts} attempt(s).`,
      policyDecision: {
        allowed: true,
        policyId: 'premium-model-escalation',
        reason: `Allowed by premium model policy after ${input.attempts} attempt(s).`,
        evidence: input.previousFailures,
      },
    },
  };
}

function deny(reason: EscalationReason, remediation: string): EscalationDecision {
  return {
    allowed: false,
    reason,
    remediation,
  };
}
