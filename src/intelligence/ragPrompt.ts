/**
 * ragPrompt.ts — RAG-augmented prompt service for the AutoClaw Intelligence
 * Layer (Phase-2 intelligence-signal-and-rag, R2.1-R2.4, R3.1-R3.2).
 *
 * `generateRAGPrompt(task, opts)` assembles a single, ready-to-paste prompt
 * that grounds an agent in the user's real code and proven patterns, in order:
 *   1. Retrieved code chunks  — `retrieveCode`, project-namespace scoped (D11).
 *   2. Matched learnings      — semantic search over `learn` vectors, scoped to
 *                               the project; degraded ⇒ `preferences.json`.
 *   3. Agent style guide      — `agent-style.md`.
 *   4. Recent MEMORY.md summary.
 *   5. Explicit agent instructions (reuse kept patterns, avoid failed ones).
 *
 * Degraded vector backend (R2.4): step 1 is skipped, `usedCode` is `false`, a
 * note is added, and the prompt is still produced from learnings (read from the
 * file-based `preferences.json`), style, and memory.
 *
 * `buildScaffold(opts)` backs the `/scaffold` command: it emits the current
 * `agent-style.md` (optionally focused) suitable for prepending to any prompt.
 *
 * Constraints: no `vscode` import (host-free); project-namespace scoped; the
 * task text is run through {@link redactSecrets} before being rendered into the
 * prompt. Code chunks, learnings, style, and memory are already redacted at
 * index/learn time. All vector access is injectable so tests run offline,
 * including a forced degraded path.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  LogFn,
  getActiveEmbeddingSignature,
  loadConfig,
} from './config';
import { IntelligenceConfig } from './types';
import { intelligencePaths } from './paths';
import { resolveProjectKey } from './project';
import { redactSecrets } from './redact';
import { getEmbedding } from './embeddings';
import { applyEmbeddingPin } from './embeddingResolve';
import { initVectorBackend } from './vector';
import { CodeSearchResult, retrieveCode } from './ragCode';
import { generateAgentStyle } from './agentStyle';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The tag `/learn` stores its distilled-memory vectors under. */
const LEARN_SOURCE = 'learn';

/** A single matched learning. */
export interface LearningHit {
  content: string;
  score?: number;
}

/**
 * Injectable seams for {@link generateRAGPrompt}. Defaults wire the real
 * project-scoped vector store + filesystem; tests pass stubs (and can force the
 * degraded path) so no native backend or repo is needed.
 */
export interface RAGPromptDeps {
  /** Code retrieval (defaults to project-scoped {@link retrieveCode}). */
  retrieveCode?: (task: string) => Promise<CodeSearchResult[]>;
  /** Semantic learning retrieval over `learn` vectors (project-scoped). */
  retrieveLearnings?: (task: string) => Promise<LearningHit[]>;
  /** True when the vector backend is degraded/unavailable. */
  vectorDegraded?: () => Promise<boolean>;
  /** File-based learnings fallback (preferences.json) for degraded mode. */
  readPreferenceLearnings?: () => string[];
  /** Reads `agent-style.md` (defaults to fs read). */
  readAgentStyle?: () => string | undefined;
  /** Reads the recent `MEMORY.md` summary (defaults to fs read + trim). */
  readMemorySummary?: () => string | undefined;
}

/** Options for {@link generateRAGPrompt}. */
export interface RAGPromptOptions {
  /** Directory that contains `.autoclaw`. */
  workspaceRoot: string;
  /** Max code chunks to include. Defaults to 5. */
  maxCodeChunks?: number;
  /** Max learnings to include. Defaults to 4. */
  maxLearnings?: number;
  /** Include the agent style guide. Defaults to true. */
  includeStyle?: boolean;
  /** Include the recent memory summary. Defaults to true. */
  includeMemory?: boolean;
  /** Pre-resolved config. Loaded from disk when omitted. */
  config?: IntelligenceConfig;
  /** Optional warning sink. */
  log?: LogFn;
  /** Injectable dependencies (tests / degraded-path injection). */
  deps?: RAGPromptDeps;
}

/** Result of {@link generateRAGPrompt}. */
export interface RAGPromptResult {
  /** The assembled, ready-to-paste prompt. */
  prompt: string;
  /** True when indexed code chunks were included (false in degraded mode). */
  usedCode: boolean;
  /** Number of code chunks included. */
  codeHits: number;
  /** Number of learnings included. */
  learningHits: number;
  /** Human-readable notes (e.g. degraded-mode explanation). */
  notes: string[];
}

/** Options for {@link buildScaffold}. */
export interface ScaffoldOptions {
  /** Directory that contains `.autoclaw`. */
  workspaceRoot: string;
  /** Optional focus area to emphasize. */
  focus?: string;
  /** Injectable reader for `agent-style.md` (defaults to fs read). */
  readAgentStyle?: (workspaceRoot: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CODE = 5;
const DEFAULT_MAX_LEARNINGS = 4;
const MEMORY_SUMMARY_MAX = 1200;
const CODE_CHUNK_MAX = 800;
const LEARNING_MAX = 400;

function safeReadFile(file: string): string | undefined {
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      return text.trim() === '' ? undefined : text;
    }
  } catch {
    // unreadable — treat as absent
  }
  return undefined;
}

/** Read the most recent `## ` sections of MEMORY.md, capped for prompt size. */
function summarizeMemory(memory: string | undefined): string | undefined {
  if (!memory) {
    return undefined;
  }
  const sections = memory.split('\n## ');
  const recent = sections.slice(-3).join('\n## ').trim();
  if (recent === '') {
    return undefined;
  }
  return recent.length > MEMORY_SUMMARY_MAX ? recent.slice(-MEMORY_SUMMARY_MAX) : recent;
}

/** Read `preferences.json` preferred patterns as a degrade-safe learning source. */
function readPreferenceLearnings(vectorDir: string): string[] {
  const file = path.join(vectorDir, 'preferences.json');
  try {
    if (!fs.existsSync(file)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.preferredPatterns)) {
      return parsed.preferredPatterns.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    // malformed — treat as no learnings
  }
  return [];
}

/**
 * Build the default (real) dependency set for a workspace: project-scoped code
 * + learning retrieval against the vector store, with filesystem readers for
 * style/memory/preferences.
 */
function defaultDeps(opts: RAGPromptOptions): Required<RAGPromptDeps> {
  const { workspaceRoot } = opts;
  const log: LogFn = opts.log ?? (() => undefined);
  // Honor the indexer's pinned provider on every read open + query embed. The
  // raw `auto` seed model (`Xenova/...`) would rewrite the store's meta `model`
  // and re-raise the stale-index signal each time retrieval/the degraded probe
  // opens the DB — the never-converging "embedding model changed" loop. Sync,
  // no network probe, no pin mutation (cf. {@link applyEmbeddingPin}).
  const config = applyEmbeddingPin(opts.config ?? loadConfig(workspaceRoot, log), workspaceRoot);
  const paths = intelligencePaths(workspaceRoot);
  const project = resolveProjectKey(workspaceRoot);
  const maxLearnings = opts.maxLearnings ?? DEFAULT_MAX_LEARNINGS;

  return {
    retrieveCode: (task) =>
      retrieveCode(task, {
        workspaceRoot,
        limit: opts.maxCodeChunks ?? DEFAULT_MAX_CODE,
        config,
        log,
      }),
    retrieveLearnings: async (task) => {
      const db = await initVectorBackend(config, paths.dbPath, getActiveEmbeddingSignature(config), log);
      if (db.degraded) {
        db.close();
        return [];
      }
      try {
        const embedding = await getEmbedding(task, config.embedding, log);
        // semanticVectorSearch has no source filter; over-fetch then keep `learn`.
        const hits = await db.semanticVectorSearch(embedding, {
          limit: maxLearnings * 3,
          minSimilarity: config.search.minSimilarity,
          project,
        });
        return hits
          .filter((h) => h.source === LEARN_SOURCE)
          .slice(0, maxLearnings)
          .map((h) => ({ content: h.content, score: h.score }));
      } finally {
        db.close();
      }
    },
    vectorDegraded: async () => {
      const db = await initVectorBackend(config, paths.dbPath, getActiveEmbeddingSignature(config), log);
      const degraded = db.degraded;
      db.close();
      return degraded;
    },
    readPreferenceLearnings: () => readPreferenceLearnings(paths.vectorDir),
    readAgentStyle: () => safeReadFile(path.join(paths.root, 'agent-style.md')),
    readMemorySummary: () => summarizeMemory(safeReadFile(paths.memoryPath)),
  };
}

// ---------------------------------------------------------------------------
// generateRAGPrompt (R2.1-R2.4)
// ---------------------------------------------------------------------------

/**
 * Assemble a RAG-augmented prompt for `task`. See the module header for the
 * section order and the degraded-mode behavior. Project-namespace scoped via
 * the underlying retrieval; never throws on a degraded backend.
 */
export async function generateRAGPrompt(
  task: string,
  opts: RAGPromptOptions,
): Promise<RAGPromptResult> {
  const base = defaultDeps(opts);
  const override = opts.deps ?? {};
  const deps: Required<RAGPromptDeps> = {
    retrieveCode: override.retrieveCode ?? base.retrieveCode,
    retrieveLearnings: override.retrieveLearnings ?? base.retrieveLearnings,
    vectorDegraded: override.vectorDegraded ?? base.vectorDegraded,
    readPreferenceLearnings: override.readPreferenceLearnings ?? base.readPreferenceLearnings,
    readAgentStyle: override.readAgentStyle ?? base.readAgentStyle,
    readMemorySummary: override.readMemorySummary ?? base.readMemorySummary,
  };
  const includeStyle = opts.includeStyle !== false;
  const includeMemory = opts.includeMemory !== false;
  const maxLearnings = opts.maxLearnings ?? DEFAULT_MAX_LEARNINGS;
  const notes: string[] = [];

  const degraded = await deps.vectorDegraded();

  // 1. Code chunks (skipped + noted when degraded — R2.4).
  let codeResults: CodeSearchResult[] = [];
  if (degraded) {
    notes.push('Code retrieval unavailable (vector backend degraded).');
  } else {
    try {
      codeResults = await deps.retrieveCode(task);
    } catch (err) {
      notes.push(`Code retrieval failed: ${(err as Error).message}`);
    }
  }
  const usedCode = !degraded && codeResults.length > 0;

  // 2. Learnings — semantic when available, else preferences.json fallback.
  let learnings: string[] = [];
  if (!degraded) {
    try {
      const hits = await deps.retrieveLearnings(task);
      learnings = hits.map((h) => h.content);
    } catch (err) {
      notes.push(`Learning retrieval failed: ${(err as Error).message}`);
    }
  }
  if (learnings.length === 0) {
    learnings = deps.readPreferenceLearnings();
    if (degraded && learnings.length > 0) {
      notes.push('Learnings sourced from saved preferences (file-based fallback).');
    }
  }
  learnings = learnings.slice(0, maxLearnings);

  // 3 + 4. Style + memory (file-based; available regardless of vector state).
  const style = includeStyle ? deps.readAgentStyle() : undefined;
  const memory = includeMemory ? deps.readMemorySummary() : undefined;

  // --- Assemble -----------------------------------------------------------
  const safeTask = redactSecrets(task).trim();
  const lines: string[] = [];
  lines.push('# AutoClaw RAG-Augmented Context');
  lines.push('');
  lines.push(`**Task:** ${safeTask}`);
  lines.push('');

  if (usedCode) {
    lines.push('## Relevant Code from Your Project (RAG retrieved)');
    lines.push('');
    for (const r of codeResults) {
      lines.push(`### ${r.file} (score: ${(r.score * 100).toFixed(0)}%)`);
      lines.push('```');
      lines.push(r.content.slice(0, CODE_CHUNK_MAX));
      lines.push('```');
      lines.push('');
    }
  } else if (degraded) {
    lines.push('## Relevant Code from Your Project');
    lines.push('');
    lines.push('_Code retrieval was unavailable (vector backend degraded); this prompt was ' +
      'built from learnings, style, and memory only._');
    lines.push('');
  }

  if (learnings.length > 0) {
    lines.push('## Your Previously Successful Patterns');
    lines.push('');
    for (const l of learnings) {
      lines.push(`- ${l.slice(0, LEARNING_MAX).replace(/\s+/g, ' ').trim()}`);
    }
    lines.push('');
  }

  if (style) {
    lines.push('## Your Learned Agent Style Guide');
    lines.push('');
    lines.push(style.trim());
    lines.push('');
  }

  if (memory) {
    lines.push('## Project Memory Summary (recent)');
    lines.push('');
    lines.push(memory.trim());
    lines.push('');
  }

  lines.push('## Instructions for the Agent');
  lines.push('');
  lines.push('- Follow the patterns and style shown in the retrieved examples above.');
  lines.push('- Prefer solutions that match what has been successfully kept in past sessions.');
  lines.push('- Avoid approaches recorded under patterns to avoid.');
  lines.push('- Match existing project conventions; read code before changing it.');
  lines.push('- Be concise and engineering-focused; produce production-ready code.');
  lines.push('- If the task is ambiguous, ask clarifying questions before coding.');
  lines.push('');

  return {
    prompt: lines.join('\n'),
    usedCode,
    codeHits: usedCode ? codeResults.length : 0,
    learningHits: learnings.length,
    notes,
  };
}

// ---------------------------------------------------------------------------
// buildScaffold (R3.1-R3.2) — backs the `/scaffold` command
// ---------------------------------------------------------------------------

/**
 * Produce scaffold text from the current `agent-style.md`, suitable for
 * prepending to any new agent task. When `focus` is given, a focus header is
 * prepended and the output explicitly emphasizes learnings related to that
 * area (R3.2). When `agent-style.md` is absent, a default style body is
 * generated so the command always yields useful output.
 */
export function buildScaffold(opts: ScaffoldOptions): string {
  const read = opts.readAgentStyle ?? defaultReadAgentStyle;
  const focus = opts.focus?.trim();
  const style = read(opts.workspaceRoot) ?? generateAgentStyle(focus);

  const lines: string[] = [];
  lines.push('# AutoClaw Agent Scaffold');
  lines.push('');
  lines.push('_Prepend this to a new agent task to inject your learned style._');
  if (focus) {
    lines.push('');
    lines.push(`**Focus:** ${focus}`);
    lines.push('');
    lines.push(`When applying this style, emphasize learnings and patterns related to "${focus}".`);
  }
  lines.push('');
  lines.push(style.trim());
  lines.push('');
  return lines.join('\n');
}

function defaultReadAgentStyle(workspaceRoot: string): string | undefined {
  const paths = intelligencePaths(workspaceRoot);
  return safeReadFile(path.join(paths.root, 'agent-style.md'));
}
