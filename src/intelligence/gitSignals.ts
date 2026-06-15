/**
 * gitSignals.ts — git-validated kept/discarded enrichment for the AutoClaw
 * Intelligence Layer (Phase-2 intelligence-signal-and-rag, R1.1-R1.5).
 *
 * `enrichSessionsWithGitSignals` raises the trustworthiness of the learning
 * signal: instead of trusting "approved in chat", it correlates each session's
 * code blocks against the diffs of recent commits and marks a session
 * `gitKept` only when a structural match clears a configurable confidence
 * threshold. "Kept" then means "actually committed" (R1.1).
 *
 * Matching is structural + offline:
 *   - identifier overlap (function / class / const / def names declared in the
 *     code block that also appear in a commit's added lines), AND
 *   - line similarity (non-trivial source lines that re-appear as added lines).
 * The two are blended into a `[0,1]` confidence. A session is `gitKept` at or
 * above `minConfidence` and a `KeptCode` entry with `reason: 'git_commit'` is
 * appended so downstream ranking (see `ranking.ts`) and aggregation can prefer
 * it WITHOUT widening the shared {@link SessionSignals} contract.
 *
 * Constraints honored:
 *   - No `vscode` import — stays host-free / unit-testable.
 *   - The git invocation is injectable ({@link GitRunner}, reused from
 *     `ragCode.ts`) so tests run with a stub and need no real repository.
 *   - No git repo (or git failure) ⇒ sessions returned unchanged, never throws
 *     (R1.4).
 *   - Every persisted string (commit message, kept snippet) is run through
 *     {@link redactSecrets} first (R7.1).
 *   - The reference `HOME`-only home-dir lookup is replaced by
 *     {@link resolveHomeDir}, which honors both `HOME` and `USERPROFILE` (R1.5).
 */

import * as os from 'os';
import { execSync } from 'child_process';

import { LogFn } from './config';
import { redactSecrets } from './redact';
import { GitRunner } from './ragCode';
import { KeptCode, UnifiedSession } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link enrichSessionsWithGitSignals}. */
export interface GitSignalsOptions {
  /** How many days of history to scan for kept-code correlation. */
  lookbackDays: number;
  /** Minimum blended confidence `[0,1]` to mark a session `gitKept`. */
  minConfidence: number;
  /** Directory the git commands run in (the workspace / repo root). */
  cwd: string;
  /** Injectable git runner (defaults to a real `git` via execSync). */
  gitRunner?: GitRunner;
  /** Cap on commits scanned (newest first). Defaults to 50. */
  maxCommits?: number;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
}

/** A commit summary parsed from `git log`. */
export interface CommitInfo {
  hash: string;
  date: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Home directory (R1.5 — the reference used `process.env.HOME` only, which is
// undefined on Windows; honor `USERPROFILE` too and fall back to os.homedir()).
// ---------------------------------------------------------------------------

/**
 * Resolve the user's home directory cross-platform. Prefers an explicit `HOME`
 * (POSIX) or `USERPROFILE` (Windows) override, falling back to
 * `os.homedir()`. Fixes the reference path bug where only `HOME` was consulted,
 * breaking Claude-session discovery on Windows.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HOME || env.USERPROFILE;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv;
  }
  return os.homedir();
}

// ---------------------------------------------------------------------------
// Git helpers (injectable runner; never throws to callers)
// ---------------------------------------------------------------------------

/** Run a git command via the runner, returning trimmed stdout or `null`. */
function tryGit(runner: GitRunner, args: string, cwd: string): string | null {
  try {
    const out = runner(args, cwd);
    const trimmed = typeof out === 'string' ? out.trim() : '';
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/** True when `cwd` is inside a git work tree (R1.4 guard). */
function isGitRepo(runner: GitRunner, cwd: string): boolean {
  return tryGit(runner, 'rev-parse --is-inside-work-tree', cwd) === 'true';
}

/** Read recent commits over the lookback window, newest first. */
function getRecentCommits(
  runner: GitRunner,
  cwd: string,
  lookbackDays: number,
  maxCommits: number,
): CommitInfo[] {
  const days = lookbackDays > 0 ? lookbackDays : 1;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const raw = tryGit(
    runner,
    `log --since="${since}" --pretty=format:"%H|%ai|%s" -n ${maxCommits}`,
    cwd,
  );
  if (!raw) {
    return [];
  }
  const commits: CommitInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const [hash, date, ...msg] = trimmed.split('|');
    if (hash && hash.trim() !== '') {
      commits.push({
        hash: hash.trim(),
        date: (date ?? '').trim(),
        message: msg.join('|').trim(),
      });
    }
  }
  return commits;
}

/** Fetch a commit's diff with zero context lines for tight line matching. */
function getDiffForCommit(runner: GitRunner, cwd: string, hash: string): string {
  return tryGit(runner, `show ${hash} --no-color --unified=0`, cwd) ?? '';
}

// ---------------------------------------------------------------------------
// Structural matching
// ---------------------------------------------------------------------------

/** Declared function / class / const|let|var / def identifiers in a block. */
function extractIdentifiers(code: string): Set<string> {
  const ids = new Set<string>();
  const re =
    /(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && name.length > 3) {
      ids.add(name.toLowerCase());
    }
  }
  return ids;
}

/** Parse the `+`-prefixed added lines of a unified diff (excluding `+++`). */
function addedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push(line.slice(1).trim().toLowerCase());
    }
  }
  return out;
}

/**
 * Blend identifier overlap and line similarity into a `[0,1]` confidence that
 * `code` was committed in `diff`. Identifiers are the stronger structural
 * signal (weight 0.6); re-appearing source lines add the remaining 0.4.
 */
function matchScore(code: string, addedJoined: string, addedSet: ReadonlySet<string>): number {
  if (!code || addedJoined === '') {
    return 0;
  }

  const ids = extractIdentifiers(code);
  let idMatches = 0;
  for (const id of ids) {
    if (addedJoined.includes(id)) {
      idMatches++;
    }
  }
  const idScore = ids.size > 0 ? idMatches / ids.size : 0;

  const lines = code
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length >= 12);
  let lineMatches = 0;
  for (const l of lines) {
    if (addedSet.has(l) || addedJoined.includes(l)) {
      lineMatches++;
    }
  }
  const lineScore = lines.length > 0 ? lineMatches / lines.length : 0;

  const score = 0.6 * idScore + 0.4 * lineScore;
  return score < 0 ? 0 : score > 1 ? 1 : score;
}

/** All candidate code strings a session contributes (kept blocks + messages). */
function sessionCodeBlocks(session: UnifiedSession): string[] {
  const out: string[] = [];
  for (const k of session.signals?.keptCode ?? []) {
    if (k.code && k.code.trim() !== '') {
      out.push(k.code);
    }
  }
  for (const msg of session.messages ?? []) {
    for (const block of msg.codeBlocks ?? []) {
      if (block.code && block.code.trim() !== '') {
        out.push(block.code);
      }
    }
  }
  return out;
}

/** First non-empty line of a (redacted) block — a compact kept-code label. */
function snippetLabel(code: string): string {
  const redacted = redactSecrets(code);
  const first = redacted
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (first ?? redacted.trim()).slice(0, 200);
}

// ---------------------------------------------------------------------------
// enrichSessionsWithGitSignals (R1.1-R1.5)
// ---------------------------------------------------------------------------

/**
 * Enrich `sessions` in place with git-validated kept signals and return the
 * same array. For each session, the best structural match across recent
 * commits is computed; at or above `minConfidence` the session is marked
 * `gitKept` with its `gitKeptCommit`, and a redacted `KeptCode` entry with
 * `reason: 'git_commit'` (carrying the confidence) is appended so ranking and
 * aggregation can prefer committed code. Below threshold, `gitKept` is set
 * `false`. No git repo / git failure ⇒ sessions returned unchanged.
 *
 * @param sessions the (already deduped) sessions to enrich
 * @param opts     lookback window, confidence threshold, cwd, injectable runner
 * @returns the same `sessions` array, enriched
 */
export async function enrichSessionsWithGitSignals(
  sessions: UnifiedSession[],
  opts: GitSignalsOptions,
): Promise<UnifiedSession[]> {
  const log: LogFn = opts.log ?? (() => undefined);
  const runner = opts.gitRunner ?? defaultGitRunner;
  const cwd = opts.cwd;
  const maxCommits = opts.maxCommits && opts.maxCommits > 0 ? opts.maxCommits : 50;

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return sessions;
  }
  if (!isGitRepo(runner, cwd)) {
    log('gitSignals: no git repo detected; skipping kept-code enrichment');
    return sessions; // R1.4 — passthrough, no error
  }

  const commits = getRecentCommits(runner, cwd, opts.lookbackDays, maxCommits);
  if (commits.length === 0) {
    log('gitSignals: no commits in lookback window; nothing to correlate');
    return sessions;
  }

  // Pre-fetch + pre-parse diffs once (newest-first, capped for performance).
  const parsedDiffs = commits.slice(0, Math.min(commits.length, maxCommits)).map((commit) => {
    const diff = getDiffForCommit(runner, cwd, commit.hash);
    const added = addedLines(diff);
    return { commit, addedJoined: added.join('\n'), addedSet: new Set(added) };
  });

  let enriched = 0;
  for (const session of sessions) {
    const blocks = sessionCodeBlocks(session);
    if (blocks.length === 0) {
      continue; // nothing to correlate for this session
    }

    let bestScore = 0;
    let bestCommit: CommitInfo | null = null;
    let bestBlock = '';
    for (const { commit, addedJoined, addedSet } of parsedDiffs) {
      if (addedJoined === '') {
        continue;
      }
      for (const block of blocks) {
        const score = matchScore(block, addedJoined, addedSet);
        if (score > bestScore) {
          bestScore = score;
          bestCommit = commit;
          bestBlock = block;
        }
      }
    }

    if (!session.signals) {
      session.signals = { keptCode: [] };
    }
    if (bestScore >= opts.minConfidence && bestCommit) {
      session.signals.gitKept = true;
      session.signals.gitKeptCommit = {
        hash: bestCommit.hash,
        message: redactSecrets(bestCommit.message), // R7.1 — message may leak
      };
      // Record confidence via a typed KeptCode entry (the shared SessionSignals
      // contract carries kept confidence here, not as a separate scalar).
      const alreadyGitKept = (session.signals.keptCode ?? []).some(
        (k) => k.reason === 'git_commit',
      );
      if (!alreadyGitKept) {
        const entry: KeptCode = {
          code: snippetLabel(bestBlock),
          reason: 'git_commit',
          confidence: bestScore,
        };
        session.signals.keptCode = [...(session.signals.keptCode ?? []), entry];
      }
      enriched++;
    } else {
      session.signals.gitKept = false;
    }
  }

  log(`gitSignals: enriched ${enriched}/${sessions.length} session(s) with git-kept signals`);
  return sessions;
}

// ---------------------------------------------------------------------------
// Default git runner (real `git`, stderr suppressed) — mirrors ragCode.ts.
// ---------------------------------------------------------------------------

/** Default git runner — real `git` via execSync, stderr suppressed. */
const defaultGitRunner: GitRunner = (args, cwd) =>
  execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
