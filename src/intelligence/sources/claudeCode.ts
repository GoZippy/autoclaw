/**
 * sources/claudeCode.ts — Tier-2 Claude Code Source Adapter (R2.1, default-off).
 *
 * Reads the Claude Code session store the runner already knows about —
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — and normalizes each
 * transcript file into one full {@link UnifiedSession} (messages + fenced code
 * blocks), NOT the summary-only `SessionSummary` the orchestrator uses (R2.2).
 *
 * Cross-OS (R2.4): the home directory comes from {@link AdapterEnv.homeDir} (the
 * fix for the reference `HOME`-only bug), never a hardcoded path. Each session is
 * tagged with the project decoded from the transcript's `cwd`. Honors the
 * incremental watermark via `ExtractOptions.sinceTs` (R4.1). Best-effort and
 * host-free: discovery + extraction NEVER throw — a missing store yields an
 * unavailable hint and no sessions.
 *
 * Redaction (R5.2) is applied at message-build time by {@link makeMessage}.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AdapterCapabilities,
  AdapterEnv,
  ExtractOptions,
  KeptCode,
  MessageRole,
  SessionMessage,
  SessionSignals,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { toForwardSlash } from '../paths';
import { redactSecrets } from '../redact';
import { coerceTs, makeMessage, makeProvenance, mapRole } from './parse';

const ADAPTER_ID = 'claude-code';
const DISPLAY_NAME = 'Claude Code';

/**
 * Tool names that write code to disk. A successful one (its `tool_result` is not
 * `is_error`) is an `applied_edit` kept signal; a session that ATTEMPTS edits but
 * has every one fail is treated as `discarded`. This transcript-derived outcome
 * signal (no git required) gives the workflow miner + effectiveness matrix both
 * a positive and a negative pole.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace']);

/** Max applied-edit code snippets retained per session (keeps memory bounded). */
const MAX_KEPT_PER_SESSION = 5;

/** One observed edit attempt: the tool_use id + a representative code snippet. */
interface EditAttempt {
  id?: string;
  code: string;
}

/** Pull the written code out of an edit tool's `input`, best-effort. */
function editCodeFromInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const i = input as Record<string, unknown>;
  if (typeof i.new_string === 'string') {
    return i.new_string;
  }
  if (typeof i.content === 'string') {
    return i.content;
  }
  if (typeof i.new_source === 'string') {
    return i.new_source;
  }
  if (Array.isArray(i.edits)) {
    // MultiEdit: concatenate each edit's replacement text.
    return i.edits
      .map((e) =>
        e && typeof e === 'object' && typeof (e as Record<string, unknown>).new_string === 'string'
          ? ((e as Record<string, unknown>).new_string as string)
          : '',
      )
      .filter((s) => s)
      .join('\n');
  }
  return '';
}

/**
 * Scan one message's `content` blocks for edit `tool_use` attempts and
 * `tool_result` outcomes, accumulating into the per-file collectors. A no-op
 * when `content` is a plain string (older transcripts) — those carry no
 * structured outcome and stay `unknown`.
 */
function scanOutcomeBlocks(
  content: unknown,
  edits: EditAttempt[],
  resultIsError: Map<string, boolean>,
): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string' && EDIT_TOOLS.has(b.name)) {
      edits.push({
        id: typeof b.id === 'string' ? b.id : undefined,
        code: editCodeFromInput(b.input),
      });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      resultIsError.set(b.tool_use_id, b.is_error === true);
    }
  }
}

/**
 * Collapse the per-file edit attempts + tool_result outcomes into
 * {@link SessionSignals}: applied edits become `applied_edit` kept signals
 * (⇒ shipped); a session whose edits ALL failed is `discarded`; a read-only
 * session (no edit attempts) stays `unknown`.
 */
function buildOutcomeSignals(
  edits: EditAttempt[],
  resultIsError: Map<string, boolean>,
): SessionSignals {
  const keptCode: KeptCode[] = [];
  let applied = 0;
  let failed = 0;
  for (const e of edits) {
    if (!e.id || !resultIsError.has(e.id)) {
      continue; // no matching result (truncated transcript) — ignore, don't guess
    }
    if (resultIsError.get(e.id) === true) {
      failed++;
      continue;
    }
    applied++;
    const code = e.code.trim();
    if (code && keptCode.length < MAX_KEPT_PER_SESSION) {
      keptCode.push({ code: redactSecrets(code), reason: 'applied_edit', confidence: 0.6 });
    }
  }

  const signals: SessionSignals = { keptCode };
  if (applied > 0) {
    if (keptCode.length === 0) {
      signals.outcome = 'shipped'; // edits landed but carried no capturable code
    }
  } else if (failed > 0) {
    signals.outcome = 'discarded'; // attempted edits, every one failed
  }
  return signals;
}

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: true,
  incremental: true,
};

interface ClaudeCodeOptions {
  /** Override the `~/.claude/projects` root (tests). */
  projectsDir?: string;
}

/** Resolve the Claude Code projects directory from the env (cross-OS). */
export function claudeProjectsDir(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.homeDir) {
    return undefined;
  }
  return path.join(env.homeDir, '.claude', 'projects');
}

/**
 * Flatten a Claude `message.content` value (string OR array of typed blocks)
 * into plain text. `text` blocks pass through; `tool_use` / `tool_result`
 * blocks are rendered compactly so the transcript stays faithful without
 * dumping raw tool payloads.
 */
export function flattenClaudeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    if (type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      let input = '';
      try {
        input = b.input !== undefined ? JSON.stringify(b.input) : '';
      } catch {
        input = '';
      }
      parts.push(`[tool_use ${name}${input ? ` ${input}` : ''}]`);
    } else if (type === 'tool_result') {
      parts.push(`[tool_result] ${flattenClaudeContent(b.content)}`);
    } else if (typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

function listJsonlRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listJsonlRecursive(full));
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out.sort();
}

function statMtime(file: string): number {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return Date.now();
  }
}

/**
 * Parse one Claude Code transcript `.jsonl` file into a {@link UnifiedSession}.
 * Returns `undefined` when the file holds no message lines. Exported so the
 * Claude Desktop adapter can reuse the identical transcript format.
 */
export function readClaudeTranscript(
  file: string,
  adapterId: string,
  tool: string,
  fallbackProject?: string,
): UnifiedSession | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  const messages: SessionMessage[] = [];
  // Transcript-derived outcome collectors: edit attempts + their result errors.
  const edits: EditAttempt[] = [];
  const resultIsError = new Map<string, boolean>();
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let project: string | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof rec.sessionId === 'string' && !sessionId) {
      sessionId = rec.sessionId;
    }
    if (typeof rec.cwd === 'string' && !project) {
      project = toForwardSlash(rec.cwd);
    }

    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type === 'summary' && typeof rec.summary === 'string' && !title) {
      title = rec.summary;
      continue;
    }

    const messageObj =
      rec.message && typeof rec.message === 'object' && !Array.isArray(rec.message)
        ? (rec.message as Record<string, unknown>)
        : undefined;
    if (!messageObj) {
      continue;
    }

    // Harvest structured edit attempts / results BEFORE the content is flattened
    // to text (the flatten step discards block types + tool_use ids).
    scanOutcomeBlocks(messageObj.content, edits, resultIsError);

    const role: MessageRole = mapRole(messageObj.role ?? rec.type, 'assistant');
    const text = flattenClaudeContent(messageObj.content);
    if (text.trim() === '') {
      continue;
    }
    const ts = coerceTs(rec.timestamp ?? rec.ts);
    messages.push(makeMessage(role, text, ts));
    if (typeof ts === 'number') {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
    }
  }

  if (messages.length === 0) {
    return undefined;
  }

  const started = startedAt ?? statMtime(file);
  const id = sessionId ?? path.basename(file, path.extname(file));
  return {
    id: `${adapterId}:${id}`,
    source: adapterId,
    tool,
    project: project ?? fallbackProject,
    startedAt: started,
    endedAt,
    title: title ?? `${tool} session ${id}`,
    messages,
    signals: buildOutcomeSignals(edits, resultIsError),
    provenance: makeProvenance(adapterId, toForwardSlash(file)),
  };
}

/**
 * Normalize a project/cwd path for comparison + grouping: forward slashes,
 * lower-cased drive letter (Windows `K:` vs `k:`), no trailing slash. Keeps the
 * rest of the path case intact so genuinely distinct repos stay distinct.
 */
export function normalizeProjectPath(p: string): string {
  let out = toForwardSlash(p).replace(/\/+$/, '');
  out = out.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return out;
}

/**
 * True when `sessionProject` (a session's cwd) belongs to `workspaceRoot` — an
 * exact match or a sub-directory. Used to scope `/learn` to the open workspace
 * so sessions from OTHER repos are never analyzed (and never git-validated
 * against the wrong repo).
 */
function sessionInWorkspace(sessionProject: string | undefined, workspaceRoot: string): boolean {
  if (!sessionProject) {
    return false;
  }
  const ws = normalizeProjectPath(workspaceRoot);
  const sp = normalizeProjectPath(sessionProject);
  return sp === ws || sp.startsWith(`${ws}/`);
}

class ClaudeCodeAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 2 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const dir = claudeProjectsDir(env, this.options.projectsDir);
    if (!dir) {
      return { available: false, locations: [], hint: 'could not resolve the home directory' };
    }
    let exists = false;
    try {
      exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        available: false,
        locations: [],
        hint: `no Claude Code session store at ${toForwardSlash(dir)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(dir)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const dir = claudeProjectsDir(this.env ?? defaultEnv(), this.options.projectsDir);
    if (!dir) {
      return;
    }
    // Scope to the open workspace when one is known, so /learn never analyzes (or
    // git-validates) sessions that belong to OTHER repos. With no workspaceRoot
    // (corpus-wide mining) every session is emitted with its real project.
    const workspaceRoot =
      this.env?.workspaceRoot && this.env.workspaceRoot.trim() !== ''
        ? this.env.workspaceRoot
        : undefined;
    let emitted = 0;
    for (const file of listJsonlRecursive(dir)) {
      const session = readClaudeTranscript(
        file,
        ADAPTER_ID,
        DISPLAY_NAME,
        this.env?.workspaceRoot,
      );
      if (!session) {
        continue;
      }
      if (workspaceRoot && !sessionInWorkspace(session.project, workspaceRoot)) {
        continue;
      }
      if (typeof opts.sinceTs === 'number' && session.startedAt < opts.sinceTs) {
        continue;
      }
      yield session;
      emitted++;
      if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
        break;
      }
    }
  }
}

/** Minimal env fallback so a bare extract() (no prior discover) still resolves. */
function defaultEnv(): AdapterEnv {
  return {
    homeDir: '',
    platform: process.platform,
    env: {},
  };
}

/** Factory for the Tier-2 Claude Code adapter. */
export function createClaudeCodeAdapter(options?: ClaudeCodeOptions): SourceAdapter {
  return new ClaudeCodeAdapter(options);
}
