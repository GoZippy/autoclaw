/**
 * sources/claudeDesktop.ts — Tier-2 Claude Desktop Source Adapter (R2.1, off).
 *
 * Reads the desktop session store the `runner-claude-desktop` writes —
 * `<workspaceRoot>/.autoclaw/runners/claude-desktop-sessions.json` — which
 * indexes restart-safe session ids + metadata. For each indexed session it
 * resolves the matching full transcript under `~/.claude/projects` (the same
 * on-disk format Claude Code uses) and emits a complete {@link UnifiedSession}
 * (R2.2). When no transcript is found on disk, it still emits a thin session
 * from the stored prompt preview so the session is not lost.
 *
 * Cross-OS (R2.4) via {@link AdapterEnv.homeDir} / `workspaceRoot`; honors the
 * watermark via `ExtractOptions.sinceTs` against each session's last-activity
 * time (R4.1); tags every session with the project. Redaction (R5.2) is applied
 * at message-build time. Best-effort + host-free: never throws.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AdapterCapabilities,
  AdapterEnv,
  ExtractOptions,
  SourceAdapter,
  SourcePresence,
  UnifiedSession,
} from '../types';
import { toForwardSlash } from '../paths';
import { makeMessage, makeProvenance } from './parse';
import { claudeProjectsDir, readClaudeTranscript } from './claudeCode';

const ADAPTER_ID = 'claude-desktop';
const DISPLAY_NAME = 'Claude Desktop';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: true,
  incremental: true,
};

interface ClaudeDesktopOptions {
  /** Override the session-index path (tests). */
  indexPath?: string;
  /** Override the `~/.claude/projects` transcript root (tests). */
  projectsDir?: string;
}

interface DesktopSessionRecord {
  sessionId: string;
  context?: string;
  createdAt?: string;
  lastActivityAt?: string;
  promptPreview?: string;
}

/** Resolve the desktop session-index path from the env (cross-OS). */
export function desktopIndexPath(env: AdapterEnv, override?: string): string | undefined {
  if (override && override.trim() !== '') {
    return override;
  }
  if (!env.workspaceRoot) {
    return undefined;
  }
  return path.join(env.workspaceRoot, '.autoclaw', 'runners', 'claude-desktop-sessions.json');
}

function readIndex(indexPath: string): DesktopSessionRecord[] {
  let raw: string;
  try {
    if (!fs.existsSync(indexPath)) {
      return [];
    }
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const sessions =
      parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object'
        ? (parsed.sessions as Record<string, DesktopSessionRecord>)
        : undefined;
    if (!sessions) {
      return [];
    }
    return Object.values(sessions).filter(
      (r): r is DesktopSessionRecord => !!r && typeof r.sessionId === 'string',
    );
  } catch {
    return [];
  }
}

/** Locate the transcript file for a session id anywhere under the projects dir. */
function findTranscript(projectsDir: string | undefined, sessionId: string): string | undefined {
  if (!projectsDir) {
    return undefined;
  }
  const target = `${sessionId}.jsonl`;
  const stack = [projectsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name === target) {
        return full;
      }
    }
  }
  return undefined;
}

class ClaudeDesktopAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 2 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: ClaudeDesktopOptions;

  constructor(options: ClaudeDesktopOptions = {}) {
    this.options = options;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const indexPath = desktopIndexPath(env, this.options.indexPath);
    const projectsDir = claudeProjectsDir(env, this.options.projectsDir);

    const locations: string[] = [];
    if (indexPath && safeExists(indexPath)) {
      locations.push(toForwardSlash(indexPath));
    }
    if (projectsDir && safeExists(projectsDir)) {
      locations.push(toForwardSlash(projectsDir));
    }
    if (locations.length === 0) {
      return {
        available: false,
        locations: [],
        hint: indexPath
          ? `no Claude Desktop session index at ${toForwardSlash(indexPath)}`
          : 'no workspace root to locate the Claude Desktop session index',
      };
    }
    return { available: true, locations };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const indexPath = desktopIndexPath(env, this.options.indexPath);
    const projectsDir = claudeProjectsDir(env, this.options.projectsDir);
    if (!indexPath) {
      return;
    }

    const project = env.workspaceRoot ? toForwardSlash(env.workspaceRoot) : undefined;
    let emitted = 0;

    for (const record of readIndex(indexPath)) {
      const transcriptFile = findTranscript(projectsDir, record.sessionId);
      let session: UnifiedSession | undefined;

      if (transcriptFile) {
        session = readClaudeTranscript(transcriptFile, ADAPTER_ID, DISPLAY_NAME, project);
      }

      if (!session) {
        // No transcript on disk — emit a thin session from the index record so
        // the conversation is still represented.
        const started = parseIso(record.lastActivityAt ?? record.createdAt);
        const preview = record.promptPreview ?? '';
        if (preview.trim() === '') {
          continue;
        }
        session = {
          id: `${ADAPTER_ID}:${record.sessionId}`,
          source: ADAPTER_ID,
          tool: DISPLAY_NAME,
          project,
          startedAt: started,
          title: `${DISPLAY_NAME} session ${record.sessionId}`,
          messages: [makeMessage('user', preview, started)],
          signals: { keptCode: [] },
          provenance: makeProvenance(ADAPTER_ID, `${toForwardSlash(indexPath)}#${record.sessionId}`),
        };
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

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function parseIso(iso?: string): number {
  if (typeof iso === 'string') {
    const n = Date.parse(iso);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return Date.now();
}

function defaultEnv(): AdapterEnv {
  return { homeDir: '', platform: process.platform, env: {} };
}

/** Factory for the Tier-2 Claude Desktop adapter. */
export function createClaudeDesktopAdapter(options?: ClaudeDesktopOptions): SourceAdapter {
  return new ClaudeDesktopAdapter(options);
}
