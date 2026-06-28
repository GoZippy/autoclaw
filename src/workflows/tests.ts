import type { FailureType } from '../diagnostics/failureTypes';
import { validateWorkflowContract, type ContractDiagnostic, type ContractPreflightContext } from './contracts';
import type { PolicyDecision, WorkflowDefinition, WorkflowNode } from './types';
import { validateWorkflow, type WorkflowDiagnostic } from './validate';

export interface WorkflowTestCase {
  id: string;
  workflowId: string;
  workflow: WorkflowDefinition;
  inputs: Record<string, unknown>;
  mocks?: WorkflowMocks;
  expect: WorkflowExpectation[];
  contractContext?: ContractPreflightContext;
}

export interface WorkflowMocks {
  nodes?: Record<string, MockNodeResult>;
  tools?: Record<string, MockNodeResult>;
  models?: Record<string, MockNodeResult>;
}

export interface MockNodeResult {
  status?: 'completed' | 'failed' | 'skipped';
  outputs?: Record<string, unknown>;
  artifacts?: string[];
  failureType?: FailureType;
  policyDecisions?: PolicyDecision[];
  summary?: string;
}

export type WorkflowExpectation =
  | { type: 'status'; status: 'passed' | 'failed' }
  | { type: 'route_includes'; nodeId: string }
  | { type: 'route_excludes'; nodeId: string }
  | { type: 'routing_profile'; profile: string }
  | { type: 'failure_type'; failureType?: FailureType }
  | { type: 'artifact'; path: string }
  | { type: 'policy_decision'; policyId: string; allowed?: boolean }
  | { type: 'node_output'; nodeId: string; key: string; equals: unknown };

export interface WorkflowExpectationResult {
  passed: boolean;
  expectation: WorkflowExpectation;
  message: string;
  expected: unknown;
  actual: unknown;
  path: string;
}

export interface WorkflowTestResult {
  id: string;
  workflowId: string;
  passed: boolean;
  route: string[];
  routingProfile?: string;
  outputsByNode: Record<string, Record<string, unknown>>;
  artifacts: string[];
  failureType?: FailureType;
  diagnostics: Array<WorkflowDiagnostic | ContractDiagnostic>;
  policyDecisions: PolicyDecision[];
  expectations: WorkflowExpectationResult[];
}

export function runWorkflowTestCase(testCase: WorkflowTestCase): WorkflowTestResult {
  const validation = validateWorkflow(testCase.workflow);
  const contract = validateWorkflowContract(testCase.workflow, testCase.contractContext ?? {});
  const diagnostics: Array<WorkflowDiagnostic | ContractDiagnostic> = [
    ...validation.diagnostics,
    ...contract.diagnostics,
  ];
  const policyDecisions = [...contract.policyDecisions];
  const route: string[] = [];
  const outputsByNode: Record<string, Record<string, unknown>> = {};
  const artifacts: string[] = [];
  let failureType: FailureType | undefined;

  if (validation.valid && contract.valid) {
    for (const node of executionOrder(testCase.workflow)) {
      const mock = mockForNode(node, testCase.mocks);
      const result = mock ?? defaultNodeResult(node, testCase.inputs);
      if (result.status === 'skipped') {
        continue;
      }
      route.push(node.id);
      if (result.outputs) {
        outputsByNode[node.id] = result.outputs;
      }
      artifacts.push(...(result.artifacts ?? []));
      policyDecisions.push(...(result.policyDecisions ?? []));
      if (result.failureType) {
        failureType = result.failureType;
      }
      if (result.status === 'failed') {
        break;
      }
    }
  }

  const expectationResults = testCase.expect.map((expectation) =>
    evaluateExpectation(expectation, {
      route,
      routingProfile: testCase.workflow.policies?.routingProfile,
      outputsByNode,
      artifacts,
      failureType,
      diagnostics,
      policyDecisions,
    }),
  );

  return {
    id: testCase.id,
    workflowId: testCase.workflowId,
    passed: validation.valid && contract.valid && expectationResults.every((result) => result.passed),
    route,
    routingProfile: testCase.workflow.policies?.routingProfile,
    outputsByNode,
    artifacts,
    failureType,
    diagnostics,
    policyDecisions,
    expectations: expectationResults,
  };
}

export function formatWorkflowTestFailures(result: WorkflowTestResult): string {
  const failures = result.expectations.filter((expectation) => !expectation.passed);
  if (result.diagnostics.length === 0 && failures.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === 'error') {
      lines.push(`diagnostic ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  for (const failure of failures) {
    lines.push(`${failure.path}: ${failure.message}; expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}`);
  }
  return lines.join('\n');
}

function executionOrder(workflow: WorkflowDefinition): WorkflowNode[] {
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
  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(nodes.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const nextCount = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextCount);
      if (nextCount <= 0) {
        ready.push(next);
      }
    }
  }

  for (const node of workflow.nodes) {
    if (!seen.has(node.id)) {
      ordered.push(node);
    }
  }
  return ordered;
}

function mockForNode(node: WorkflowNode, mocks: WorkflowMocks | undefined): MockNodeResult | undefined {
  return mocks?.nodes?.[node.id] ?? mocks?.tools?.[node.id] ?? mocks?.models?.[node.id];
}

function defaultNodeResult(node: WorkflowNode, inputs: Record<string, unknown>): MockNodeResult {
  if (node.type === 'input') {
    return { outputs: { ...inputs } };
  }
  if (node.type === 'gate') {
    const passed = typeof node.config.mockPass === 'boolean' ? node.config.mockPass : true;
    return {
      status: passed ? 'completed' : 'failed',
      outputs: { passed, failureType: passed ? undefined : node.config.failureTypeOnFail },
      failureType: passed ? undefined : (node.config.failureTypeOnFail as FailureType | undefined),
    };
  }
  if (node.type === 'artifact') {
    const path = typeof node.config.path === 'string' ? node.config.path : `${node.id}.artifact.json`;
    return { outputs: { artifact: path }, artifacts: [path] };
  }
  return { outputs: {} };
}

function evaluateExpectation(
  expectation: WorkflowExpectation,
  state: Omit<WorkflowTestResult, 'id' | 'workflowId' | 'passed' | 'expectations'>,
): WorkflowExpectationResult {
  switch (expectation.type) {
    case 'status': {
      const actual = state.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'passed';
      return expectationResult(expectation, actual === expectation.status, expectation.status, actual, '$.status');
    }
    case 'route_includes':
      return expectationResult(expectation, state.route.includes(expectation.nodeId), expectation.nodeId, state.route, '$.route');
    case 'route_excludes':
      return expectationResult(expectation, !state.route.includes(expectation.nodeId), `not ${expectation.nodeId}`, state.route, '$.route');
    case 'routing_profile':
      return expectationResult(expectation, state.routingProfile === expectation.profile, expectation.profile, state.routingProfile, '$.routingProfile');
    case 'failure_type':
      return expectationResult(expectation, state.failureType === expectation.failureType, expectation.failureType, state.failureType, '$.failureType');
    case 'artifact':
      return expectationResult(expectation, state.artifacts.includes(expectation.path), expectation.path, state.artifacts, '$.artifacts');
    case 'policy_decision': {
      const actual = state.policyDecisions.find((decision) => decision.policyId === expectation.policyId);
      const pass = !!actual && (expectation.allowed === undefined || actual.allowed === expectation.allowed);
      return expectationResult(expectation, pass, { policyId: expectation.policyId, allowed: expectation.allowed }, actual, '$.policyDecisions');
    }
    case 'node_output': {
      const actual = state.outputsByNode[expectation.nodeId]?.[expectation.key];
      return expectationResult(expectation, Object.is(actual, expectation.equals), expectation.equals, actual, `$.outputsByNode.${expectation.nodeId}.${expectation.key}`);
    }
  }
}

function expectationResult(
  expectation: WorkflowExpectation,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  path: string,
): WorkflowExpectationResult {
  return {
    passed,
    expectation,
    message: passed ? 'Expectation passed.' : `Expectation ${expectation.type} failed.`,
    expected,
    actual,
    path,
  };
}
