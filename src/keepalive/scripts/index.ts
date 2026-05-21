/**
 * scripts/index.ts — Registry of per-IDE computer-use scripts.
 *
 * The `computer_use` strategy resolves a script by its id (the
 * `playwright_script` field on `scope.json`) through {@link resolveScript}.
 * New IDEs are added by creating a `<ide>-chat-submit.ts` file and registering
 * it here.
 */

import type { IdeComputerUseScript } from './types';
import { kilocodeChatSubmit } from './kilocode-chat-submit';
import { cursorChatSubmit } from './cursor-chat-submit';

/** Every shipped computer-use script, keyed by id. */
const SCRIPTS: Readonly<Record<string, IdeComputerUseScript>> = {
  [kilocodeChatSubmit.id]: kilocodeChatSubmit,
  [cursorChatSubmit.id]: cursorChatSubmit,
};

/** Resolve a computer-use script by id, or `null` when none is registered. */
export function resolveScript(id: string | undefined): IdeComputerUseScript | null {
  if (!id) { return null; }
  return SCRIPTS[id] ?? null;
}

/** List the ids of every registered computer-use script. */
export function listScriptIds(): string[] {
  return Object.keys(SCRIPTS);
}

export type { IdeComputerUseScript, ComputerUseStep } from './types';
