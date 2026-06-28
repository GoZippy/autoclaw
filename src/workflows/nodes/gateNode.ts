/**
 * gateNode.ts — Gate node adapter for the WL-1 headless runner (WL-1.3).
 *
 * A gate is a deterministic judge: schema, compile, test, acceptance, budget,
 * scope, mutation, or review. Tools judge agents (requirements §Product
 * Principles 4) — so a gate's verdict gates the downstream approve/artifact
 * path. Every gate maps its failure onto the shared failure taxonomy and
 * records command, exit code, duration, and pass/fail into the run event.
 *
 * Command-backed gates (compile/test/acceptance) run through the injectable
 * CommandRunner, so they are fully mockable and never shell out by default.
 */

import type {
  NodeContext,
  NodeExecResult,
  WorkflowFailureType,
} from '../state';

export type GateKind =
  | 'schema' | 'compile' | 'test' | 'acceptance'
  | 'budget' | 'scope' | 'mutation' | 'review';

export interface GateNodeConfig {
  [key: string]: unknown;
  kind?: GateKind;
  /** Command for compile/test/acceptance/mutation gates. */
  command?: string;
  cwd?: string;
  timeoutSeconds?: number;
  /** Expected exit code for command gates (default 0 = pass). */
  expectExitCode?: number;
  /** For 'budget': fail when run cost has already reached this ceiling. */
  budgetCents?: number;
  /** For 'schema': a simple required-keys check against the upstream output. */
  requiredKeys?: string[];
  /** For tests/fixtures: force a deterministic pass/fail without a command. */
  mockPass?: boolean;
}

/** The structured verdict a gate produces, surfaced to run events & ledger. */
export interface GateResult {
  kind: GateKind;
  passed: boolean;
  command?: string;
  exitCode?: number;
  durationMs: number;
  failureType?: WorkflowFailureType;
  detail?: string;
}

/** Map a failed command gate to the right taxonomy entry. */
function failureForGate(kind: GateKind, timedOut: boolean): WorkflowFailureType {
  if (timedOut) { return 'budget_exhausted'; }
  switch (kind) {
    case 'compile': return 'compile_error';
    case 'test': return 'test_failure';
    case 'acceptance': return 'acceptance_failure';
    case 'mutation': return 'mutation_survived';
    case 'schema': return 'artifact_invalid';
    case 'scope': return 'scope_conflict';
    case 'budget': return 'budget_exhausted';
    case 'review': return 'irreducible_or_needs_human';
    default: return 'unknown_external';
  }
}

/** Evaluate a gate node. Returns the verdict embedded in a NodeExecResult. */
export async function runGateNode(ctx: NodeContext): Promise<NodeExecResult> {
  const cfg = (ctx.node.config ?? {}) as GateNodeConfig;
  const kind: GateKind = cfg.kind ?? 'acceptance';

  const verdict = await evaluateGate(ctx, cfg, kind);

  if (verdict.passed) {
    return {
      status: 'completed',
      output: { gate: verdict },
      summary: `gate '${kind}' passed`,
    };
  }
  return {
    status: 'failed',
    failureType: verdict.failureType,
    output: { gate: verdict },
    summary: `gate '${kind}' failed (${verdict.failureType})`,
  };
}

async function evaluateGate(
  ctx: NodeContext,
  cfg: GateNodeConfig,
  kind: GateKind
): Promise<GateResult> {
  // Deterministic short-circuit for fixtures/tests.
  if (typeof cfg.mockPass === 'boolean') {
    return {
      kind,
      passed: cfg.mockPass,
      durationMs: 0,
      failureType: cfg.mockPass ? undefined : failureForGate(kind, false),
      detail: 'mock gate',
    };
  }

  // Budget gate: compare accumulated run cost against the ceiling. No command.
  if (kind === 'budget') {
    const ceiling = cfg.budgetCents ?? Infinity;
    const passed = ctx.run.costCents <= ceiling;
    return {
      kind,
      passed,
      durationMs: 0,
      failureType: passed ? undefined : 'budget_exhausted',
      detail: `cost ${ctx.run.costCents}¢ vs ceiling ${ceiling}¢`,
    };
  }

  // Schema gate: required-keys check on the nearest upstream output object.
  if (kind === 'schema') {
    const required = cfg.requiredKeys ?? [];
    const candidate = nearestUpstreamObject(ctx);
    const missing = required.filter(k => !(candidate && k in candidate));
    const passed = missing.length === 0;
    return {
      kind,
      passed,
      durationMs: 0,
      failureType: passed ? undefined : 'artifact_invalid',
      detail: passed ? 'all required keys present' : `missing keys: ${missing.join(', ')}`,
    };
  }

  // Command-backed gates: compile / test / acceptance / mutation / scope / review.
  if (!cfg.command) {
    // No command and no mock — a review/scope gate with no evidence cannot pass.
    return {
      kind,
      passed: false,
      durationMs: 0,
      failureType: kind === 'review' ? 'irreducible_or_needs_human' : 'artifact_invalid',
      detail: `gate '${kind}' has no command and no mock verdict`,
    };
  }

  const res = await ctx.deps.commandRunner(cfg.command, {
    cwd: cfg.cwd ?? ctx.deps.workspaceRoot,
    timeoutSeconds: cfg.timeoutSeconds ?? ctx.node.timeoutSeconds,
  });
  const expect = cfg.expectExitCode ?? 0;
  const passed = !res.timedOut && res.exitCode === expect;
  return {
    kind,
    passed,
    command: cfg.command,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    failureType: passed ? undefined : failureForGate(kind, !!res.timedOut),
    detail: res.timedOut ? 'command timed out' : `exit ${res.exitCode} (expected ${expect})`,
  };
}

/** Find the most recent upstream output that is a plain object. */
function nearestUpstreamObject(ctx: NodeContext): Record<string, unknown> | null {
  const vals = Object.values(ctx.upstream);
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}
