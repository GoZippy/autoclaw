import type { FailureType } from '../diagnostics/failureTypes';

export const WORKFLOW_SCHEMA = 'autoclaw.workflow.v1' as const;
export const WORKFLOW_RUN_EVENT_SCHEMA = 'autoclaw.workflowRunEvent.v1' as const;

export type WorkflowSchema = typeof WORKFLOW_SCHEMA;
export type WorkflowRunEventSchema = typeof WORKFLOW_RUN_EVENT_SCHEMA;
export type WorkflowEdition = 'core' | 'pro' | 'teams' | 'enterprise';
export type WorkflowNodeType =
  | 'input'
  | 'context'
  | 'router'
  | 'agent'
  | 'tool'
  | 'gate'
  | 'loop'
  | 'artifact'
  | 'human'
  | 'control';
export type WorkflowEdgeType = 'data' | 'control' | 'evidence';
export type WorkflowPortDirection = 'input' | 'output';
export type WorkflowPortDataType = 'void' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'artifact' | 'unknown';
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'halted' | 'human_required';
export type WorkflowNodeRunStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'retrying';
export type ModelLocality = 'local' | 'lan' | 'cloud';
export type WorkflowIntent =
  | 'plan'
  | 'code'
  | 'debug'
  | 'test'
  | 'review'
  | 'security'
  | 'docs'
  | 'release'
  | 'refactor'
  | 'research'
  | 'summarize'
  | 'coordination'
  | 'benchmark'
  | 'vision'
  | 'tool-use'
  | 'long-context'
  | 'creative'
  | 'cheap-grade';
export type WorkflowOutcome = 'success' | 'failure' | 'stopped' | 'blocked';

export interface UnknownFields {
  [key: string]: unknown;
}

export interface WorkflowDefinition extends UnknownFields {
  schema: WorkflowSchema;
  id: string;
  name: string;
  description?: string;
  edition?: WorkflowEdition;
  version?: string;
  contract?: WorkflowContract;
  variables?: Record<string, WorkflowVariable>;
  policies?: WorkflowPolicies;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: Record<string, WorkflowLayoutNode>;
  metadata?: WorkflowMetadata;
}

export interface WorkflowMetadata extends UnknownFields {
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  packId?: string;
  tags?: string[];
}

export interface WorkflowLayoutNode extends UnknownFields {
  x: number;
  y: number;
}

export interface WorkflowVariable extends UnknownFields {
  type: WorkflowPortDataType;
  default?: unknown;
  description?: string;
  scope?: 'workflow' | 'run' | 'node';
}

export interface WorkflowContract extends UnknownFields {
  inputs: WorkflowInputContract[];
  outputs: WorkflowOutputContract[];
  invariants?: WorkflowInvariant[];
  requiredTools?: ToolRequirement[];
  requiredModels?: ModelRequirement[];
  requiredPermissions?: WorkflowPermission[];
  successCriteria: SuccessCriterion[];
  privacy?: PrivacyConstraint[];
  recovery?: RecoveryBehavior;
}

export interface WorkflowInputContract extends UnknownFields {
  id: string;
  type: WorkflowPortDataType;
  required?: boolean;
  description?: string;
}

export interface WorkflowOutputContract extends UnknownFields {
  id: string;
  type: WorkflowPortDataType;
  description?: string;
}

export interface WorkflowInvariant extends UnknownFields {
  id: string;
  description: string;
  noTouchGlobs?: string[];
}

export interface ToolRequirement extends UnknownFields {
  id: string;
  name?: string;
  version?: string;
  required?: boolean;
  permissions?: WorkflowPermission[];
}

export interface ModelRequirement extends UnknownFields {
  id: string;
  provider?: string;
  model?: string;
  capabilities?: ModelCapability[];
  locality?: ModelLocality;
  minContextWindow?: number;
}

export type ModelCapability = 'json' | 'tools' | 'vision' | 'embeddings' | 'long-context' | 'thinking';

export interface WorkflowPermission extends UnknownFields {
  id: string;
  kind: 'read' | 'write' | 'execute' | 'network' | 'publish' | 'model' | 'human';
  scope?: string;
}

export interface SuccessCriterion extends UnknownFields {
  id: string;
  description: string;
  gateNodeId?: string;
}

export interface PrivacyConstraint extends UnknownFields {
  id: string;
  dataSensitivity: 'public' | 'project-private' | 'secret-adjacent' | 'regulated';
  allowedLocalities?: ModelLocality[];
}

export interface RecoveryBehavior extends UnknownFields {
  onFailure: 'retry' | 'route' | 'human' | 'halt';
  maxAttempts?: number;
}

export interface PolicyDecision extends UnknownFields {
  allowed: boolean;
  policyId: string;
  reason: string;
  remediation?: string;
  evidence?: string[];
}

export interface WorkflowPolicies extends UnknownFields {
  budget?: WorkflowBudget;
  routingProfile?: 'cheap' | 'balanced' | 'quality' | 'local-only' | 'air-gapped' | 'release-critical';
  allowWrites?: boolean;
  allowNetwork?: boolean;
  requireHumanApproval?: boolean;
  maxIterations?: number;
  maxDepth?: number;
  maxWallTimeSeconds?: number;
  premiumModelPolicy?: PremiumModelPolicy;
}

export interface WorkflowBudget extends UnknownFields {
  maxCostCents?: number;
  maxTokens?: number;
  maxWallTimeSeconds?: number;
  maxIterations?: number;
}

export interface PremiumModelPolicy extends UnknownFields {
  allowedProviders?: string[];
  maxCostCents?: number;
  minAttemptsBeforeEscalation?: number;
  allowedFailureTriggers?: FailureType[];
  requiresHumanApproval?: boolean;
}

export interface RetryPolicy extends UnknownFields {
  maxAttempts: number;
  backoffMs?: number;
  retryOn?: FailureType[];
}

export interface WorkflowNode extends UnknownFields {
  id: string;
  type: WorkflowNodeType;
  kind: string;
  label?: string;
  config: Record<string, unknown>;
  ports?: WorkflowNodePorts;
  retry?: RetryPolicy;
  timeoutSeconds?: number;
  intent?: WorkflowIntent;
  budget?: WorkflowBudget;
}

export interface WorkflowNodePorts extends UnknownFields {
  inputs?: WorkflowPort[];
  outputs?: WorkflowPort[];
}

export interface WorkflowPort extends UnknownFields {
  id: string;
  direction?: WorkflowPortDirection;
  type: WorkflowPortDataType;
  required?: boolean;
  label?: string;
}

export interface WorkflowEdge extends UnknownFields {
  id: string;
  type?: WorkflowEdgeType;
  from: WorkflowEndpoint;
  to: WorkflowEndpoint;
  condition?: WorkflowCondition;
}

export interface WorkflowEndpoint extends UnknownFields {
  node: string;
  port?: string;
}

export interface WorkflowCondition extends UnknownFields {
  expression?: string;
  onStatus?: WorkflowNodeRunStatus | WorkflowNodeRunStatus[];
  onFailureType?: FailureType | FailureType[];
}

export interface WorkflowProviderRef extends UnknownFields {
  id: string;
  endpoint?: string;
  locality: ModelLocality;
  privacyTier?: 'local' | 'workspace' | 'cloud';
}

export interface WorkflowModelRef extends UnknownFields {
  providerId: string;
  model: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
  locality?: ModelLocality;
}

export interface WorkflowToolRef extends UnknownFields {
  id: string;
  kind: 'shell' | 'mcp' | 'adapter' | 'structured-action';
  permissions?: WorkflowPermission[];
}

export interface WorkflowArtifact extends UnknownFields {
  id: string;
  path: string;
  kind: 'context' | 'diff' | 'report' | 'review' | 'log' | 'data';
  createdAt: string;
  nodeId?: string;
  mediaType?: string;
}

export interface GateResult extends UnknownFields {
  id: string;
  kind: string;
  passed: boolean;
  failureType?: FailureType;
  summary?: string;
}

export interface WorkflowRunMetadata extends UnknownFields {
  schema: 'autoclaw.workflowRun.v1';
  runId: string;
  workflowId: string;
  workflowSchema: WorkflowSchema;
  status: WorkflowRunStatus;
  startedAt: string;
  completedAt?: string;
  taskId?: string;
  branch?: string;
  gitSha?: string;
  outcome?: WorkflowOutcome;
  failureType?: FailureType;
}

export interface WorkflowRunEvent extends UnknownFields {
  schema: WorkflowRunEventSchema;
  runId: string;
  nodeId: string;
  event: 'queued' | 'started' | 'completed' | 'failed' | 'skipped' | 'retrying' | 'escalated' | 'halted' | 'human_required';
  timestamp: string;
  durationMs?: number;
  model?: WorkflowRunModel;
  tokens?: WorkflowRunTokens;
  failureType?: FailureType;
  gateResults?: GateResult[];
  artifacts?: string[];
  summary?: string;
  retryCount?: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  policyDecision?: PolicyDecision;
}

export interface WorkflowRunModel extends UnknownFields {
  provider: string;
  model: string;
  locality: ModelLocality;
  selectionReason?: string;
}

export interface WorkflowRunTokens extends UnknownFields {
  input?: number;
  output?: number;
  costCents?: number;
}

export interface WorkflowRunState extends UnknownFields {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  nodes: Record<string, WorkflowNodeState>;
  artifacts: WorkflowArtifact[];
  costs: WorkflowRunTokens;
  limits?: WorkflowBudget;
  outcome?: WorkflowOutcome;
  failureType?: FailureType;
}

export interface WorkflowNodeState extends UnknownFields {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  failureType?: FailureType;
  artifacts?: string[];
}

export const parseWorkflow = (input: string | unknown): WorkflowDefinition =>
  parseWorkflowDefinition(input);

export function parseWorkflowDefinition(input: string | unknown): WorkflowDefinition {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow definition must be an object');
  }
  return value as WorkflowDefinition;
}

export function parseWorkflowRunEvent(input: string | unknown): WorkflowRunEvent {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow run event must be an object');
  }
  return value as WorkflowRunEvent;
}

export function stringifyWorkflowDefinition(workflow: WorkflowDefinition): string {
  return JSON.stringify(workflow, null, 2);
}
