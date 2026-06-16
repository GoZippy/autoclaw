/**
 * sources/continue.ts — Tier-3 Continue.dev Source Adapter (R4.1, default-off).
 *
 * Continue persists one JSON file per session under `~/.continue/sessions/`:
 *   ~/.continue/sessions/<sessionId>.json
 *     { sessionId, title, workspaceDirectory, history: [ { message: { role,
 *       content }, contextItems? }, ... ] }
 * (`sessions.json` in the same dir is the index, not a transcript — skipped.)
 * Each session file becomes one full {@link UnifiedSession} (messages + fenced
 * code blocks), tagged with the session's `workspaceDirectory`.
 *
 * Cross-OS (R2.4) via {@link AdapterEnv.homeDir} — never a hardcoded `~`/`/home`.
 * Honors the watermark via `ExtractOptions.sinceTs` against message/file
 * timestamps (R4.1); redaction (R5.2) at message-build time. Best-effort +
 * host-free: never throws — a missing store yields an unavailable hint and no
 * sessions.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AdapterCapabilities,
  AdapterEnv,
  ExtractOptions,
  MessageRole,
  SessionMessage,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { toForwardSlash } from '../paths';
import { coerceTs, firstString, makeMessage, makeProvenance, mapRole } from './parse';

const ADAPTER_ID = 'continue';
const DISPLAY_NAME = 'Continue';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: true,
  incremental: true,
};

interface ContinueOptions {
  /** Override the `~/.continue/sessions` dir (tests). */
  sessionsDir?: string;
}

/** Resolve the `~/.continue/sessions` directory from the env (cross-OS). */
export function continueSessionsDir(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.homeDir) {
    return undefined;
  }
  return path.join(env.homeDir, '.continue', 'sessions');
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

/** Flatten a Continue `content` value (string OR array of `{ type, text }`). */
function flattenContent(content: unknown): string {
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
    } else if (block && typeof block === 'object' && typeof (block as any).text === 'string') {
      parts.push((block as any).text);
    }
  }
  return parts.join('\n').trim();
}

/** List session json files, skipping the `sessions.json` index. */
function listSessionFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json') && f.toLowerCase() !== 'sessions.json')
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function messageFromItem(item: Record<string, unknown>): SessionMessage | undefined {
  // Continue history items wrap the turn under `message`; older shapes are flat.
  const msgObj =
    item.message && typeof item.message === 'object' && !Array.isArray(item.message)
      ? (item.message as Record<string, unknown>)
      : item;
  const content = msgObj.content ?? msgObj.text ?? msgObj.body;
  const text = flattenContent(content) || (firstString(msgObj, ['text', 'body', 'message']) ?? '');
  if (text.trim() === '') {
    return undefined;
  }
  const role: MessageRole = mapRole(msgObj.role ?? msgObj.type ?? msgObj.sender, 'assistant');
  const ts = coerceTs(msgObj.ts ?? msgObj.timestamp ?? item.ts ?? item.timestamp);
  return makeMessage(role, text, ts);
}

function sessionFromFile(file: string): UnifiedSession | undefined {
  const raw = readTextSafe(file);
  if (!raw || raw.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;

  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : obj && Array.isArray(obj.history)
      ? (obj.history as unknown[])
      : obj && Array.isArray(obj.messages)
        ? (obj.messages as unknown[])
        : [];

  const messages: SessionMessage[] = [];
  for (const it of items) {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      const m = messageFromItem(it as Record<string, unknown>);
      if (m) {
        messages.push(m);
      }
    }
  }
  if (messages.length === 0) {
    return undefined;
  }

  const sessionId =
    (obj && firstString(obj, ['sessionId', 'id'])) ?? path.basename(file, path.extname(file));
  const title = obj && firstString(obj, ['title']);
  const project = obj && firstString(obj, ['workspaceDirectory', 'workspace']);
  const started = messages.find((m) => typeof m.ts === 'number')?.ts ?? statMtime(file);

  return {
    id: `${ADAPTER_ID}:${sessionId}`,
    source: ADAPTER_ID,
    tool: DISPLAY_NAME,
    project: project ? toForwardSlash(project) : undefined,
    startedAt: started,
    title: title ?? `Continue session ${sessionId}`,
    messages,
    signals: { keptCode: [] },
    provenance: makeProvenance(ADAPTER_ID, toForwardSlash(file)),
  };
}

class ContinueAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 3 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: ContinueOptions;

  constructor(options: ContinueOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const dir = continueSessionsDir(env, this.options.sessionsDir);
    if (!dir) {
      return { available: false, locations: [], hint: 'could not resolve the home directory' };
    }
    if (!safeExistsDir(dir)) {
      return {
        available: false,
        locations: [],
        hint: `no Continue session store at ${toForwardSlash(dir)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(dir)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const dir = continueSessionsDir(env, this.options.sessionsDir);
    if (!dir || !safeExistsDir(dir)) {
      return;
    }
    let emitted = 0;
    for (const file of listSessionFiles(dir)) {
      const session = sessionFromFile(file);
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

/** Factory for the Tier-3 Continue.dev adapter. */
export function createContinueAdapter(options?: ContinueOptions): SourceAdapter {
  return new ContinueAdapter(options);
}
