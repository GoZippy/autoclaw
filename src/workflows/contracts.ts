import type { FailureType } from '../diagnostics/failureTypes';
import type {
  ModelCapability,
  ModelLocality,
  PolicyDecision,
  ToolRequirement,
  WorkflowContract,
  WorkflowDefinition,
  WorkflowInvariant,
  ModelRequirement,
  WorkflowModelRef,
  WorkflowNode,
  WorkflowPermission,
} from './types';

export type ContractDiagnosticSeverity = 'error' | 'warning';

export interface ContractDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: ContractDiagnosticSeverity;
  failureType?: FailureType;
  remediation?: string;
}

export interface ContractValidationResult {
  valid: boolean;
  diagnostics: ContractDiagnostic[];
  policyDecisions: PolicyDecision[];
  summary: WorkflowContractSummary;
}

export interface WorkflowContractSummary {
  workflowId: string;
  hasContract: boolean;
  inputCount: number;
  outputCount: number;
  invariantCount: number;
  requiredToolIds: string[];
  requiredModelIds: string[];
  requiredPermissionIds: string[];
  successCriteriaIds: string[];
  privacyConstraintIds: string[];
  recovery?: string;
}

export interface ContractPreflightContext {
  availableTools?: AvailableTool[];
  availableModels?: AvailableModel[];
  grantedPermissions?: AvailablePermission[];
}

export interface AvailableTool {
  id: string;
  name?: string;
}

export interface AvailableModel {
  id?: string;
  provider?: string;
  model?: string;
  capabilities?: ModelCapability[];
  locality?: ModelLocality;
  contextWindow?: number;
}

export interface AvailablePermission {
  id?: string;
  kind: WorkflowPermission['kind'];
  scope?: string;
}

interface WriteTarget {
  nodeId: string;
  path: string;
}

export function validateWorkflowContract(
  workflow: WorkflowDefinition,
  context: ContractPreflightContext = {},
): ContractValidationResult {
  const diagnostics: ContractDiagnostic[] = [];
  const policyDecisions: PolicyDecision[] = [];
  const contract = workflow.contract;

  if (!contract) {
    diagnostics.push({
      code: 'contract.missing',
      message: 'Workflow contract is required before preflight.',
      path: '$.contract',
      severity: 'error',
      failureType: 'artifact_invalid',
      remediation: 'Add contract inputs, outputs, success criteria, and required capabilities.',
    });
    return {
      valid: false,
      diagnostics,
      policyDecisions,
      summary: summarizeWorkflowContract(workflow),
    };
  }

  validateContractShape(contract, diagnostics);
  validateRequiredTools(contract.requiredTools ?? [], context.availableTools ?? [], diagnostics, policyDecisions);
  validateRequiredModels(contract.requiredModels ?? [], context.availableModels ?? [], diagnostics, policyDecisions);
  validateRequiredPermissions(contract.requiredPermissions ?? [], context.grantedPermissions ?? [], diagnostics, policyDecisions);
  validateNoTouchInvariants(workflow, contract.invariants ?? [], diagnostics, policyDecisions);

  return {
    valid: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    policyDecisions,
    summary: summarizeWorkflowContract(workflow),
  };
}

export function summarizeWorkflowContract(workflow: Pick<WorkflowDefinition, 'id' | 'contract'>): WorkflowContractSummary {
  const contract = workflow.contract;
  return {
    workflowId: workflow.id,
    hasContract: !!contract,
    inputCount: contract?.inputs?.length ?? 0,
    outputCount: contract?.outputs?.length ?? 0,
    invariantCount: contract?.invariants?.length ?? 0,
    requiredToolIds: (contract?.requiredTools ?? []).map((tool) => tool.id),
    requiredModelIds: (contract?.requiredModels ?? []).map((model) => model.id),
    requiredPermissionIds: (contract?.requiredPermissions ?? []).map((permission) => permission.id),
    successCriteriaIds: (contract?.successCriteria ?? []).map((criterion) => criterion.id),
    privacyConstraintIds: (contract?.privacy ?? []).map((privacy) => privacy.id),
    recovery: contract?.recovery?.onFailure,
  };
}

function validateContractShape(contract: WorkflowContract, diagnostics: ContractDiagnostic[]): void {
  validateIdArray(contract.inputs, '$.contract.inputs', 'contract.inputs_required', 'Contract inputs must be a non-empty array.', diagnostics);
  validateIdArray(contract.outputs, '$.contract.outputs', 'contract.outputs_required', 'Contract outputs must be a non-empty array.', diagnostics);
  validateIdArray(
    contract.successCriteria,
    '$.contract.successCriteria',
    'contract.success_criteria_required',
    'Contract successCriteria must be a non-empty array.',
    diagnostics,
  );

  if (contract.recovery?.maxAttempts !== undefined && (!Number.isFinite(contract.recovery.maxAttempts) || contract.recovery.maxAttempts < 0)) {
    diagnostics.push({
      code: 'contract.recovery_invalid',
      message: 'Recovery maxAttempts must be a non-negative number.',
      path: '$.contract.recovery.maxAttempts',
      severity: 'error',
      failureType: 'budget_exhausted',
    });
  }
}

function validateIdArray(
  value: unknown,
  path: string,
  code: string,
  message: string,
  diagnostics: ContractDiagnostic[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push({ code, message, path, severity: 'error', failureType: 'artifact_invalid' });
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      diagnostics.push({
        code: 'contract.id_required',
        message: 'Contract entries require stable ids.',
        path: `${path}[${index}].id`,
        severity: 'error',
        failureType: 'artifact_invalid',
      });
      return;
    }
    if (ids.has(id)) {
      diagnostics.push({
        code: 'contract.id_duplicate',
        message: `Duplicate contract entry id "${id}".`,
        path: `${path}[${index}].id`,
        severity: 'error',
        failureType: 'artifact_invalid',
      });
    }
    ids.add(id);
  });
}

function validateRequiredTools(
  requiredTools: readonly ToolRequirement[],
  availableTools: readonly AvailableTool[],
  diagnostics: ContractDiagnostic[],
  policyDecisions: PolicyDecision[],
): void {
  const available = new Set<string>();
  for (const tool of availableTools) {
    available.add(tool.id);
    if (tool.name) {
      available.add(tool.name);
    }
  }
  for (let i = 0; i < requiredTools.length; i++) {
    const tool = requiredTools[i];
    if (!tool.required) {
      continue;
    }
    const present = available.has(tool.id) || (tool.name ? available.has(tool.name) : false);
    policyDecisions.push({
      allowed: present,
      policyId: `required-tool:${tool.id}`,
      reason: present ? `Required tool ${tool.id} is available.` : `Required tool ${tool.id} is missing.`,
      remediation: present ? undefined : `Install or configure tool "${tool.name ?? tool.id}" before running this workflow.`,
    });
    if (!present) {
      diagnostics.push({
        code: 'contract.tool_missing',
        message: `Required tool "${tool.id}" is not available.`,
        path: `$.contract.requiredTools[${i}]`,
        severity: 'error',
        failureType: 'tool_action_illegal',
        remediation: `Install or configure tool "${tool.name ?? tool.id}".`,
      });
    }
  }
}

function validateRequiredModels(
  requiredModels: readonly ModelRequirement[],
  availableModels: readonly AvailableModel[],
  diagnostics: ContractDiagnostic[],
  policyDecisions: PolicyDecision[],
): void {
  for (let i = 0; i < requiredModels.length; i++) {
    const required = requiredModels[i];
    const present = availableModels.some((model) => modelMatches(required, model));
    policyDecisions.push({
      allowed: present,
      policyId: `required-model:${required.id}`,
      reason: present ? `Required model ${required.id} is available.` : `Required model ${required.id} is missing.`,
      remediation: present ? undefined : 'Configure a provider/model that satisfies this workflow contract.',
    });
    if (!present && availableModels.length > 0) {
      diagnostics.push({
        code: 'contract.model_missing',
        message: `No available model satisfies requirement "${required.id}".`,
        path: `$.contract.requiredModels[${i}]`,
        severity: 'error',
        failureType: 'irreducible_or_needs_human',
        remediation: 'Configure a matching local, LAN, or approved cloud model.',
      });
    }
  }
}

function validateRequiredPermissions(
  requiredPermissions: readonly WorkflowPermission[],
  grantedPermissions: readonly AvailablePermission[],
  diagnostics: ContractDiagnostic[],
  policyDecisions: PolicyDecision[],
): void {
  for (let i = 0; i < requiredPermissions.length; i++) {
    const permission = requiredPermissions[i];
    const granted = grantedPermissions.some((p) => permissionMatches(permission, p));
    policyDecisions.push({
      allowed: granted,
      policyId: `required-permission:${permission.id}`,
      reason: granted ? `Permission ${permission.id} is granted.` : `Permission ${permission.id} is not granted.`,
      remediation: granted ? undefined : `Grant ${permission.kind} permission for ${permission.scope ?? 'the requested scope'}.`,
    });
    if (!granted && grantedPermissions.length > 0) {
      diagnostics.push({
        code: 'contract.permission_missing',
        message: `Required permission "${permission.id}" is not granted.`,
        path: `$.contract.requiredPermissions[${i}]`,
        severity: 'error',
        failureType: 'scope_conflict',
        remediation: `Grant ${permission.kind} permission for ${permission.scope ?? 'the requested scope'}.`,
      });
    }
  }
}

function validateNoTouchInvariants(
  workflow: WorkflowDefinition,
  invariants: readonly WorkflowInvariant[],
  diagnostics: ContractDiagnostic[],
  policyDecisions: PolicyDecision[],
): void {
  const writeTargets = collectWriteTargets(workflow.nodes);
  for (let i = 0; i < invariants.length; i++) {
    const invariant = invariants[i];
    for (const glob of invariant.noTouchGlobs ?? []) {
      if (glob.startsWith('!')) {
        continue;
      }
      for (const target of writeTargets) {
        if (!globMatches(glob, target.path)) {
          continue;
        }
        policyDecisions.push({
          allowed: false,
          policyId: `invariant:${invariant.id}`,
          reason: `Write target ${target.path} violates no-touch invariant ${invariant.id}.`,
          remediation: 'Route to a human approval node, narrow the target scope, or change the workflow contract.',
          evidence: [target.nodeId, target.path],
        });
        diagnostics.push({
          code: 'contract.invariant_no_touch_violation',
          message: `Node "${target.nodeId}" writes "${target.path}", which violates invariant "${invariant.id}".`,
          path: `$.contract.invariants[${i}].noTouchGlobs`,
          severity: 'error',
          failureType: 'scope_conflict',
          remediation: 'Remove the write node, change its target, or update the invariant with review.',
        });
      }
    }
  }
}

function collectWriteTargets(nodes: readonly WorkflowNode[]): WriteTarget[] {
  const targets: WriteTarget[] = [];
  for (const node of nodes) {
    if (!isWriteNode(node)) {
      continue;
    }
    for (const key of ['file', 'targetFile', 'path', 'outputPath'] as const) {
      const value = node.config[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        targets.push({ nodeId: node.id, path: stripTemplate(value) });
      }
    }
    const files = node.config.files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (typeof file === 'string') {
          targets.push({ nodeId: node.id, path: stripTemplate(file) });
        }
      }
    }
  }
  return targets;
}

function isWriteNode(node: WorkflowNode): boolean {
  if (node.type === 'artifact') {
    return true;
  }
  if (node.type !== 'tool') {
    return false;
  }
  const action = String(node.config.action ?? node.kind ?? '').toLowerCase();
  return (
    action.includes('write') ||
    action.includes('patch') ||
    action.includes('edit') ||
    action.includes('publish') ||
    action.includes('apply')
  );
}

function stripTemplate(value: string): string {
  return value.replace(/^\$\{\{/, '').replace(/\}\}$/, '');
}

function modelMatches(required: ModelRequirement, available: AvailableModel): boolean {
  if (required.id && available.id === required.id) {
    return true;
  }
  if (required.provider && available.provider !== required.provider) {
    return false;
  }
  if (required.model && available.model !== required.model) {
    return false;
  }
  if (required.locality && available.locality !== required.locality) {
    return false;
  }
  for (const capability of required.capabilities ?? []) {
    if (!(available.capabilities ?? []).includes(capability)) {
      return false;
    }
  }
  if (required.minContextWindow && (available.contextWindow ?? 0) < required.minContextWindow) {
    return false;
  }
  return !!(required.provider || required.model || required.locality || required.capabilities?.length || required.minContextWindow);
}

function permissionMatches(required: WorkflowPermission, granted: AvailablePermission): boolean {
  if (required.id && granted.id === required.id) {
    return true;
  }
  if (required.kind !== granted.kind) {
    return false;
  }
  return !required.scope || !granted.scope || required.scope === granted.scope;
}

function globMatches(glob: string, target: string): boolean {
  const normalizedGlob = normalizePath(glob);
  const normalizedTarget = normalizePath(target);
  if (normalizedGlob === normalizedTarget) {
    return true;
  }
  const escaped = normalizedGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`).test(normalizedTarget);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}
