/**
 * sources/kilocode.ts — Tier-3 Kilo Code Source Adapter (R4.1, default-off).
 *
 * Kilo Code is a VS Code extension; it persists per-task chat history under the
 * editor's `globalStorage`:
 *   <userData>/User/globalStorage/kilocode.kilo-code/tasks/<taskId>/
 *     ├── api_conversation_history.json   (Anthropic-style message array)
 *     └── ui_messages.json
 * Each task directory becomes one full {@link UnifiedSession} (messages + fenced
 * code blocks).
 *
 * Cross-OS (never a hardcoded path): the editor `userData` base is resolved the
 * same way cursor.ts resolves its base dir — from {@link AdapterEnv.platform} /
 * `homeDir` / `env` (APPDATA / XDG_CONFIG_HOME) — and probed across the common
 * VS Code-family forks (Code, Insiders, VSCodium, Cursor, Windsurf, Kiro).
 * Honors the incremental watermark via `ExtractOptions.sinceTs` (R4.1);
 * redaction (R5.2) at message-build time. Best-effort + host-free: never throws
 * — a missing store yields an unavailable hint and no sessions.
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
import { coerceTs, makeMessage, makeProvenance, mapRole } from './parse';

const ADAPTER_ID = 'kilocode';
const DISPLAY_NAME = 'Kilo Code';
const EXTENSION_ID = 'kilocode.kilo-code';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: false,
  workspaceAttribution: false,
  incremental: true,
};

/** Common VS Code-family application folders that host third-party extensions. */
const VSCODE_APP_FOLDERS: readonly string[] = [
  'Code',
  'Code - Insiders',
  'VSCodium',
  'Cursor',
  'Windsurf',
  'Kiro',
];

interface KilocodeOptions {
  /** Explicit globalStorage extension dir (tests). Bypasses env resolution. */
  globalStorageDir?: string;
}

/**
 * Resolve the candidate `<userData>/User/globalStorage` directories for every
 * supported VS Code-family editor on this platform. Cross-OS — derived from the
 * env, never a hardcoded `/home`. Exported for reuse by the Cline/Roo adapter.
 */
export function resolveVscodeGlobalStorageBases(env: AdapterEnv): string[] {
  const home = env.homeDir;
  const roots: string[] = [];
  switch (env.platform) {
    case 'win32': {
      const appData = env.env.APPDATA;
      if (appData && appData.trim() !== '') {
        roots.push(appData);
      } else if (home) {
        roots.push(path.join(home, 'AppData', 'Roaming'));
      }
      break;
    }
    case 'darwin':
      if (home) {
        roots.push(path.join(home, 'Library', 'Application Support'));
      }
      break;
    default:
      // Linux + others
      if (env.env.XDG_CONFIG_HOME && env.env.XDG_CONFIG_HOME.trim() !== '') {
        roots.push(env.env.XDG_CONFIG_HOME);
      }
      if (home) {
        roots.push(path.join(home, '.config'));
      }
      break;
  }
  const bases: string[] = [];
  for (const root of roots) {
    for (const app of VSCODE_APP_FOLDERS) {
      bases.push(path.join(root, app, 'User', 'globalStorage'));
    }
  }
  return bases;
}

/**
 * Resolve the per-editor extension storage dirs for `extensionId` (e.g. the
 * `tasks` parent). Returns an explicit override verbatim when supplied.
 */
export function resolveExtensionStorageDirs(
  env: AdapterEnv,
  extensionId: string,
  override?: string,
): string[] {
  if (override && override.trim() !== '') {
    return [override];
  }
  return resolveVscodeGlobalStorageBases(env).map((base) => path.join(base, extensionId));
}

function safeExistsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function statMtime(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
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

/**
 * Flatten an Anthropic-style `content` value (string OR array of typed blocks)
 * into plain text. `text` blocks pass through; `tool_use` / `tool_result`
 * render compactly. Shared shape used by Kilo Code, Cline and Roo.
 */
export function flattenBlockContent(content: unknown): string {
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
    if (typeof b.text === 'string' && b.text.trim() !== '') {
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
      parts.push(`[tool_result] ${flattenBlockContent(b.content)}`);
    }
  }
  return parts.join('\n').trim();
}

/** List `<extDir>/tasks/<taskId>` directories, sorted. */
function listTaskDirs(extDir: string): string[] {
  const tasksDir = path.join(extDir, 'tasks');
  try {
    return fs
      .readdirSync(tasksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(tasksDir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build a {@link UnifiedSession} from one task directory's
 * `api_conversation_history.json`. Exported so the Cline/Roo adapter reuses the
 * identical task-history format.
 */
export function sessionFromTaskDir(
  taskDir: string,
  adapterId: string,
  tool: string,
  project?: string,
): UnifiedSession | undefined {
  const histFile = path.join(taskDir, 'api_conversation_history.json');
  const raw = readTextSafe(histFile);
  if (!raw || raw.trim() === '') {
    return undefined;
  }
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
      : [];

  const messages: SessionMessage[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      continue;
    }
    const rec = r as Record<string, unknown>;
    const text = flattenBlockContent(rec.content ?? rec.text ?? rec.message);
    if (text.trim() === '') {
      continue;
    }
    const role: MessageRole = mapRole(rec.role ?? rec.type ?? rec.sender, 'assistant');
    const ts = coerceTs(rec.ts ?? rec.timestamp ?? rec.time);
    messages.push(makeMessage(role, text, ts));
  }
  if (messages.length === 0) {
    return undefined;
  }
  const taskId = path.basename(taskDir);
  const started = messages.find((m) => typeof m.ts === 'number')?.ts ?? statMtime(taskDir);
  return {
    id: `${adapterId}:${taskId}`,
    source: adapterId,
    tool,
    project,
    startedAt: started,
    title: `${tool} task ${taskId}`,
    messages,
    signals: { keptCode: [] },
    provenance: makeProvenance(adapterId, toForwardSlash(taskDir)),
  };
}

class KilocodeAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 3 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: KilocodeOptions;

  constructor(options: KilocodeOptions = {}) {
    this.options = options;
  }

  private extDirs(env: AdapterEnv): string[] {
    return resolveExtensionStorageDirs(env, EXTENSION_ID, this.options.globalStorageDir);
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const present = this.extDirs(env).filter((d) => safeExistsDir(path.join(d, 'tasks')));
    if (present.length === 0) {
      return {
        available: false,
        locations: [],
        hint: `no Kilo Code task history found in any VS Code globalStorage for ${EXTENSION_ID}`,
      };
    }
    return { available: true, locations: present.map((d) => toForwardSlash(d)) };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const project = env.workspaceRoot ? toForwardSlash(env.workspaceRoot) : undefined;
    let emitted = 0;
    for (const extDir of this.extDirs(env)) {
      for (const taskDir of listTaskDirs(extDir)) {
        const session = sessionFromTaskDir(taskDir, ADAPTER_ID, DISPLAY_NAME, project);
        if (!session) {
          continue;
        }
        if (typeof opts.sinceTs === 'number' && session.startedAt < opts.sinceTs) {
          continue;
        }
        yield session;
        emitted++;
        if (typeof opts.limit === 'number' && opts.limit > 0 && emitted >= opts.limit) {
          return;
        }
      }
    }
  }
}

function defaultEnv(): AdapterEnv {
  return { homeDir: '', platform: process.platform, env: {} };
}

/** Factory for the Tier-3 Kilo Code adapter. */
export function createKilocodeAdapter(options?: KilocodeOptions): SourceAdapter {
  return new KilocodeAdapter(options);
}
