import type { LoopNodeConfig } from '../loops';
import type { WorkflowPolicies } from '../types';
import {
  SCAFFOLD_SCHEMA,
  type ReviewerIndependence,
  type ScaffoldMutationKind,
  type ScaffoldRouterProfile,
  type ScaffoldVariant,
} from './types';

export type ScaffoldContextMode = 'minimal' | 'balanced' | 'full' | 'kg-heavy';

export type ScaffoldMutationDiagnosticCode =
  | 'unsupported_mutation'
  | 'invalid_context_mode'
  | 'invalid_loop_policy'
  | 'invalid_router_profile'
  | 'invalid_best_of_n'
  | 'invalid_tool_lane'
  | 'invalid_reviewer_independence'
  | 'scope_widening_requires_human'
  | 'policy_bypass_requires_human';

export interface ScaffoldMutationDiagnostic {
  code: ScaffoldMutationDiagnosticCode;
  severity: 'error' | 'warning';
  reason: string;
}

export interface ScaffoldMutationRequest {
  base: ScaffoldVariant;
  kind: ScaffoldMutationKind;
  createdAt?: string;
  createdBy?: string;
  humanApproved?: boolean;
  currentScopeGlobs?: string[];
  proposedScopeGlobs?: string[];
  currentPolicies?: WorkflowPolicies;
  proposedPolicies?: WorkflowPolicies;
  contextMode?: ScaffoldContextMode;
  contextPlanId?: string;
  loopPolicy?: Partial<LoopNodeConfig>;
  routerProfile?: ScaffoldRouterProfile;
  bestOfN?: number;
  toolLaneIds?: string[];
  reviewerIndependence?: ReviewerIndependence;
}

export interface ScaffoldMutationResult {
  ok: boolean;
  diagnostics: ScaffoldMutationDiagnostic[];
  scaffold?: ScaffoldVariant;
}

const ROUTER_PROFILES: ScaffoldRouterProfile[] = [
  'cheap',
  'balanced',
  'quality',
  'local-only',
  'air-gapped',
  'release-critical',
];
const REVIEWER_INDEPENDENCE: ReviewerIndependence[] = ['same-model', 'different-model', 'different-provider', 'human'];
const CONTEXT_MODES: ScaffoldContextMode[] = ['minimal', 'balanced', 'full', 'kg-heavy'];
const LOOP_KINDS = ['retry', 'generate-verify-revise', 'retrieve-diagnose-reretrieve', 'best-of-N', 'mutation-test-strengthen'];
const MAX_TOOL_LANES = 8;
const MAX_BEST_OF_N = 5;
const MAX_ID_LENGTH = 80;

export function mutateScaffoldVariant(request: ScaffoldMutationRequest): ScaffoldMutationResult {
  const diagnostics = validateScaffoldMutationRequest(request);
  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  const base = request.base;
  const createdAt = request.createdAt ?? new Date().toISOString();
  const child: ScaffoldVariant = {
    ...base,
    schema: SCAFFOLD_SCHEMA,
    id: childScaffoldId(base.id, request),
    createdAt,
    ...(request.createdBy ? { createdBy: request.createdBy } : {}),
    parentScaffoldId: base.id,
    mutation: {
      kind: request.kind,
      summary: mutationSummary(request),
      parentScaffoldId: base.id,
    },
    metadata: {
      ...(base.metadata ?? {}),
      mutationKind: request.kind,
    },
  };

  applyMutation(child, request);
  return { ok: true, diagnostics, scaffold: child };
}

export function validateScaffoldMutationRequest(request: ScaffoldMutationRequest): ScaffoldMutationDiagnostic[] {
  const diagnostics: ScaffoldMutationDiagnostic[] = [];
  if (!supportedMutationKind(request.kind)) {
    diagnostics.push(error('unsupported_mutation', `unsupported scaffold mutation kind ${request.kind}`));
  }
  validateMutationPayload(request, diagnostics);
  validateScopeGuard(request, diagnostics);
  validatePolicyGuard(request, diagnostics);
  return diagnostics;
}

function validateMutationPayload(
  request: ScaffoldMutationRequest,
  diagnostics: ScaffoldMutationDiagnostic[],
): void {
  switch (request.kind) {
    case 'context_mode':
      if (!request.contextMode || !CONTEXT_MODES.includes(request.contextMode)) {
        diagnostics.push(error('invalid_context_mode', 'context_mode mutation requires a supported contextMode'));
      }
      if (request.contextPlanId !== undefined && !validId(request.contextPlanId)) {
        diagnostics.push(error('invalid_context_mode', 'contextPlanId must be a bounded non-empty id'));
      }
      break;
    case 'loop_policy':
      if (!validLoopPolicy(request.loopPolicy)) {
        diagnostics.push(error('invalid_loop_policy', 'loop_policy mutation must stay within bounded loop limits'));
      }
      break;
    case 'router_profile':
      if (!request.routerProfile || !ROUTER_PROFILES.includes(request.routerProfile)) {
        diagnostics.push(error('invalid_router_profile', 'router_profile mutation requires a supported routerProfile'));
      }
      break;
    case 'best_of_n':
      if (
        typeof request.bestOfN !== 'number'
        || !Number.isInteger(request.bestOfN)
        || request.bestOfN < 1
        || request.bestOfN > MAX_BEST_OF_N
      ) {
        diagnostics.push(error('invalid_best_of_n', `best_of_n must be an integer from 1 to ${MAX_BEST_OF_N}`));
      }
      break;
    case 'tool_lane':
      if (!validToolLaneIds(request.toolLaneIds)) {
        diagnostics.push(error('invalid_tool_lane', `tool_lane requires 1-${MAX_TOOL_LANES} bounded lane ids`));
      }
      break;
    case 'reviewer_independence':
      if (!request.reviewerIndependence || !REVIEWER_INDEPENDENCE.includes(request.reviewerIndependence)) {
        diagnostics.push(error('invalid_reviewer_independence', 'reviewer_independence mutation requires a supported value'));
      }
      break;
    default:
      break;
  }
}

function validateScopeGuard(
  request: ScaffoldMutationRequest,
  diagnostics: ScaffoldMutationDiagnostic[],
): void {
  if (request.humanApproved) {
    return;
  }
  const current = new Set(request.currentScopeGlobs ?? []);
  const proposed = request.proposedScopeGlobs ?? [];
  const widened = proposed.filter((glob) => !current.has(glob));
  if (widened.length > 0) {
    diagnostics.push(error('scope_widening_requires_human', `mutation proposes new scope globs: ${widened.join(', ')}`));
  }
}

function validatePolicyGuard(
  request: ScaffoldMutationRequest,
  diagnostics: ScaffoldMutationDiagnostic[],
): void {
  if (request.humanApproved || !request.proposedPolicies) {
    return;
  }
  const current = request.currentPolicies ?? {};
  const proposed = request.proposedPolicies;
  const bypasses: string[] = [];
  if (current.allowWrites !== true && proposed.allowWrites === true) bypasses.push('allowWrites');
  if (current.allowNetwork !== true && proposed.allowNetwork === true) bypasses.push('allowNetwork');
  if (current.requireHumanApproval === true && proposed.requireHumanApproval === false) bypasses.push('requireHumanApproval');
  if (current.premiumModelPolicy?.requiresHumanApproval === true && proposed.premiumModelPolicy?.requiresHumanApproval === false) {
    bypasses.push('premiumModelPolicy.requiresHumanApproval');
  }
  if (limitIncreased(current.maxIterations, proposed.maxIterations)) bypasses.push('maxIterations');
  if (limitIncreased(current.maxDepth, proposed.maxDepth)) bypasses.push('maxDepth');
  if (limitIncreased(current.budget?.maxCostCents, proposed.budget?.maxCostCents)) bypasses.push('budget.maxCostCents');
  if (bypasses.length > 0) {
    diagnostics.push(error('policy_bypass_requires_human', `mutation relaxes policy controls: ${bypasses.join(', ')}`));
  }
}

function applyMutation(scaffold: ScaffoldVariant, request: ScaffoldMutationRequest): void {
  switch (request.kind) {
    case 'context_mode':
      scaffold.contextPlanId = request.contextPlanId ?? `context:${request.contextMode}`;
      scaffold.metadata = {
        ...(scaffold.metadata ?? {}),
        contextMode: request.contextMode,
      };
      break;
    case 'loop_policy': {
      const policy = normalizeLoopPolicy(request.loopPolicy);
      scaffold.loopPolicyId = loopPolicyId(policy);
      scaffold.metadata = {
        ...(scaffold.metadata ?? {}),
        loopPolicy: policy,
      };
      break;
    }
    case 'router_profile':
      scaffold.routerProfile = request.routerProfile!;
      break;
    case 'best_of_n':
      scaffold.metadata = {
        ...(scaffold.metadata ?? {}),
        bestOfN: request.bestOfN,
      };
      break;
    case 'tool_lane':
      scaffold.toolLaneIds = uniqueStrings(request.toolLaneIds!);
      break;
    case 'reviewer_independence':
      scaffold.review = {
        ...(scaffold.review ?? { tier: 'tier1-local', gatesFirst: true }),
        reviewerIndependence: request.reviewerIndependence!,
      };
      if (request.reviewerIndependence === 'human') {
        scaffold.review.tier = 'human';
      }
      break;
    default:
      break;
  }
}

function supportedMutationKind(kind: ScaffoldMutationKind): boolean {
  return kind === 'context_mode'
    || kind === 'loop_policy'
    || kind === 'router_profile'
    || kind === 'best_of_n'
    || kind === 'tool_lane'
    || kind === 'reviewer_independence';
}

function validLoopPolicy(policy: Partial<LoopNodeConfig> | undefined): boolean {
  if (!policy) return false;
  const normalized = normalizeLoopPolicy(policy);
  return normalized.maxIterations >= 1
    && normalized.maxIterations <= 8
    && normalized.maxDepth >= 1
    && normalized.maxDepth <= 3
    && normalized.noProgressAfter >= 1
    && normalized.noProgressAfter <= 5
    && (!normalized.kind || LOOP_KINDS.includes(normalized.kind));
}

function normalizeLoopPolicy(policy: Partial<LoopNodeConfig> | undefined): Required<Pick<LoopNodeConfig, 'maxIterations' | 'maxDepth' | 'noProgressAfter'>> & Pick<LoopNodeConfig, 'kind' | 'escalateOnFailure'> {
  return {
    ...(policy?.kind ? { kind: policy.kind } : {}),
    maxIterations: policy?.maxIterations ?? 3,
    maxDepth: policy?.maxDepth ?? 1,
    noProgressAfter: policy?.noProgressAfter ?? 2,
    ...(typeof policy?.escalateOnFailure === 'boolean' ? { escalateOnFailure: policy.escalateOnFailure } : {}),
  };
}

function validToolLaneIds(ids: string[] | undefined): boolean {
  return Array.isArray(ids)
    && ids.length > 0
    && ids.length <= MAX_TOOL_LANES
    && uniqueStrings(ids).length === ids.length
    && ids.every(validId);
}

function validId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/\s/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function limitIncreased(current: number | undefined, proposed: number | undefined): boolean {
  return typeof proposed === 'number' && (typeof current !== 'number' || proposed > current);
}

function childScaffoldId(parentId: string, request: ScaffoldMutationRequest): string {
  const basis = [
    request.kind,
    request.contextMode,
    request.contextPlanId,
    request.routerProfile,
    request.bestOfN,
    request.toolLaneIds?.join(','),
    request.reviewerIndependence,
    JSON.stringify(request.loopPolicy ?? {}),
  ].filter((part) => part !== undefined).join('|');
  return `${parentId}--mut-${sanitizeId(request.kind)}-${hashString(basis)}`;
}

function loopPolicyId(policy: ReturnType<typeof normalizeLoopPolicy>): string {
  return `loop:${policy.kind ?? 'retry'}:${policy.maxIterations}:${policy.maxDepth}:${policy.noProgressAfter}`;
}

function mutationSummary(request: ScaffoldMutationRequest): string {
  switch (request.kind) {
    case 'context_mode': return `Set context mode to ${request.contextMode}`;
    case 'loop_policy': return `Set loop policy to ${loopPolicyId(normalizeLoopPolicy(request.loopPolicy))}`;
    case 'router_profile': return `Set router profile to ${request.routerProfile}`;
    case 'best_of_n': return `Set best-of-N count to ${request.bestOfN}`;
    case 'tool_lane': return `Set tool lanes to ${request.toolLaneIds?.join(', ')}`;
    case 'reviewer_independence': return `Set reviewer independence to ${request.reviewerIndependence}`;
    default: return `Apply ${request.kind} mutation`;
  }
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'mutation';
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function error(code: ScaffoldMutationDiagnosticCode, reason: string): ScaffoldMutationDiagnostic {
  return { code, severity: 'error', reason };
}
