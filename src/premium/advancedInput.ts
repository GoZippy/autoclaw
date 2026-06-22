// ZIPPY OPEN MATERIAL
//
// Host-free helper that builds the AdvancedOrchestrationInput for the
// `autoclaw.orchestrate.advancedPlan` command from a dependency-free JSON
// descriptor (the extension intentionally does not parse manifest YAML in code —
// see orchestrate.ts; YAML parsing is delegated to the AI). Agents may be omitted
// and merged from the orchestrator registry. Pure + testable; no `vscode`.

import type {
  AdvancedOrchestrationInput,
  AdvancedOrchestrationTask,
  AdvancedOrchestrationAgent,
} from './premiumApi';

/** Starter descriptor written when none exists, so the command is discoverable. */
export const ADVANCED_INPUT_TEMPLATE = JSON.stringify(
  {
    objective: 'balanced',
    tasks: [
      { id: 'T1', effort: 2, criticality: 'high', filePaths: ['src/a.ts'], requiredCapabilities: ['typescript'] },
      { id: 'T2', dependsOn: ['T1'], effort: 1, filePaths: ['src/b.ts'] },
    ],
    agents: [
      { id: 'claude-code', capabilities: ['typescript'], reputation: 0.9, maxParallel: 2 },
      { id: 'kilocode', capabilities: ['typescript'], reputation: 0.7, maxParallel: 1 },
    ],
  },
  null,
  2,
);

export type BuildAdvancedInputResult =
  | { ok: true; input: AdvancedOrchestrationInput }
  | { ok: false; reason: 'no_input' | 'no_tasks' | 'invalid_json' | 'no_agents'; template: string };

function asTasks(v: unknown): AdvancedOrchestrationTask[] {
  if (!Array.isArray(v)) { return []; }
  return v.filter((t): t is AdvancedOrchestrationTask =>
    !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string' && (t as { id: string }).id !== '');
}

function asAgents(v: unknown): AdvancedOrchestrationAgent[] {
  if (!Array.isArray(v)) { return []; }
  return v.filter((a): a is AdvancedOrchestrationAgent =>
    !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' && (a as { id: string }).id !== '');
}

/** Map orchestrator `registry.json` agents → AdvancedOrchestrationAgent[]. */
function agentsFromRegistry(registryJson: string | undefined): AdvancedOrchestrationAgent[] {
  if (!registryJson) { return []; }
  try {
    const reg = JSON.parse(registryJson.replace(/^﻿/, '')) as { agents?: Array<Record<string, unknown>> };
    if (!Array.isArray(reg.agents)) { return []; }
    return reg.agents
      .filter((a) => typeof a.id === 'string' && a.id !== '')
      .map((a) => ({
        id: a.id as string,
        capabilities: Array.isArray(a.capabilities) ? (a.capabilities as unknown[]).filter((c): c is string => typeof c === 'string') : [],
        reputation: typeof a.reputation === 'number' ? (a.reputation as number) : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Build the engine input from the `advanced-input.json` descriptor text, merging
 * agents from the registry when the descriptor omits them. Returns `ok:false`
 * with a starter `template` when there's nothing usable to plan.
 */
export function buildAdvancedInput(opts: {
  workspaceRoot: string;
  inputJson?: string;
  registryJson?: string;
}): BuildAdvancedInputResult {
  if (!opts.inputJson || opts.inputJson.trim() === '') {
    return { ok: false, reason: 'no_input', template: ADVANCED_INPUT_TEMPLATE };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(opts.inputJson.replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid_json', template: ADVANCED_INPUT_TEMPLATE };
  }

  const tasks = asTasks(parsed.tasks);
  if (tasks.length === 0) {
    return { ok: false, reason: 'no_tasks', template: ADVANCED_INPUT_TEMPLATE };
  }

  let agents = asAgents(parsed.agents);
  if (agents.length === 0) {
    agents = agentsFromRegistry(opts.registryJson);
  }
  if (agents.length === 0) {
    return { ok: false, reason: 'no_agents', template: ADVANCED_INPUT_TEMPLATE };
  }

  const objRaw = parsed.objective;
  const objective =
    objRaw === 'speed' || objRaw === 'cost' || objRaw === 'quality' || objRaw === 'balanced' ? objRaw : undefined;

  return { ok: true, input: { workspaceRoot: opts.workspaceRoot, tasks, agents, objective } };
}
