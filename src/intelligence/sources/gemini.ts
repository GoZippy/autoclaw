/**
 * sources/gemini.ts — Tier-2 Gemini CLI Source Adapter (R2.1, default-off).
 *
 * Reads the Gemini CLI data directory `~/.gemini/` — session/history/checkpoint
 * logs (`*.json` / `*.jsonl`, e.g. `~/.gemini/tmp/<hash>/logs.json`, chat
 * checkpoints) — and normalizes each into a full {@link UnifiedSession} (R2.2)
 * with messages + fenced code blocks.
 *
 * Cross-OS (R2.4) via {@link AdapterEnv.homeDir} — never a hardcoded `~`/`/home`.
 * Honors the watermark via `ExtractOptions.sinceTs` against file mtimes /
 * message timestamps (R4.1); tags every session with the project; redaction
 * (R5.2) at message-build time. Best-effort + host-free: never throws.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AdapterCapabilities,
  AdapterEnv,
  ExtractOptions,
  SessionMessage,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { toForwardSlash } from '../paths';
import {
  coerceTs,
  firstString,
  makeMessage,
  makeProvenance,
  mapRole,
  parseJsonl,
} from './parse';

const ADAPTER_ID = 'gemini';
const DISPLAY_NAME = 'Gemini CLI';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: false,
  incremental: true,
};

interface GeminiOptions {
  /** Override the `~/.gemini` root (tests). */
  geminiDir?: string;
}

/** Resolve the Gemini CLI data directory from the env (cross-OS). */
export function geminiDataDir(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.homeDir) {
    return undefined;
  }
  return path.join(env.homeDir, '.gemini');
}

function safeExistsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function statMtime(file: string): number {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return Date.now();
  }
}

function readTextSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Recursively collect Gemini log files, skipping config/non-log files. */
function listLogFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && /\.(jsonl|json)$/i.test(ent.name)) {
        // Skip obvious config/settings files — they are not transcripts.
        if (/^(settings|config|mcp_config|installation_id|user_id)\.json$/i.test(ent.name)) {
          continue;
        }
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Coerce one Gemini log record into a message (Gemini uses role `model`). */
function messageFromRecord(rec: Record<string, unknown>): SessionMessage | undefined {
  // Gemini history entries: { role: 'user'|'model', parts: [{text}] } or
  // { type, text/content }.
  let text = firstString(rec, ['text', 'content', 'body', 'message']);
  if (text === undefined && Array.isArray((rec as any).parts)) {
    const parts = (rec as any).parts as unknown[];
    const joined = parts
      .map((p) =>
        p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : '',
      )
      .filter((s) => s.length > 0)
      .join('\n');
    if (joined.trim() !== '') {
      text = joined;
    }
  }
  if (text === undefined) {
    return undefined;
  }
  const role = mapRole(rec.role ?? rec.type ?? rec.sender ?? rec.author, 'assistant');
  const ts = coerceTs(rec.ts ?? rec.timestamp ?? rec.time);
  return makeMessage(role, text, ts);
}

function sessionFromFile(file: string, project?: string): UnifiedSession | undefined {
  const raw = readTextSafe(file);
  if (!raw || raw.trim() === '') {
    return undefined;
  }
  const ext = path.extname(file).toLowerCase();
  const messages: SessionMessage[] = [];

  if (ext === '.jsonl') {
    for (const rec of parseJsonl(raw)) {
      const m = messageFromRecord(rec);
      if (m) {
        messages.push(m);
      }
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const records: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (Array.isArray((parsed as any).messages)
            ? (parsed as any).messages
            : Array.isArray((parsed as any).history)
              ? (parsed as any).history
              : [parsed])
        : [];
    for (const r of records) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        const m = messageFromRecord(r as Record<string, unknown>);
        if (m) {
          messages.push(m);
        }
      }
    }
  }

  if (messages.length === 0) {
    return undefined;
  }
  const started = messages.find((m) => typeof m.ts === 'number')?.ts ?? statMtime(file);
  return {
    id: `${ADAPTER_ID}:${path.basename(path.dirname(file))}:${path.basename(file)}`,
    source: ADAPTER_ID,
    tool: DISPLAY_NAME,
    project,
    startedAt: started,
    title: `Gemini session ${path.basename(file)}`,
    messages,
    signals: { keptCode: [] },
    provenance: makeProvenance(ADAPTER_ID, toForwardSlash(file)),
  };
}

class GeminiAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 2 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: GeminiOptions;

  constructor(options: GeminiOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const dir = geminiDataDir(env, this.options.geminiDir);
    if (!dir) {
      return { available: false, locations: [], hint: 'could not resolve the home directory' };
    }
    if (!safeExistsDir(dir)) {
      return {
        available: false,
        locations: [],
        hint: `no Gemini CLI data directory at ${toForwardSlash(dir)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(dir)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const dir = geminiDataDir(env, this.options.geminiDir);
    if (!dir || !safeExistsDir(dir)) {
      return;
    }
    const project = env.workspaceRoot ? toForwardSlash(env.workspaceRoot) : undefined;
    let emitted = 0;
    for (const file of listLogFiles(dir)) {
      const session = sessionFromFile(file, project);
      if (!session) {
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

function defaultEnv(): AdapterEnv {
  return { homeDir: '', platform: process.platform, env: {} };
}

/** Factory for the Tier-2 Gemini CLI adapter. */
export function createGeminiAdapter(options?: GeminiOptions): SourceAdapter {
  return new GeminiAdapter(options);
}
