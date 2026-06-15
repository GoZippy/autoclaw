/**
 * sources/registry.ts — Source Adapter framework for the Intelligence Layer.
 *
 * Owns the discovery + collection round-trip described by the core-loop design
 * (R1.1-R1.7, R5.5 / D12):
 *   - `SourceRegistry.registerAdapter` adds a {@link SourceAdapter}.
 *   - `discoverSources(env)` probes every registered adapter CONCURRENTLY
 *     (`Promise.allSettled`) with per-adapter error isolation and returns each
 *     adapter alongside its {@link SourcePresence}.
 *   - `collectSessions(opts)` runs every ENABLED adapter concurrently, isolates
 *     per-adapter failures (one adapter throwing never aborts the run — R1.5),
 *     tags each session with the resolved project (R1.6), and applies
 *     cross-source dedup that MERGES duplicates and raises kept-code confidence
 *     when independent sources agree rather than double-counting (R5.5 / D12).
 *   - `resolveEnabledSources` applies the enablement defaults (D13): the Tier-1
 *     AutoClaw-native adapter defaults ON, third-party adapters default OFF.
 *
 * No `vscode` import; no I/O at module load. Adapters degrade gracefully — a
 * missing source NEVER throws, it surfaces an "unavailable" presence + hint.
 */

import * as crypto from 'crypto';

import { LogFn } from '../config';
import { resolveProjectKey } from '../project';
import {
  AdapterEnv,
  ExtractOptions,
  KeptCode,
  SessionOutcome,
  SessionSignals,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { createAutoclawNativeAdapter } from './autoclawNative';
import { createCursorAdapter } from './cursor';
import { createGenericAdapter } from './generic';
import { createClaudeCodeAdapter } from './claudeCode';
import { createClaudeDesktopAdapter } from './claudeDesktop';
import { createKiroAdapter } from './kiro';
import { createGeminiAdapter } from './gemini';

// ---------------------------------------------------------------------------
// Enablement defaults (D13)
// ---------------------------------------------------------------------------

/** Adapter id → default-enabled flag. Tier-1 native on; third-party off. */
export const DEFAULT_SOURCE_ENABLED: Readonly<Record<string, boolean>> = {
  'autoclaw-native': true,
  cursor: false,
  generic: false,
  'claude-code': false,
  'claude-desktop': false,
  kiro: false,
  gemini: false,
};

/**
 * Given the persisted `config.sources` map and the set of known adapter ids,
 * return the ids that should run. An explicit `{ enabled }` toggle always wins;
 * otherwise the {@link DEFAULT_SOURCE_ENABLED} default applies (unknown ids
 * default OFF). (R1.7 / D13)
 */
export function resolveEnabledSources(
  sources: Record<string, { enabled: boolean }> | undefined,
  knownIds: string[],
): string[] {
  const enabled: string[] = [];
  for (const id of knownIds) {
    const toggle = sources ? sources[id] : undefined;
    if (toggle && typeof toggle.enabled === 'boolean') {
      if (toggle.enabled) {
        enabled.push(id);
      }
      continue;
    }
    if (DEFAULT_SOURCE_ENABLED[id] === true) {
      enabled.push(id);
    }
  }
  return enabled;
}

// ---------------------------------------------------------------------------
// collectSessions options
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** Cap on the number of (most-recent) sessions returned. */
  last?: number;
  /** Adapter ids to run (see {@link resolveEnabledSources}). */
  enabledIds: string[];
  /** Discovery/extraction environment. */
  env: AdapterEnv;
  /** Resolved project key to tag sessions with. Falls back to
   *  `resolveProjectKey(env.workspaceRoot)` when omitted. */
  project?: string;
  /** Only collect sessions newer than this epoch-ms watermark. */
  sinceTs?: number;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
}

/** A discovered adapter paired with the result of probing for it. */
export interface DiscoveredSource {
  adapter: SourceAdapter;
  presence: SourcePresence;
}

// ---------------------------------------------------------------------------
// Dedup tuning (R5.5 / D12)
// ---------------------------------------------------------------------------

/** Sessions whose content hash + project match within the same time bucket are
 *  treated as the same conversation observed by multiple sources. */
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function noisyOr(a: number, b: number): number {
  const x = clamp01(a);
  const y = clamp01(b);
  return clamp01(1 - (1 - x) * (1 - y));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

/** Content-hash + time-bucket + project dedup key. */
function dedupKey(session: UnifiedSession): string {
  const text = normalizeText(session.messages.map((m) => m.text).join('\n'));
  const hash = sha1(text);
  const bucket = Math.floor((session.startedAt || 0) / DEDUP_WINDOW_MS);
  return `${session.project ?? ''}::${bucket}::${hash}`;
}

function outcomeRank(o: SessionOutcome | undefined): number {
  switch (o) {
    case 'shipped':
      return 2;
    case 'discarded':
      return 1;
    default:
      return 0;
  }
}

function mergeKeptCode(a: KeptCode[], b: KeptCode[]): KeptCode[] {
  const map = new Map<string, KeptCode>();
  for (const k of a) {
    map.set(normalizeText(k.code), { ...k });
  }
  for (const k of b) {
    const key = normalizeText(k.code);
    const existing = map.get(key);
    if (existing) {
      // Independent sources agree on this kept code — raise confidence
      // (noisy-OR) rather than double-counting it as two separate signals.
      existing.confidence = noisyOr(existing.confidence, k.confidence);
    } else {
      map.set(key, { ...k });
    }
  }
  return Array.from(map.values());
}

function mergeSignals(a: SessionSignals, b: SessionSignals): SessionSignals {
  const merged: SessionSignals = {
    keptCode: mergeKeptCode(a.keptCode ?? [], b.keptCode ?? []),
  };
  if (a.gitKept || b.gitKept) {
    merged.gitKept = true;
  }
  merged.gitKeptCommit = a.gitKeptCommit ?? b.gitKeptCommit;
  merged.tokenUsage = a.tokenUsage ?? b.tokenUsage;
  const outcome = outcomeRank(a.outcome) >= outcomeRank(b.outcome) ? a.outcome : b.outcome;
  if (outcome) {
    merged.outcome = outcome;
  }
  return merged;
}

function mergeDuplicate(a: UnifiedSession, b: UnifiedSession): UnifiedSession {
  // Keep the richer transcript as the primary record.
  const primary = b.messages.length > a.messages.length ? b : a;
  const merged: UnifiedSession = { ...primary };
  merged.startedAt = Math.min(a.startedAt || 0, b.startedAt || 0);
  const ends = [a.endedAt, b.endedAt].filter((v): v is number => typeof v === 'number');
  merged.endedAt = ends.length ? Math.max(...ends) : merged.endedAt;
  merged.signals = mergeSignals(a.signals, b.signals);
  return merged;
}

/**
 * Cross-source dedup (R5.5 / D12): collapse sessions that share content hash +
 * project within the same time bucket into one record, raising kept-code
 * confidence where independent sources agree.
 */
export function dedupSessions(sessions: UnifiedSession[]): UnifiedSession[] {
  const map = new Map<string, UnifiedSession>();
  for (const s of sessions) {
    const key = dedupKey(s);
    const existing = map.get(key);
    map.set(key, existing ? mergeDuplicate(existing, s) : s);
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  /** Register (or replace) an adapter by id. */
  registerAdapter(adapter: SourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Look up a single adapter. */
  getAdapter(id: string): SourceAdapter | undefined {
    return this.adapters.get(id);
  }

  /** All registered adapters, registration order. */
  list(): SourceAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** All registered adapter ids. */
  ids(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Probe every registered adapter for presence on this machine. Runs
   * concurrently with per-adapter isolation — a discover() that throws yields
   * an `unavailable` presence rather than aborting the whole probe.
   */
  async discoverSources(env: AdapterEnv): Promise<DiscoveredSource[]> {
    const list = this.list();
    const settled = await Promise.allSettled(list.map((a) => a.discover(env)));
    return list.map((adapter, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        return { adapter, presence: r.value };
      }
      return {
        adapter,
        presence: {
          available: false,
          locations: [],
          hint: `discovery failed: ${(r.reason as Error)?.message ?? String(r.reason)}`,
        },
      };
    });
  }

  /**
   * Run every enabled adapter concurrently, isolate per-adapter failures,
   * tag sessions with the resolved project, and dedup across sources.
   */
  async collectSessions(opts: CollectOptions): Promise<UnifiedSession[]> {
    const warn: LogFn = opts.log ?? (() => undefined);

    const project =
      opts.project ??
      (opts.env.workspaceRoot ? resolveProjectKey(opts.env.workspaceRoot) : undefined);

    const extractOpts: ExtractOptions = {
      sinceTs: opts.sinceTs,
      workspace: project ?? opts.env.workspaceRoot,
      limit: opts.last,
    };

    const adapters = opts.enabledIds
      .map((id) => this.adapters.get(id))
      .filter((a): a is SourceAdapter => a !== undefined);

    const settled = await Promise.allSettled(
      adapters.map((a) => this.runAdapter(a, opts.env, extractOpts, warn)),
    );

    const all: UnifiedSession[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        all.push(...r.value);
      } else {
        // Per-adapter isolation (R1.5): log and continue the run.
        warn(`source ${adapters[i].id}: collection failed (${(r.reason as Error)?.message ?? String(r.reason)})`);
      }
    }

    // Tag every session with the resolved project (R1.6).
    if (project) {
      for (const s of all) {
        s.project = project;
      }
    }

    let result = dedupSessions(all);

    if (typeof opts.last === 'number' && opts.last > 0 && result.length > opts.last) {
      result = result.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, opts.last);
    }

    return result;
  }

  /**
   * Discover then extract a single adapter, fully isolated. An adapter that
   * reports `unavailable`, or throws at any stage, yields no sessions and a
   * warning rather than aborting the run (R1.5).
   */
  private async runAdapter(
    adapter: SourceAdapter,
    env: AdapterEnv,
    extractOpts: ExtractOptions,
    warn: LogFn,
  ): Promise<UnifiedSession[]> {
    let presence: SourcePresence;
    try {
      presence = await adapter.discover(env);
    } catch (err) {
      warn(`source ${adapter.id}: discover failed (${(err as Error).message})`);
      return [];
    }

    if (!presence.available) {
      if (presence.hint) {
        warn(`source ${adapter.id}: unavailable — ${presence.hint}`);
      }
      return [];
    }

    const out: UnifiedSession[] = [];
    try {
      for await (const session of adapter.extract(extractOpts)) {
        out.push(session);
        if (
          typeof extractOpts.limit === 'number' &&
          extractOpts.limit > 0 &&
          out.length >= extractOpts.limit
        ) {
          break;
        }
      }
    } catch (err) {
      warn(`source ${adapter.id}: extract failed (${(err as Error).message})`);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------------

/**
 * Build a registry pre-populated with the three built-in adapters. Tests inject
 * their own adapters via {@link SourceRegistry.registerAdapter} (which replaces
 * by id) or construct a bare {@link SourceRegistry}.
 */
export function createDefaultRegistry(): SourceRegistry {
  const registry = new SourceRegistry();
  registry.registerAdapter(createAutoclawNativeAdapter());
  registry.registerAdapter(createCursorAdapter());
  registry.registerAdapter(createGenericAdapter());
  registry.registerAdapter(createClaudeCodeAdapter());
  registry.registerAdapter(createClaudeDesktopAdapter());
  registry.registerAdapter(createKiroAdapter());
  registry.registerAdapter(createGeminiAdapter());
  return registry;
}

/** Shared default registry instance (lazy-built adapters; no I/O at import). */
export const defaultRegistry: SourceRegistry = createDefaultRegistry();
