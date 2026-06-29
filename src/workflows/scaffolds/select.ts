import type { FailureType } from '../../diagnostics/failureTypes';
import type { ModelCapability, ModelLocality, WorkflowIntent } from '../types';
import type {
  PromptHarnessContract,
  ScaffoldRouterProfile,
  ScaffoldScore,
  ScaffoldVariant,
} from './types';

export interface ScaffoldSelectionModel {
  provider?: string;
  model?: string;
  locality?: ModelLocality;
  modelFamily?: string;
  capabilities?: ModelCapability[];
  promptHarnessId?: string;
}

export interface ScaffoldSelectionConstraints {
  allowedLocalities?: ModelLocality[];
  privacyLocality?: ModelLocality[];
  maxCostCents?: number;
  promptHarnessId?: string;
  model?: ScaffoldSelectionModel;
}

export interface SelectScaffoldRequest {
  intent: WorkflowIntent;
  profile: ScaffoldRouterProfile;
  variants: ScaffoldVariant[];
  scores?: ScaffoldScore[];
  promptHarnesses?: PromptHarnessContract[];
  constraints?: ScaffoldSelectionConstraints;
  previousFailureType?: FailureType;
  now?: string;
}

export interface ScaffoldSelectionRejection {
  scaffoldId: string;
  reason: string;
}

export interface ScaffoldSelectionCandidate {
  scaffold: ScaffoldVariant;
  score: number;
  reason: string;
  history: ScaffoldHistory;
}

export interface ScaffoldSelectionDecision {
  selected?: ScaffoldVariant;
  selectedScore?: number;
  reason: string;
  candidates: ScaffoldSelectionCandidate[];
  rejected: ScaffoldSelectionRejection[];
  warnings: string[];
}

interface ScaffoldHistory {
  count: number;
  passRate: number;
  averageReward: number;
  averageCostCents: number;
  latestScoreAt?: string;
  sameFailurePasses: number;
  sameFailureFailures: number;
  falseAccepts: number;
  falseRejects: number;
  scopeViolations: number;
}

const DEFAULT_LOCALITIES: ModelLocality[] = ['local', 'lan', 'cloud'];
const SCORE_WINDOW = 12;

export function selectScaffoldVariant(request: SelectScaffoldRequest): ScaffoldSelectionDecision {
  const warnings: string[] = [];
  const rejected: ScaffoldSelectionRejection[] = [];
  const harnessById = new Map((request.promptHarnesses ?? []).map((harness) => [harness.id, harness]));
  const allowedLocalities = localityPolicy(request.profile, request.constraints);
  const nowMs = parseTimestamp(request.now) ?? Date.now();

  const candidates: ScaffoldSelectionCandidate[] = [];
  for (const scaffold of request.variants) {
    const rejection = rejectScaffold(scaffold, request, harnessById, allowedLocalities);
    if (rejection) {
      rejected.push({ scaffoldId: scaffold.id, reason: rejection });
      continue;
    }

    const history = summarizeHistory(scaffold.id, request.scores ?? [], request.previousFailureType);
    const score = scoreScaffold(scaffold, request, history, harnessById.get(scaffold.promptHarnessId ?? ''), nowMs);
    candidates.push({
      scaffold,
      score,
      history,
      reason: candidateReason(scaffold, history, score),
    });
  }

  candidates.sort((a, b) => {
    const scoreDelta = b.score - a.score;
    return Math.abs(scoreDelta) > 0.0001 ? scoreDelta : a.scaffold.id.localeCompare(b.scaffold.id);
  });

  const selected = candidates[0];
  if (!selected) {
    return {
      reason: 'No scaffold satisfied intent, profile, locality, cost, and harness constraints.',
      candidates,
      rejected,
      warnings,
    };
  }

  return {
    selected: selected.scaffold,
    selectedScore: roundScore(selected.score),
    reason: selectionReason(selected.scaffold, selected.history, selected.score),
    candidates,
    rejected,
    warnings,
  };
}

function rejectScaffold(
  scaffold: ScaffoldVariant,
  request: SelectScaffoldRequest,
  harnessById: Map<string, PromptHarnessContract>,
  allowedLocalities: readonly ModelLocality[],
): string | undefined {
  if (scaffold.taskIntent !== request.intent) {
    return `intent ${scaffold.taskIntent} does not match ${request.intent}`;
  }
  if (!profileCompatible(scaffold.routerProfile, request.profile)) {
    return `profile ${scaffold.routerProfile} does not satisfy ${request.profile}`;
  }

  const scaffoldLocalities = localitiesFromMetadata(scaffold.metadata);
  if (!intersects(scaffoldLocalities, allowedLocalities)) {
    return `locality denied by profile/policy`;
  }

  const harness = scaffold.promptHarnessId ? harnessById.get(scaffold.promptHarnessId) : undefined;
  if (request.constraints?.promptHarnessId && scaffold.promptHarnessId !== request.constraints.promptHarnessId) {
    return `prompt harness does not match required harness`;
  }
  if (harness) {
    const harnessLocalities = localitiesFromMetadata(harness.metadata);
    if (!intersects(harnessLocalities, allowedLocalities)) {
      return `prompt harness locality denied by profile/policy`;
    }
    const model = request.constraints?.model;
    if (model && !harnessSupportsModel(harness, model)) {
      return `prompt harness unsupported by requested model`;
    }
  } else if (scaffold.promptHarnessId && request.promptHarnesses?.length) {
    return `prompt harness not registered`;
  }

  const expectedCost = numberFromMetadata(scaffold.metadata, 'expectedCostCents');
  if (request.constraints?.maxCostCents !== undefined && expectedCost !== undefined && expectedCost > request.constraints.maxCostCents) {
    return `scaffold exceeds cost ceiling`;
  }

  return undefined;
}

function scoreScaffold(
  scaffold: ScaffoldVariant,
  request: SelectScaffoldRequest,
  history: ScaffoldHistory,
  harness: PromptHarnessContract | undefined,
  nowMs: number,
): number {
  let score = 0;
  score += 40;

  if (scaffold.routerProfile === request.profile) {
    score += 12;
  } else if (request.profile === 'balanced' && scaffold.routerProfile !== 'air-gapped') {
    score += 4;
  }

  score += history.averageReward * 30;
  score += history.passRate * 16;
  score -= history.averageCostCents * (request.profile === 'cheap' ? 0.7 : 0.25);
  score -= history.falseAccepts * 10;
  score -= history.scopeViolations * 25;
  score -= history.sameFailureFailures * 9;
  score += history.sameFailurePasses * 12;

  const expectedCost = numberFromMetadata(scaffold.metadata, 'expectedCostCents') ?? history.averageCostCents;
  if (request.profile === 'cheap' || request.profile === 'local-only' || request.profile === 'air-gapped') {
    score -= expectedCost * 0.6;
  }

  const model = request.constraints?.model;
  if (model && scaffold.promptHarnessId && scaffold.promptHarnessId === model.promptHarnessId) {
    score += 8;
  }
  if (harness && model) {
    if (harness.modelFamily && model.modelFamily && harness.modelFamily === model.modelFamily) {
      score += 5;
    }
    for (const capability of harness.capabilities ?? []) {
      if (model.capabilities?.includes(capability)) {
        score += 1;
      }
    }
  }

  const createdAgeDays = ageDays(scaffold.createdAt, nowMs);
  if (createdAgeDays !== undefined) {
    score += Math.max(0, 8 - createdAgeDays / 14);
  }
  const latestScoreAgeDays = ageDays(history.latestScoreAt, nowMs);
  if (latestScoreAgeDays !== undefined) {
    score += Math.max(0, 8 - latestScoreAgeDays / 7);
  }

  return score;
}

function summarizeHistory(scaffoldId: string, scores: ScaffoldScore[], previousFailureType: FailureType | undefined): ScaffoldHistory {
  const scoped = scores
    .filter((score) => score.scaffoldId === scaffoldId)
    .sort((a, b) => (parseTimestamp(b.createdAt) ?? 0) - (parseTimestamp(a.createdAt) ?? 0))
    .slice(0, SCORE_WINDOW);

  if (scoped.length === 0) {
    return {
      count: 0,
      passRate: 0.5,
      averageReward: 0,
      averageCostCents: 0,
      sameFailurePasses: 0,
      sameFailureFailures: 0,
      falseAccepts: 0,
      falseRejects: 0,
      scopeViolations: 0,
    };
  }

  let passed = 0;
  let reward = 0;
  let cost = 0;
  let sameFailurePasses = 0;
  let sameFailureFailures = 0;
  let falseAccepts = 0;
  let falseRejects = 0;
  let scopeViolations = 0;

  for (const row of scoped) {
    if (row.pass) passed += 1;
    reward += row.reward;
    cost += row.costCents;
    if (row.falseAccept) falseAccepts += 1;
    if (row.falseReject) falseRejects += 1;
    if (row.scopeViolation) scopeViolations += 1;
    if (previousFailureType && row.failureType === previousFailureType) {
      if (row.pass) sameFailurePasses += 1;
      else sameFailureFailures += 1;
    }
  }

  return {
    count: scoped.length,
    passRate: passed / scoped.length,
    averageReward: reward / scoped.length,
    averageCostCents: cost / scoped.length,
    latestScoreAt: scoped[0]?.createdAt,
    sameFailurePasses,
    sameFailureFailures,
    falseAccepts,
    falseRejects,
    scopeViolations,
  };
}

function localityPolicy(
  profile: ScaffoldRouterProfile,
  constraints: ScaffoldSelectionConstraints | undefined,
): ModelLocality[] {
  if (profile === 'local-only' || profile === 'air-gapped') {
    return ['local'];
  }
  if (constraints?.allowedLocalities?.length) {
    return constraints.allowedLocalities;
  }
  if (constraints?.privacyLocality?.length) {
    return constraints.privacyLocality;
  }
  return DEFAULT_LOCALITIES;
}

function profileCompatible(scaffoldProfile: ScaffoldRouterProfile, requestProfile: ScaffoldRouterProfile): boolean {
  if (scaffoldProfile === requestProfile) {
    return true;
  }
  if (requestProfile === 'balanced') {
    return scaffoldProfile !== 'air-gapped';
  }
  if (requestProfile === 'cheap') {
    return scaffoldProfile === 'cheap' || scaffoldProfile === 'local-only' || scaffoldProfile === 'balanced';
  }
  if (requestProfile === 'quality') {
    return scaffoldProfile === 'quality' || scaffoldProfile === 'release-critical' || scaffoldProfile === 'balanced';
  }
  if (requestProfile === 'release-critical') {
    return scaffoldProfile === 'release-critical' || scaffoldProfile === 'quality';
  }
  return false;
}

function harnessSupportsModel(harness: PromptHarnessContract, model: ScaffoldSelectionModel): boolean {
  if (harness.id === model.promptHarnessId) {
    return true;
  }
  if (harness.modelFamily && model.modelFamily && harness.modelFamily !== model.modelFamily) {
    return false;
  }
  for (const capability of harness.capabilities ?? []) {
    if (!model.capabilities?.includes(capability)) {
      return false;
    }
  }
  return true;
}

function localitiesFromMetadata(metadata: Record<string, unknown> | undefined): ModelLocality[] {
  if (!metadata) {
    return DEFAULT_LOCALITIES;
  }
  if (metadata.cloudOnly === true) {
    return ['cloud'];
  }
  const single = parseLocality(metadata.locality);
  if (single) {
    return [single];
  }
  const many = metadata.localities;
  if (Array.isArray(many)) {
    const parsed = many.map(parseLocality).filter((item): item is ModelLocality => Boolean(item));
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return DEFAULT_LOCALITIES;
}

function parseLocality(value: unknown): ModelLocality | undefined {
  return value === 'local' || value === 'lan' || value === 'cloud' ? value : undefined;
}

function numberFromMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function intersects(a: readonly ModelLocality[], b: readonly ModelLocality[]): boolean {
  return a.some((item) => b.includes(item));
}

function ageDays(timestamp: string | undefined, nowMs: number): number | undefined {
  const then = parseTimestamp(timestamp);
  if (then === undefined) {
    return undefined;
  }
  return Math.max(0, (nowMs - then) / 86400000);
}

function parseTimestamp(timestamp: string | undefined): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function selectionReason(scaffold: ScaffoldVariant, history: ScaffoldHistory, score: number): string {
  const parts = [
    `Selected scaffold ${scaffold.id}`,
    `intent=${scaffold.taskIntent}`,
    `profile=${scaffold.routerProfile}`,
    `reward=${roundScore(history.averageReward)}`,
    `passRate=${roundScore(history.passRate)}`,
    `score=${roundScore(score)}`,
  ];
  if (scaffold.promptHarnessId) {
    parts.push(`harness=${scaffold.promptHarnessId}`);
  }
  return parts.join('; ');
}

function candidateReason(scaffold: ScaffoldVariant, history: ScaffoldHistory, score: number): string {
  return [
    `scaffold=${scaffold.id}`,
    `reward=${roundScore(history.averageReward)}`,
    `passRate=${roundScore(history.passRate)}`,
    `cost=${roundScore(history.averageCostCents)}`,
    `score=${roundScore(score)}`,
  ].join('; ');
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
