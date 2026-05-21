/**
 * register.ts — Extension-wiring stub for the `/dream` + `/recall` skills.
 *
 * WA-1 must NOT modify `src/extension.ts` (a concurrent session owns it).
 * Instead, the extension should — when it is ready to wire C2/C3/C4 — import
 * and call {@link registerMemorySkills} from its `activate()` function.
 *
 * The function is intentionally pure-ish and `vscode`-free: it takes the
 * minimal host surface it needs (a command registrar) so this module stays
 * unit-testable and decoupled from the VS Code API.
 *
 * Sprint 3 Workstream C — tasks C2/C3/C4.
 */

import { runDreamPipeline, type DreamInput, type DreamResult } from './pipeline';
import {
  recallQuery,
  recallAsOf,
  recallTimeline,
  type RecallOptions,
  type TimeTravelQuery,
} from '../recall/query';
import type { BitemporalFact } from '../../memory/bitemporalFact';

/**
 * Minimal host contract — a subset of `vscode.commands.registerCommand`.
 * The extension passes a thin adapter; tests pass a recording fake.
 */
export interface CommandRegistrar {
  register(commandId: string, handler: (...args: unknown[]) => unknown): void;
}

/** Disposable-ish handle returned so the caller can track registrations. */
export interface MemorySkillRegistration {
  /** Command ids that were registered. */
  commandIds: string[];
}

/**
 * Register the `/dream` and `/recall` skill commands against a host.
 *
 * TODO(extension-session): call this from `src/extension.ts` `activate()`,
 * passing a `CommandRegistrar` backed by `vscode.commands.registerCommand`,
 * and feed the handlers real workspace data (transcripts, fact store loaded
 * from `.autoclaw/memory/`, and a code index). Until then this is a
 * no-side-effect wiring helper that the extension can adopt without WA-1
 * touching `extension.ts`.
 */
export function registerMemorySkills(
  registrar: CommandRegistrar,
): MemorySkillRegistration {
  const commandIds = ['autoclaw.dream', 'autoclaw.recall'];

  registrar.register('autoclaw.dream', (input?: unknown): DreamResult =>
    runDreamPipeline(input as DreamInput),
  );

  registrar.register('autoclaw.recall', (facts?: unknown, query?: unknown, opts?: unknown) =>
    recallQuery((facts as BitemporalFact[]) ?? [], String(query ?? ''), (opts as RecallOptions) ?? {}),
  );

  return { commandIds };
}

/** Re-exported helpers so the extension can build richer handlers if needed. */
export { recallAsOf, recallTimeline };
export type { TimeTravelQuery };
