/**
 * contextPack.ts — orchestrator "context pack" producer (Channel A delivery).
 *
 * A *context pack* is the single bundle of grounded intelligence the
 * orchestrator hands a newly-assigned agent so it starts work already grounded
 * in this project's real code, proven patterns, learned style, recent memory,
 * and durable knowledge-graph facts — independent of which runner picks it up
 * (Claude Code, Kiro, KiloCode, Cursor, Windsurf, Continue, Cline, Codex, …).
 *
 * Why a pack and not just `/rag-generate`: delivery is **file-based** — the
 * orchestrator writes `sprint-<N>-<agent>.context.md` next to the assignment
 * brief, so EVERY runner can read it (only some runners speak MCP). The same
 * data is also returned as a structured {@link ContextPackResult} suitable for
 * embedding under `Message.payload.intelligence` on a task assignment.
 *
 * Built on:
 *   - {@link generateRAGPrompt} — code + learnings + style + memory (R2.x).
 *   - the in-process Knowledge Graph — durable, project-scoped facts.
 *
 * Constraints (match the rest of the Intelligence Layer):
 *   - Host-free: no `vscode` import.
 *   - Project-namespace scoped via the underlying retrieval.
 *   - Degrade-safe: with no embeddings backend it STILL emits a useful pack
 *     from preferences.json + style + memory, and the KG falls back to
 *     full-text. Never throws on a degraded backend.
 *   - All external access is injectable so tests run fully offline.
 */

import { LogFn } from './config';
import { IntelligenceConfig } from './types';
import { resolveProjectKey } from './project';
import { RAGPromptResult, generateRAGPrompt } from './ragPrompt';
import type { Thought } from './kg/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the pack is being built for — drives the header and the task text. */
export interface ContextPackScope {
  /** Natural-language description of the work (drives retrieval + the header). */
  task: string;
  /** Agent the pack is for (e.g. `claude-code`). Used in the header + filename. */
  agentId?: string;
  /** Optional work-lane / role label (e.g. `coder`, `reviewer`). */
  role?: string;
  /** Sprint number, when this pack is for an orchestrated sprint. */
  sprint?: number;
  /** Task ids covered (e.g. `["B1","B2"]`). Shown in the header. */
  taskIds?: string[];
}

/** A single durable fact recalled from the Knowledge Graph. */
export interface KgFact {
  text: string;
  kind?: string;
}

/** Injectable seams. Defaults wire the real RAG + KG; tests pass stubs. */
export interface ContextPackDeps {
  /** Build the RAG section (defaults to {@link generateRAGPrompt}). */
  generateRAGPrompt?: (task: string) => Promise<RAGPromptResult>;
  /** Recall durable KG facts for the task (defaults to the in-process KG). */
  searchKgFacts?: (task: string, project: string) => Promise<KgFact[]>;
}

/** Options for {@link buildContextPack}. */
export interface ContextPackOptions {
  /** Directory that contains `.autoclaw`. */
  workspaceRoot: string;
  /** Max code chunks to include (forwarded to RAG). Defaults to 5. */
  maxCodeChunks?: number;
  /** Max learnings to include (forwarded to RAG). Defaults to 4. */
  maxLearnings?: number;
  /** Max KG facts to include. Defaults to 6. */
  maxKgFacts?: number;
  /** Include the agent style guide. Defaults to true. */
  includeStyle?: boolean;
  /** Include the recent memory summary. Defaults to true. */
  includeMemory?: boolean;
  /** ISO timestamp to stamp the pack with. Defaults to "now". */
  generatedAt?: string;
  /** Pre-resolved config (forwarded to RAG). Loaded from disk when omitted. */
  config?: IntelligenceConfig;
  /** Optional warning sink. */
  log?: LogFn;
  /** Injectable dependencies (tests / offline). */
  deps?: ContextPackDeps;
}

/** Result of {@link buildContextPack}. */
export interface ContextPackResult {
  /** The assembled, ready-to-read `sprint-<N>-<agent>.context.md` body. */
  markdown: string;
  /** The raw RAG prompt (without the KG section), for callers that want it. */
  ragPrompt: string;
  /** Durable facts recalled from the KG (possibly empty). */
  kgFacts: KgFact[];
  /** True when indexed code chunks were included (false in degraded mode). */
  usedCode: boolean;
  /** Number of code chunks included. */
  codeHits: number;
  /** Number of learnings included. */
  learningHits: number;
  /** Number of KG facts included. */
  kgHits: number;
  /** True when the vector backend was degraded/unavailable. */
  degraded: boolean;
  /** Human-readable notes (degraded-mode explanations, retrieval failures). */
  notes: string[];
  /** ISO timestamp the pack was stamped with. */
  generatedAt: string;
  /**
   * Compact, JSON-serializable summary suitable for `task_assign`
   * `payload.intelligence`. Excludes the (large) markdown body — the caller
   * writes that to a file and references it via `context_file`.
   */
  summary: ContextPackSummary;
}

/** Compact summary embedded in a task-assignment payload. */
export interface ContextPackSummary {
  task: string;
  agent_id?: string;
  role?: string;
  sprint?: number;
  task_ids?: string[];
  used_code: boolean;
  code_hits: number;
  learning_hits: number;
  kg_hits: number;
  degraded: boolean;
  notes: string[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_KG_FACTS = 6;
const KG_FACT_MAX = 280;

function noop(): void {
  /* no-op log */
}

/**
 * Demote every top-level (`# `) heading in `body` to `## ` so the embedding
 * pack keeps a single H1 — but ONLY outside fenced code blocks, so a `# comment`
 * line inside a ``` fence (and the embedded `agent-style.md` / code chunks) is
 * left untouched. Handles the RAG prompt's own H1 and any nested H1 (e.g. the
 * `# Agent Style Guide` that `agent-style.md` ships with).
 */
function demoteHeadingsOutsideFences(body: string): string {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && /^# /.test(line)) {
        return '#' + line;
      }
      return line;
    })
    .join('\n');
}

/**
 * Default KG recall: the in-process Knowledge Graph, project-scoped. Imported
 * lazily so this module stays load-time I/O-free and tests can inject without
 * pulling the KG/SQLite stack in. Never throws — a degraded KG returns `[]`.
 */
async function defaultSearchKgFacts(
  task: string,
  project: string,
  opts: ContextPackOptions,
): Promise<KgFact[]> {
  const max = opts.maxKgFacts ?? DEFAULT_MAX_KG_FACTS;
  try {
    // Lazy import keeps the KG/SQLite dependency off the hot path + out of tests.
    const { getKnowledgeGraph } = await import('./kg/service');
    const handle = getKnowledgeGraph({ workspaceRoot: opts.workspaceRoot });
    const thoughts = await handle.kg.searchSimilar(task, {
      k: max,
      project,
      includeText: true,
    });
    return thoughts
      .map((t: Thought): KgFact => ({ text: (t.text ?? '').trim(), kind: t.kind }))
      .filter((f: KgFact) => f.text !== '')
      .slice(0, max);
  } catch (err) {
    (opts.log ?? noop)(`context-pack: KG recall unavailable — ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// buildContextPack
// ---------------------------------------------------------------------------

/**
 * Assemble a context pack for `scope`. The RAG section (code + learnings +
 * style + memory) is built first, then durable KG facts are appended. Returns
 * the renderable markdown plus a compact summary for the assignment payload.
 * Degrade-safe: a missing vector backend yields a learnings/style/memory-only
 * pack; a missing KG simply omits the facts section.
 */
export async function buildContextPack(
  scope: ContextPackScope,
  opts: ContextPackOptions,
): Promise<ContextPackResult> {
  const log = opts.log ?? noop;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const project = resolveProjectKey(opts.workspaceRoot);

  const ragFn =
    opts.deps?.generateRAGPrompt ??
    ((task: string) =>
      generateRAGPrompt(task, {
        workspaceRoot: opts.workspaceRoot,
        maxCodeChunks: opts.maxCodeChunks,
        maxLearnings: opts.maxLearnings,
        includeStyle: opts.includeStyle,
        includeMemory: opts.includeMemory,
        config: opts.config,
        log,
      }));
  const kgFn =
    opts.deps?.searchKgFacts ??
    ((task: string, proj: string) => defaultSearchKgFacts(task, proj, opts));

  const rag = await ragFn(scope.task);

  let kgFacts: KgFact[] = [];
  try {
    kgFacts = await kgFn(scope.task, project);
  } catch (err) {
    log(`context-pack: KG recall failed — ${(err as Error).message}`);
  }
  const maxKg = opts.maxKgFacts ?? DEFAULT_MAX_KG_FACTS;
  kgFacts = kgFacts.slice(0, maxKg);

  const degraded = rag.notes.some((n) => /degraded/i.test(n)) || (!rag.usedCode && rag.codeHits === 0 && /unavailable/i.test(rag.notes.join(' ')));

  const markdown = renderContextPackMarkdown(scope, rag, kgFacts, generatedAt);

  const summary: ContextPackSummary = {
    task: scope.task,
    agent_id: scope.agentId,
    role: scope.role,
    sprint: scope.sprint,
    task_ids: scope.taskIds,
    used_code: rag.usedCode,
    code_hits: rag.codeHits,
    learning_hits: rag.learningHits,
    kg_hits: kgFacts.length,
    degraded,
    notes: rag.notes,
    generated_at: generatedAt,
  };

  return {
    markdown,
    ragPrompt: rag.prompt,
    kgFacts,
    usedCode: rag.usedCode,
    codeHits: rag.codeHits,
    learningHits: rag.learningHits,
    kgHits: kgFacts.length,
    degraded,
    notes: rag.notes,
    generatedAt,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the `sprint-<N>-<agent>.context.md` body. The RAG prompt's own H1 is
 * demoted to an H2 so the pack has a single top-level title, then KG facts and
 * a short "how to use this" footer are appended.
 */
export function renderContextPackMarkdown(
  scope: ContextPackScope,
  rag: RAGPromptResult,
  kgFacts: KgFact[],
  generatedAt: string,
): string {
  const titleBits: string[] = ['AutoClaw Context Pack'];
  if (typeof scope.sprint === 'number') {
    titleBits.push(`Sprint ${scope.sprint}`);
  }
  if (scope.agentId) {
    titleBits.push(scope.agentId);
  }

  const lines: string[] = [];
  lines.push(`# ${titleBits.join(' — ')}`);
  lines.push('');
  lines.push(
    `_Generated ${generatedAt}. Read this before you start: it grounds you in ` +
      `this project's real code, proven patterns, learned style, recent memory, ` +
      `and durable facts. These are retrieved hints, not authority — verify ` +
      `against the current code before relying on them._`,
  );
  lines.push('');
  if (scope.role) {
    lines.push(`**Role / lane:** ${scope.role}`);
  }
  if (scope.taskIds && scope.taskIds.length > 0) {
    lines.push(`**Tasks:** ${scope.taskIds.join(', ')}`);
  }
  lines.push('');

  // Embed the RAG body under one section, demoting every H1 outside code
  // fences so this file keeps a single top-level title. The RAG prompt's own
  // leading H1 becomes the section label.
  lines.push('## Grounded Context (RAG-retrieved)');
  lines.push('');
  const ragBody = demoteHeadingsOutsideFences(rag.prompt.replace(/^# .*\n/, ''));
  lines.push(ragBody.trim());
  lines.push('');

  lines.push('## Durable Knowledge-Graph Facts');
  lines.push('');
  if (kgFacts.length === 0) {
    lines.push('_No durable facts recorded for this project yet._');
  } else {
    for (const f of kgFacts) {
      const tag = f.kind ? `*(${f.kind})* ` : '';
      lines.push(`- ${tag}${f.text.slice(0, KG_FACT_MAX).replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
