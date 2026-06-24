/**
 * health.ts — a single, fast, side-effect-free snapshot of Intelligence-Layer
 * health: embedding provider (configured + resolved + live reachability), vector
 * index (chunk count, model/dimension, freshness, commit drift, stale signal),
 * learning recency, and which session sources are enabled.
 *
 * This is the contract the provider picker, the dashboard health card, the
 * proactive nudges, and the activation probe all read from. It deliberately
 * imports NO `vscode` so it is unit-testable and reusable from the MCP/HTTP
 * surfaces. The only I/O is best-effort fs reads, cheap (~1.5s) liveness probes,
 * and an injectable git runner — nothing here writes or mutates state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { LogFn, loadConfig } from './config';
import { IntelligenceConfig } from './types';
import { intelligencePaths } from './paths';
import { resolveProjectKey } from './project';
import { readIndexHealth, IndexHealthSnapshot } from './ragCode';
import { readEmbeddingPin } from './embeddingResolve';
import { detectRouter, detectOllama } from './embeddings';
import { resolvePanelBackendStatus } from './installBackend';
import { gatherStorageStatus } from './storage';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Commit drift past this many changed files earns a "re-index" nudge. */
const DRIFT_FILES_NUDGE = 25;
/** An index older than this many days earns a freshness nudge. */
const STALE_AGE_DAYS = 14;
/** A learn run older than this many days earns a "learn" nudge. */
const LEARN_AGE_DAYS = 14;

/** Command ids the nudges' one-click actions map to (panel/command layer wires them). */
export const HEALTH_ACTIONS = {
  setProvider: 'autoclaw.intelligence.setEmbeddingProvider',
  indexCode: 'autoclaw.intelligence.indexCode',
  learn: 'autoclaw.intelligence.learn',
  installBackend: 'autoclaw.intelligence.installBackend',
  detectProvider: 'autoclaw.intelligence.detectEmbeddingProvider',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthStatus = 'green' | 'amber' | 'red';
export type NudgeSeverity = 'info' | 'warn' | 'error';

export interface HealthNudge {
  /** Stable id so a caller can dedupe one-shot toasts across a session. */
  id: string;
  severity: NudgeSeverity;
  title: string;
  detail: string;
  /** Optional one-click remediation. `command` is a VS Code command id. */
  action?: { command: string; label: string };
}

export interface ProviderHealth {
  /** What the config asks for (may be `auto`). */
  configured: string;
  /** The concrete provider in effect (from explicit config or the auto pin). */
  resolved?: string;
  model?: string;
  dimension?: number;
  /**
   * Live reachability of the resolved provider. `true`/`false` for network
   * providers (router/ollama), `true` for in-process providers (transformers/
   * none), `undefined` when probing was skipped or nothing is resolved yet.
   */
  reachable?: boolean;
  /** Human one-liner suitable for a status row. */
  detail: string;
}

export interface IndexHealth {
  backendInstalled: boolean;
  backendPath: string;
  dbSizeBytes: number;
  chunkCount?: number;
  storeModel?: string;
  storeDimension?: number;
  indexedAt?: string;
  commit?: string;
  /** Files changed between the indexed commit and current HEAD (best-effort). */
  driftFiles?: number;
  /** True when the store holds mixed-geometry vectors (model change / degrade). */
  stale: boolean;
  /** True when the configured embedding provider degraded to `none` mid-index. */
  embeddingDegraded: boolean;
  /** True when no index has ever been built for this project. */
  neverIndexed: boolean;
}

export interface LearnHealth {
  lastRunAt?: string;
}

export interface SharingHealth {
  /** Source-adapter ids currently enabled for learning. */
  enabledSources: string[];
}

export interface IntelligenceHealth {
  generatedAt: string;
  project: string;
  status: HealthStatus;
  provider: ProviderHealth;
  index: IndexHealth;
  learn: LearnHealth;
  sharing: SharingHealth;
  nudges: HealthNudge[];
}

export interface IntelligenceHealthOptions {
  /** Pre-loaded config (avoids a disk read). Loaded from disk when omitted. */
  config?: IntelligenceConfig;
  /** Run live provider liveness probes. Default true; pass false for a cheap render. */
  probe?: boolean;
  /** Explicit backend-dir override (the VS Code setting), forwarded to the resolver. */
  backendDirOverride?: string;
  /** Global-storage fallback dir for backend resolution (VS Code globalStorageUri). */
  globalStorageFallback?: string;
  /** Cross-project system dir, when configured. */
  systemDir?: string;
  /** Enabled source-adapter ids (from the registry); surfaced verbatim. */
  enabledSources?: string[];
  /** Injectable git runner (defaults to real `git`). Returns stdout or throws. */
  gitRunner?: (args: string, cwd: string) => string;
  log?: LogFn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultGitRunner(args: string, cwd: string): string {
  // Bounded: this runs on the status-bar/panel refresh path (billed ~1.5s). A
  // hung or slow git (held index.lock, networked FS, huge diff) must DEGRADE the
  // driftFiles field via tryGit's catch, not block the health snapshot.
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function tryGit(run: (a: string, c: string) => string, args: string, cwd: string): string | null {
  try {
    return run(args, cwd).trim();
  } catch {
    return null;
  }
}

function daysSince(iso: string | undefined): number | undefined {
  if (!iso) {
    return undefined;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

/** Newest `insight-*.md` mtime in the learnings dir → last learn-run time. */
function lastLearnRunAt(learningsDir: string): string | undefined {
  try {
    const entries = fs.readdirSync(learningsDir).filter((f) => f.startsWith('insight-'));
    let newest = 0;
    for (const f of entries) {
      const st = fs.statSync(path.join(learningsDir, f));
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
      }
    }
    return newest > 0 ? new Date(newest).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** Probe the resolved provider's liveness. In-process providers are always "up". */
async function probeProvider(
  resolved: string | undefined,
  cfg: IntelligenceConfig,
  pinRouterHost?: string,
  pinOllamaHost?: string,
): Promise<boolean | undefined> {
  switch (resolved) {
    case 'router':
      return detectRouter(cfg.embedding.routerHost ?? pinRouterHost);
    case 'ollama':
      return detectOllama(cfg.embedding.ollamaHost ?? pinOllamaHost);
    case 'transformers':
    case 'none':
      return true; // in-process — no service to reach
    default:
      return undefined; // unresolved `auto` — nothing to probe yet
  }
}

function describeProvider(p: {
  configured: string;
  resolved?: string;
  model?: string;
  dimension?: number;
  reachable?: boolean;
}): string {
  if (!p.resolved) {
    return `${p.configured} → not yet resolved (run a detect or index to pin a provider)`;
  }
  const id = `${p.resolved}${p.model ? ` (${p.model}${p.dimension ? `, ${p.dimension}-dim` : ''})` : ''}`;
  const via = p.configured === 'auto' ? 'auto → ' : '';
  if (p.reachable === false) {
    return `${via}${id} — NOT reachable`;
  }
  if (p.resolved === 'none') {
    return `${via}${id} — basic keyword vectors, low retrieval quality`;
  }
  return `${via}${id}${p.reachable === true ? ' — reachable' : ''}`;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Build a single Intelligence-Layer health snapshot. Best-effort throughout:
 * any individual probe/read failure degrades that field rather than throwing.
 */
export async function getIntelligenceHealth(
  workspaceRoot: string,
  opts: IntelligenceHealthOptions = {},
): Promise<IntelligenceHealth> {
  const log: LogFn = opts.log ?? (() => undefined);
  const config = opts.config ?? loadConfig(workspaceRoot, log);
  const probe = opts.probe !== false;
  const project = resolveProjectKey(workspaceRoot);
  const paths = intelligencePaths(workspaceRoot);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;

  // --- Provider -----------------------------------------------------------
  const pin = readEmbeddingPin(workspaceRoot);
  const configured = config.embedding.provider;
  let resolved: string | undefined;
  let model: string | undefined;
  let dimension: number | undefined;
  if (configured !== 'auto') {
    resolved = configured;
    model = config.embedding.model;
    dimension = config.embedding.dimension;
  } else if (pin) {
    resolved = pin.provider;
    model = pin.model;
    dimension = pin.dimension;
  }
  let reachable: boolean | undefined;
  if (probe && resolved) {
    try {
      reachable = await probeProvider(resolved, config, pin?.routerHost, pin?.ollamaHost);
    } catch {
      reachable = undefined;
    }
  }
  const provider: ProviderHealth = {
    configured,
    resolved,
    model,
    dimension,
    reachable,
    detail: describeProvider({ configured, resolved, model, dimension, reachable }),
  };

  // --- Index --------------------------------------------------------------
  const backend = resolvePanelBackendStatus(
    workspaceRoot,
    opts.backendDirOverride,
    opts.globalStorageFallback,
  );
  const storage = gatherStorageStatus({
    workspaceRoot,
    contractRoot: paths.root,
    dbPath: paths.dbPath,
    lastIndexPath: paths.lastIndexPath,
    backendDir: backend.path,
    backendInstalled: backend.installed,
    systemDir: opts.systemDir,
  });
  const snap: IndexHealthSnapshot | undefined = readIndexHealth(paths.indexHealthPath, project);
  // "Never indexed" means NO snapshot — a successful index that produced zero
  // chunks (empty repo, or all files excluded by fileExtensions/ignoredDirs) has
  // a snapshot and must NOT nag as un-indexed forever.
  const neverIndexed = !snap;

  let driftFiles: number | undefined;
  const indexedCommit = snap?.commit ?? storage.index.commit;
  if (indexedCommit) {
    const diff = tryGit(gitRunner, `diff --name-only ${indexedCommit} HEAD`, workspaceRoot);
    if (diff !== null) {
      driftFiles = diff.split(/\r?\n/).filter((l) => l.trim() !== '').length;
    }
  }

  const index: IndexHealth = {
    backendInstalled: backend.installed,
    backendPath: backend.path,
    dbSizeBytes: storage.index.dbSizeBytes,
    chunkCount: snap?.chunkCount,
    storeModel: snap?.model,
    storeDimension: snap?.dimension,
    indexedAt: snap?.indexedAt ?? storage.index.indexedAt,
    commit: indexedCommit,
    driftFiles,
    stale: snap?.staleIndex ?? false,
    embeddingDegraded: snap?.embeddingDegraded ?? false,
    neverIndexed,
  };

  // --- Learn --------------------------------------------------------------
  const learn: LearnHealth = { lastRunAt: lastLearnRunAt(paths.learningsDir) };

  // --- Sharing ------------------------------------------------------------
  const sharing: SharingHealth = { enabledSources: opts.enabledSources ?? [] };

  // --- Nudges + rollup ----------------------------------------------------
  const nudges = buildNudges({ provider, index, learn, backend });
  const status: HealthStatus = nudges.some((n) => n.severity === 'error')
    ? 'red'
    : nudges.some((n) => n.severity === 'warn')
      ? 'amber'
      : 'green';

  return {
    generatedAt: new Date().toISOString(),
    project,
    status,
    provider,
    index,
    learn,
    sharing,
    nudges,
  };
}

function buildNudges(args: {
  provider: ProviderHealth;
  index: IndexHealth;
  learn: LearnHealth;
  backend: { installed: boolean };
}): HealthNudge[] {
  const { provider, index, learn, backend } = args;
  const nudges: HealthNudge[] = [];

  if (!backend.installed) {
    nudges.push({
      id: 'backend-missing',
      severity: 'warn',
      title: 'Vector backend not installed',
      detail:
        'Semantic search is in degraded (keyword-only) mode until the sqlite-vec backend is installed.',
      action: { command: HEALTH_ACTIONS.installBackend, label: 'Install backend' },
    });
  }

  if (provider.resolved && provider.resolved !== 'none' && provider.reachable === false) {
    nudges.push({
      id: 'provider-unreachable',
      severity: 'error',
      title: `Embedding provider "${provider.resolved}" is unreachable`,
      detail:
        'Indexing would fall back to low-quality vectors. Start the provider, or pick another so ' +
        'retrieval stays consistent.',
      action: { command: HEALTH_ACTIONS.setProvider, label: 'Set provider…' },
    });
  } else if (provider.resolved === 'none' || provider.configured === 'none') {
    nudges.push({
      id: 'provider-none',
      severity: 'warn',
      title: 'Using basic (keyword) embeddings',
      detail:
        'Retrieval quality is reduced. Set up Ollama, the Zippy Mesh router, or the offline ' +
        'provider for semantic search.',
      action: { command: HEALTH_ACTIONS.setProvider, label: 'Set provider…' },
    });
  } else if (!provider.resolved) {
    nudges.push({
      id: 'provider-unresolved',
      severity: 'info',
      title: 'Embedding provider not yet detected',
      detail: 'Run a detect (or index once) to pin the best available provider.',
      action: { command: HEALTH_ACTIONS.detectProvider, label: 'Detect provider' },
    });
  }

  if (index.stale || index.embeddingDegraded) {
    nudges.push({
      id: 'index-stale',
      severity: 'error',
      title: 'Index is stale (mixed embedding geometry)',
      detail:
        'The store holds vectors from more than one embedding model, so similarity scores are ' +
        'unreliable. Rebuild with a healthy provider to clear it.',
      action: { command: HEALTH_ACTIONS.indexCode, label: 'Full re-index' },
    });
  } else if (index.neverIndexed) {
    nudges.push({
      id: 'never-indexed',
      severity: 'warn',
      title: 'Codebase not indexed yet',
      detail: 'Index the codebase so agents can retrieve grounded context instead of guessing.',
      action: { command: HEALTH_ACTIONS.indexCode, label: 'Index codebase' },
    });
  } else {
    if ((index.driftFiles ?? 0) >= DRIFT_FILES_NUDGE) {
      nudges.push({
        id: 'index-drift',
        severity: 'info',
        title: `${index.driftFiles} files changed since last index`,
        detail: 'Re-index so retrieval reflects your current code.',
        action: { command: HEALTH_ACTIONS.indexCode, label: 'Re-index' },
      });
    }
    const ageDays = daysSince(index.indexedAt);
    if (ageDays !== undefined && ageDays >= STALE_AGE_DAYS) {
      nudges.push({
        id: 'index-age',
        severity: 'info',
        title: `Index is ${Math.floor(ageDays)} days old`,
        detail: 'A periodic re-index keeps retrieval grounded in current code.',
        action: { command: HEALTH_ACTIONS.indexCode, label: 'Re-index' },
      });
    }
  }

  const learnAge = daysSince(learn.lastRunAt);
  if (learn.lastRunAt === undefined) {
    nudges.push({
      id: 'learn-never',
      severity: 'info',
      title: 'No learning runs yet',
      detail:
        'Run learning to distill patterns, preferences, and coordination outcomes from past ' +
        'sessions into reusable context.',
      action: { command: HEALTH_ACTIONS.learn, label: 'Learn now' },
    });
  } else if (learnAge !== undefined && learnAge >= LEARN_AGE_DAYS) {
    nudges.push({
      id: 'learn-age',
      severity: 'info',
      title: `Last learning run was ${Math.floor(learnAge)} days ago`,
      detail: 'Re-run learning to fold recent sessions into the shared knowledge base.',
      action: { command: HEALTH_ACTIONS.learn, label: 'Learn now' },
    });
  }

  return nudges;
}
