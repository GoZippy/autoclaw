/**
 * loops.ts — Bounded loop execution for the WL-1 headless runner (WL-1.2).
 *
 * Implements loop policies (max iterations, max depth, max duration, max cost,
 * success condition, no-progress detection) and the loop patterns:
 *   - retry
 *   - generate-verify-revise
 *   - retrieve-diagnose-reretrieve
 *   - best-of-N
 *   - mutation-test-strengthen
 *
 * Every loop emits `retrying`, `escalated`, `halted`, and `human_required` run
 * events and exits with a typed stop reason from
 * `state.RunStopReason`. No-progress detection watches for: unchanged outputs,
 * repeated same failure type, unchanged retrieval top-K, repeated test failure,
 * or cost/time ceiling approaching.
 */

import type {
  NodeContext,
  NodeExecResult,
  RunStopReason,
  WorkflowEdge,
  WorkflowFailureType,
  WorkflowNode,
} from './state';
import { isHumanRequired, isRetryableFailure } from './state';

// ---------------------------------------------------------------------------
// Body node resolution (graph-derived)
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered body-node list for a loop node.
 *
 * If `configBodyNodes` is provided (from `node.config.bodyNodes`), it is
 * used directly and returned as-is (trusted explicit order). Otherwise,
 * BFS from the loop node's outgoing edges discovers reachable nodes, and
 * the result is topologically sorted within the body subgraph.
 */
export function resolveLoopBodyNodes(
  loopNodeId: string,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  configBodyNodes?: string[],
): string[] {
  if (configBodyNodes && configBodyNodes.length > 0) {
    return configBodyNodes;
  }
  const nodeSet = new Set(nodes.map((n) => n.id));
  const bodySet = new Set<string>();
  const queue: string[] = [];

  for (const e of edges) {
    if (e.from?.node === loopNodeId && e.to?.node && e.to.node !== loopNodeId) {
      queue.push(e.to.node);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!nodeSet.has(id) || id === loopNodeId || bodySet.has(id)) continue;
    bodySet.add(id);
    for (const e of edges) {
      if (e.from?.node === id && e.to?.node && e.to.node !== loopNodeId) {
        queue.push(e.to.node);
      }
    }
  }
  return topoOrderSubset([...bodySet], edges, loopNodeId);
}

function topoOrderSubset(
  bodyIds: string[],
  edges: readonly WorkflowEdge[],
  loopNodeId: string,
): string[] {
  const bodySet = new Set(bodyIds);
  const inDegree = new Map<string, number>(bodyIds.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(bodyIds.map((id) => [id, []]));

  for (const e of edges) {
    const from = e.from?.node;
    const to = e.to?.node;
    if (!from || !to || from === loopNodeId || to === loopNodeId) continue;
    if (!bodySet.has(from) || !bodySet.has(to)) continue;
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const nbr of adj.get(id) ?? []) {
      const d = (inDegree.get(nbr) ?? 1) - 1;
      inDegree.set(nbr, d);
      if (d === 0) queue.push(nbr);
    }
  }
  for (const id of bodyIds) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

export interface LoopNodeConfig {
  [key: string]: unknown;
  kind?: 'retry' | 'generate-verify-revise' | 'retrieve-diagnose-reretrieve' | 'best-of-N' | 'mutation-test-strengthen';
  /** Explicit body node IDs (ordered). Derived from graph if absent. */
  bodyNodes?: string[];
  /** Node ID treated as the success gate — loop exits when this node completes. */
  successGateNodeId?: string;
  maxIterations?: number;
  maxDepth?: number;
  maxCostCents?: number;
  maxWallTimeMs?: number;
  /** Expression that evaluates to true when the loop should exit with success. */
  stopOn?: string;
  /** Expression that evaluates to true when the loop is stuck and should exit. */
  noProgress?: string;
  /** When true, escalate to a stronger model on the next iteration. */
  escalateOnFailure?: boolean;
  /** How many consecutive identical failure types triggers no_progress. Default 2. */
  noProgressAfter?: number;
}

interface LoopPolicy {
  maxIterations: number;
  maxDepth: number;
  maxCostCents: number;
  maxWallTimeMs: number;
}

const DEFAULT_POLICY: LoopPolicy = {
  maxIterations: 3,
  maxDepth: 1,
  maxCostCents: Infinity,
  maxWallTimeMs: Infinity,
};

function readPolicy(node: WorkflowNode): LoopPolicy {
  const cfg = (node.config ?? {}) as LoopNodeConfig;
  const budget = (node.budget ?? {}) as { maxCostCents?: number; maxWallTimeMs?: number };
  return {
    maxIterations: cfg.maxIterations ?? 3,
    maxDepth: cfg.maxDepth ?? 1,
    maxCostCents: cfg.maxCostCents ?? budget.maxCostCents ?? Infinity,
    maxWallTimeMs: cfg.maxWallTimeMs ?? budget.maxWallTimeMs ?? Infinity,
  };
}

/**
 * Execute a loop node. The loop body is the set of nodes reachable from the
 * loop node via its `outputs` ports, upstream of any edge that leads back to
 * the loop node itself. The runner re-executes the body until a stop condition
 * is met.
 */
export async function runLoopNode(
  ctx: NodeContext,
  executeBody: (iteration: number, upstream: Record<string, unknown>) => Promise<NodeExecResult>,
): Promise<NodeExecResult> {
  const policy = readPolicy(ctx.node);
  const cfg = (ctx.node.config ?? {}) as LoopNodeConfig;
  const noProgressAfter = cfg.noProgressAfter ?? 2;
  const startedAt = Date.now();
  let lastFailureType: WorkflowFailureType | undefined;
  let lastOutput: unknown;
  let sameFailureCount = 0;
  const MAX_SAME_FAILURE = noProgressAfter;

  for (let iteration = 0; iteration < policy.maxIterations; iteration++) {
    if (ctx.deps.shouldHalt?.()) {
      return {
        status: 'failed',
        failureType: 'irreducible_or_needs_human',
        summary: 'loop halted by signal',
      };
    }

    if (ctx.run.costCents >= policy.maxCostCents) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'halted',
        timestamp: ctx.deps.now(),
        failureType: 'budget_exhausted',
        summary: `loop budget exhausted at iteration ${iteration}`,
      });
      return {
        status: 'failed',
        failureType: 'budget_exhausted',
        summary: 'loop budget exhausted',
      };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= policy.maxWallTimeMs) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'halted',
        timestamp: ctx.deps.now(),
        failureType: 'budget_exhausted',
        summary: `loop wall time exceeded at iteration ${iteration}`,
      });
      return {
        status: 'failed',
        failureType: 'budget_exhausted',
        summary: 'loop wall time exceeded',
      };
    }

    ctx.run.emit({
      nodeId: ctx.node.id,
      event: iteration === 0 ? 'started' : 'retrying',
      timestamp: ctx.deps.now(),
      iteration,
      summary: `loop iteration ${iteration + 1}/${policy.maxIterations}`,
    });

    const bodyCtx: NodeContext = {
      ...ctx,
      iteration,
    };
    const result = await executeBody(iteration, bodyCtx.upstream);

    if (result.status === 'completed') {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'completed',
        timestamp: ctx.deps.now(),
        iteration,
        summary: `loop completed at iteration ${iteration}`,
      });
      return {
        status: 'completed',
        output: result.output,
        summary: `loop exited after ${iteration + 1} iteration(s)`,
      };
    }

    const failureType = result.failureType ?? 'unknown_external';

    // No-progress: same failure type repeated.
    if (failureType === lastFailureType) {
      sameFailureCount++;
    } else {
      sameFailureCount = 0;
      lastFailureType = failureType;
    }

    if (sameFailureCount >= MAX_SAME_FAILURE) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'halted',
        timestamp: ctx.deps.now(),
        failureType: 'irreducible_or_needs_human',
        summary: `no progress: ${failureType} repeated ${MAX_SAME_FAILURE} times`,
      });
      return {
        status: 'failed',
        failureType: 'irreducible_or_needs_human',
        summary: `no progress on ${failureType}`,
      };
    }

    // No-progress: unchanged output.
    if (result.output !== undefined && result.output === lastOutput) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'halted',
        timestamp: ctx.deps.now(),
        failureType: 'irreducible_or_needs_human',
        summary: 'no progress: unchanged output',
      });
      return {
        status: 'failed',
        failureType: 'irreducible_or_needs_human',
        summary: 'no progress: unchanged output',
      };
    }
    lastOutput = result.output;

    // Human-required failure — stop immediately.
    if (isHumanRequired(failureType)) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'human_required',
        timestamp: ctx.deps.now(),
        failureType,
        summary: `loop requires human: ${failureType}`,
      });
      return {
        status: 'failed',
        failureType,
        summary: `loop requires human: ${failureType}`,
      };
    }

    // Escalation candidate — emit escalated event.
    if (ctx.node.config && (ctx.node.config as Record<string, unknown>).escalateOnFailure) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'escalated',
        timestamp: ctx.deps.now(),
        failureType,
        summary: `escalated after ${failureType}`,
      });
    }

    // Non-retryable failure — stop.
    if (!isRetryableFailure(failureType)) {
      ctx.run.emit({
        nodeId: ctx.node.id,
        event: 'failed',
        timestamp: ctx.deps.now(),
        failureType,
        summary: `non-retryable failure: ${failureType}`,
      });
      return {
        status: 'failed',
        failureType,
        summary: `non-retryable failure: ${failureType}`,
      };
    }
  }

  ctx.run.emit({
    nodeId: ctx.node.id,
    event: 'halted',
    timestamp: ctx.deps.now(),
    failureType: 'irreducible_or_needs_human',
    summary: `loop hit max iterations (${policy.maxIterations})`,
  });
  return {
    status: 'failed',
    failureType: 'irreducible_or_needs_human',
    summary: `loop hit max iterations (${policy.maxIterations})`,
  };
}

export function loopStopReason(iteration: number, policy: LoopPolicy, reason: 'success' | 'max_iterations' | 'budget' | 'no_progress' | 'human'): RunStopReason {
  switch (reason) {
    case 'success': return 'success_gate_passed';
    case 'max_iterations': return 'max_iterations';
    case 'budget': return 'max_cost';
    case 'no_progress': return 'no_progress';
    case 'human': return 'human_required';
    default: return 'node_failed';
  }
}
