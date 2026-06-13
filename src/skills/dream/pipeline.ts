/**
 * pipeline.ts — The `/dream` consolidation pipeline (C2).
 *
 * `/dream` is the asleep-side cycle (docs/V3_PLAN.md §2). It runs as a chain
 * of independently-testable *pure* stages:
 *
 *   1. extract        — pull candidate facts out of recent session transcripts
 *   2. dedupe         — drop candidates already present in the memory tiers
 *   3. conflictResolve— bi-temporal supersession of contradicting facts
 *   4. driftCheck     — flag facts referencing broken file paths / renamed symbols
 *   5. spider         — collect TODOs and `// AI:` / `# AI:` comments
 *   6. preSummarize   — pick files likely needed next session, summarise them
 *
 * Every stage is exported on its own and consumes/produces plain data, so a
 * test can exercise one stage in isolation. {@link runDreamPipeline} threads
 * them together. No fs / vscode / network — the caller supplies transcripts,
 * existing facts, and a code-index snapshot.
 *
 * Spec: docs/V3_PLAN.md §2 (Wake & Sleep), §6 Workstream C — task C2.
 */

import {
  type BitemporalFact,
  type NewFactInput,
  type Provenance,
  createFact,
  supersede,
} from '../../memory/bitemporalFact';

// ---------------------------------------------------------------------------
// Stage 1 — extract
// ---------------------------------------------------------------------------

/** A recent session transcript handed to the pipeline. */
export interface SessionTranscript {
  /** Stable id of the session (runner session id, Claude session id, …). */
  session_id: string;
  /** ISO8601 — when the session ended; used as the facts' `recorded_at`. */
  ended_at: string;
  /** Raw transcript text. */
  text: string;
}

/** A fact candidate before it is reconciled against existing memory. */
export interface FactCandidate {
  subject: string;
  content: string;
  /** ISO8601 — when the fact became true; defaults to the session end. */
  valid_from: string;
  recorded_at: string;
  source: string;
  /**
   * Optional provenance (MEM-1). Carried onto the created fact's `verified_by`.
   * Left absent by {@link extract} unless `withProvenance` is requested, so the
   * default pipeline output is byte-identical.
   */
  verified_by?: Provenance;
}

/**
 * Lines a transcript marks as durable facts. We look for an explicit
 * `FACT[subject]: content` convention plus `/note` capture echoes —
 * deliberately conservative so `/dream` never hallucinates memory from
 * conversational chatter.
 */
const FACT_LINE = /^\s*FACT\[([^\]]+)\]:\s*(.+)$/i;
const NOTE_ECHO = /^\s*(?:\/note|NOTE):\s*(.+)$/i;

/**
 * Stage 1 — extract candidate facts from recent transcripts. Pure: a
 * transcript with no `FACT[...]` / `NOTE:` markers yields nothing.
 *
 * When `withProvenance` is set, each candidate is stamped with session
 * provenance (`method: 'session'`); facts pulled from a transcript line are
 * genuinely session-verified. It is opt-in so the default output stays
 * byte-identical to pre-MEM-1 behavior.
 */
export function extract(
  transcripts: readonly SessionTranscript[],
  withProvenance = false,
): FactCandidate[] {
  const out: FactCandidate[] = [];
  for (const t of transcripts) {
    const provenance: Provenance | undefined = withProvenance
      ? { method: 'session', evidence: `session:${t.session_id}`, verified_at: t.ended_at }
      : undefined;
    for (const rawLine of t.text.split(/\r?\n/)) {
      const factMatch = rawLine.match(FACT_LINE);
      if (factMatch) {
        out.push({
          subject: factMatch[1].trim(),
          content: factMatch[2].trim(),
          valid_from: t.ended_at,
          recorded_at: t.ended_at,
          source: `session:${t.session_id}`,
          ...(provenance ? { verified_by: provenance } : {}),
        });
        continue;
      }
      const noteMatch = rawLine.match(NOTE_ECHO);
      if (noteMatch) {
        out.push({
          // A bare note has no explicit subject — key it on the note text so
          // /dream can still dedupe identical notes.
          subject: `note:${noteMatch[1].trim().slice(0, 48).toLowerCase()}`,
          content: noteMatch[1].trim(),
          valid_from: t.ended_at,
          recorded_at: t.ended_at,
          source: `session:${t.session_id}`,
          ...(provenance ? { verified_by: provenance } : {}),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — dedupe
// ---------------------------------------------------------------------------

/** Normalised key for comparing fact text — case/whitespace-insensitive. */
function contentKey(subject: string, content: string): string {
  return `${subject.trim().toLowerCase()}::${content.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * Stage 2 — drop candidates whose (subject, content) already exists among the
 * known facts, and collapse exact duplicates within the batch itself.
 */
export function dedupe(
  candidates: readonly FactCandidate[],
  existing: readonly BitemporalFact[],
): FactCandidate[] {
  const known = new Set(existing.map((f) => contentKey(f.subject, f.content)));
  const seen = new Set<string>();
  const out: FactCandidate[] = [];
  for (const c of candidates) {
    const key = contentKey(c.subject, c.content);
    if (known.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3 — conflict-resolve (bi-temporal supersession)
// ---------------------------------------------------------------------------

/** Produces a stable fact id from a candidate. Deterministic for tests. */
function factId(c: FactCandidate, ordinal: number): string {
  const slug = c.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `fact-${slug}-${c.recorded_at.replace(/[^0-9]/g, '').slice(0, 14)}-${ordinal}`;
}

/** Result of the conflict-resolution stage. */
export interface ConflictResolution {
  /** Brand-new facts (no existing fact for the subject). */
  created: BitemporalFact[];
  /** Newly created facts that supersede an existing fact. */
  successors: BitemporalFact[];
  /** Existing facts closed by a successor (`superseded_by` + `valid_to` set). */
  superseded: BitemporalFact[];
}

/**
 * Stage 3 — turn deduped candidates into bi-temporal facts, superseding any
 * existing *current* fact for the same subject whose content differs.
 *
 * A candidate whose content is identical to the current fact is dropped (it
 * carries no new information; dedupe usually catches it, but a candidate with
 * a newer `valid_from` reaches here). When the subject is unseen the candidate
 * becomes a fresh fact.
 */
export function conflictResolve(
  candidates: readonly FactCandidate[],
  existing: readonly BitemporalFact[],
): ConflictResolution {
  // Index the current (un-superseded) fact per subject.
  const currentBySubject = new Map<string, BitemporalFact>();
  for (const f of existing) {
    if (f.superseded_by !== null) {
      continue;
    }
    const prev = currentBySubject.get(f.subject);
    if (!prev || f.valid_from > prev.valid_from) {
      currentBySubject.set(f.subject, f);
    }
  }

  const created: BitemporalFact[] = [];
  const successors: BitemporalFact[] = [];
  const superseded: BitemporalFact[] = [];

  candidates.forEach((c, i) => {
    const input: NewFactInput = {
      id: factId(c, i),
      subject: c.subject,
      content: c.content,
      valid_from: c.valid_from,
      recorded_at: c.recorded_at,
      source: c.source,
      tier: 'recall',
      // Carry candidate provenance onto the fact; absent ⇒ left absent by createFact.
      verified_by: c.verified_by,
    };
    const fact = createFact(input);
    const prior = currentBySubject.get(c.subject);

    if (!prior) {
      created.push(fact);
      currentBySubject.set(c.subject, fact);
      return;
    }
    if (contentKey(prior.subject, prior.content) === contentKey(c.subject, c.content)) {
      return; // identical content — no conflict, no new fact
    }
    const res = supersede(prior, fact);
    superseded.push(res.superseded);
    successors.push(res.successor);
    currentBySubject.set(c.subject, res.successor);
  });

  return { created, successors, superseded };
}

// ---------------------------------------------------------------------------
// Stage 4 — drift-check
// ---------------------------------------------------------------------------

/** A snapshot of the current codebase, supplied by the caller. */
export interface CodeIndex {
  /** Forward-slashed repo-relative file paths that currently exist. */
  files: readonly string[];
  /** Symbol names (functions, classes, exports) currently defined. */
  symbols: readonly string[];
}

/** A single drift finding raised against a stored fact. */
export interface DriftFinding {
  fact_id: string;
  kind: 'broken_file_ref' | 'renamed_symbol';
  /** The path or symbol in the fact that no longer resolves. */
  reference: string;
  detail: string;
}

/** Matches repo-relative-ish paths inside fact text. */
const PATH_REF = /\b((?:src|test|tests|docs|skills|adapters|packages)\/[\w./-]+\.\w+)\b/g;
/** Matches `` `symbolName` `` back-tick code spans. */
const SYMBOL_REF = /`([A-Za-z_$][\w$]*)`/g;

/**
 * Stage 4 — check that file paths and back-ticked symbols mentioned in stored
 * facts still resolve against the current {@link CodeIndex}. Facts that drift
 * are reported, not auto-deleted (the plan: "surface drift loudly").
 */
export function driftCheck(
  facts: readonly BitemporalFact[],
  index: CodeIndex,
): DriftFinding[] {
  const fileSet = new Set(index.files.map((f) => f.replace(/\\/g, '/')));
  const symbolSet = new Set(index.symbols);
  const findings: DriftFinding[] = [];

  for (const fact of facts) {
    if (fact.superseded_by !== null) {
      continue; // historical facts are allowed to reference gone code
    }
    const text = `${fact.subject} ${fact.content}`;

    for (const m of text.matchAll(PATH_REF)) {
      const ref = m[1].replace(/\\/g, '/');
      if (!fileSet.has(ref)) {
        findings.push({
          fact_id: fact.id,
          kind: 'broken_file_ref',
          reference: ref,
          detail: `fact references "${ref}" which no longer exists`,
        });
      }
    }
    for (const m of text.matchAll(SYMBOL_REF)) {
      const ref = m[1];
      // Only flag identifier-shaped spans that look like code, not prose.
      if (ref.length >= 3 && !symbolSet.has(ref)) {
        findings.push({
          fact_id: fact.id,
          kind: 'renamed_symbol',
          reference: ref,
          detail: `fact references symbol \`${ref}\` not found in the current index`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Stage 5 — spider TODOs and AI comments
// ---------------------------------------------------------------------------

/** A workspace source file fed to the spider stage. */
export interface SourceFile {
  /** Forward-slashed repo-relative path. */
  path: string;
  content: string;
}

/** One actionable item found by the spider. */
export interface SpiderItem {
  file: string;
  line: number;
  kind: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'BUG' | 'AI';
  text: string;
}

/** TODO-family markers. */
const TODO_MARK = /\b(TODO|FIXME|HACK|XXX|BUG)\b\s*[:\-]?\s*(.*)$/;
/** `// AI:` and `# AI:` agent-directed comments. */
const AI_MARK = /(?:\/\/|#)\s*AI\s*[:\-]\s*(.*)$/;

/**
 * Stage 5 — spider TODO-family markers and `// AI:` / `# AI:` comments across
 * the supplied source files. Pure scan; the AI-comment regex is checked first
 * so an `// AI: TODO ...` line is classified as an AI directive.
 */
export function spider(files: readonly SourceFile[]): SpiderItem[] {
  const items: SpiderItem[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ai = lines[i].match(AI_MARK);
      if (ai) {
        items.push({ file: file.path, line: i + 1, kind: 'AI', text: ai[1].trim() });
        continue;
      }
      const todo = lines[i].match(TODO_MARK);
      if (todo) {
        items.push({
          file: file.path,
          line: i + 1,
          kind: todo[1].toUpperCase() as SpiderItem['kind'],
          text: todo[2].trim(),
        });
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Stage 6 — pre-summarize
// ---------------------------------------------------------------------------

/** A file flagged as likely-needed next session, with a cheap summary. */
export interface PreSummary {
  file: string;
  /** A short extractive summary — first non-trivial lines / signatures. */
  summary: string;
  /** Why this file was picked, for the cost ledger. */
  because: string;
}

/**
 * Stage 6 — pick files likely needed next session and produce a cheap
 * extractive summary for each. "Likely needed" = files that still carry open
 * spider items (TODO / AI), highest item-count first. Pure: no LLM call — the
 * summary is the file's leading export/comment lines.
 */
export function preSummarize(
  files: readonly SourceFile[],
  spiderItems: readonly SpiderItem[],
  limit = 5,
): PreSummary[] {
  const countByFile = new Map<string, number>();
  for (const it of spiderItems) {
    countByFile.set(it.file, (countByFile.get(it.file) ?? 0) + 1);
  }
  const ranked = [...countByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: PreSummary[] = [];
  for (const [filePath, count] of ranked) {
    const file = byPath.get(filePath);
    if (!file) {
      continue;
    }
    const interesting = file.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) =>
        /^(export |function |class |interface |type |\/\*\*|#|##)/.test(l),
      )
      .slice(0, 6);
    out.push({
      file: filePath,
      summary: interesting.join(' | ') || '(no signatures extracted)',
      because: `${count} open spider item(s) — likely revisited next session`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Micro-PR queue (opt-in)
// ---------------------------------------------------------------------------

/** One queued micro-PR candidate — a single well-scoped TODO. */
export interface MicroPrCandidate {
  /** The spider item the PR would address. */
  item: SpiderItem;
  /** Estimated line budget; candidates over the cap are not queued. */
  estimated_lines: number;
}

/**
 * Pick at most one micro-PR candidate from the spider results: a TODO-family
 * item (not an `AI:` directive) whose text is short enough to suggest a
 * single-edit fix. Opt-in — the caller decides whether to act on it.
 */
export function selectMicroPr(
  spiderItems: readonly SpiderItem[],
  maxLineBudget = 30,
): MicroPrCandidate | undefined {
  for (const item of spiderItems) {
    if (item.kind === 'AI' || item.text.length === 0) {
      continue;
    }
    // Heuristic line estimate: short, imperative TODOs are cheap.
    const estimated = Math.min(maxLineBudget, Math.ceil(item.text.length / 4));
    if (estimated <= maxLineBudget) {
      return { item, estimated_lines: estimated };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Everything the pipeline needs as input. */
export interface DreamInput {
  transcripts: readonly SessionTranscript[];
  /** Facts already in the memory tiers (all tiers). */
  existingFacts: readonly BitemporalFact[];
  /** Source files to spider + pre-summarize. */
  sourceFiles: readonly SourceFile[];
  /** Snapshot of the current codebase for drift-checking. */
  codeIndex: CodeIndex;
  /** Enable the opt-in micro-PR queue. Default false. */
  microPr?: boolean;
  /**
   * Stamp session provenance (MEM-1) on extracted candidates. Default false so
   * the pipeline output stays byte-identical unless provenance is requested.
   */
  withProvenance?: boolean;
}

/** The consolidated result of one `/dream` run. */
export interface DreamResult {
  candidates: FactCandidate[];
  deduped: FactCandidate[];
  resolution: ConflictResolution;
  drift: DriftFinding[];
  spiderItems: SpiderItem[];
  preSummaries: PreSummary[];
  microPr?: MicroPrCandidate;
  /** One-line-per-stage trace, for the activity feed. */
  trace: string[];
}

/**
 * Run the full `/dream` pipeline end to end. Each stage is also exported
 * individually for isolated testing; this function just threads them.
 */
export function runDreamPipeline(input: DreamInput): DreamResult {
  const trace: string[] = [];

  const candidates = extract(input.transcripts, input.withProvenance ?? false);
  trace.push(`extract: ${candidates.length} candidate(s) from ${input.transcripts.length} transcript(s)`);

  const deduped = dedupe(candidates, input.existingFacts);
  trace.push(`dedupe: ${deduped.length} kept, ${candidates.length - deduped.length} dropped`);

  const resolution = conflictResolve(deduped, input.existingFacts);
  trace.push(
    `conflictResolve: ${resolution.created.length} new, ` +
      `${resolution.successors.length} superseding, ` +
      `${resolution.superseded.length} closed`,
  );

  // Drift-check the existing facts plus anything just created/superseded.
  const factsForDrift = [
    ...input.existingFacts,
    ...resolution.created,
    ...resolution.successors,
  ];
  const drift = driftCheck(factsForDrift, input.codeIndex);
  trace.push(`driftCheck: ${drift.length} finding(s)`);

  const spiderItems = spider(input.sourceFiles);
  trace.push(`spider: ${spiderItems.length} TODO/AI item(s)`);

  const preSummaries = preSummarize(input.sourceFiles, spiderItems);
  trace.push(`preSummarize: ${preSummaries.length} file(s)`);

  const microPr = input.microPr ? selectMicroPr(spiderItems) : undefined;
  if (input.microPr) {
    trace.push(microPr ? `microPr: queued "${microPr.item.text}"` : 'microPr: no eligible TODO');
  }

  return { candidates, deduped, resolution, drift, spiderItems, preSummaries, microPr, trace };
}
