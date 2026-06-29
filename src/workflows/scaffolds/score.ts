import type { FailureType } from '../../diagnostics/failureTypes';
import type { WorkflowRunSummary } from '../runLedger';
import {
  SCAFFOLD_SCORE_SCHEMA,
  type AntiHackingViolation,
  type ScaffoldScore,
  type ScaffoldVariant,
} from './types';
import { appendScaffoldScore } from './store';

export interface ScaffoldReviewOutcome {
  verifierPass?: boolean;
  judgeVeto?: boolean;
  falseAccept?: boolean;
  falseReject?: boolean;
  reworkCount?: number;
}

export interface ScaffoldScoreInput {
  scaffold: ScaffoldVariant;
  run: Partial<WorkflowRunSummary>;
  review?: ScaffoldReviewOutcome;
  antiHackingViolation?: AntiHackingViolation;
  createdAt?: string;
}

export interface BuildScaffoldScoreResult {
  score?: ScaffoldScore;
  warnings: string[];
}

export async function scoreAndAppendScaffoldRun(
  workspaceRoot: string,
  input: ScaffoldScoreInput,
): Promise<BuildScaffoldScoreResult> {
  const result = buildScaffoldScore(input);
  if (result.score) {
    await appendScaffoldScore(workspaceRoot, result.score);
  }
  return result;
}

export function buildScaffoldScore(input: ScaffoldScoreInput): BuildScaffoldScoreResult {
  const warnings: string[] = [];
  const runId = requireString(input.run.runId, 'run.runId', warnings);
  const workflowId = input.run.workflowId ?? input.scaffold.workflowId;
  if (!workflowId) {
    warnings.push('run.workflowId is missing and scaffold.workflowId is empty');
  }
  if (!runId || !workflowId) {
    normalizeFailures(input.run.failureTypes, warnings);
    normalizeNonNegative(input.run.costCents, 'run.costCents', warnings);
    normalizeNonNegative(input.run.durationMs, 'run.durationMs', warnings);
    return { warnings };
  }

  const failureTypes = normalizeFailures(input.run.failureTypes, warnings);
  const failedGateCount = normalizeNonNegative(input.run.failedGateCount, 'run.failedGateCount', warnings);
  const gateCount = normalizeNonNegative(input.run.gateCount, 'run.gateCount', warnings);
  const retryCount = normalizeNonNegative(input.run.retryCount, 'run.retryCount', warnings);
  const reworkCount = normalizeNonNegative(input.review?.reworkCount, 'review.reworkCount', warnings);
  const costCents = normalizeNonNegative(input.run.costCents, 'run.costCents', warnings);
  const durationMs = normalizeNonNegative(input.run.durationMs, 'run.durationMs', warnings);
  const verifierPass = input.review?.verifierPass ?? failedGateCount === 0;
  const judgeVeto = input.review?.judgeVeto ?? false;
  const falseAccept = input.review?.falseAccept ?? false;
  const falseReject = input.review?.falseReject ?? false;
  const scopeViolation =
    !!input.antiHackingViolation ||
    failureTypes.includes('scope_conflict') ||
    input.run.status === 'halted';
  const statusPass = input.run.status === 'completed';
  const pass =
    statusPass &&
    verifierPass &&
    !judgeVeto &&
    !falseAccept &&
    !scopeViolation &&
    !input.antiHackingViolation;

  const score: ScaffoldScore = {
    schema: SCAFFOLD_SCORE_SCHEMA,
    scaffoldId: input.scaffold.id,
    runId,
    workflowId,
    taskIntent: input.scaffold.taskIntent,
    createdAt: input.createdAt ?? new Date().toISOString(),
    pass,
    reward: calculateReward({
      pass,
      statusPass,
      verifierPass,
      judgeVeto,
      falseAccept,
      falseReject,
      failedGateCount,
      gateCount,
      failureTypes,
      retryCount,
      reworkCount,
      costCents,
      durationMs,
      antiHackingViolation: input.antiHackingViolation,
    }),
    verifierPass,
    judgeVeto,
    falseAccept,
    falseReject,
    scopeViolation,
    costCents,
    durationMs,
    retryCount,
    reworkCount,
    failureType: primaryFailure(failureTypes, input.antiHackingViolation),
    antiHackingViolation: input.antiHackingViolation,
    promptHarnessId: input.scaffold.promptHarnessId,
    reviewerIndependence: input.scaffold.review?.reviewerIndependence,
    metadata: {
      status: input.run.status ?? 'unknown',
      gateCount,
      failedGateCount,
      artifactCount: normalizeNonNegative(input.run.artifactCount, 'run.artifactCount', warnings),
      eventCount: normalizeNonNegative(input.run.eventCount, 'run.eventCount', warnings),
      failureTypes,
    },
  };

  return { score, warnings };
}

interface RewardParts {
  pass: boolean;
  statusPass: boolean;
  verifierPass: boolean;
  judgeVeto: boolean;
  falseAccept: boolean;
  falseReject: boolean;
  failedGateCount: number;
  gateCount: number;
  failureTypes: FailureType[];
  retryCount: number;
  reworkCount: number;
  costCents: number;
  durationMs: number;
  antiHackingViolation?: AntiHackingViolation;
}

function calculateReward(parts: RewardParts): number {
  if (parts.antiHackingViolation) {
    return parts.antiHackingViolation.severity === 'fatal'
      ? -1
      : parts.antiHackingViolation.severity === 'error'
        ? -0.75
        : -0.25;
  }

  let reward = parts.pass ? 1 : 0;
  if (!parts.statusPass) {
    reward -= 0.35;
  }
  if (!parts.verifierPass) {
    reward -= 0.25;
  }
  if (parts.judgeVeto) {
    reward -= 0.5;
  }
  if (parts.falseAccept) {
    reward -= 0.9;
  }
  if (parts.falseReject) {
    reward -= 0.35;
  }
  reward -= Math.min(0.25, parts.failedGateCount * 0.1);
  reward -= Math.min(0.2, parts.retryCount * 0.05);
  reward -= Math.min(0.2, parts.reworkCount * 0.05);
  reward -= Math.min(0.15, parts.costCents / 1000);
  reward -= Math.min(0.1, parts.durationMs / 600000);
  if (parts.failureTypes.includes('scope_conflict')) {
    reward -= 0.35;
  }
  if (parts.failureTypes.includes('mutation_survived')) {
    reward -= 0.3;
  }
  if (parts.gateCount > 0 && parts.failedGateCount === 0 && parts.pass) {
    reward += 0.05;
  }
  return Math.max(-1, Math.min(1, roundReward(reward)));
}

function normalizeFailures(value: unknown, warnings: string[]): FailureType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const failures: FailureType[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      failures.push(item as FailureType);
    } else {
      warnings.push('run.failureTypes contained a non-string value');
    }
  }
  return [...new Set(failures)].sort();
}

function normalizeNonNegative(value: unknown, label: string, warnings: string[]): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${label} must be a finite number; using 0`);
    return 0;
  }
  if (value < 0) {
    warnings.push(`${label} was negative; using 0`);
    return 0;
  }
  return value;
}

function requireString(value: unknown, label: string, warnings: string[]): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  warnings.push(`${label} is required`);
  return undefined;
}

function primaryFailure(failureTypes: FailureType[], antiHackingViolation?: AntiHackingViolation): FailureType | undefined {
  if (antiHackingViolation?.kind === 'scope_violation') {
    return 'scope_conflict';
  }
  return failureTypes[0];
}

function roundReward(value: number): number {
  return Math.round(value * 1000) / 1000;
}
