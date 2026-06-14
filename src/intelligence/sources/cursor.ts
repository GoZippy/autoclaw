/**
 * sources/cursor.ts — Tier-2 Cursor Source Adapter (R1.3, default-disabled).
 *
 * Opens Cursor's `state.vscdb` SQLite store READ-ONLY via a lazy
 * `require('better-sqlite3')` wrapped in try/catch, so the degraded "no source"
 * path never needs the native module. Resolves the cross-OS Cursor location:
 *   - Windows : %APPDATA%/Cursor
 *   - macOS   : ~/Library/Application Support/Cursor
 *   - Linux   : ~/.config/Cursor
 * then `<base>/User/globalStorage/state.vscdb`.
 *
 * It scans `ItemTable` for chat-bearing keys, parses messages + fenced code
 * blocks, and infers `keptCode` from user-approval phrases. On ANY failure
 * (missing native module, missing DB, malformed data) discover() reports
 * unavailable + hint and extract() yields nothing — it NEVER throws.
 *
 * No `vscode` import; no work / native require at module load time.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AdapterCapabilities,
  AdapterEnv,
  ExtractOptions,
  KeptCode,
  MessageRole,
  SessionCodeBlock,
  SessionMessage,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { toForwardSlash } from '../paths';
import { extractCodeBlocks, makeMessage, makeProvenance, mapRole } from './parse';

const ADAPTER_ID = 'cursor';
const DISPLAY_NAME = 'Cursor';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: false,
  workspaceAttribution: false,
  incremental: false,
};

/** User phrases that signal approval of the preceding assistant suggestion. */
const APPROVAL_RE =
  /\b(lgtm|looks good|apply( (this|that|it))?|accept(ed)?|approv(e|ed)|ship it|merge it|use this|that works|yes,? (apply|do it|please)|perfect)\b/i;

interface CursorOptions {
  /** Explicit `state.vscdb` path (tests). Bypasses env-based resolution. */
  dbPath?: string;
}

/** Resolve the Cursor application-data base directory for the platform. */
export function resolveCursorBaseDir(env: AdapterEnv): string | undefined {
  const home = env.homeDir;
  switch (env.platform) {
    case 'win32': {
      const appData = env.env.APPDATA;
      if (appData && appData.trim() !== '') {
        return path.join(appData, 'Cursor');
      }
      if (home) {
        return path.join(home, 'AppData', 'Roaming', 'Cursor');
      }
      return undefined;
    }
    case 'darwin':
      return home ? path.join(home, 'Library', 'Application Support', 'Cursor') : undefined;
    default:
      // Linux + others
      if (env.env.XDG_CONFIG_HOME && env.env.XDG_CONFIG_HOME.trim() !== '') {
        return path.join(env.env.XDG_CONFIG_HOME, 'Cursor');
      }
      return home ? path.join(home, '.config', 'Cursor') : undefined;
  }
}

function resolveStateDb(env: AdapterEnv, options: CursorOptions): string | undefined {
  if (options.dbPath) {
    return options.dbPath;
  }
  const base = resolveCursorBaseDir(env);
  if (!base) {
    return undefined;
  }
  return path.join(base, 'User', 'globalStorage', 'state.vscdb');
}

/** Recursively collect message-like nodes from a parsed JSON value, in order. */
function collectMessages(value: unknown, out: SessionMessage[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMessages(item, out);
    }
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  const obj = value as Record<string, unknown>;

  const text = pickText(obj);
  if (text !== undefined && text.trim() !== '') {
    out.push(makeMessage(roleFromNode(obj), text));
    // A message node may still nest replies/children — keep walking those.
  }

  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child && typeof child === 'object') {
      collectMessages(child, out);
    }
  }
}

function pickText(obj: Record<string, unknown>): string | undefined {
  for (const k of ['text', 'content', 'richText', 'body', 'message']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') {
      return v;
    }
  }
  return undefined;
}

function roleFromNode(obj: Record<string, unknown>): MessageRole {
  // Cursor bubbles use `type: 1|2` or `type: 'user'|'ai'`; also `role`.
  const t = obj.type;
  if (typeof t === 'number') {
    return t === 1 ? 'user' : 'assistant';
  }
  return mapRole(obj.role ?? obj.type ?? obj.sender ?? obj.author, 'assistant');
}

/** Infer kept-code: code blocks in the assistant turn just before a user OK. */
function inferKeptCode(messages: SessionMessage[]): KeptCode[] {
  const kept: KeptCode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !APPROVAL_RE.test(m.text)) {
      continue;
    }
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role !== 'assistant') {
        continue;
      }
      const blocks: SessionCodeBlock[] = prev.codeBlocks ?? [];
      for (const b of blocks) {
        if (seen.has(b.code)) {
          continue;
        }
        seen.add(b.code);
        kept.push({ code: b.code, reason: 'user_approval', confidence: 0.7 });
      }
      break; // only the immediately-preceding assistant turn
    }
  }
  return kept;
}

class CursorAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 2 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: CursorOptions;

  constructor(options: CursorOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const dbPath = resolveStateDb(env, this.options);
    if (!dbPath) {
      return {
        available: false,
        locations: [],
        hint: 'could not resolve the Cursor data directory for this platform',
      };
    }
    let exists = false;
    try {
      exists = fs.existsSync(dbPath) && fs.statSync(dbPath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        available: false,
        locations: [],
        hint: `Cursor state database not found at ${toForwardSlash(dbPath)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(dbPath)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env;
    const dbPath = env
      ? resolveStateDb(env, this.options)
      : this.options.dbPath;
    if (!dbPath) {
      return;
    }

    let db: any;
    try {
      // Lazy require — better-sqlite3 is an optionalDependency (R1.3).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      // Missing native module or unreadable DB — degrade silently (no throw).
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    try {
      let rows: Array<{ key: string; value: unknown }> = [];
      try {
        rows = db
          .prepare(
            "SELECT key, value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%aiService%' OR key LIKE '%composer%' OR key LIKE '%aichat%'",
          )
          .all();
      } catch {
        rows = [];
      }

      let emitted = 0;
      for (const row of rows) {
        const value = typeof row.value === 'string' ? row.value : bufToString(row.value);
        if (!value) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
        const messages: SessionMessage[] = [];
        collectMessages(parsed, messages);
        if (messages.length === 0) {
          continue;
        }
        const startedAt = Date.now();
        emitted++;
        yield {
          id: `${ADAPTER_ID}:${row.key}`,
          source: ADAPTER_ID,
          tool: 'Cursor',
          startedAt,
          title: `Cursor chat (${row.key})`,
          messages,
          signals: { keptCode: inferKeptCode(messages) },
          provenance: makeProvenance(ADAPTER_ID, `${toForwardSlash(dbPath)}#${row.key}`),
        };
        if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
          break;
        }
      }
    } catch {
      // Any query/parse failure degrades to "no sessions" — never throws.
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function bufToString(value: unknown): string | undefined {
  try {
    if (value && typeof (value as any).toString === 'function') {
      const s = (value as any).toString('utf8');
      return typeof s === 'string' ? s : undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Factory for the Tier-2 Cursor adapter. */
export function createCursorAdapter(options?: CursorOptions): SourceAdapter {
  return new CursorAdapter(options);
}
