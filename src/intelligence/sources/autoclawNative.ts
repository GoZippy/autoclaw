/**
 * sources/autoclawNative.ts — Tier-1 AutoClaw-native Source Adapter (R1.2).
 *
 * Reads the on-disk AutoClaw contract under `<workspaceRoot>/.autoclaw`:
 *   - orchestrator audit JSONL  (`.autoclaw/orchestrator/audit/*.jsonl`)
 *   - cross-agent comms bus     (`.autoclaw/comms/comms-log.jsonl`)
 *   - the board                 (`.autoclaw/board.json`)
 *   - KDream long-term memory   (`.autoclaw/kdream/memory/MEMORY.md`)
 *
 * Each source maps into one {@link UnifiedSession}. `SessionOutcome` is derived
 * from board/audit completion markers where available. Always-available adapter
 * (default-enabled): missing files yield an empty / unavailable hint, never a
 * throw.
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
  SessionOutcome,
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

const ADAPTER_ID = 'autoclaw-native';
const DISPLAY_NAME = 'AutoClaw Native';

const CAPABILITIES: AdapterCapabilities = {
  fullTranscripts: true,
  codeBlocks: true,
  timestamps: true,
  workspaceAttribution: true,
  incremental: true,
};

interface AutoclawNativeOptions {
  /** Override the `.autoclaw` root (tests). Defaults to env/opts workspace. */
  contractRoot?: string;
}

function readTextSafe(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function listJsonlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** Derive a session outcome from a board.json shape (best effort). */
function deriveBoardOutcome(board: unknown): SessionOutcome {
  if (!board || typeof board !== 'object') {
    return 'unknown';
  }
  const tasks: unknown[] = [];
  const b = board as Record<string, unknown>;
  for (const key of ['tasks', 'items', 'cards', 'columns']) {
    const v = b[key];
    if (Array.isArray(v)) {
      tasks.push(...v);
    }
  }
  if (tasks.length === 0) {
    return 'unknown';
  }
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (!t || typeof t !== 'object') {
      continue;
    }
    const status = String(
      firstString(t as Record<string, unknown>, ['status', 'state', 'column']) ?? '',
    ).toLowerCase();
    total++;
    if (/done|complete|shipped|merged|closed/.test(status)) {
      done++;
    }
  }
  if (total === 0) {
    return 'unknown';
  }
  return done >= total ? 'shipped' : 'unknown';
}

function auditOutcome(entries: Record<string, unknown>[]): SessionOutcome {
  for (const e of entries) {
    const blob = JSON.stringify(e).toLowerCase();
    if (/"(status|result|outcome)"\s*:\s*"(success|completed|done|shipped|merged)"/.test(blob)) {
      return 'shipped';
    }
    if (/"(status|result|outcome)"\s*:\s*"(failed|error|aborted|discarded)"/.test(blob)) {
      return 'discarded';
    }
  }
  return 'unknown';
}

class AutoclawNativeAdapter implements SourceAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;
  readonly tier = 1 as const;
  readonly capabilities = CAPABILITIES;

  private env?: AdapterEnv;
  private readonly options: AutoclawNativeOptions;

  constructor(options: AutoclawNativeOptions = {}) {
    this.options = options;
  }

  private resolveRoot(workspace?: string): string | undefined {
    if (this.options.contractRoot) {
      return this.options.contractRoot;
    }
    const root = workspace ?? this.env?.workspaceRoot;
    if (!root) {
      return undefined;
    }
    return path.join(root, '.autoclaw');
  }

  async discover(env: AdapterEnv): Promise<SourcePresence> {
    this.env = env;
    const root = this.resolveRoot(env.workspaceRoot);
    if (!root) {
      return { available: false, locations: [], hint: 'no workspace root to locate .autoclaw' };
    }
    let exists = false;
    try {
      exists = fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        available: false,
        locations: [],
        hint: `no .autoclaw directory at ${toForwardSlash(root)}`,
      };
    }
    return { available: true, locations: [toForwardSlash(root)] };
  }

  async *extract(opts: ExtractOptions): AsyncIterable<UnifiedSession> {
    const root = this.resolveRoot(opts.workspace);
    if (!root) {
      return;
    }

    const sinceTs = opts.sinceTs;
    const passesSince = (ts: number): boolean =>
      typeof sinceTs !== 'number' || ts >= sinceTs;

    // 1. Orchestrator audit JSONL — one session per file.
    const auditDir = path.join(root, 'orchestrator', 'audit');
    for (const file of listJsonlFiles(auditDir)) {
      const raw = readTextSafe(file);
      if (!raw) {
        continue;
      }
      const entries = parseJsonl(raw);
      if (entries.length === 0) {
        continue;
      }
      const messages: SessionMessage[] = [];
      let startedAt: number | undefined;
      let endedAt: number | undefined;
      for (const e of entries) {
        const ts = coerceTs(e.ts ?? e.timestamp ?? e.time);
        const text =
          firstString(e, ['message', 'text', 'content', 'summary', 'event', 'action']) ??
          JSON.stringify(e);
        const role = mapRole(e.role ?? e.actor ?? e.agent, 'system');
        messages.push(makeMessage(role, text, ts));
        if (typeof ts === 'number') {
          startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
          endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
        }
      }
      const started = startedAt ?? statMtime(file);
      if (!passesSince(started)) {
        continue;
      }
      yield {
        id: `${ADAPTER_ID}:audit:${path.basename(file)}`,
        source: ADAPTER_ID,
        tool: 'AutoClaw Orchestrator',
        startedAt: started,
        endedAt,
        title: `Orchestrator audit ${path.basename(file)}`,
        messages,
        signals: { keptCode: [], outcome: auditOutcome(entries) },
        provenance: makeProvenance(ADAPTER_ID, toForwardSlash(file)),
      };
    }

    // 2. Comms bus — one session.
    const commsFile = path.join(root, 'comms', 'comms-log.jsonl');
    const commsRaw = readTextSafe(commsFile);
    if (commsRaw) {
      const entries = parseJsonl(commsRaw);
      if (entries.length > 0) {
        const messages: SessionMessage[] = [];
        let startedAt: number | undefined;
        let endedAt: number | undefined;
        for (const e of entries) {
          const ts = coerceTs(e.ts ?? e.timestamp ?? e.time);
          const text =
            firstString(e, ['message', 'text', 'body', 'content', 'payload']) ?? JSON.stringify(e);
          const role = mapRole(e.role ?? e.from ?? e.sender, 'assistant');
          messages.push(makeMessage(role, text, ts));
          if (typeof ts === 'number') {
            startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
            endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
          }
        }
        const started = startedAt ?? statMtime(commsFile);
        if (passesSince(started)) {
          yield {
            id: `${ADAPTER_ID}:comms`,
            source: ADAPTER_ID,
            tool: 'AutoClaw Comms',
            startedAt: started,
            endedAt,
            title: 'Cross-agent comms',
            messages,
            signals: { keptCode: [] },
            provenance: makeProvenance(ADAPTER_ID, toForwardSlash(commsFile)),
          };
        }
      }
    }

    // 3. Board — one session carrying the derived outcome.
    const boardFile = path.join(root, 'board.json');
    const boardRaw = readTextSafe(boardFile);
    if (boardRaw) {
      let board: unknown;
      try {
        board = JSON.parse(boardRaw);
      } catch {
        board = undefined;
      }
      if (board) {
        const started = statMtime(boardFile);
        if (passesSince(started)) {
          yield {
            id: `${ADAPTER_ID}:board`,
            source: ADAPTER_ID,
            tool: 'AutoClaw Board',
            startedAt: started,
            title: 'Board snapshot',
            summary: 'AutoClaw board state',
            messages: [makeMessage('system', boardRaw, started)],
            signals: { keptCode: [], outcome: deriveBoardOutcome(board) },
            provenance: makeProvenance(ADAPTER_ID, toForwardSlash(boardFile)),
          };
        }
      }
    }

    // 4. KDream memory — one session.
    const memoryFile = path.join(root, 'kdream', 'memory', 'MEMORY.md');
    const memoryRaw = readTextSafe(memoryFile);
    if (memoryRaw && memoryRaw.trim() !== '') {
      const started = statMtime(memoryFile);
      if (passesSince(started)) {
        yield {
          id: `${ADAPTER_ID}:kdream-memory`,
          source: ADAPTER_ID,
          tool: 'KDream Memory',
          startedAt: started,
          title: 'KDream MEMORY.md',
          messages: [makeMessage('assistant', memoryRaw, started)],
          signals: { keptCode: [] },
          provenance: makeProvenance(ADAPTER_ID, toForwardSlash(memoryFile)),
        };
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

/** Factory for the Tier-1 AutoClaw-native adapter. */
export function createAutoclawNativeAdapter(options?: AutoclawNativeOptions): SourceAdapter {
  return new AutoclawNativeAdapter(options);
}
