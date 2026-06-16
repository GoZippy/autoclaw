/**
 * sources/kiro.ts — Tier-2 Kiro Source Adapter (R2.1, R2.3, default-off).
 *
 * Ingests local Kiro state into full {@link UnifiedSession}s (R2.2):
 *   - workspace spec docs under `<workspaceRoot>/.kiro/specs/<spec>/*.md`
 *     (requirements / design / tasks) → one session per spec, and
 *   - local Kiro chat logs under `~/.kiro/**` (`*.json` / `*.jsonl`) when present.
 *
 * Discovery MAY consult `kiro-cli chat --list-sessions` (R2.3) — a lazy,
 * try/catch-wrapped subprocess used only to enrich the availability hint; it is
 * never required and never throws into the run. The CLI has no GA machine-
 * readable transcript output (Kiro #5423), so transcripts come from local files.
 *
 * Cross-OS (R2.4) via {@link AdapterEnv.homeDir} / `workspaceRoot`; honors the
 * watermark via `ExtractOptions.sinceTs` against file mtimes (R4.1); tags every
 * session with the project; redaction (R5.2) at message-build time. Best-effort
 * + host-free: never throws.
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

const ADAPTER_ID = 'kiro';
const DISPLAY_NAME = 'Kiro';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: true,
  incremental: true,
};

interface KiroOptions {
  /** Override the workspace specs dir (tests). */
  specsDir?: string;
  /** Override the `~/.kiro` root (tests). */
  homeKiroDir?: string;
  /** Allow the best-effort `kiro-cli chat --list-sessions` probe (default on). */
  useCli?: boolean;
}

/** Resolve the workspace `.kiro/specs` directory from the env. */
export function kiroSpecsDir(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.workspaceRoot) {
    return undefined;
  }
  return path.join(env.workspaceRoot, '.kiro', 'specs');
}

/** Resolve the home `~/.kiro` directory from the env (cross-OS). */
export function kiroHomeDir(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.homeDir) {
    return undefined;
  }
  return path.join(env.homeDir, '.kiro');
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

/** Best-effort `kiro-cli chat --list-sessions`; returns ids or []. Never throws. */
function listCliSessions(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require('child_process');
    const out = cp.execFileSync('kiro-cli', ['chat', '--list-sessions'], {
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.split(/\s+/)[0]);
  } catch {
    return [];
  }
}

/** Build a session from one spec directory's markdown docs. */
function sessionFromSpec(specDir: string, project?: string): UnifiedSession | undefined {
  let files: string[];
  try {
    files = fs
      .readdirSync(specDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    return undefined;
  }
  if (files.length === 0) {
    return undefined;
  }

  const messages: SessionMessage[] = [];
  let started: number | undefined;
  for (const name of files) {
    const full = path.join(specDir, name);
    const raw = readTextSafe(full);
    if (!raw || raw.trim() === '') {
      continue;
    }
    const ts = statMtime(full);
    started = started === undefined ? ts : Math.min(started, ts);
    // Spec docs are authored assistant artifacts; code blocks captured by makeMessage.
    messages.push(makeMessage('assistant', `# ${name}\n\n${raw}`, ts));
  }
  if (messages.length === 0) {
    return undefined;
  }
  const specName = path.basename(specDir);
  const startedAt = started ?? Date.now();
  return {
    id: `${ADAPTER_ID}:spec:${specName}`,
    source: ADAPTER_ID,
    tool: DISPLAY_NAME,
    project,
    startedAt,
    title: `Kiro spec: ${specName}`,
    messages,
    signals: { keptCode: [] },
    provenance: makeProvenance(ADAPTER_ID, toForwardSlash(specDir)),
  };
}

/** Build a session from one local Kiro chat log (`.json` / `.jsonl`). */
function sessionFromChatLog(file: string, project?: string): UnifiedSession | undefined {
  const raw = readTextSafe(file);
  if (!raw || raw.trim() === '') {
    return undefined;
  }
  const ext = path.extname(file).toLowerCase();
  const messages: SessionMessage[] = [];

  const pushRecord = (rec: Record<string, unknown>): void => {
    const text = firstString(rec, ['text', 'content', 'body', 'message', 'prompt']);
    if (text === undefined) {
      return;
    }
    const role = mapRole(rec.role ?? rec.type ?? rec.sender ?? rec.author, 'assistant');
    const ts = coerceTs(rec.ts ?? rec.timestamp ?? rec.time);
    messages.push(makeMessage(role, text, ts));
  };

  if (ext === '.jsonl') {
    for (const rec of parseJsonl(raw)) {
      pushRecord(rec);
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
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).messages)
        ? (parsed as any).messages
        : [parsed];
    for (const r of records) {
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        pushRecord(r as Record<string, unknown>);
      }
    }
  }

  if (messages.length === 0) {
    return undefined;
  }
  const started =
    messages.find((m) => typeof m.ts === 'number')?.ts ?? statMtime(file);
  return {
    id: `${ADAPTER_ID}:chat:${path.basename(file)}`,
    source: ADAPTER_ID,
    tool: DISPLAY_NAME,
    project,
    startedAt: started,
    title: `Kiro chat ${path.basename(file)}`,
    messages,
    signals: { keptCode: [] },
    provenance: makeProvenance(ADAPTER_ID, toForwardSlash(file)),
  };
}

function listChatLogs(dir: string): string[] {
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
        // Skip the specs tree (handled separately) but walk chat/history dirs.
        if (ent.name === 'specs') {
          continue;
        }
        stack.push(full);
      } else if (ent.isFile() && /\.(jsonl|json)$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

class KiroAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 2 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: KiroOptions;

  constructor(options: KiroOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const specsDir = kiroSpecsDir(env, this.options.specsDir);
    const homeDir = kiroHomeDir(env, this.options.homeKiroDir);

    const locations: string[] = [];
    if (specsDir && safeExistsDir(specsDir)) {
      locations.push(toForwardSlash(specsDir));
    }
    if (homeDir && safeExistsDir(homeDir)) {
      locations.push(toForwardSlash(homeDir));
    }

    let hint: string | undefined;
    if (this.options.useCli !== false) {
      const ids = listCliSessions();
      if (ids.length > 0) {
        hint = `kiro-cli reports ${ids.length} session(s)`;
      }
    }

    if (locations.length === 0) {
      return {
        available: false,
        locations: [],
        hint: hint ?? 'no local Kiro specs or chat storage found',
      };
    }
    return { available: true, locations, hint };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const project = env.workspaceRoot ? toForwardSlash(env.workspaceRoot) : undefined;
    const passesSince = (ts: number): boolean =>
      typeof opts.sinceTs !== 'number' || ts >= opts.sinceTs;
    let emitted = 0;

    const tryYield = (session: UnifiedSession | undefined): UnifiedSession | undefined => {
      if (!session || !passesSince(session.startedAt)) {
        return undefined;
      }
      return session;
    };

    // 1. Workspace spec docs — one session per spec dir.
    const specsDir = kiroSpecsDir(env, this.options.specsDir);
    if (specsDir && safeExistsDir(specsDir)) {
      let specDirs: string[] = [];
      try {
        specDirs = fs
          .readdirSync(specsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(specsDir, e.name))
          .sort();
      } catch {
        specDirs = [];
      }
      for (const dir of specDirs) {
        const session = tryYield(sessionFromSpec(dir, project));
        if (session) {
          yield session;
          emitted++;
          if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
            return;
          }
        }
      }
    }

    // 2. Local Kiro chat logs under ~/.kiro (excluding the specs tree).
    const homeDir = kiroHomeDir(env, this.options.homeKiroDir);
    if (homeDir && safeExistsDir(homeDir)) {
      for (const file of listChatLogs(homeDir)) {
        const session = tryYield(sessionFromChatLog(file, project));
        if (session) {
          yield session;
          emitted++;
          if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
            return;
          }
        }
      }
    }
  }
}

function defaultEnv(): AdapterEnv {
  return { homeDir: '', platform: process.platform, env: {} };
}

/** Factory for the Tier-2 Kiro adapter. */
export function createKiroAdapter(options?: KiroOptions): SourceAdapter {
  return new KiroAdapter(options);
}
