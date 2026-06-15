/**
 * sourcesCommand.ts — HOST-FREE core for the `/sources` surface (R3.1, R3.2).
 *
 * Pure logic for listing, enabling, and disabling ingestion sources. The vscode
 * command/chat wrapper (the integrator's job) calls into this; this file MUST
 * stay free of `vscode` so it remains unit-testable under plain mocha.
 *
 *   - `listSources(opts)` → a row per registered source: id, tier, availability,
 *     locations, (optional) session count, and enabled-state (R3.1).
 *   - `setSourceEnabled(...)` → persist a consent decision to `config.sources`
 *     (R3.2) via {@link recordConsent}.
 *   - `pendingConsentSources(...)` → the available third-party sources awaiting
 *     first-run opt-in, for the consent prompt wrapper (R3.4).
 *   - `intelligenceSourcesReport(...)` → a plain-text block for the doctor
 *     source-coverage section (R3.3).
 *
 * No `vscode` import; no work at import time.
 */

import * as os from 'os';
import * as path from 'path';

import { LogFn, loadConfig } from './config';
import { resolveProjectKey } from './project';
import { toForwardSlash } from './paths';
import { AdapterEnv, ExtractOptions, IntelligenceConfig } from './types';
import {
  SourceRegistry,
  createDefaultRegistry,
} from './sources/registry';
import {
  ConsentDecision,
  ensureFirstRunConsent,
  isEnabled,
  recordConsent,
} from './sources/consent';
import { WatermarkStore } from './sources/watermark';

/** One row in the `/sources` listing (R3.1). */
export interface SourceRow {
  /** Source Adapter id. */
  id: string;
  /** Human tool name. */
  displayName: string;
  /** Adapter tier (1 native, 2 first-party transcript, 3 generic). */
  tier: 1 | 2 | 3;
  /** Whether the source was found available on this machine. */
  available: boolean;
  /** Concrete on-disk locations (forward-slash). */
  locations: string[];
  /** Whether the source is enabled (explicit toggle or default). */
  enabled: boolean;
  /** Best-effort session count (only when `countSessions` is requested). */
  sessionCount?: number;
  /** Availability/remediation hint. */
  hint?: string;
}

/** Options shared by the `/sources` operations. */
export interface SourcesContext {
  /** Directory that contains (or will contain) `.autoclaw`. */
  workspaceRoot: string;
  /** Source Adapter registry. Defaults to {@link createDefaultRegistry}. */
  registry?: SourceRegistry;
  /** Discovery/extraction environment. Defaults to the live process env. */
  env?: AdapterEnv;
  /** Pre-resolved config. Loaded from disk when omitted. */
  config?: IntelligenceConfig;
  /** Optional warning sink. */
  log?: LogFn;
}

/** Options for {@link listSources}. */
export interface ListSourcesOptions extends SourcesContext {
  /** Count sessions per available source (best-effort, can be slow). */
  countSessions?: boolean;
  /** Cap on counted sessions per source (default 500). */
  countCap?: number;
}

/** Build the default discovery/extraction env from the live process. */
export function defaultAdapterEnv(workspaceRoot: string): AdapterEnv {
  return {
    homeDir: os.homedir(),
    workspaceRoot: toForwardSlash(path.resolve(workspaceRoot)),
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
  };
}

function resolveContext(ctx: SourcesContext): {
  registry: SourceRegistry;
  env: AdapterEnv;
  config: IntelligenceConfig;
  project: string;
  log: LogFn;
} {
  const log: LogFn = ctx.log ?? (() => undefined);
  const registry = ctx.registry ?? createDefaultRegistry();
  const env = ctx.env ?? defaultAdapterEnv(ctx.workspaceRoot);
  const config = ctx.config ?? loadConfig(ctx.workspaceRoot, log);
  const project = resolveProjectKey(ctx.workspaceRoot);
  return { registry, env, config, project, log };
}

/**
 * List every registered source with tier, availability, location, enabled-state,
 * and (optionally) a best-effort session count (R3.1). Never throws — a failing
 * adapter degrades to an unavailable row.
 */
export async function listSources(opts: ListSourcesOptions): Promise<SourceRow[]> {
  const { registry, env, config, project, log } = resolveContext(opts);
  const discovered = await registry.discoverSources(env);
  const watermarks = new WatermarkStore(opts.workspaceRoot, log);
  const cap = typeof opts.countCap === 'number' && opts.countCap > 0 ? opts.countCap : 500;

  const rows: SourceRow[] = [];
  for (const { adapter, presence } of discovered) {
    const enabled = isEnabled(config, adapter.id);
    const row: SourceRow = {
      id: adapter.id,
      displayName: adapter.displayName,
      tier: adapter.tier,
      available: presence.available,
      locations: presence.locations,
      enabled,
      hint: presence.hint,
    };

    if (opts.countSessions && presence.available && enabled) {
      row.sessionCount = await countSessions(adapter, env, watermarks, project, cap, log);
    }
    rows.push(row);
  }
  return rows;
}

/** Best-effort session count for one adapter, isolated and capped. */
async function countSessions(
  adapter: { id: string; extract(opts: ExtractOptions): AsyncIterable<unknown> },
  env: AdapterEnv,
  watermarks: WatermarkStore,
  project: string,
  cap: number,
  log: LogFn,
): Promise<number> {
  const mark = watermarks.get(adapter.id, project);
  const extractOpts: ExtractOptions = {
    sinceTs: mark.lastTs,
    workspace: project ?? env.workspaceRoot,
    limit: cap,
  };
  let count = 0;
  try {
    for await (const _ of adapter.extract(extractOpts)) {
      count++;
      if (count >= cap) {
        break;
      }
    }
  } catch (err) {
    log(`sources: counting ${adapter.id} failed (${(err as Error).message})`);
  }
  return count;
}

/**
 * Enable or disable a source, persisting the decision to `config.sources`
 * (R3.2). Lock-protected via {@link recordConsent}; best-effort.
 */
export async function setSourceEnabled(
  workspaceRoot: string,
  sourceId: string,
  enabled: boolean,
  log?: LogFn,
): Promise<void> {
  await recordConsent(workspaceRoot, sourceId, enabled, log);
}

/**
 * The available third-party sources awaiting first-run opt-in (R3.4). Feeds the
 * consent prompt the command/UI layer presents before any third-party extract.
 */
export async function pendingConsentSources(ctx: SourcesContext): Promise<ConsentDecision> {
  const { registry, env, config } = resolveContext(ctx);
  const discovered = await registry.discoverSources(env);
  return ensureFirstRunConsent(
    discovered.map((d) => ({ id: d.adapter.id, available: d.presence.available })),
    config,
  );
}

/**
 * Render a plain-text source-coverage report for the doctor section (R3.3).
 * Pure formatting over {@link listSources} output.
 */
export function renderSourcesReport(rows: SourceRow[]): string {
  const lines: string[] = [];
  lines.push('Intelligence — Source Coverage');
  for (const r of rows) {
    const state = r.enabled ? 'enabled' : 'disabled';
    const avail = r.available ? 'available' : 'unavailable';
    const count = typeof r.sessionCount === 'number' ? `, ${r.sessionCount} session(s)` : '';
    const loc = r.locations.length ? ` @ ${r.locations[0]}` : '';
    lines.push(
      `  [tier ${r.tier}] ${r.displayName} (${r.id}): ${state}, ${avail}${count}${loc}` +
        (r.hint && !r.available ? ` — ${r.hint}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Convenience all-in-one for the doctor section: list (without counting, for
 * speed) and render. Never throws.
 */
export async function intelligenceSourcesReport(ctx: SourcesContext): Promise<string> {
  try {
    const rows = await listSources({ ...ctx, countSessions: false });
    return renderSourcesReport(rows);
  } catch (err) {
    return `Intelligence — Source Coverage\n  (unavailable: ${(err as Error).message})`;
  }
}
