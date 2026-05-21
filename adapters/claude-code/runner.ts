/**
 * Adapter entry point — registers the Claude Code runner.
 *
 * This is the thin shim the orchestrator (or an adapter loader) calls to
 * make the `claude-code` runner available in a {@link RunnerRegistry}.
 * All behavior lives in `src/runners/claude-code.ts`; this file only wires
 * the runner into a registry.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.1
 */

import {
  ClaudeCodeRunner,
  RunnerRegistry,
  type ClaudeHeadlessTransport,
  type Runner,
} from '../../src/runners';

/**
 * Construct a Claude Code runner instance.
 *
 * @param transport - optional transport override (SDK-backed or a mock);
 *                     defaults to the CLI-backed headless transport.
 * @returns a fresh {@link ClaudeCodeRunner}.
 */
export function createClaudeCodeRunner(transport?: ClaudeHeadlessTransport): Runner {
  return transport ? new ClaudeCodeRunner(transport) : new ClaudeCodeRunner();
}

/**
 * Register the Claude Code runner with a {@link RunnerRegistry}.
 *
 * Detection is intentionally left to the caller: the registry runs
 * `detect()` for every registered runner via {@link RunnerRegistry.detect}.
 *
 * @param registry  - the registry to register into.
 * @param transport - optional transport override.
 * @returns the registered runner instance.
 */
export function registerClaudeCodeRunner(
  registry: RunnerRegistry,
  transport?: ClaudeHeadlessTransport,
): Runner {
  const runner = createClaudeCodeRunner(transport);
  registry.register(runner);
  return runner;
}

/** Stable id of the runner this adapter registers. */
export const CLAUDE_CODE_RUNNER_ID = 'claude-code';

export default registerClaudeCodeRunner;
