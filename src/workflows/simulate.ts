import { validateWorkflowContract, type AvailableModel, type AvailableTool, type ContractPreflightContext } from './contracts';
import type { PolicyDecision, WorkflowDefinition, WorkflowNode } from './types';
import { validateWorkflow, type WorkflowDiagnostic } from './validate';

export interface WorkflowSimulationOptions extends ContractPreflightContext {
  costPerNodeCents?: number;
  durationPerNodeSeconds?: number;
}

export interface WorkflowSimulationResult {
  workflowId: string;
  valid: boolean;
  likelyPath: string[];
  blockedNodes: WorkflowSimulationBlocker[];
  missingTools: string[];
  eligibleModels: WorkflowSimulationModel[];
  estimatedCostCents: { min: number; max: number };
  estimatedDurationSeconds: { min: number; max: number };
  writePermissions: WorkflowWritePermissionSummary[];
  humanApprovals: string[];
  policyBlocks: PolicyDecision[];
  diagnostics: WorkflowDiagnostic[];
}

export interface WorkflowSimulationBlocker {
  nodeId?: string;
  code: string;
  message: string;
  remediation?: string;
}

export interface WorkflowSimulationModel {
  requirementId: string;
  provider?: string;
  model?: string;
  locality?: string;
  reason: string;
}

export interface WorkflowWritePermissionSummary {
  nodeId: string;
  target?: string;
  requiresApproval: boolean;
  reason: string;
}

export function simulateWorkflow(workflow: WorkflowDefinition, options: WorkflowSimulationOptions = {}): WorkflowSimulationResult {
  const validation = validateWorkflow(workflow);
  const contract = validateWorkflowContract(workflow, options);
  const missingTools = missingRequiredTools(workflow, options.availableTools ?? []);
  const eligibleModels = findEligibleModels(workflow, options.availableModels ?? []);
  const likelyPath = validation.valid ? likelyExecutionPath(workflow) : [];
  const humanApprovals = workflow.nodes
    .filter((node) => node.type === 'human' || node.kind.toLowerCase().includes('approval'))
    .map((node) => node.id);
  if (workflow.policies?.requireHumanApproval && humanApprovals.length === 0) {
    humanApprovals.push('workflow-policy');
  }
  const writePermissions = summarizeWrites(workflow);
  const policyBlocks = contract.policyDecisions.filter((decision) => !decision.allowed);
  const blockedNodes: WorkflowSimulationBlocker[] = [
    ...validation.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
    ...contract.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, remediation: diagnostic.remediation })),
  ];

  for (const tool of missingTools) {
    blockedNodes.push({
      code: 'simulation.missing_tool',
      message: `Required tool "${tool}" is unavailable.`,
      remediation: `Install or configure "${tool}" before running this workflow.`,
    });
  }
  for (const permission of writePermissions.filter((item) => item.requiresApproval)) {
    blockedNodes.push({
      nodeId: permission.nodeId,
      code: 'simulation.write_permission_required',
      message: permission.reason,
      remediation: 'Grant write permission or add a human approval node.',
    });
  }

  const nodeCount = Math.max(1, likelyPath.length || workflow.nodes.length);
  const costPerNode = options.costPerNodeCents ?? 1;
  const durationPerNode = options.durationPerNodeSeconds ?? 10;
  const maxIterations = workflow.policies?.budget?.maxIterations ?? workflow.policies?.maxIterations ?? 1;
  return {
    workflowId: workflow.id,
    valid: validation.valid && contract.valid && blockedNodes.length === 0,
    likelyPath,
    blockedNodes,
    missingTools,
    eligibleModels,
    estimatedCostCents: {
      min: nodeCount * costPerNode,
      max: nodeCount * costPerNode * Math.max(1, maxIterations),
    },
    estimatedDurationSeconds: {
      min: nodeCount * durationPerNode,
      max: nodeCount * durationPerNode * Math.max(1, maxIterations),
    },
    writePermissions,
    humanApprovals,
    policyBlocks,
    diagnostics: validation.diagnostics,
  };
}

function likelyExecutionPath(workflow: WorkflowDefinition): string[] {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    if (!nodes.has(edge.from.node) || !nodes.has(edge.to.node)) {
      continue;
    }
    outgoing.get(edge.from.node)!.push(edge.to.node);
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
  }

  const ready = workflow.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const route: string[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    route.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextCount = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextCount);
      if (nextCount <= 0) {
        ready.push(next);
      }
    }
  }
  for (const node of workflow.nodes) {
    if (!seen.has(node.id) && node.type === 'loop') {
      route.push(node.id);
    }
  }
  return route;
}

function missingRequiredTools(workflow: WorkflowDefinition, availableTools: readonly AvailableTool[]): string[] {
  const available = new Set<string>();
  for (const tool of availableTools) {
    available.add(tool.id);
    if (tool.name) {
      available.add(tool.name);
    }
  }
  return (workflow.contract?.requiredTools ?? [])
    .filter((tool) => tool.required && !available.has(tool.id) && !(tool.name && available.has(tool.name)))
    .map((tool) => tool.id);
}

function findEligibleModels(workflow: WorkflowDefinition, availableModels: readonly AvailableModel[]): WorkflowSimulationModel[] {
  const localities = allowedLocalities(workflow);
  const eligible: WorkflowSimulationModel[] = [];
  for (const requirement of workflow.contract?.requiredModels ?? []) {
    for (const model of availableModels) {
      if (requirement.locality && model.locality !== requirement.locality) {
        continue;
      }
      if (model.locality && !localities.includes(model.locality)) {
        continue;
      }
      if ((requirement.capabilities ?? []).some((capability) => !(model.capabilities ?? []).includes(capability))) {
        continue;
      }
      if (requirement.minContextWindow && (model.contextWindow ?? 0) < requirement.minContextWindow) {
        continue;
      }
      eligible.push({
        requirementId: requirement.id,
        provider: model.provider,
        model: model.model ?? model.id,
        locality: model.locality,
        reason: `Matches requirement ${requirement.id}.`,
      });
    }
  }
  return eligible;
}

function allowedLocalities(workflow: WorkflowDefinition): string[] {
  if (workflow.policies?.routingProfile === 'local-only' || workflow.policies?.routingProfile === 'air-gapped') {
    return ['local'];
  }
  const privacyAllowed = workflow.contract?.privacy?.flatMap((privacy) => privacy.allowedLocalities ?? []) ?? [];
  return privacyAllowed.length > 0 ? [...new Set(privacyAllowed)] : ['local', 'lan', 'cloud'];
}

function summarizeWrites(workflow: WorkflowDefinition): WorkflowWritePermissionSummary[] {
  return workflow.nodes.filter(isWriteNode).map((node) => {
    const target = writeTarget(node);
    const hasWritePermission = (workflow.contract?.requiredPermissions ?? []).some((permission) => permission.kind === 'write');
    return {
      nodeId: node.id,
      target,
      requiresApproval: !hasWritePermission || workflow.policies?.allowWrites === false,
      reason: hasWritePermission && workflow.policies?.allowWrites !== false
        ? `Node ${node.id} has declared write permission.`
        : `Node ${node.id} writes ${target ?? 'an artifact'} without an enabled write policy.`,
    };
  });
}

function isWriteNode(node: WorkflowNode): boolean {
  if (node.type === 'artifact') {
    return true;
  }
  if (node.type !== 'tool') {
    return false;
  }
  const action = String(node.config.action ?? node.kind ?? '').toLowerCase();
  return action.includes('write') || action.includes('patch') || action.includes('edit') || action.includes('publish') || action.includes('apply');
}

function writeTarget(node: WorkflowNode): string | undefined {
  for (const key of ['file', 'targetFile', 'path', 'outputPath'] as const) {
    const value = node.config[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}
