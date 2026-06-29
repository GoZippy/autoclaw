/**
 * toolNode.ts — Tool node executor for the WL-1 headless runner.
 *
 * A tool node runs a deterministic action: a mock action (for tests/fixtures),
 * a shell command, a test command, or — later — an MCP/adapter/structured
 * action. Execution is mockable: real shell-outs only happen when an explicit
 * CommandRunner is supplied via RunnerDeps (WL-1 requirement 6, safe-by-default).
 *
 * This file deliberately defines ONLY the tool seam. The gate semantics
 * (pass/fail mapping to the failure taxonomy) live in gateNode.ts; the model
 * routing seam lives in modelNode.ts.
 */

import type {
  NodeContext,
  NodeExecResult,
  WorkflowFailureType,
} from '../state';

export type ToolNodeKind = 'mock' | 'shell' | 'test' | 'mcp' | 'action';

export interface ToolNodeConfig {
  [key: string]: unknown;
  kind?: ToolNodeKind;
  /** Shell/test command for kind 'shell' | 'test'. */
  command?: string;
  /** Working directory for the command (defaults to workspaceRoot). */
  cwd?: string;
  /** Per-node timeout; maps a timeout to budget_exhausted. */
  timeoutSeconds?: number;
  /** For kind 'mock': the output to emit. */
  mockOutput?: unknown;
  /** For kind 'mock': simulate a failure with this taxonomy type. */
  mockFailure?: WorkflowFailureType;
  /** For kind 'mock'/'shell'/'test': exit code a stub should report. */
  mockExitCode?: number;
}

/**
 * Execute a tool node. Returns a typed NodeExecResult; never throws for an
 * expected tool failure (those become `status:'failed'` with a failureType).
 */
export async function runToolNode(ctx: NodeContext): Promise<NodeExecResult> {
  const cfg = (ctx.node.config ?? {}) as ToolNodeConfig;
  const kind: ToolNodeKind = cfg.kind ?? 'mock';

  if (kind === 'mock') {
    if (cfg.mockFailure) {
      return {
        status: 'failed',
        failureType: cfg.mockFailure,
        summary: `mock tool node failed (${cfg.mockFailure})`,
      };
    }
    return {
      status: 'completed',
      output: cfg.mockOutput ?? { ok: true, kind: 'mock' },
      costCents: 0,
      summary: 'mock tool node completed',
    };
  }

  // shell / test / mcp / action all route through the injectable CommandRunner.
  if (!cfg.command) {
    return {
      status: 'failed',
      failureType: 'tool_format_invalid',
      summary: `tool node kind '${kind}' requires a 'command'`,
    };
  }

  const result = await ctx.deps.commandRunner(cfg.command, {
    cwd: cfg.cwd ?? ctx.deps.workspaceRoot,
    timeoutSeconds: cfg.timeoutSeconds ?? ctx.node.timeoutSeconds,
  });

  if (result.timedOut) {
    return {
      status: 'failed',
      failureType: 'budget_exhausted',
      summary: `tool command timed out after ${result.durationMs}ms`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      failureType: kind === 'test' ? 'test_failure' : 'tool_action_illegal',
      output: { exitCode: result.exitCode },
      summary: `tool command exited ${result.exitCode}`,
    };
  }

  return {
    status: 'completed',
    output: { exitCode: 0, stdout: result.stdout },
    costCents: 0,
    summary: `tool command succeeded in ${result.durationMs}ms`,
  };
}
