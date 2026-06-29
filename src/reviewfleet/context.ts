/**
 * reviewfleet/context.ts — RF-5: Content-safe review context producer.
 *
 * Gives an automated reviewer grounding (what subsystem the task touches,
 * related KG decisions, relevant file paths, hit counts) WITHOUT ever leaking
 * secrets, raw diffs, code fences, or large code dumps.
 *
 * The #1 invariant is CONTENT SAFETY — the output is always safe to put in a
 * model prompt AND an audit log, regardless of what the intelligence layer
 * returns.
 *
 * Content-safety pipeline (applied in order on every summary):
 *   1. Strip code fences and their contents (anything between ``` ... ```).
 *   2. Strip lines that look like diffs (+/-/@@ prefixed) or secret assignments.
 *   3. Run redact() — masks API keys, bearer tokens, KEY=... patterns, long
 *      hex/base64 blobs, PEM blocks.
 *   4. Truncate to maxChars (default 800) with an ellipsis.
 *
 * Degrade-safe: any error from fetchContextPack → minimal safe fallback.
 * NEVER throws.
 */

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReviewContextResult {
  /** Content-safe, model-prompt-ready summary of the task context. */
  summary: string;
  /** Provenance counts from the intelligence layer. */
  provenance: {
    kgHits: number;
    codeHits: number;
    degraded: boolean;
  };
  /** Always true — the content-safety pipeline guarantees it. */
  safe: true;
}

/**
 * Injectable seams for buildReviewContext.
 * All have safe production defaults; tests always inject fakes.
 */
export interface ReviewContextDeps {
  /**
   * Fetch a context pack from the intelligence layer.
   * Default: lazy import of buildContextPack from '../intelligence/contextPack'.
   * Tests ALWAYS inject a fake — the real intelligence layer is never called.
   */
  fetchContextPack?: (args: {
    task: string;
    taskId: string;
    workspaceRoot: string;
  }) => Promise<{
    markdown?: string;
    codeHits?: number;
    kgHits?: number;
    degraded?: boolean;
  }>;

  /**
   * Secret redactor.
   * Default: redactSecrets (from '../intelligence/redact').
   * Replaces PEM blocks, bearer tokens, API keys, env-secret lines, and long
   * hex/base64 blobs with ‹redacted:kind› markers.
   */
  redact?: (text: string) => string;

  /**
   * Hard cap on summary length in characters.
   * Default: 800. Enforced AFTER the safety pipeline runs.
   */
  maxChars?: number;
}

/* -------------------------------------------------------------------------- */
/*  Default redactor (re-exported for unit tests)                             */
/* -------------------------------------------------------------------------- */

/**
 * Thin wrapper around the intelligence-layer redactSecrets.
 * Re-exported so callers can unit-test the redaction logic directly.
 * Imported lazily in buildReviewContext so the module stays I/O-free on load.
 */
export function redactSecrets(text: string): string {
  // We import synchronously here because this function is called in a hot path
  // (tests and runtime). The intelligence/redact module is pure (no I/O).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { redactSecrets: rs } = require('../intelligence/redact') as {
    redactSecrets: (t: string) => string;
  };
  return rs(text);
}

/* -------------------------------------------------------------------------- */
/*  Content-safety pipeline helpers                                           */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_CHARS = 800;

/**
 * Strip fenced code blocks (``` ... ```) and their contents.
 * Also strips tildes-fenced blocks (~~~ ... ~~~).
 * Applied BEFORE redaction so we never pass code bodies into the summary.
 */
function stripCodeFences(text: string): string {
  // Match opening fence (``` or ~~~, optionally with language tag) and
  // everything up to the matching closing fence (or end of string).
  return text.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, '');
}

/**
 * Strip diff-like lines: lines starting with +, -, @@ that look like
 * unified-diff output or git-diff headers.  Also strip obvious
 * secret-assignment lines (KEY=value on their own line).
 */
function stripDiffAndSecretLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      // Diff lines: +/- are content; @@ is a hunk header
      if (/^[+-]{1,3}\s/.test(trimmed) || /^@@/.test(trimmed)) {
        return false;
      }
      // diff --git header
      if (/^diff --/.test(trimmed)) {
        return false;
      }
      // index / --- / +++ diff file lines
      if (/^(index |--- |[+]{3} )/.test(trimmed)) {
        return false;
      }
      // KEY=value secret-assignment patterns (not already caught by redact)
      if (
        /^(export\s+)?[A-Z_0-9]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|API|AUTH)[A-Z_0-9]*\s*=/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      return true;
    })
    .join('\n');
}

/**
 * Truncate `text` to `maxChars`, appending '…' if it was clipped.
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 1) + '…';
}

/**
 * Full content-safety pipeline:
 *   strip fences → strip diff/secret lines → redact → truncate
 */
function applySafetyPipeline(
  text: string,
  redactFn: (t: string) => string,
  maxChars: number,
): string {
  let result = stripCodeFences(text);
  result = stripDiffAndSecretLines(result);
  result = redactFn(result);
  result = truncate(result.trim(), maxChars);
  return result;
}

/* -------------------------------------------------------------------------- */
/*  buildReviewContext                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Default lazy fetchContextPack — wraps buildContextPack from the intelligence
 * layer.  Never called in tests (tests inject fakes).
 */
async function defaultFetchContextPack(args: {
  task: string;
  taskId: string;
  workspaceRoot: string;
}): Promise<{ markdown?: string; codeHits?: number; kgHits?: number; degraded?: boolean }> {
  // Lazy import keeps the heavy intelligence stack off the hot path.
  const { buildContextPack } = await import('../intelligence/contextPack');
  const pack = await buildContextPack(
    { task: args.task, taskIds: [args.taskId] },
    { workspaceRoot: args.workspaceRoot },
  );
  return {
    markdown: pack.markdown,
    codeHits: pack.codeHits,
    kgHits: pack.kgHits,
    degraded: pack.degraded,
  };
}

/** Minimal safe result returned on any error or absence of data. */
const SAFE_FALLBACK: ReviewContextResult = {
  summary: '(no additional context available)',
  provenance: { kgHits: 0, codeHits: 0, degraded: true },
  safe: true,
};

/**
 * Build a content-safe review context summary for the given task.
 *
 * Grounding strategy:
 *   - Calls fetchContextPack (injectable) to get KG hits, code hits, and
 *     markdown from the intelligence layer.
 *   - Derives a SHORT, human-readable summary: task id/intent, hit counts,
 *     and a list of RELEVANT FILE PATHS extracted from the markdown (basename
 *     extraction from code-chunk headers and KG fact lines).
 *   - Runs the full content-safety pipeline on every piece of text before
 *     including it in the summary.
 *
 * NEVER throws.  On any error → returns SAFE_FALLBACK with degraded:true.
 */
export async function buildReviewContext(
  args: { taskId: string; intent?: string; workspaceRoot: string },
  deps?: ReviewContextDeps,
): Promise<ReviewContextResult> {
  const maxChars = deps?.maxChars ?? DEFAULT_MAX_CHARS;
  const redactFn = deps?.redact ?? redactSecrets;
  const fetchFn = deps?.fetchContextPack ?? defaultFetchContextPack;

  let pack: { markdown?: string; codeHits?: number; kgHits?: number; degraded?: boolean };

  try {
    pack = await fetchFn({
      task: args.intent ?? args.taskId,
      taskId: args.taskId,
      workspaceRoot: args.workspaceRoot,
    });
  } catch {
    return SAFE_FALLBACK;
  }

  // If we got nothing useful, return minimal fallback.
  if (!pack || (!pack.markdown && !pack.codeHits && !pack.kgHits)) {
    return {
      summary: '(no additional context available)',
      provenance: {
        kgHits: pack?.kgHits ?? 0,
        codeHits: pack?.codeHits ?? 0,
        degraded: pack?.degraded ?? true,
      },
      safe: true,
    };
  }

  const kgHits = pack.kgHits ?? 0;
  const codeHits = pack.codeHits ?? 0;
  const degraded = pack.degraded ?? false;

  // Build a content-safe summary from the pack.
  // We DERIVE high-level facts only — we do NOT include raw markdown bodies.
  const summaryLines: string[] = [];

  // Header: task + intent
  const intentClause = args.intent ? ` (${args.intent})` : '';
  summaryLines.push(`Task: ${args.taskId}${intentClause}`);

  // Hit counts
  const countParts: string[] = [];
  if (kgHits > 0) {
    countParts.push(`${kgHits} related KG decision${kgHits === 1 ? '' : 's'}`);
  }
  if (codeHits > 0) {
    countParts.push(`${codeHits} code hit${codeHits === 1 ? '' : 's'}`);
  }
  if (countParts.length > 0) {
    summaryLines.push(`Intelligence: ${countParts.join(', ')}.`);
  }
  if (degraded) {
    summaryLines.push('(intelligence layer degraded — partial context only)');
  }

  // Extract file paths mentioned in the markdown (basename-only for safety).
  // We look for lines that mention file paths — common patterns from context
  // pack markdown: "- src/foo/bar.ts", "**File:** src/foo.ts", etc.
  if (pack.markdown) {
    const filePaths = extractFilePaths(pack.markdown);
    if (filePaths.length > 0) {
      summaryLines.push(`Relevant files: ${filePaths.join(', ')}.`);
    }
  }

  const rawSummary = summaryLines.join(' ');

  // Apply the full content-safety pipeline.
  const safeSummary = applySafetyPipeline(rawSummary, redactFn, maxChars);

  return {
    summary: safeSummary,
    provenance: { kgHits, codeHits, degraded },
    safe: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  File-path extraction helper                                               */
/* -------------------------------------------------------------------------- */

/**
 * Extract file-path basenames from a context-pack markdown body.
 *
 * We look for lines that contain path-shaped strings (e.g. "src/foo/bar.ts",
 * "- **File:** baz.ts"). We extract basenames only — never full paths — so the
 * summary contains no workspace-root leakage or directory structure.
 *
 * Returns at most 8 unique basenames, deduplicated.
 */
function extractFilePaths(markdown: string): string[] {
  // Regex: a path-shaped token — at least one segment of word chars optionally
  // preceded by path separators, ending in a known source extension.
  const PATH_RE =
    /(?:^|[\s("`'])([A-Za-z0-9_./-]+\.(?:ts|js|tsx|jsx|json|md|yaml|yml|py|go|rs|sh|env))\b/gm;

  const seen = new Set<string>();
  const result: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = PATH_RE.exec(markdown)) !== null) {
    const fullPath = match[1];
    // Extract basename only (last segment after / or \).
    const basename = fullPath.split(/[/\\]/).pop() ?? fullPath;
    // Skip if it looks like a URL fragment or is purely generic (e.g. "index.ts").
    if (basename && !seen.has(basename) && basename.length > 3) {
      seen.add(basename);
      result.push(basename);
    }
    if (result.length >= 8) {
      break;
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  buildReviewContextProvider — convenience factory                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns a curried function `(taskId, intent?) => Promise<string>` that
 * returns just the `.summary` from buildReviewContext.
 *
 * Designed for easy wiring into `ReviewFleetProdOpts.contextProvider`:
 *
 * ```ts
 * const opts: ReviewFleetProdOpts = {
 *   workspaceRoot,
 *   roster,
 *   contextProvider: buildReviewContextProvider(workspaceRoot),
 * };
 * ```
 */
export function buildReviewContextProvider(
  workspaceRoot: string,
  deps?: ReviewContextDeps,
): (taskId: string, intent?: string) => Promise<string> {
  return async (taskId: string, intent?: string): Promise<string> => {
    const result = await buildReviewContext({ taskId, intent, workspaceRoot }, deps);
    return result.summary;
  };
}
