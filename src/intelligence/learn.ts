/**
 * learn.ts — the `/learn` orchestrator for the AutoClaw Intelligence Layer
 * (R5.1-R5.8, R7.1).
 *
 * `learnFromSessions` is the durable-memory gatekeeper. A single run:
 *   1. holds an advisory lock on `preferences.json` for its entire duration (R5.2);
 *   2. collects + dedups sessions from the ENABLED Source Adapters via the
 *      injectable registry, honoring `--last N` (R5.4, R5.5);
 *   3. aggregates successful / avoided patterns + preferred tools, falling back
 *      to sensible defaults so the output is never empty (R5.3);
 *   4. redacts every string destined for disk or embeddings (R7.1);
 *   5. builds structured {@link LearnedMemory} records — the gate for what
 *      becomes durable memory (R5.7, R5.8);
 *   6. writes a timestamped `.autoclaw/learnings/insight-<ts>.md` human view;
 *   7. merges `.autoclaw/vector/preferences.json` WITHOUT clobbering prior data;
 *   8. regenerates `agent-style.md` via {@link generateAgentStyle};
 *   9. APPENDS a dated summary to the KDream `MEMORY.md` (never overwrites);
 *  10. stores the distilled-insight embedding when the backend is available
 *      (degraded ⇒ skip, never throws);
 *  11. returns a {@link LearnSummary}.
 *
 * No `vscode` import; no network calls. The registry is injectable (defaults to
 * {@link createDefaultRegistry}) so tests pass offline fake adapters.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LogFn, getActiveEmbeddingSignature, loadConfig } from './config';
import { AdapterEnv, IntelligenceConfig, LearnedMemory, UnifiedSession } from './types';
import { ensureDir, intelligencePaths, toForwardSlash } from './paths';
import { resolveProjectKey } from './project';
import { redactSecrets } from './redact';
import { getEmbedding } from './embeddings';
import { acquireLock } from './fileLock';
import { initVectorDB, VectorRecord } from './vectorEngine';
import {
  SourceRegistry,
  createDefaultRegistry,
  resolveEnabledSources,
} from './sources/registry';
import { StyleAggregates, generateAgentStyle } from './agentStyle';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link learnFromSessions}. */
export interface LearnOptions {
  /** Directory that contains (or will contain) `.autoclaw`. */
  workspaceRoot: string;
  /** Cap on the number of most-recent sessions analyzed per source (`--last N`). */
  last?: number;
  /** Optional free-text focus area the run is scoped to. */
  focus?: string;
  /** Pre-resolved config. Loaded from disk when omitted. */
  config?: IntelligenceConfig;
  /** Source Adapter registry. Defaults to {@link createDefaultRegistry}. */
  registry?: SourceRegistry;
  /** Explicit enabled adapter ids. Defaults to {@link resolveEnabledSources}. */
  enabledIds?: string[];
  /** Discovery/extraction environment. Defaults to the live process env. */
  env?: AdapterEnv;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
}

/** Summary returned by {@link learnFromSessions}. */
export interface LearnSummary {
  /** Number of (deduped) sessions analyzed this run. */
  sessionsAnalyzed: number;
  /** Total kept-code signals observed across the analyzed sessions. */
  kept: number;
  /** Number of distilled patterns (successful + avoided) persisted. */
  patterns: number;
  /** Distinct Source Adapter ids that contributed sessions, sorted. */
  sources: string[];
}

/** On-disk shape of `preferences.json` (merge target). */
interface PreferencesFile {
  preferredPatterns: string[];
  avoided: string[];
  tools: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Defaults (R5.3 — output is never empty even with no signal)
// ---------------------------------------------------------------------------

const DEFAULT_SUCCESSFUL_PATTERNS: readonly string[] = [
  'Make focused, single-responsibility changes and verify them with tests before moving on.',
  'Match existing project conventions for naming, error handling, and structure.',
  'Read the relevant code before editing it; never change code you have not seen.',
];

const DEFAULT_AVOIDED_PATTERNS: readonly string[] = [
  'Avoid large speculative rewrites that are not backed by tests.',
  'Avoid adding new dependencies when an existing project utility already covers the need.',
];

const DEFAULT_PREFERRED_TOOLS: readonly string[] = ['general-purpose coding agent'];

const SOURCE_TAG = 'learn';
const MAX_PATTERNS = 25;
const MAX_PATTERN_LEN = 200;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

/** Redact secrets, collapse whitespace, and cap length — for any persisted text. */
function clean(text: string, max: number = MAX_PATTERN_LEN): string {
  return truncate(collapse(redactSecrets(text)), max);
}

/** First non-empty line of a (redacted) code block, used as a pattern label. */
function firstMeaningfulLine(code: string): string {
  const redacted = redactSecrets(code);
  const lines = redacted.split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l.length > 0);
  return first ?? redacted.trim();
}

// ---------------------------------------------------------------------------
// Aggregation (R5.3)
// ---------------------------------------------------------------------------

interface Aggregates extends StyleAggregates {
  keptCount: number;
  sources: string[];
  usedDefaults: boolean;
}

function aggregate(sessions: UnifiedSession[]): Aggregates {
  const successful = new Set<string>();
  const avoided = new Set<string>();
  const toolCount = new Map<string, number>();
  const sourceSet = new Set<string>();
  let keptCount = 0;

  for (const s of sessions) {
    if (s.source) {
      sourceSet.add(s.source);
    }
    const keptCode = s.signals?.keptCode ?? [];
    keptCount += keptCode.length;

    const shipped =
      s.signals?.outcome === 'shipped' || s.signals?.gitKept === true || keptCode.length > 0;
    if (shipped) {
      const tool = (s.tool || s.source || 'unknown').trim();
      toolCount.set(tool, (toolCount.get(tool) ?? 0) + 1);
    }

    for (const k of keptCode) {
      const snippet = truncate(collapse(firstMeaningfulLine(k.code)), MAX_PATTERN_LEN);
      if (snippet) {
        successful.add(`Kept (${k.reason.replace(/_/g, ' ')}): ${snippet}`);
      }
    }

    if (s.signals?.outcome === 'shipped') {
      const label = clean(s.summary || s.title || '');
      if (label) {
        successful.add(`Shipped: ${label}`);
      }
    }

    if (s.signals?.outcome === 'discarded') {
      const label = clean(s.summary || s.title || 'an approach that was abandoned');
      if (label) {
        avoided.add(`Discarded: ${label}`);
      }
    }
  }

  const tools = Array.from(toolCount.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool]) => tool);

  let successfulPatterns = Array.from(successful).slice(0, MAX_PATTERNS);
  let avoidedPatterns = Array.from(avoided).slice(0, MAX_PATTERNS);
  let preferredTools = tools;

  let usedDefaults = false;
  if (successfulPatterns.length === 0) {
    successfulPatterns = [...DEFAULT_SUCCESSFUL_PATTERNS];
    usedDefaults = true;
  }
  if (avoidedPatterns.length === 0) {
    avoidedPatterns = [...DEFAULT_AVOIDED_PATTERNS];
    usedDefaults = true;
  }
  if (preferredTools.length === 0) {
    preferredTools = [...DEFAULT_PREFERRED_TOOLS];
    usedDefaults = true;
  }

  return {
    successfulPatterns,
    avoidedPatterns,
    preferredTools,
    keptCount,
    sources: Array.from(sourceSet).sort(),
    usedDefaults,
  };
}

// ---------------------------------------------------------------------------
// LearnedMemory records — the durable-memory gate (R5.7, R5.8)
// ---------------------------------------------------------------------------

function buildMemoryRecords(
  agg: Aggregates,
  distilled: string,
  project: string,
  createdAt: string,
): LearnedMemory[] {
  const baseConfidence = agg.usedDefaults ? 0.5 : 0.72;
  const records: LearnedMemory[] = [];

  for (const content of agg.successfulPatterns) {
    records.push({
      namespace: project,
      kind: 'procedural',
      content,
      confidence: baseConfidence,
      importance: 0.6,
      source: SOURCE_TAG,
      project,
      createdAt,
    });
  }

  for (const content of agg.avoidedPatterns) {
    records.push({
      namespace: project,
      kind: 'failure',
      content,
      confidence: baseConfidence,
      importance: 0.6,
      source: SOURCE_TAG,
      project,
      createdAt,
    });
  }

  records.push({
    namespace: project,
    kind: 'reflection',
    content: distilled,
    confidence: 0.6,
    importance: 0.7,
    source: SOURCE_TAG,
    project,
    createdAt,
  });

  return records;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildDistilledInsight(
  agg: Aggregates,
  sessionsAnalyzed: number,
  focus: string | undefined,
): string {
  const parts: string[] = [];
  if (focus) {
    parts.push(`Focus: ${focus}.`);
  }
  parts.push(
    `Analyzed ${sessionsAnalyzed} session(s) with ${agg.keptCount} kept-code signal(s).`,
  );
  if (agg.preferredTools.length) {
    parts.push(`Preferred tools: ${agg.preferredTools.join(', ')}.`);
  }
  if (agg.successfulPatterns.length) {
    parts.push(`Successful patterns: ${agg.successfulPatterns.join(' | ')}.`);
  }
  if (agg.avoidedPatterns.length) {
    parts.push(`Patterns to avoid: ${agg.avoidedPatterns.join(' | ')}.`);
  }
  return clean(parts.join(' '), 4000);
}

function renderInsightFile(
  records: LearnedMemory[],
  agg: Aggregates,
  sessionsAnalyzed: number,
  focus: string | undefined,
  iso: string,
  distilled: string,
): string {
  const procedural = records.filter((r) => r.kind === 'procedural');
  const failures = records.filter((r) => r.kind === 'failure');

  const lines: string[] = [];
  lines.push(`# Insight — ${iso}`);
  lines.push('');
  if (focus) {
    lines.push(`**Focus:** ${focus}`);
    lines.push('');
  }
  lines.push(`- Sessions analyzed: ${sessionsAnalyzed}`);
  lines.push(`- Kept-code signals: ${agg.keptCount}`);
  lines.push(`- Sources: ${agg.sources.length ? agg.sources.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('## Successful Patterns (procedural)');
  lines.push('');
  lines.push(procedural.length ? procedural.map((r) => `- ${r.content}`).join('\n') : '_None._');
  lines.push('');
  lines.push('## Patterns to Avoid (failure)');
  lines.push('');
  lines.push(failures.length ? failures.map((r) => `- ${r.content}`).join('\n') : '_None._');
  lines.push('');
  lines.push('## Preferred Tools');
  lines.push('');
  lines.push(agg.preferredTools.map((t) => `- ${t}`).join('\n'));
  lines.push('');
  lines.push('## Reflection');
  lines.push('');
  lines.push(distilled);
  lines.push('');
  return lines.join('\n');
}

function renderMemoryEntry(
  agg: Aggregates,
  sessionsAnalyzed: number,
  focus: string | undefined,
  iso: string,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`## ${iso} — /learn`);
  if (focus) {
    lines.push(`Focus: ${focus}`);
  }
  lines.push(
    `Analyzed ${sessionsAnalyzed} session(s), ${agg.keptCount} kept signal(s) from ` +
      `${agg.sources.length ? agg.sources.join(', ') : 'no sources'}.`,
  );
  lines.push('Successful patterns:');
  for (const p of agg.successfulPatterns) {
    lines.push(`- ${p}`);
  }
  lines.push('Patterns to avoid:');
  for (const p of agg.avoidedPatterns) {
    lines.push(`- ${p}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// preferences.json merge (no clobber)
// ---------------------------------------------------------------------------

function readPreferences(prefsPath: string): PreferencesFile {
  const empty: PreferencesFile = { preferredPatterns: [], avoided: [], tools: [], updatedAt: '' };
  try {
    if (!fs.existsSync(prefsPath)) {
      return empty;
    }
    const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as Partial<PreferencesFile>;
      return {
        preferredPatterns: Array.isArray(p.preferredPatterns)
          ? p.preferredPatterns.filter((x): x is string => typeof x === 'string')
          : [],
        avoided: Array.isArray(p.avoided)
          ? p.avoided.filter((x): x is string => typeof x === 'string')
          : [],
        tools: Array.isArray(p.tools)
          ? p.tools.filter((x): x is string => typeof x === 'string')
          : [],
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
      };
    }
  } catch {
    // malformed file — treat as empty rather than throwing/clobbering blindly
  }
  return empty;
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...existing, ...incoming]) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// learnFromSessions (R5.1-R5.8, R7.1)
// ---------------------------------------------------------------------------

/**
 * Run the `/learn` pipeline for the workspace rooted at `workspaceRoot`. See the
 * module header for the full sequence. Holds the `preferences.json` lock for the
 * whole run, never overwrites `MEMORY.md` or existing preference entries, and
 * never throws on a degraded vector backend.
 */
export async function learnFromSessions(options: LearnOptions): Promise<LearnSummary> {
  const { workspaceRoot } = options;
  const log: LogFn = options.log ?? (() => undefined);
  const config = options.config ?? loadConfig(workspaceRoot, log);
  const registry = options.registry ?? createDefaultRegistry();
  const project = resolveProjectKey(workspaceRoot);
  const paths = intelligencePaths(workspaceRoot);

  // preferences.json lives beside the vector store (documented contract path).
  const preferencesPath = toForwardSlash(path.join(paths.vectorDir, 'preferences.json'));
  const agentStylePath = toForwardSlash(path.join(paths.root, 'agent-style.md'));

  const focus = options.focus ? clean(options.focus, 200) : undefined;

  const env: AdapterEnv =
    options.env ?? {
      homeDir: os.homedir(),
      workspaceRoot: toForwardSlash(path.resolve(workspaceRoot)),
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
    };

  const enabledIds =
    options.enabledIds ?? resolveEnabledSources(config.sources, registry.ids());

  // Ensure the directories the run writes into exist before taking the lock.
  await ensureDir(paths.vectorDir);
  await ensureDir(paths.learningsDir);

  // (R5.2) Hold the preferences lock for the durable-file writes. The embedding
  // step (10) is deliberately performed AFTER releasing this lock: the first
  // transformers call may download a model for minutes, and `acquireLock` times
  // out at 15s, so holding the lock across it would make a concurrent /learn
  // fail spuriously. The embedding store is best-effort + degrade-safe.
  const release = await acquireLock(preferencesPath);
  let records: LearnedMemory[];
  let iso: string;
  let summary: LearnSummary;
  try {
    // (R5.4 / R5.5) Collect + dedup sessions from enabled adapters, honoring --last N.
    const sessions = await registry.collectSessions({
      last: options.last,
      enabledIds,
      env,
      project,
      log,
    });

    // (R5.3) Aggregate with sensible defaults so output is never empty.
    const agg = aggregate(sessions);
    iso = new Date().toISOString();

    // (R7.1) Everything below is already redacted via clean()/firstMeaningfulLine().
    const distilled = buildDistilledInsight(agg, sessions.length, focus);

    // (R5.7 / R5.8) Build the durable-memory records — the gate for what persists.
    records = buildMemoryRecords(agg, distilled, project, iso);

    // (6) Timestamped human-readable insight view over the records.
    const insightName = `insight-${iso.replace(/[:.]/g, '-')}.md`;
    const insightPath = toForwardSlash(path.join(paths.learningsDir, insightName));
    fs.writeFileSync(
      insightPath,
      renderInsightFile(records, agg, sessions.length, focus, iso, distilled),
      'utf8',
    );

    // (7) Merge preferences.json WITHOUT clobbering prior entries (lock already held).
    const prior = readPreferences(preferencesPath);
    const merged: PreferencesFile = {
      preferredPatterns: mergeUnique(prior.preferredPatterns, agg.successfulPatterns),
      avoided: mergeUnique(prior.avoided, agg.avoidedPatterns),
      tools: mergeUnique(prior.tools, agg.preferredTools),
      updatedAt: iso,
    };
    fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2), 'utf8');

    // (8) Regenerate agent-style.md (lock-protected — separate file).
    const styleRelease = await acquireLock(agentStylePath);
    try {
      fs.writeFileSync(
        agentStylePath,
        `${generateAgentStyle(focus, {
          successfulPatterns: agg.successfulPatterns,
          avoidedPatterns: agg.avoidedPatterns,
          preferredTools: agg.preferredTools,
        })}\n`,
        'utf8',
      );
    } finally {
      styleRelease();
    }

    // (9) APPEND a dated summary to MEMORY.md — never overwrite (lock-protected).
    await ensureDir(path.dirname(paths.memoryPath));
    const memoryRelease = await acquireLock(paths.memoryPath);
    try {
      const entry = renderMemoryEntry(agg, sessions.length, focus, iso);
      let existing = '';
      try {
        if (fs.existsSync(paths.memoryPath)) {
          existing = fs.readFileSync(paths.memoryPath, 'utf8');
        }
      } catch (err) {
        log(`learn: could not read MEMORY.md (${(err as Error).message}); appending fresh`);
      }
      fs.writeFileSync(paths.memoryPath, existing + entry, 'utf8');
    } finally {
      memoryRelease();
    }

    // (11) Capture the run summary while the lock is held.
    summary = {
      sessionsAnalyzed: sessions.length,
      kept: agg.keptCount,
      patterns: agg.successfulPatterns.length + agg.avoidedPatterns.length,
      sources: agg.sources,
    };
  } finally {
    release();
  }

  // (10) Store the distilled-memory embeddings AFTER releasing the preferences
  // lock. Every LearnedMemory record (procedural / failure / reflection) is
  // embedded — not just the single distilled reflection — so `/search` covers
  // the individual learnings (R6.2), not merely a per-run summary.
  await storeMemoryEmbeddings(paths.dbPath, config, project, records, log);

  return summary;
}

/** Embed + store every LearnedMemory record; degrade silently when unavailable. */
async function storeMemoryEmbeddings(
  dbPath: string,
  config: IntelligenceConfig,
  project: string,
  records: LearnedMemory[],
  log: LogFn,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  try {
    const signature = getActiveEmbeddingSignature(config);
    const db = await initVectorDB(dbPath, signature, log);
    if (db.degraded) {
      log('learn: vector backend unavailable; learning embeddings not stored');
      db.close();
      return;
    }
    try {
      const vrecs: VectorRecord[] = [];
      let i = 0;
      for (const record of records) {
        const embedding = await getEmbedding(record.content, config.embedding, log);
        vrecs.push({
          id: `${SOURCE_TAG}:${project}:${record.createdAt}:${record.kind}:${i++}`,
          content: record.content,
          embedding,
          source: SOURCE_TAG,
          project,
          timestamp: Date.parse(record.createdAt) || Date.now(),
          metadata: { kind: record.kind },
        });
      }
      // Replace this project's prior `learn` vectors in the SAME transaction
      // before inserting the fresh batch. Without this, every /learn run adds a
      // new timestamped id set and the byte-identical default patterns pile up,
      // so /search returns stacks of near-duplicate hits over time. Deleting the
      // project's `learn:<project>:` prefix keeps the learn corpus to one current
      // generation per project (other sources/projects are untouched).
      await db.storeEmbeddings(vrecs, {
        deleteIdPrefixes: [`${SOURCE_TAG}:${project}:`],
      });
    } finally {
      db.close();
    }
  } catch (err) {
    // Embedding is best-effort — never let it break the learn run.
    log(`learn: storing learning embeddings failed (${(err as Error).message})`);
  }
}
