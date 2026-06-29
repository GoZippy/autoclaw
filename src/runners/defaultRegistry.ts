/**
 * defaultRegistry.ts — build a RunnerRegistry with every built-in platform
 * runner registered.
 *
 * The per-platform runners existed but nothing wired them together into a
 * registry the extension could use. This is that wiring — the entry point the
 * fabric onboarding command (and future routing) calls. Detection is NOT run
 * here; call `registry.detect()` afterwards.
 */

import { RunnerRegistry } from './registry';
import { ClaudeCodeRunner } from './claude-code';
import { ClaudeDesktopRunner } from './claude-desktop';
import { CodexRunner } from './codex';
import { CursorRunner } from './cursor';
import { KiroRunner } from './kiro';
import { GeminiCliRunner } from './gemini-cli';
import { HermesRunner } from './hermes';
import { OpenClawRunner } from './openclaw';
import { AutoGptRunner } from './autogpt';
import { loopServiceRunnersFromConfig } from './loop-service-adapter';

export interface DefaultRegistryOptions {
  /** Reserved for future per-runner config. */
  workingDir?: string;
  /**
   * The deserialized `loop_services[]` value from the AutoClaw config (e.g.
   * the array parsed from `.autoclaw/config.yaml`). When provided, each
   * well-formed entry is built into a {@link LoopServiceAdapter} and
   * registered alongside the built-in runners. Absent or empty ⇒ no-op.
   */
  loopServices?: unknown;
}

/** The ids of every built-in platform runner, for menus + onboarding. */
export const BUILTIN_RUNNER_IDS = [
  'claude-code', 'claude-desktop', 'codex', 'cursor', 'kiro',
  'gemini-cli', 'hermes', 'openclaw', 'autogpt',
] as const;

export function createDefaultRunnerRegistry(opts: DefaultRegistryOptions = {}): RunnerRegistry {
  const reg = new RunnerRegistry();
  reg.register(new ClaudeCodeRunner());
  reg.register(new ClaudeDesktopRunner());
  reg.register(new CodexRunner());
  reg.register(new CursorRunner());
  reg.register(new KiroRunner());
  reg.register(new GeminiCliRunner());
  reg.register(new HermesRunner());
  reg.register(new OpenClawRunner());
  reg.register(new AutoGptRunner());
  for (const runner of loopServiceRunnersFromConfig(opts.loopServices)) {
    reg.register(runner);
  }
  return reg;
}
