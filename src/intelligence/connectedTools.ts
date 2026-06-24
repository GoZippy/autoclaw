/**
 * connectedTools.ts — cross-tool ingestion detection + the recall-surface
 * descriptor, both as PURE, vscode-free logic (Theme 5).
 *
 * Two jobs, no I/O of its own and no `vscode` import (mirrors the rest of the
 * `src/intelligence/` tree so it is unit-testable outside the extension host):
 *
 *  1. Detect when ANOTHER AI tool's sessions are present on disk and decide
 *     which detected-but-not-yet-enabled tools are candidates to AUTO-ENABLE
 *     ("learn from them"). The vscode-side prompt + config persistence that acts
 *     on {@link IngestionSuggestion} is wired by a later integration step — this
 *     module is only the testable core.
 *
 *  2. Describe — for the panel / docs — the real recall surfaces through which
 *     OTHER tools pull AutoClaw's shared project context.
 *
 * Detection runs each adapter's {@link SourceAdapter.discover} and reads
 * {@link SourcePresence.available} as the "sessions found on disk" signal (the
 * presence shape exposes no dedicated count, so `locations.length` is used as a
 * best-effort `sessionHint`). Detection is BEST-EFFORT: a `discover()` that
 * throws is treated as `present: false` and never propagates out.
 */

import { AdapterEnv, SourceAdapter } from './types';

// ---------------------------------------------------------------------------
// Ingestion detection
// ---------------------------------------------------------------------------

/** One tool we probed for on this machine, normalized for the decision below. */
export interface DetectedTool {
  /** Adapter id (e.g. `cursor`, `claude-code`). */
  id: string;
  displayName: string;
  tier: 1 | 2 | 3;
  /** Sessions found on disk (`SourcePresence.available`). */
  present: boolean;
  /** Currently enabled in the persisted intelligence config. */
  enabled: boolean;
  /** Best-effort session count if the presence exposed one. */
  sessionHint?: number;
}

export interface IngestionSuggestion {
  /** Tools that are present on disk but NOT yet enabled — candidates to auto-enable. */
  toEnable: DetectedTool[];
  /** All detected tools, for display. */
  all: DetectedTool[];
}

/**
 * Pure decision: which detected tools should we offer to start learning from?
 * A tool is a candidate exactly when its sessions are present on disk and it is
 * not already enabled. Simple and obvious by design — the caller owns prompting
 * and persistence.
 */
export function decideIngestion(detected: DetectedTool[]): IngestionSuggestion {
  return {
    toEnable: detected.filter((t) => t.present && !t.enabled),
    all: detected,
  };
}

/** Subset of a {@link SourceAdapter} the detector needs to probe + label a tool. */
type DetectableAdapter = Pick<SourceAdapter, 'id' | 'displayName' | 'tier' | 'discover'>;

/**
 * Probe each adapter's `discover()` and map the result to a {@link DetectedTool}.
 * Best-effort and isolated: a `discover()` that rejects (or otherwise throws)
 * yields `present: false` for that tool and never aborts the whole detection.
 */
export async function detectConnectedTools(args: {
  adapters: DetectableAdapter[];
  enabledIds: string[];
  env: AdapterEnv;
}): Promise<DetectedTool[]> {
  const { adapters, enabledIds, env } = args;
  const enabled = new Set(enabledIds);

  const settled = await Promise.allSettled(adapters.map((a) => a.discover(env)));

  return adapters.map((adapter, i) => {
    const r = settled[i];
    const base: DetectedTool = {
      id: adapter.id,
      displayName: adapter.displayName,
      tier: adapter.tier,
      present: false,
      enabled: enabled.has(adapter.id),
    };
    if (r.status !== 'fulfilled') {
      // Best-effort: a discover() that threw is simply "not present".
      return base;
    }
    const presence = r.value;
    base.present = presence.available === true;
    const count = Array.isArray(presence.locations) ? presence.locations.length : 0;
    if (count > 0) {
      base.sessionHint = count;
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Recall surfaces
// ---------------------------------------------------------------------------

/** One channel through which another tool can pull AutoClaw's shared context. */
export interface RecallSurface {
  kind: 'mcp' | 'http' | 'file';
  name: string;
  detail: string;
}

/**
 * The real, existing surfaces through which OTHER tools recall AutoClaw's shared
 * project context — for the panel / docs to display. These mirror the live
 * delivery channels (MCP tools + the bridge HTTP route) and the ambient
 * host-context digests written into each detected host's rules/steering dir.
 *
 * OpenClaw / Hermes / Codex / CoWork and other custom agents are NOT given their
 * own adapters here: they either map onto an existing source adapter or pull
 * context through one of these surfaces via the acp/1 generic connector.
 */
export function recallSurfaces(): RecallSurface[] {
  return [
    {
      kind: 'mcp',
      name: 'intelligence.contextPack',
      detail:
        'MCP tool — builds a grounded context pack (RAG code + patterns/learnings + style + memory + KG facts) for a task; read-only.',
    },
    {
      kind: 'mcp',
      name: 'intelligence.retrieve',
      detail:
        'MCP tool — semantic code retrieval over this project’s Intelligence index; read-only, degrades to empty.',
    },
    {
      kind: 'http',
      name: 'GET /api/v1/intelligence/context',
      detail:
        'Bridge HTTP route — bearer-gated context pack for cross-machine / HTTP-only peers (Hermes, OpenClaw).',
    },
    {
      kind: 'file',
      name: 'host-context digests',
      detail:
        'Auto-written project-context digest in each detected host rules dir (.cursor/rules, .kiro/steering, .windsurf/rules, .continue/prompts, .clinerules, .agent/rules).',
    },
  ];
}
