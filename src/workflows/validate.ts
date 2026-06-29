import type { FailureType } from '../diagnostics/failureTypes';
import { WORKFLOW_SCHEMA, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from './types';

export type WorkflowDiagnosticSeverity = 'error' | 'warning';

export interface WorkflowDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: WorkflowDiagnosticSeverity;
  failureType?: FailureType;
}

export interface WorkflowValidationResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
}

export function validateWorkflow(workflow: unknown): WorkflowValidationResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const fail = (code: string, message: string, path: string, failureType?: FailureType): void => {
    diagnostics.push({ code, message, path, severity: 'error', failureType });
  };

  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('workflow.object_required', 'Workflow definition must be an object.', '$');
    return { valid: false, diagnostics };
  }

  const candidate = workflow as Partial<WorkflowDefinition>;
  if (candidate.schema !== WORKFLOW_SCHEMA) {
    fail('workflow.schema_invalid', `Workflow schema must be ${WORKFLOW_SCHEMA}.`, '$.schema');
  }
  if (!isNonEmptyString(candidate.id)) {
    fail('workflow.id_required', 'Workflow id is required.', '$.id');
  }
  if (!isNonEmptyString(candidate.name)) {
    fail('workflow.name_required', 'Workflow name is required.', '$.name');
  }
  if (!Array.isArray(candidate.nodes)) {
    fail('workflow.nodes_required', 'Workflow nodes must be an array.', '$.nodes');
  }
  if (!Array.isArray(candidate.edges)) {
    fail('workflow.edges_required', 'Workflow edges must be an array.', '$.edges');
  }

  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const edges = Array.isArray(candidate.edges) ? candidate.edges : [];
  validateNodes(nodes, diagnostics);
  validateEdges(edges, nodes, diagnostics);
  validatePolicies(candidate, diagnostics);
  validateCycles(nodes, edges, diagnostics);

  return { valid: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
}

function validateNodes(nodes: unknown[], diagnostics: WorkflowDiagnostic[]): void {
  const ids = new Set<string>();
  nodes.forEach((raw, index) => {
    const path = `$.nodes[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push({ code: 'node.object_required', message: 'Workflow node must be an object.', path, severity: 'error' });
      return;
    }
    const node = raw as Partial<WorkflowNode>;
    if (!isNonEmptyString(node.id)) {
      diagnostics.push({ code: 'node.id_required', message: 'Workflow node id is required.', path: `${path}.id`, severity: 'error' });
    } else if (ids.has(node.id)) {
      diagnostics.push({ code: 'node.id_duplicate', message: `Duplicate node id "${node.id}".`, path: `${path}.id`, severity: 'error' });
    } else {
      ids.add(node.id);
    }
    if (!isNonEmptyString(node.type)) {
      diagnostics.push({ code: 'node.type_required', message: 'Workflow node type is required.', path: `${path}.type`, severity: 'error' });
    }
    if (!isNonEmptyString(node.kind)) {
      diagnostics.push({ code: 'node.kind_required', message: 'Workflow node kind is required.', path: `${path}.kind`, severity: 'error' });
    }
    if (!isPlainRecord(node.config)) {
      diagnostics.push({ code: 'node.config_required', message: 'Workflow node config must be an object.', path: `${path}.config`, severity: 'error' });
    } else {
      validateNodeConfig(node as WorkflowNode, path, diagnostics);
    }
    validatePorts(node, path, diagnostics);
    validatePositiveNumber(node.timeoutSeconds, `${path}.timeoutSeconds`, 'node.timeout_invalid', diagnostics);
    if (node.retry) {
      validatePositiveNumber(node.retry.maxAttempts, `${path}.retry.maxAttempts`, 'node.retry_invalid', diagnostics);
    }
  });
}

function validateNodeConfig(node: WorkflowNode, path: string, diagnostics: WorkflowDiagnostic[]): void {
  if (node.type === 'tool') {
    const hasCommand = isNonEmptyString(node.config.command);
    const hasToolId = isNonEmptyString(node.config.toolId);
    const hasAction = isNonEmptyString(node.config.action);
    if (!hasCommand && !hasToolId && !hasAction) {
      diagnostics.push({
        code: 'node.config.tool_target_required',
        message: 'Tool nodes require config.command, config.toolId, or config.action.',
        path: `${path}.config`,
        severity: 'error',
        failureType: 'tool_format_invalid',
      });
    }
  }
  if (node.type === 'agent') {
    const hasProvider = isNonEmptyString(node.config.provider) || isNonEmptyString(node.config.providerId);
    const hasModel = isNonEmptyString(node.config.model);
    const hasMock = node.config.mockComplete === true || node.config.provider === 'mock';
    if (!hasProvider && !hasModel && !hasMock) {
      diagnostics.push({
        code: 'node.config.agent_model_required',
        message: 'Agent nodes require config.provider/config.providerId, config.model, or config.mockComplete.',
        path: `${path}.config`,
        severity: 'error',
        failureType: 'tool_format_invalid',
      });
    }
  }
  if (node.type === 'gate') {
    const hasCriterion = isNonEmptyString(node.config.criterion) || isNonEmptyString(node.config.check) || isNonEmptyString(node.config.command);
    const hasMockPass = typeof node.config.mockPass === 'boolean';
    if (!hasCriterion && !hasMockPass) {
      diagnostics.push({
        code: 'node.config.gate_criterion_required',
        message: 'Gate nodes require config.criterion, config.check, config.command, or config.mockPass.',
        path: `${path}.config`,
        severity: 'error',
        failureType: 'tool_format_invalid',
      });
    }
  }
}

function validatePorts(node: Partial<WorkflowNode>, path: string, diagnostics: WorkflowDiagnostic[]): void {
  for (const group of ['inputs', 'outputs'] as const) {
    const ports = node.ports?.[group];
    if (ports === undefined) {
      continue;
    }
    if (!Array.isArray(ports)) {
      diagnostics.push({ code: 'node.ports_invalid', message: `Node ports.${group} must be an array.`, path: `${path}.ports.${group}`, severity: 'error' });
      continue;
    }
    const ids = new Set<string>();
    ports.forEach((port, index) => {
      if (!isNonEmptyString(port.id)) {
        diagnostics.push({ code: 'node.port.id_required', message: 'Workflow port id is required.', path: `${path}.ports.${group}[${index}].id`, severity: 'error' });
      } else if (ids.has(port.id)) {
        diagnostics.push({ code: 'node.port.id_duplicate', message: `Duplicate port id "${port.id}".`, path: `${path}.ports.${group}[${index}].id`, severity: 'error' });
      } else {
        ids.add(port.id);
      }
    });
  }
}

function validateEdges(edges: unknown[], nodes: unknown[], diagnostics: WorkflowDiagnostic[]): void {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const raw of nodes) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const node = raw as WorkflowNode;
      if (isNonEmptyString(node.id)) {
        nodeMap.set(node.id, node);
      }
    }
  }

  const edgeIds = new Set<string>();
  edges.forEach((raw, index) => {
    const path = `$.edges[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push({ code: 'edge.object_required', message: 'Workflow edge must be an object.', path, severity: 'error' });
      return;
    }
    const edge = raw as Partial<WorkflowEdge>;
    if (!isNonEmptyString(edge.id)) {
      diagnostics.push({ code: 'edge.id_required', message: 'Workflow edge id is required.', path: `${path}.id`, severity: 'error' });
    } else if (edgeIds.has(edge.id)) {
      diagnostics.push({ code: 'edge.id_duplicate', message: `Duplicate edge id "${edge.id}".`, path: `${path}.id`, severity: 'error' });
    } else {
      edgeIds.add(edge.id);
    }
    validateEndpoint(edge.from, `${path}.from`, 'edge.from_invalid', nodeMap, diagnostics);
    validateEndpoint(edge.to, `${path}.to`, 'edge.to_invalid', nodeMap, diagnostics);
  });
}

function validateEndpoint(
  endpoint: unknown,
  path: string,
  code: string,
  nodeMap: Map<string, WorkflowNode>,
  diagnostics: WorkflowDiagnostic[],
): void {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    diagnostics.push({ code, message: 'Workflow edge endpoint must be an object.', path, severity: 'error' });
    return;
  }
  const ref = endpoint as { node?: unknown; port?: unknown };
  if (!isNonEmptyString(ref.node)) {
    diagnostics.push({ code, message: 'Workflow edge endpoint node is required.', path: `${path}.node`, severity: 'error' });
    return;
  }
  const node = nodeMap.get(ref.node);
  if (!node) {
    diagnostics.push({ code: 'edge.node_missing', message: `Workflow edge references missing node "${ref.node}".`, path: `${path}.node`, severity: 'error' });
    return;
  }
  if (ref.port !== undefined && !nodeHasPort(node, String(ref.port))) {
    diagnostics.push({ code: 'edge.port_missing', message: `Workflow edge references missing port "${ref.port}" on node "${ref.node}".`, path: `${path}.port`, severity: 'error' });
  }
}

function validatePolicies(candidate: Partial<WorkflowDefinition>, diagnostics: WorkflowDiagnostic[]): void {
  const budget = candidate.policies?.budget;
  if (budget) {
    validateNonNegativeNumber(budget.maxCostCents, '$.policies.budget.maxCostCents', 'policy.budget_invalid', diagnostics);
    validateNonNegativeNumber(budget.maxTokens, '$.policies.budget.maxTokens', 'policy.budget_invalid', diagnostics);
    validatePositiveNumber(budget.maxWallTimeSeconds, '$.policies.budget.maxWallTimeSeconds', 'policy.wall_time_invalid', diagnostics);
    validatePositiveNumber(budget.maxIterations, '$.policies.budget.maxIterations', 'policy.iterations_invalid', diagnostics);
  }
  validatePositiveNumber(candidate.policies?.maxIterations, '$.policies.maxIterations', 'policy.iterations_invalid', diagnostics);
  validatePositiveNumber(candidate.policies?.maxDepth, '$.policies.maxDepth', 'policy.depth_invalid', diagnostics);
  validatePositiveNumber(candidate.policies?.maxWallTimeSeconds, '$.policies.maxWallTimeSeconds', 'policy.wall_time_invalid', diagnostics);
}

function validateCycles(nodes: unknown[], edges: unknown[], diagnostics: WorkflowDiagnostic[]): void {
  const nodeIds = new Set<string>();
  const loopNodes = new Set<string>();
  for (const raw of nodes) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const node = raw as WorkflowNode;
      if (isNonEmptyString(node.id)) {
        nodeIds.add(node.id);
        if (node.type === 'loop') {
          loopNodes.add(node.id);
        }
      }
    }
  }

  const graph = new Map<string, string[]>();
  for (const id of nodeIds) {
    graph.set(id, []);
  }
  for (const raw of edges) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const edge = raw as WorkflowEdge;
    if (edge.from?.node && edge.to?.node && nodeIds.has(edge.from.node) && nodeIds.has(edge.to.node)) {
      graph.get(edge.from.node)!.push(edge.to.node);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      const start = stack.indexOf(nodeId);
      const cycle = start >= 0 ? stack.slice(start).concat(nodeId) : [nodeId];
      const key = cycle.join('>');
      if (!reported.has(key) && !cycle.some((id) => loopNodes.has(id))) {
        reported.add(key);
        diagnostics.push({
          code: 'graph.cycle_without_loop',
          message: `Workflow graph contains a cycle without an explicit loop node: ${cycle.join(' -> ')}.`,
          path: '$.edges',
          severity: 'error',
          failureType: 'task_needs_decomposition',
        });
      }
      return;
    }
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const next of graph.get(nodeId) ?? []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const id of nodeIds) {
    visit(id);
  }
}

function nodeHasPort(node: WorkflowNode, portId: string): boolean {
  return [...(node.ports?.inputs ?? []), ...(node.ports?.outputs ?? [])].some((port) => port.id === portId);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePositiveNumber(value: unknown, path: string, code: string, diagnostics: WorkflowDiagnostic[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    diagnostics.push({ code, message: 'Value must be a positive number.', path, severity: 'error', failureType: 'budget_exhausted' });
  }
}

function validateNonNegativeNumber(value: unknown, path: string, code: string, diagnostics: WorkflowDiagnostic[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    diagnostics.push({ code, message: 'Value must be a non-negative number.', path, severity: 'error', failureType: 'budget_exhausted' });
  }
}
