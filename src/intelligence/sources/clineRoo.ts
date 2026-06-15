/**
 * sources/clineRoo.ts — Tier-3 Cline / Roo Source Adapter (R4.1, default-off).
 *
 * Cline and its Roo Code fork are VS Code extensions that persist per-task chat
 * history under the editor's `globalStorage`, in the SAME task layout Kilo Code
 * uses:
 *   <userData>/User/globalStorage/<extId>/tasks/<taskId>/
 *     └── api_conversation_history.json   (Anthropic-style message array)
 * Covered extension ids:
 *   - `saoudrizwan.claude-dev`        (Cline)
 *   - `rooveterinaryinc.roo-cline`    (Roo Code)
 * Each task directory becomes one full {@link UnifiedSession}.
 *
 * Cross-OS: the editor `userData` base + globalStorage path resolution is reused
 * verbatim from kilocode.ts (env-derived, never hardcoded), probed across the
 * common VS Code-family forks. Honors the watermark via `ExtractOptions.sinceTs`
 * (R4.1); redaction (R5.2) at message-build time. Best-effort + host-free:
 * never throws — a missing store yields an unavailable hint and no sessions.
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
import { resolveExtensionStorageDirs, sessionFromTaskDir } from './kilocode';

const ADAPTER_ID = 'cline-roo';
const DISPLAY_NAME = 'Cline / Roo';

/** Extension ids whose task history shares the Cline layout. */
const EXTENSION_IDS: readonly string[] = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline'];

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: false,
  workspaceAttribution: false,
  incremental: true,
};

interface ClineRooOptions {
  /** Explicit globalStorage extension dir(s) (tests). Bypasses env resolution. */
  globalStorageDirs?: string[];
}

function safeExistsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

class ClineRooAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 3 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: ClineRooOptions;

  constructor(options: ClineRooOptions = {}) {
    this.options = options;
  }

  /** All candidate `<extDir>` task-history parents across editors + ids. */
  private extDirs(env: AdapterEnv): string[] {
    if (this.options.globalStorageDirs && this.options.globalStorageDirs.length > 0) {
      return this.options.globalStorageDirs;
    }
    const dirs: string[] = [];
    for (const extId of EXTENSION_IDS) {
      dirs.push(...resolveExtensionStorageDirs(env, extId));
    }
    return dirs;
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const present = this.extDirs(env).filter((d) => safeExistsDir(path.join(d, 'tasks')));
    if (present.length === 0) {
      return {
        available: false,
        locations: [],
        hint: `no Cline/Roo task history found in any VS Code globalStorage (${EXTENSION_IDS.join(', ')})`,
      };
    }
    return { available: true, locations: present.map((d) => toForwardSlash(d)) };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const env = this.env ?? defaultEnv();
    const project = env.workspaceRoot ? toForwardSlash(env.workspaceRoot) : undefined;
    let emitted = 0;
    for (const extDir of this.extDirs(env)) {
      const tasksDir = path.join(extDir, 'tasks');
      let taskDirs: string[] = [];
      try {
        taskDirs = fs
          .readdirSync(tasksDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(tasksDir, e.name))
          .sort();
      } catch {
        taskDirs = [];
      }
      for (const taskDir of taskDirs) {
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

/** Factory for the Tier-3 Cline / Roo adapter. */
export function createClineRooAdapter(options?: ClineRooOptions): SourceAdapter {
  return new ClineRooAdapter(options);
}
