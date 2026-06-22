/**
 * hostContext.ts — Channel C delivery: write an *ambient* project-context digest
 * into each detected host's rules/steering directory, in that host's auto-load
 * format, so file-only runners (Cursor, Windsurf, Continue, Cline/KiloCode,
 * Antigravity) get current project intel even outside an orchestrated task.
 *
 * The digest is one {@link buildContextPack} run (retrieved code + proven
 * patterns/learnings + learned style + recent memory + durable KG facts) wrapped
 * per host. The per-host wrappers mirror the static-skill adapters in
 * `scripts/adapters/*` (Cursor `.mdc`, Kiro/Windsurf frontmatter, Continue
 * `.prompt`, plain markdown for Cline/Antigravity) so the host loads it the same
 * way it loads AutoClaw's skills.
 *
 * Claude Code / Kiro / Cursor (MCP) and HTTP peers are already served live by
 * the `intelligence.contextPack` MCP tool + the `/api/v1/intelligence/context`
 * bridge route, so this channel targets the rules-dir hosts that lack live
 * access. We only write where the host's directory already exists (i.e. the host
 * is set up for this workspace) — never create a host's tree.
 *
 * Cross-platform: directories are composed with `path.join`, detection is by
 * `fs.existsSync`, and files are written with `\n` line endings (Node writes the
 * string verbatim on every OS; all target hosts accept LF). No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LogFn } from './config';
import { IntelligenceConfig } from './types';
import { ContextPackDeps, ContextPackResult, buildContextPack } from './contextPack';

/** Stable base name for the generated digest (host extension is appended). */
const DIGEST_BASENAME = 'autoclaw-project-context';

/** One-line description embedded in host frontmatter (kept colon-free for YAML safety). */
const DIGEST_DESCRIPTION =
  'AutoClaw project context — retrieved code patterns, proven conventions, ' +
  'learned style, recent memory, and durable facts for this repo';

/** The project-level task that drives the digest retrieval. */
const DIGEST_TASK =
  'Project conventions, recurring patterns, and durable context for new work in this repo';

type HostFormat = 'plain' | 'cursor' | 'kiro' | 'windsurf' | 'continue';

/** A resolved place to drop the digest for one host. */
export interface HostContextTarget {
  /** Host id (e.g. `cursor`, `cline`). */
  id: string;
  /** Absolute directory the file is written into. */
  dir: string;
  /** Absolute file path written. */
  file: string;
  /** Wrapper format applied to the digest body. */
  format: HostFormat;
}

/** Result of {@link writeHostContextFiles}. */
export interface WriteHostContextResult {
  /** Files actually written (host id + absolute path). */
  written: Array<{ id: string; path: string }>;
  /** Targets whose write failed (host id + error message). */
  failed: Array<{ id: string; error: string }>;
  /** How many host dirs were detected (set up for this workspace). */
  targetsDetected: number;
  /** True when the underlying pack was built in degraded mode. */
  degraded: boolean;
}

/** Options for {@link writeHostContextFiles}. */
export interface WriteHostContextOptions {
  /** Pre-resolved config (forwarded to the pack build). */
  config?: IntelligenceConfig;
  /** Optional warning sink. */
  log?: LogFn;
  /** Injectable pack dependencies (tests / offline). */
  deps?: ContextPackDeps;
  /** Override the detected target set (tests). */
  targets?: HostContextTarget[];
  /** Use a pre-built pack instead of building one (tests). */
  pack?: ContextPackResult;
  /**
   * Refresh-only mode: write a digest ONLY where one already exists (the user
   * previously opted in by running the command). Auto-refresh triggers
   * (`/learn`, `/index-code`) pass this so they keep existing digests current
   * without ever creating files as a surprise side effect.
   */
  onlyExisting?: boolean;
}

function noop(): void {
  /* no-op log */
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve which host rules/steering dirs exist for `workspaceRoot`. Only hosts
 * whose directory is already present are returned — we never create a host tree.
 * `.clinerules/` covers both Cline and KiloCode (KiloCode reads Cline rules).
 */
export function resolveHostContextTargets(workspaceRoot: string): HostContextTarget[] {
  const candidates: Array<{ id: string; dir: string; ext: string; format: HostFormat }> = [
    { id: 'cline', dir: path.join(workspaceRoot, '.clinerules'), ext: 'md', format: 'plain' },
    { id: 'cursor', dir: path.join(workspaceRoot, '.cursor', 'rules'), ext: 'mdc', format: 'cursor' },
    { id: 'kiro', dir: path.join(workspaceRoot, '.kiro', 'steering'), ext: 'md', format: 'kiro' },
    { id: 'windsurf', dir: path.join(workspaceRoot, '.windsurf', 'rules'), ext: 'md', format: 'windsurf' },
    { id: 'continue', dir: path.join(workspaceRoot, '.continue', 'prompts'), ext: 'prompt', format: 'continue' },
    { id: 'antigravity', dir: path.join(workspaceRoot, '.agent', 'rules'), ext: 'md', format: 'plain' },
  ];
  return candidates
    .filter((c) => dirExists(c.dir))
    .map((c) => ({
      id: c.id,
      dir: c.dir,
      file: path.join(c.dir, `${DIGEST_BASENAME}.${c.ext}`),
      format: c.format,
    }));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/**
 * Wrap a digest `body` in the host's auto-load format. Mirrors the per-host
 * transforms in `scripts/adapters/*` so the host treats the digest like an
 * AutoClaw skill rule.
 */
export function formatForHost(format: HostFormat, body: string): string {
  const name = DIGEST_BASENAME;
  const description = DIGEST_DESCRIPTION;
  switch (format) {
    case 'cursor':
      return ensureTrailingNewline(`---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}`);
    case 'kiro':
      return ensureTrailingNewline(
        `---\ninclusion: auto\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
      );
    case 'windsurf':
      return ensureTrailingNewline(
        `---\nname: ${name}\ndescription: ${description}\ntrigger: model_decision\n---\n\n${body}`,
      );
    case 'continue':
      return (
        `---\nname: ${name}\ndescription: ${description}\n---\n\n` +
        `<s>\n${body.trimEnd()}\n</s>\n\n` +
        `AutoClaw project context: {{{ input }}}\n`
      );
    case 'plain':
    default:
      return ensureTrailingNewline(`> ${description}\n\n${body}`);
  }
}

/**
 * Build the project digest once and write it into every detected host dir in the
 * host's format. Degrade-safe: a missing vector backend still yields a
 * learnings/style/memory digest. Per-file write failures are collected, never
 * thrown, so one unwritable host can't block the others.
 */
export async function writeHostContextFiles(
  workspaceRoot: string,
  opts: WriteHostContextOptions = {},
): Promise<WriteHostContextResult> {
  const log = opts.log ?? noop;
  let targets = opts.targets ?? resolveHostContextTargets(workspaceRoot);
  // Refresh-only: keep just the hosts that already have a digest on disk.
  if (opts.onlyExisting) {
    targets = targets.filter((t) => {
      try {
        return fs.statSync(t.file).isFile();
      } catch {
        return false;
      }
    });
  }
  const written: Array<{ id: string; path: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  if (targets.length === 0) {
    return { written, failed, targetsDetected: 0, degraded: false };
  }

  const pack =
    opts.pack ??
    (await buildContextPack(
      { task: DIGEST_TASK },
      {
        workspaceRoot,
        maxCodeChunks: 3,
        maxLearnings: 6,
        maxKgFacts: 8,
        config: opts.config,
        log,
        deps: opts.deps,
      },
    ));

  for (const t of targets) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      fs.writeFileSync(t.file, formatForHost(t.format, pack.markdown), 'utf8');
      written.push({ id: t.id, path: t.file });
    } catch (err) {
      failed.push({ id: t.id, error: (err as Error).message });
      log(`host-context: failed to write ${t.id} — ${(err as Error).message}`);
    }
  }

  return { written, failed, targetsDetected: targets.length, degraded: pack.degraded };
}
