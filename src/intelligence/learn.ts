/**
 * learn.ts — the `/learn` orchestrator for the AutoClaw Intelligence Layer
 * (R5.1-R5.8, R7.1).
 *
 * `learnFromSessions` is the durable-memory gatekeeper. A single run:
 *   1. collects + dedups sessions, git-validates kept code, and aggregates —
 *      all lock-free reads/compute (R5.4, R5.5);
 *   2. holds an advisory lock on `preferences.json` ONLY across the durable
 *      preference + insight writes — not the slow collect/git work above or the
 *      embedding/metrics work below — so a concurrent run cannot time out (R5.2);
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
import { initVectorBackend, VectorRecord } from './vector';
import {
  SourceRegistry,
  createDefaultRegistry,
  resolveEnabledSources,
} from './sources/registry';
import { StyleAggregates, generateAgentStyle } from './agentStyle';
import { enrichSessionsWithGitSignals } from './gitSignals';
import { deriveOutcome } from './ranking';
import { LearningRunStats, recordLearningRun } from './metrics/store';
import { aggregateRealTokens } from './metrics/ledgerBridge';
import { WorkflowInsights, mineWorkflows, workflowPatternLabel } from './workflows';
import { computeEffectiveness } from './effectiveness';
import { recordEffectiveness } from './metrics/effectivenessStore';
import { CoordinationSignals, collectCoordinationSignals } from './coordinationSignals';

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
  /** Mined successful workflow patterns folded into durable memory this run. */
  workflowsMined: number;
  /** Coordination outcomes (consensus verdicts + review findings) folded in. */
  coordinationOutcomes: number;
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
/** How many mined workflow / anti-workflow patterns to fold into durable memory. */
const MAX_WORKFLOWS = 5;

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

/** Rough run-token estimate: real usage hints when present, else ~4 chars/token. */
function estimateTokens(sessions: UnifiedSession[]): number {
  let total = 0;
  for (const s of sessions) {
    const usage = s.signals?.tokenUsage;
    if (usage) {
      total += Math.max(0, usage.prompt) + Math.max(0, usage.completion);
      continue;
    }
    let chars = 0;
    for (const m of s.messages) {
      chars += (m.text ?? '').length;
      for (const b of m.codeBlocks ?? []) {
        chars += (b.code ?? '').length;
      }
    }
    total += Math.ceil(chars / 4);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Aggregation (R5.3)
// ---------------------------------------------------------------------------

interface Aggregates extends StyleAggregates {
  keptCount: number;
  sources: string[];
  usedDefaults: boolean;
  /** Mined workflow signal (folded into the pattern sets below). */
  workflows: WorkflowInsights;
  /** Multi-agent coordination outcomes (folded into the pattern sets below). */
  coordination: CoordinationSignals;
}

/** Empty coordination signal — used when no comms tree is present. */
const EMPTY_COORDINATION: CoordinationSignals = {
  outcomes: [], findings: [], successful: [], avoided: [],
  counts: { approved: 0, changesRequested: 0, rejected: 0, findings: 0 },
};

function aggregate(
  sessions: UnifiedSession[],
  coordination: CoordinationSignals = EMPTY_COORDINATION,
): Aggregates {
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

  // (workflow-mining) Fold mined tool-sequence patterns into the SAME pattern
  // sets BEFORE the empty/default check, so a corpus that yields workflow signal
  // but no per-snippet kept code is still treated as real signal (not defaults).
  // Workflows are prepended so they rank ahead of single-snippet patterns.
  const workflows = mineWorkflows(sessions);
  // Coordination outcomes lead both lists: a cross-agent review that confirmed a
  // finding or gated a merge is the highest-value, most reusable team signal.
  // They are folded BEFORE the empty/default check so a corpus with coordination
  // signal but no kept code is still treated as real.
  const successfulList = [
    ...coordination.successful,
    ...workflows.successful
      .slice(0, MAX_WORKFLOWS)
      .map((p) => `Workflow: ${workflowPatternLabel(p)}`),
    ...Array.from(successful),
  ];
  const avoidedList = [
    ...coordination.avoided,
    ...workflows.antiPatterns
      .slice(0, MAX_WORKFLOWS)
      .map((p) => `Anti-workflow: ${workflowPatternLabel(p)}`),
    ...Array.from(avoided),
  ];

  let successfulPatterns = successfulList.slice(0, MAX_PATTERNS);
  let avoidedPatterns = avoidedList.slice(0, MAX_PATTERNS);
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
    workflows,
    coordination,
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
  gitValidated = false,
): LearnedMemory[] {
  const baseConfidence = agg.usedDefaults ? 0.5 : gitValidated ? 0.85 : 0.72;
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
  const c = agg.coordination.counts;
  if (c.approved + c.changesRequested + c.rejected + c.findings > 0) {
    parts.push(
      `Coordination: ${c.approved} approved, ${c.changesRequested} changes-requested, ` +
        `${c.rejected} rejected, ${c.findings} review finding(s).`,
    );
  }
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
  const cc = agg.coordination.counts;
  if (cc.approved + cc.changesRequested + cc.rejected + cc.findings > 0) {
    lines.push(
      `- Coordination: ${cc.approved} approved, ${cc.changesRequested} changes-requested, ` +
        `${cc.rejected} rejected, ${cc.findings} review finding(s)`,
    );
  }
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
  const runStartedAt = Date.now();

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
  // ---- Compute phase (NO lock held) -------------------------------------
  // collectSessions, git enrichment (up to ~50 `git show` subprocesses), and
  // aggregation only READ/COMPUTE — they write nothing durable. Running them
  // before taking the preferences lock keeps the lock's hold time bounded to the
  // file writes below, so a concurrent /learn cannot time out against slow git
  // I/O on a large repo (mirrors the decision that moved embedding out of the
  // lock; acquireLock times out at 15s).

  // (R5.4 / R5.5) Collect + dedup sessions from enabled adapters, honoring --last N.
  const sessions = await registry.collectSessions({
    last: options.last,
    enabledIds,
    env,
    project,
    log,
  });

  // (Phase-2 signal-and-rag) Git-validate kept code BEFORE aggregation so
  // distilled patterns prefer actually-committed code. Offline-safe: no repo
  // => passthrough, never throws.
  await enrichSessionsWithGitSignals(sessions, {
    lookbackDays: 14,
    minConfidence: 0.55,
    cwd: workspaceRoot,
    log,
  });

  // (#8) Harvest multi-agent coordination outcomes from the comms tree
  // (consensus verdicts + finding reports) so the run learns from team events,
  // not just per-session code diffs. Pure reads; degrade-safe on a missing tree.
  let coordination: CoordinationSignals | undefined;
  try {
    coordination = collectCoordinationSignals(workspaceRoot);
  } catch (err) {
    log(`learn: collecting coordination signals failed (${(err as Error).message})`);
  }

  // (KG) Record coordination outcomes as durable, queryable knowledge-graph
  // facts so context packs + kg.search surface real team decisions instead of an
  // empty graph. Best-effort, deduped by deterministic id, never blocks /learn.
  if (coordination) {
    try {
      const { recordCoordinationToKg } = await import('./kgRecord');
      await recordCoordinationToKg(workspaceRoot, coordination, { log });
    } catch (err) {
      log(`learn: KG coordination recording failed (${(err as Error).message})`);
    }
  }

  // (R5.3) Aggregate with sensible defaults so output is never empty.
  const agg = aggregate(sessions, coordination);
  const iso = new Date().toISOString();

  // (R7.1) Everything below is already redacted via clean()/firstMeaningfulLine().
  const distilled = buildDistilledInsight(agg, sessions.length, focus);

  // (R5.7 / R5.8) Build the durable-memory records — the gate for what persists.
  // Raise confidence when the run was git-validated (Phase-2 R4.2).
  const gitValidated = sessions.some((s) => deriveOutcome(s).signalType === 'git_commit');
  const gitEnriched = gitValidated;
  const estTokens = estimateTokens(sessions);
  const records = buildMemoryRecords(agg, distilled, project, iso, gitValidated);

  // (6) Render the timestamped human-readable insight view (no I/O yet).
  const insightName = `insight-${iso.replace(/[:.]/g, '-')}.md`;
  const insightPath = toForwardSlash(path.join(paths.learningsDir, insightName));
  const insightBody = renderInsightFile(records, agg, sessions.length, focus, iso, distilled);

  // ---- Durable preference + insight writes (preferences lock held) -------
  // (R5.2) Hold the lock ONLY across the preference-related writes, not the
  // collect/enrich/aggregate work above or the embedding/metrics work below.
  const release = await acquireLock(preferencesPath);
  try {
    fs.writeFileSync(insightPath, insightBody, 'utf8');

    // (7) Merge preferences.json WITHOUT clobbering prior entries (lock held).
    const prior = readPreferences(preferencesPath);
    const merged: PreferencesFile = {
      preferredPatterns: mergeUnique(prior.preferredPatterns, agg.successfulPatterns),
      avoided: mergeUnique(prior.avoided, agg.avoidedPatterns),
      tools: mergeUnique(prior.tools, agg.preferredTools),
      updatedAt: iso,
    };
    fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2), 'utf8');
  } finally {
    release();
  }

  // (8) Regenerate agent-style.md (its own advisory lock — separate file).
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

  // (9) APPEND a dated summary to MEMORY.md — never overwrite (its own lock).
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

  // (11) The run summary.
  const c = agg.coordination.counts;
  const summary: LearnSummary = {
    sessionsAnalyzed: sessions.length,
    kept: agg.keptCount,
    patterns: agg.successfulPatterns.length + agg.avoidedPatterns.length,
    sources: agg.sources,
    workflowsMined: agg.workflows.successful.length,
    coordinationOutcomes: c.approved + c.changesRequested + c.rejected + c.findings,
  };

  // (10) Store the distilled-memory embeddings AFTER releasing the preferences
  // lock. Every LearnedMemory record (procedural / failure / reflection) is
  // embedded — not just the single distilled reflection — so `/search` covers
  // the individual learnings (R6.2), not merely a per-run summary.
  await storeMemoryEmbeddings(paths.dbPath, config, project, records, log);

  // (metrics-dashboard R1.1/R2.4) Record run metrics; attach real tokens from
  // the existing cost ledger when token logging is enabled. Best-effort — a
  // metrics failure never breaks the learn run.
  try {
    const ledger = await aggregateRealTokens(workspaceRoot, config, { sinceTs: runStartedAt });
    const stats: LearningRunStats = {
      ts: iso,
      sessionsAnalyzed: summary.sessionsAnalyzed,
      kept: summary.kept,
      keptRate: summary.sessionsAnalyzed > 0 ? summary.kept / summary.sessionsAnalyzed : 0,
      patternsLearned: summary.patterns,
      sources: summary.sources,
      estTokens,
      gitEnriched,
    };
    if (focus) {
      stats.focus = focus;
    }
    if (ledger.available) {
      stats.realTokens = ledger.usage;
      stats.costUsd = ledger.costUsd;
    }
    await recordLearningRun(workspaceRoot, stats);
  } catch (err) {
    log(`learn: recording metrics failed (${(err as Error).message})`);
  }

  // (effectiveness) Persist the tool × project matrix snapshot from the same
  // corpus. Best-effort — a snapshot failure never breaks the learn run.
  try {
    const matrix = computeEffectiveness(sessions, { now: iso });
    await recordEffectiveness(workspaceRoot, matrix);
  } catch (err) {
    log(`learn: recording effectiveness failed (${(err as Error).message})`);
  }

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
    const db = await initVectorBackend(config, dbPath, signature, log);
    if (db.degraded) {
      log('learn: vector backend unavailable; learning embeddings not stored');
      db.close();
      return;
    }
    try {
      const vrecs: VectorRecord[] = [];
      let i = 0;
      let embeddingDegraded = false;
      for (const record of records) {
        const embedding = await getEmbedding(record.content, config.embedding, log, () => {
          embeddingDegraded = true;
        });
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
      if (embeddingDegraded) {
        log(
          `learn: WARNING — the "${config.embedding.provider}" embedding provider failed on some ` +
            `records; those fell back to basic 'none' vectors (mixed geometry). Fix the provider ` +
            `and re-run /learn for a clean rebuild.`,
        );
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // Embedding is best-effort — never let it break the learn run.
    log(`learn: storing learning embeddings failed (${(err as Error).message})`);
  }
}
