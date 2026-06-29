import type { FailureType } from '../../diagnostics/failureTypes';
import type { ModelCapability, ModelLocality, UnknownFields, WorkflowIntent, WorkflowPolicies } from '../types';

export const SCAFFOLD_SCHEMA = 'autoclaw.scaffold.v1' as const;
export const PROMPT_HARNESS_SCHEMA = 'autoclaw.promptHarness.v1' as const;
export const SCAFFOLD_SCORE_SCHEMA = 'autoclaw.scaffoldScore.v1' as const;

export type ScaffoldSchema = typeof SCAFFOLD_SCHEMA;
export type PromptHarnessSchema = typeof PROMPT_HARNESS_SCHEMA;
export type ScaffoldScoreSchema = typeof SCAFFOLD_SCORE_SCHEMA;
export type ScaffoldRouterProfile = NonNullable<WorkflowPolicies['routingProfile']>;
export type ScaffoldMutationKind =
  | 'context_mode'
  | 'loop_policy'
  | 'router_profile'
  | 'tool_lane'
  | 'reviewer_independence'
  | 'prompt_harness'
  | 'model_profile'
  | 'best_of_n'
  | 'other';
export type ScaffoldReviewTier = 'tier1-local' | 'tier2-strong' | 'panel' | 'human';
export type ReviewerIndependence = 'same-model' | 'different-model' | 'different-provider' | 'human';
export type AntiHackingSeverity = 'warning' | 'error' | 'fatal';
export type AntiHackingViolationKind =
  | 'hidden_verifier_read'
  | 'verifier_modified'
  | 'hidden_test_modified'
  | 'score_ledger_modified'
  | 'run_ledger_modified'
  | 'policy_modified'
  | 'scope_violation'
  | 'expected_output_hardcode'
  | 'privilege_escalation'
  | 'self_score_edit'
  | 'unknown';

export interface ScaffoldMutation extends UnknownFields {
  kind: ScaffoldMutationKind;
  summary: string;
  parentScaffoldId?: string;
}

export interface ReviewScaffoldConfig extends UnknownFields {
  tier: ScaffoldReviewTier;
  reviewerIndependence: ReviewerIndependence;
  gatesFirst: boolean;
  panelSize?: number;
  requiredProviderDiversity?: boolean;
  automatedVoteLabel?: string;
}

export interface ScaffoldVariant extends UnknownFields {
  schema: ScaffoldSchema;
  id: string;
  workflowId: string;
  taskIntent: WorkflowIntent;
  routerProfile: ScaffoldRouterProfile;
  toolLaneIds: string[];
  createdAt: string;
  createdBy?: string;
  contextPlanId?: string;
  promptHarnessId?: string;
  loopPolicyId?: string;
  parentScaffoldId?: string;
  mutation?: ScaffoldMutation;
  review?: ReviewScaffoldConfig;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PromptHarnessContract extends UnknownFields {
  schema: PromptHarnessSchema;
  id: string;
  roleFormat: 'chatml' | 'anthropic' | 'openai-responses' | 'qwen-xml' | 'plain' | 'custom';
  toolCallFormat: 'none' | 'json' | 'xml' | 'function-call' | 'custom';
  toolResponseFormat: 'none' | 'json' | 'xml' | 'function-call' | 'custom';
  reasoningFormat: 'hidden' | 'visible' | 'tagged' | 'none' | 'custom';
  supportsVisionInSystem: boolean;
  modelFamily?: string;
  capabilities?: ModelCapability[];
  maxContextTokens?: number;
  requiresReasoningParser?: boolean;
  requiresToolParser?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AntiHackingViolation extends UnknownFields {
  kind: AntiHackingViolationKind;
  summary: string;
  severity: AntiHackingSeverity;
  path?: string;
  detectedAt?: string;
}

export interface ScaffoldScoreModel extends UnknownFields {
  provider: string;
  model: string;
  locality: ModelLocality;
}

export interface ScaffoldScore extends UnknownFields {
  schema: ScaffoldScoreSchema;
  scaffoldId: string;
  runId: string;
  workflowId: string;
  taskIntent: WorkflowIntent;
  createdAt: string;
  pass: boolean;
  reward: number;
  verifierPass: boolean;
  judgeVeto: boolean;
  falseAccept?: boolean;
  falseReject?: boolean;
  scopeViolation: boolean;
  costCents: number;
  durationMs: number;
  retryCount: number;
  reworkCount: number;
  failureType?: FailureType;
  antiHackingViolation?: AntiHackingViolation;
  promptHarnessId?: string;
  reviewerIndependence?: ReviewerIndependence;
  model?: ScaffoldScoreModel;
  metadata?: Record<string, unknown>;
}

export function parseScaffoldVariant(input: string | unknown): ScaffoldVariant {
  const value = parseRecord(input, 'Scaffold variant');
  requireSchema(value, SCAFFOLD_SCHEMA, 'Scaffold variant');
  requireString(value, 'id', 'Scaffold variant');
  requireString(value, 'workflowId', 'Scaffold variant');
  requireString(value, 'taskIntent', 'Scaffold variant');
  requireString(value, 'routerProfile', 'Scaffold variant');
  requireStringArray(value, 'toolLaneIds', 'Scaffold variant');
  requireString(value, 'createdAt', 'Scaffold variant');
  return value as ScaffoldVariant;
}

export function parsePromptHarnessContract(input: string | unknown): PromptHarnessContract {
  const value = parseRecord(input, 'Prompt harness contract');
  requireSchema(value, PROMPT_HARNESS_SCHEMA, 'Prompt harness contract');
  requireString(value, 'id', 'Prompt harness contract');
  requireString(value, 'roleFormat', 'Prompt harness contract');
  requireString(value, 'toolCallFormat', 'Prompt harness contract');
  requireString(value, 'toolResponseFormat', 'Prompt harness contract');
  requireString(value, 'reasoningFormat', 'Prompt harness contract');
  if (typeof value.supportsVisionInSystem !== 'boolean') {
    throw new Error('Prompt harness contract supportsVisionInSystem must be a boolean');
  }
  return value as PromptHarnessContract;
}

export function parseScaffoldScore(input: string | unknown): ScaffoldScore {
  const value = parseRecord(input, 'Scaffold score');
  requireSchema(value, SCAFFOLD_SCORE_SCHEMA, 'Scaffold score');
  requireString(value, 'scaffoldId', 'Scaffold score');
  requireString(value, 'runId', 'Scaffold score');
  requireString(value, 'workflowId', 'Scaffold score');
  requireString(value, 'taskIntent', 'Scaffold score');
  requireString(value, 'createdAt', 'Scaffold score');
  requireBoolean(value, 'pass', 'Scaffold score');
  requireBoolean(value, 'verifierPass', 'Scaffold score');
  requireBoolean(value, 'judgeVeto', 'Scaffold score');
  requireBoolean(value, 'scopeViolation', 'Scaffold score');
  requireNumber(value, 'reward', 'Scaffold score');
  requireNumber(value, 'costCents', 'Scaffold score');
  requireNumber(value, 'durationMs', 'Scaffold score');
  requireNumber(value, 'retryCount', 'Scaffold score');
  requireNumber(value, 'reworkCount', 'Scaffold score');
  return value as ScaffoldScore;
}

function parseRecord(input: string | unknown, label: string): Record<string, unknown> {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireSchema(value: Record<string, unknown>, schema: string, label: string): void {
  if (value.schema !== schema) {
    throw new Error(`${label} schema must be ${schema}`);
  }
}

function requireString(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== 'string' || value[key] === '') {
    throw new Error(`${label} ${key} must be a non-empty string`);
  }
}

function requireStringArray(value: Record<string, unknown>, key: string, label: string): void {
  if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((item) => typeof item === 'string')) {
    throw new Error(`${label} ${key} must be a string array`);
  }
}

function requireBoolean(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== 'boolean') {
    throw new Error(`${label} ${key} must be a boolean`);
  }
}

function requireNumber(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
    throw new Error(`${label} ${key} must be a finite number`);
  }
}
