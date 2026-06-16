/**
 * sources/generic.ts — Tier-3 Generic Export Source Adapter (R1.4, default-off).
 *
 * Reads a user-configured directory of conversation exports:
 *   - `.jsonl` — one JSON object per line, each a message-ish record
 *   - `.json`  — an array of messages, `{ messages: [...] }`, or a single doc
 *   - `.md`    — markdown transcript; fenced code blocks captured
 *
 * The directory is supplied via the factory `dir` option or the
 * `AUTOCLAW_GENERIC_SOURCE_DIR` environment variable. discover() reports
 * unavailable with a hint when no path is configured or it does not exist.
 * Best-effort and host-free: never throws.
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
import { coerceTs, firstString, makeMessage, makeProvenance, mapRole, parseJsonl } from './parse';

const ADAPTER_ID = 'generic';
const DISPLAY_NAME = 'Generic Export';
const ENV_DIR_KEY = 'AUTOCLAW_GENERIC_SOURCE_DIR';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: false,
  workspaceAttribution: false,
  incremental: false,
};

interface GenericOptions {
  /** Explicit export directory. Falls back to AUTOCLAW_GENERIC_SOURCE_DIR. */
  dir?: string;
}

function messageFromRecord(rec: Record<string, unknown>): SessionMessage | undefined {
  const text = firstString(rec, ['text', 'content', 'body', 'message']);
  if (text === undefined) {
    return undefined;
  }
  const role = mapRole(rec.role ?? rec.type ?? rec.sender ?? rec.author, 'assistant');
  const ts = coerceTs(rec.ts ?? rec.timestamp ?? rec.time);
  return makeMessage(role, text, ts);
}

function listExportFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(jsonl|json|md)$/i.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function readTextSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseFile(file: string): SessionMessage[] {
  const raw = readTextSafe(file);
  if (!raw || raw.trim() === '') {
    return [];
  }
  const ext = path.extname(file).toLowerCase();

  if (ext === '.jsonl') {
    const messages: SessionMessage[] = [];
    for (const rec of parseJsonl(raw)) {
      const msg = messageFromRecord(rec);
      if (msg) {
        messages.push(msg);
      }
    }
    return messages;
  }

  if (ext === '.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const records: unknown[] = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.messages)
        ? parsed.messages
        : [parsed];
    const messages: SessionMessage[] = [];
    for (const r of records) {
      if (isRecord(r)) {
        const msg = messageFromRecord(r);
        if (msg) {
          messages.push(msg);
        }
      }
    }
    return messages;
  }

  // Markdown — whole document as one assistant message (code blocks captured).
  return [makeMessage('assistant', raw)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class GenericAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 3 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: GenericOptions;

  constructor(options: GenericOptions = {}) {
    this.options = options;
  }

  private resolveDir(): string | undefined {
    if (this.options.dir && this.options.dir.trim() !== '') {
      return this.options.dir;
    }
    const fromEnv = this.env?.env[ENV_DIR_KEY];
    if (fromEnv && fromEnv.trim() !== '') {
      return fromEnv;
    }
    return undefined;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const dir = this.resolveDir();
    if (!dir) {
      return {
        available: false,
        locations: [],
        hint: `no export directory configured (set the factory dir option or ${ENV_DIR_KEY})`,
      };
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
        hint: `configured export directory does not exist: ${toForwardSlash(dir)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(dir)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const dir = this.resolveDir();
    if (!dir) {
      return;
    }
    let emitted = 0;
    for (const file of listExportFiles(dir)) {
      const messages = parseFile(file);
      if (messages.length === 0) {
        continue;
      }
      const startedAt =
        messages.find((m) => typeof m.ts === 'number')?.ts ?? statMtime(file);
      if (typeof opts.sinceTs === 'number' && startedAt < opts.sinceTs) {
        continue;
      }
      emitted++;
      yield {
        id: `${ADAPTER_ID}:${path.basename(file)}`,
        source: ADAPTER_ID,
        tool: 'Generic Export',
        startedAt,
        title: path.basename(file),
        messages,
        signals: { keptCode: [] },
        provenance: makeProvenance(ADAPTER_ID, toForwardSlash(file)),
      };
      if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
        break;
      }
    }
  }
}

function statMtime(file: string): number {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return Date.now();
  }
}

/** Factory for the Tier-3 generic export adapter. */
export function createGenericAdapter(options?: GenericOptions): SourceAdapter {
  return new GenericAdapter(options);
}
