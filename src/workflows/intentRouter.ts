import type { FailureType } from '../diagnostics/failureTypes';
import type { ModelCapability, ModelLocality, WorkflowIntent, WorkflowPolicies } from './types';

export type RoutingProfile = NonNullable<WorkflowPolicies['routingProfile']>;

export interface IntentRouterRequest {
  intent: WorkflowIntent;
  profile: RoutingProfile;
  candidates: CandidateModel[];
  requirements?: IntentRequirements;
  previousFailures?: FailureType[];
  attempts?: number;
  escalation?: EscalationHint;
  recommendModel?: ZippyMeshRecommendModel;
}

export interface IntentRequirements {
  capabilities?: ModelCapability[];
  minContextWindow?: number;
  maxCostCents?: number;
  allowedLocalities?: ModelLocality[];
  privacyLocality?: ModelLocality[];
  allowFallbackWithoutCapabilities?: boolean;
}

export interface EscalationHint {
  minAttemptsBeforeEscalation: number;
  failureTriggers: FailureType[];
  preferredLocality?: ModelLocality;
}

export interface CandidateModel {
  providerId: string;
  model: string;
  locality: ModelLocality;
  healthy: boolean;
  capabilities: ModelCapability[];
  contextWindow?: number;
  costCents?: number;
  latencyMs?: number;
  benchmarkScore?: number;
  reputationScore?: number;
}

export interface ZippyMeshRecommendModel {
  (request: IntentRouterRequest): { providerId: string; model: string; reason?: string } | undefined;
}

export interface IntentRouterDecision {
  selected?: CandidateModel;
  reason: string;
  rejected: RejectedModel[];
  usedRecommendation: boolean;
}

export interface RejectedModel {
  providerId: string;
  model: string;
  reason: string;
}

export function routeWorkflowIntent(request: IntentRouterRequest): IntentRouterDecision {
  const rejected: RejectedModel[] = [];
  const requiredCapabilities = capabilitiesForIntent(request.intent, request.requirements?.capabilities ?? []);
  const allowedLocalities = localityPolicy(request.profile, request.requirements);
  const escalationActive = shouldEscalate(request);

  const eligible = request.candidates.filter((candidate) => {
    const rejection = rejectionReason(candidate, request, requiredCapabilities, allowedLocalities, escalationActive);
    if (rejection) {
      rejected.push({ providerId: candidate.providerId, model: candidate.model, reason: rejection });
      return false;
    }
    return true;
  });

  const recommendation = request.recommendModel?.(request);
  if (recommendation) {
    const selected = eligible.find((candidate) => candidate.providerId === recommendation.providerId && candidate.model === recommendation.model);
    if (selected) {
      return {
        selected,
        rejected,
        usedRecommendation: true,
        reason: recommendation.reason ?? `ZippyMesh recommended ${selected.providerId}:${selected.model}.`,
      };
    }
  }

  const fallbackEligible = eligible.length > 0
    ? eligible
    : request.requirements?.allowFallbackWithoutCapabilities
      ? request.candidates.filter((candidate) => candidate.healthy && allowedLocalities.includes(candidate.locality))
      : [];

  if (fallbackEligible.length === 0) {
    return {
      rejected,
      usedRecommendation: false,
      reason: 'No eligible model satisfied health, locality, budget, context, and capability requirements.',
    };
  }

  const ranked = [...fallbackEligible].sort((a, b) => scoreCandidate(b, request, escalationActive) - scoreCandidate(a, request, escalationActive));
  const selected = ranked[0];
  return {
    selected,
    rejected,
    usedRecommendation: false,
    reason: selectionReason(selected, request, escalationActive, eligible.length === 0),
  };
}

function rejectionReason(
  candidate: CandidateModel,
  request: IntentRouterRequest,
  requiredCapabilities: ModelCapability[],
  allowedLocalities: ModelLocality[],
  escalationActive: boolean,
): string | undefined {
  if (!candidate.healthy) {
    return 'provider unhealthy';
  }
  if (!allowedLocalities.includes(candidate.locality)) {
    return `locality ${candidate.locality} denied by profile/policy`;
  }
  if (request.requirements?.maxCostCents !== undefined && (candidate.costCents ?? 0) > request.requirements.maxCostCents) {
    return 'candidate exceeds cost ceiling';
  }
  if (request.requirements?.minContextWindow !== undefined && (candidate.contextWindow ?? 0) < request.requirements.minContextWindow) {
    return 'context window too small';
  }
  if (!escalationActive && candidate.locality === 'cloud' && request.profile !== 'quality' && request.profile !== 'release-critical') {
    return 'cloud candidate reserved until escalation or release-critical profile';
  }
  for (const capability of requiredCapabilities) {
    if (!candidate.capabilities.includes(capability)) {
      return `missing capability ${capability}`;
    }
  }
  return undefined;
}

function capabilitiesForIntent(intent: WorkflowIntent, explicit: readonly ModelCapability[]): ModelCapability[] {
  const capabilities = new Set<ModelCapability>(explicit);
  if (intent === 'tool-use' || intent === 'code' || intent === 'debug' || intent === 'test') {
    capabilities.add('tools');
    capabilities.add('json');
  }
  if (intent === 'long-context' || intent === 'review' || intent === 'release') {
    capabilities.add('long-context');
  }
  if (intent === 'vision') {
    capabilities.add('vision');
  }
  return [...capabilities];
}

function localityPolicy(profile: RoutingProfile, requirements: IntentRequirements | undefined): ModelLocality[] {
  if (profile === 'local-only' || profile === 'air-gapped') {
    return ['local'];
  }
  if (requirements?.allowedLocalities?.length) {
    return requirements.allowedLocalities;
  }
  if (requirements?.privacyLocality?.length) {
    return requirements.privacyLocality;
  }
  return ['local', 'lan', 'cloud'];
}

function shouldEscalate(request: IntentRouterRequest): boolean {
  const hint = request.escalation;
  if (!hint) {
    return false;
  }
  if ((request.attempts ?? 0) < hint.minAttemptsBeforeEscalation) {
    return false;
  }
  return (request.previousFailures ?? []).some((failure) => hint.failureTriggers.includes(failure));
}

function scoreCandidate(candidate: CandidateModel, request: IntentRouterRequest, escalationActive: boolean): number {
  let score = 0;
  score += (candidate.benchmarkScore ?? 0) * 5;
  score += (candidate.reputationScore ?? 0) * 3;
  score += Math.min(candidate.contextWindow ?? 0, 200000) / 10000;
  score -= (candidate.latencyMs ?? 0) / 1000;
  if (request.profile === 'cheap') {
    score -= candidate.costCents ?? 0;
    if (candidate.locality === 'local') score += 10;
  }
  if (request.profile === 'balanced') {
    score -= (candidate.costCents ?? 0) * 0.5;
    if (candidate.locality !== 'cloud') score += 5;
  }
  if (request.profile === 'quality' || request.profile === 'release-critical') {
    score += (candidate.benchmarkScore ?? 0) * 10;
    if (candidate.locality === 'cloud' && escalationActive) score += 10;
  }
  return score;
}

function selectionReason(candidate: CandidateModel, request: IntentRouterRequest, escalationActive: boolean, fallback: boolean): string {
  const parts = [
    `Selected ${candidate.providerId}:${candidate.model} for ${request.intent}.`,
    `profile=${request.profile}`,
    `locality=${candidate.locality}`,
  ];
  if (escalationActive) {
    parts.push('escalation trigger matched previous failures');
  }
  if (fallback) {
    parts.push('fallback used because no candidate satisfied all requested capabilities');
  }
  return parts.join('; ');
}
