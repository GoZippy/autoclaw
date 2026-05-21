/**
 * install.ts — `autoclaw mcp install`: cross-host MCP registry writer (BP2).
 *
 * One command wires the `autoclaw-mcp` stdio server into every detected
 * AI host on the machine. Each host speaks the same `mcpServers` JSON shape
 * (RFC §1) — just at a different path — so the writer is a per-host
 * detect → read → merge → write loop.
 *
 * Design constraints (RFC §6):
 *   - Idempotent: re-running with an already-present, identical entry is a
 *     no-op and reports `unchanged`. Re-running never duplicates or reorders
 *     other servers / unknown keys (round-trip safe).
 *   - Detection mirrors `autoclaw doctor`: a host counts as installed if its
 *     CLI is on `$PATH` OR its config directory exists.
 *   - Kiro is never edited on disk — it is registered via `kiro-cli mcp add`
 *     (RFC §6.2). When `kiro-cli` is absent we report `not-installed`.
 *   - Workspace-scoped by default; `--global` opts up to the user-global
 *     registry path (RFC §5).
 *
 * Self-contained: no imports from src/orchestrator or src/comms — the MCP
 * slice stays independently buildable and fast.
 *
 * Sprint 2 — BP2 (WA-3)
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Install scope — workspace (per-project, write tools allowed) or global. */
export type InstallScope = 'workspace' | 'global';

/** Per-host outcome of an install attempt. */
export type InstallOutcome = 'added' | 'unchanged' | 'updated' | 'not-installed' | 'error';

/** Identifier for each host the writer knows about. */
export type HostId =
  | 'claude-code'
  | 'cursor'
  | 'antigravity'
  | 'kiro'
  | 'gemini-cli'
  | 'continue'
  | 'cline'
  | 'windsurf';

/** One row of the install report. */
export interface InstallResult {
  host: HostId;
  outcome: InstallOutcome;
  /** Registry path written (or that would be written); empty for Kiro. */
  path: string;
  /** Human-readable detail — error text, or `via kiro-cli mcp add`, etc. */
  detail: string;
}

/** Options controlling an install run. */
export interface InstallOptions {
  /** Install scope. Default `workspace`. */
  scope?: InstallScope;
  /** Overwrite an existing `autoclaw` entry whose value differs. Default false. */
  force?: boolean;
  /** Absolute path to the workspace root. Default `process.cwd()`. */
  workspaceRoot?: string;
  /** Absolute path to the user home directory. Default `os.homedir()`. */
  home?: string;
  /**
   * Absolute path to the `autoclaw-mcp` server entry point that hosts will
   * `node`-spawn. Default: this module's sibling `server.js` in `out/`.
   */
  serverPath?: string;
  /** Process env, used for host detection (`$PATH`). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Runs `kiro-cli mcp add ...`. Injectable for tests. Default shells out.
   * Resolves `{ ok, detail }` — `ok:false` ⇒ reported as `not-installed`.
   */
  kiroAdd?: (args: string[]) => Promise<{ ok: boolean; detail: string }>;
}

/** The `mcpServers.autoclaw` entry the writer merges into each registry. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Server entry construction
// ---------------------------------------------------------------------------

/** Default path to the built MCP server: sibling `server.js` of this module. */
function defaultServerPath(): string {
  // At runtime this file is `out/mcp/install.js`; the server is `server.js`
  // next to it. At test time (ts-node / mocha over src) it resolves under
  // `src/mcp/` — still a stable sibling reference either way.
  return path.join(__dirname, 'server.js');
}

/**
 * Build the canonical `mcpServers.autoclaw` value (RFC §6.3). The `env`
 * carries the scope so the spawned server enables/denies write tools.
 */
export function buildServerEntry(serverPath: string, scope: InstallScope): McpServerEntry {
  return {
    command: 'node',
    args: [serverPath],
    env: { AUTOCLAW_MCP_SCOPE: scope },
  };
}

/** Structural equality of two server entries (ignores key order). */
export function serverEntriesEqual(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
  if (!a) {
    return false;
  }
  if (a.command !== b.command) {
    return false;
  }
  if (!Array.isArray(a.args) || a.args.length !== b.args.length) {
    return false;
  }
  for (let i = 0; i < b.args.length; i++) {
    if (a.args[i] !== b.args[i]) {
      return false;
    }
  }
  const ae = a.env ?? {};
  const be = b.env ?? {};
  const keys = new Set([...Object.keys(ae), ...Object.keys(be)]);
  for (const k of keys) {
    if (ae[k] !== be[k]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Host registry descriptors
// ---------------------------------------------------------------------------

/**
 * Where a host keeps its config, and how it is detected. `cliNames` are
 * binaries searched on `$PATH`; `configDirs` are directories whose presence
 * also counts as "installed" (RFC §6.1).
 */
interface HostDescriptor {
  id: HostId;
  /** Resolve the MCP registry file for the given scope. Null = no file (Kiro). */
  registryPath: (scope: InstallScope, home: string, workspaceRoot: string) => string | null;
  /** CLI binary names that, if on PATH, mark the host as installed. */
  cliNames: string[];
  /** Config directories whose existence marks the host as installed. */
  configDirs: (home: string) => string[];
  /** Key under which `mcpServers` lives for nested-config hosts (Continue). */
  serversKey?: string;
}

/** All hosts `autoclaw mcp install` knows about (RFC §6.2, V3_PLAN §5). */
const HOSTS: HostDescriptor[] = [
  {
    id: 'claude-code',
    registryPath: (scope, home, ws) =>
      scope === 'global'
        ? path.join(home, '.claude', 'settings.json')
        : path.join(ws, '.claude', 'settings.json'),
    cliNames: ['claude'],
    configDirs: home => [path.join(home, '.claude')],
  },
  {
    id: 'cursor',
    // Cursor uses ~/.cursor/mcp.json for both scopes; workspace scope uses
    // <ws>/.cursor/mcp.json when present.
    registryPath: (scope, home, ws) =>
      scope === 'global'
        ? path.join(home, '.cursor', 'mcp.json')
        : path.join(ws, '.cursor', 'mcp.json'),
    cliNames: ['cursor-agent', 'cursor'],
    configDirs: home => [path.join(home, '.cursor')],
  },
  {
    id: 'antigravity',
    // Antigravity's MCP registry is user-global only (see V3_PLAN §4).
    registryPath: (_scope, home) =>
      path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    cliNames: ['antigravity'],
    configDirs: home => [path.join(home, '.gemini', 'antigravity')],
  },
  {
    id: 'kiro',
    // No file edit — registered via `kiro-cli mcp add` (RFC §6.2).
    registryPath: () => null,
    cliNames: ['kiro-cli', 'kiro'],
    configDirs: home => [path.join(home, '.kiro')],
  },
  {
    id: 'gemini-cli',
    registryPath: (_scope, home) => path.join(home, '.gemini', 'settings.json'),
    cliNames: ['gemini'],
    configDirs: home => [path.join(home, '.gemini')],
  },
  {
    id: 'continue',
    registryPath: (_scope, home) => path.join(home, '.continue', 'config.json'),
    cliNames: ['continue'],
    configDirs: home => [path.join(home, '.continue')],
  },
  {
    id: 'cline',
    registryPath: (_scope, home) => path.join(home, '.cline', 'mcp_settings.json'),
    cliNames: ['cline'],
    configDirs: home => [path.join(home, '.cline')],
  },
  {
    id: 'windsurf',
    registryPath: (_scope, home) => path.join(home, '.windsurf', 'mcp_config.json'),
    cliNames: ['windsurf'],
    configDirs: home => [path.join(home, '.codeium', 'windsurf'), path.join(home, '.windsurf')],
  },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** True if `name` (or `name.cmd`/`name.exe` on Windows) is on `$PATH`. */
function isOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const rawPath = env.PATH ?? env.Path ?? '';
  if (!rawPath) {
    return false;
  }
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        fs.accessSync(candidate, fs.constants.F_OK);
        return true;
      } catch {
        // keep scanning
      }
    }
  }
  return false;
}

/** True if any of `dirs` exists as a directory. */
function anyDirExists(dirs: string[]): boolean {
  for (const dir of dirs) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        return true;
      }
    } catch {
      // keep scanning
    }
  }
  return false;
}

/** A host is "detected" if a CLI is on PATH or a config dir exists (RFC §6.1). */
export function detectHost(
  host: HostDescriptor,
  env: NodeJS.ProcessEnv,
  home: string
): boolean {
  if (host.cliNames.some(n => isOnPath(n, env))) {
    return true;
  }
  return anyDirExists(host.configDirs(home));
}

// ---------------------------------------------------------------------------
// Registry file merge (the idempotent core)
// ---------------------------------------------------------------------------

/** Strip a UTF-8 BOM, then JSON.parse. Returns null on any error. */
function parseJsonSafe(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Merge the `autoclaw` server entry into one host registry file.
 *
 * Round-trip safe: reads the existing JSON, mutates only `mcpServers.autoclaw`
 * (creating the `mcpServers` object if absent), and writes the whole document
 * back with 2-space indent. All other servers and unknown keys are preserved.
 *
 * Outcomes:
 *  - `added`     — no `autoclaw` entry existed; one was written.
 *  - `unchanged` — an identical entry already existed (idempotent no-op).
 *  - `updated`   — a differing entry existed and `force` was set.
 *  - `error`     — a differing entry existed and `force` was NOT set, or the
 *                  existing file was unparseable.
 */
export async function mergeRegistryFile(
  filePath: string,
  entry: McpServerEntry,
  opts: { force: boolean; serversKey?: string }
): Promise<{ outcome: InstallOutcome; detail: string }> {
  const serversKey = opts.serversKey ?? 'mcpServers';

  let doc: Record<string, unknown> = {};
  let fileExisted = false;
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    fileExisted = true;
    const parsed = parseJsonSafe(raw);
    if (parsed === null) {
      // Refuse to clobber a file we cannot understand.
      return { outcome: 'error', detail: 'existing config is not valid JSON; left untouched' };
    }
    doc = parsed;
  } catch {
    // File absent — we will create it.
  }

  const serversRaw = doc[serversKey];
  const servers: Record<string, unknown> =
    serversRaw && typeof serversRaw === 'object' && !Array.isArray(serversRaw)
      ? (serversRaw as Record<string, unknown>)
      : {};

  const existing = servers.autoclaw as McpServerEntry | undefined;

  if (existing && serverEntriesEqual(existing, entry)) {
    return { outcome: 'unchanged', detail: fileExisted ? 'entry already present' : '' };
  }

  let outcome: InstallOutcome;
  if (existing) {
    if (!opts.force) {
      return {
        outcome: 'error',
        detail: 'a different autoclaw entry exists; re-run with --force to overwrite',
      };
    }
    outcome = 'updated';
  } else {
    outcome = 'added';
  }

  servers.autoclaw = entry;
  doc[serversKey] = servers;

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  return { outcome, detail: outcome === 'updated' ? 'overwrote differing entry' : '' };
}

// ---------------------------------------------------------------------------
// Kiro — registered via the CLI, never by file edit
// ---------------------------------------------------------------------------

/** Default `kiro-cli mcp add` invocation. Best-effort: never throws. */
function defaultKiroAdd(args: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise(resolve => {
    execFile('kiro-cli', args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, detail: (stderr || err.message || '').trim() || 'kiro-cli failed' });
      } else {
        resolve({ ok: true, detail: 'via kiro-cli mcp add' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run `autoclaw mcp install` across every host.
 *
 * Detects each host, then for stdio-config hosts merges the `autoclaw` server
 * entry into the registry file; for Kiro, shells out to `kiro-cli mcp add`.
 * Returns one {@link InstallResult} per host — the table the CLI prints.
 *
 * Pure with respect to inputs: pass `home` / `workspaceRoot` / `kiroAdd` to
 * exercise it deterministically in tests.
 */
export async function installAll(opts: InstallOptions = {}): Promise<InstallResult[]> {
  const scope: InstallScope = opts.scope ?? 'workspace';
  const force = opts.force ?? false;
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const serverPath = opts.serverPath ?? defaultServerPath();
  const kiroAdd = opts.kiroAdd ?? defaultKiroAdd;

  const entry = buildServerEntry(serverPath, scope);
  const results: InstallResult[] = [];

  for (const host of HOSTS) {
    const detected = detectHost(host, env, home);

    if (!detected) {
      results.push({
        host: host.id,
        outcome: 'not-installed',
        path: '',
        detail: 'not detected (no CLI on PATH, no config dir)',
      });
      continue;
    }

    // Kiro: CLI-managed, no file edit.
    if (host.id === 'kiro') {
      const kiroArgs = [
        'mcp', 'add',
        '--name', 'autoclaw',
        '--command', 'node',
        '--args', serverPath,
        '--scope', scope,
      ];
      try {
        const r = await kiroAdd(kiroArgs);
        results.push({
          host: 'kiro',
          outcome: r.ok ? 'added' : 'not-installed',
          path: '',
          detail: r.detail,
        });
      } catch (err) {
        results.push({
          host: 'kiro',
          outcome: 'error',
          path: '',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const registryPath = host.registryPath(scope, home, workspaceRoot);
    if (!registryPath) {
      results.push({
        host: host.id,
        outcome: 'not-installed',
        path: '',
        detail: 'no registry path for this host',
      });
      continue;
    }

    try {
      const { outcome, detail } = await mergeRegistryFile(registryPath, entry, {
        force,
        serversKey: host.serversKey,
      });
      results.push({ host: host.id, outcome, path: registryPath, detail });
    } catch (err) {
      results.push({
        host: host.id,
        outcome: 'error',
        path: registryPath,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const OUTCOME_GLYPH: Record<InstallOutcome, string> = {
  added: '✓', // ✓
  updated: '✓',
  unchanged: '✓',
  'not-installed': '-',
  error: '✗', // ✗
};

/**
 * Render the install results as the human-readable table from RFC §6.5.
 * Pure string formatter — used by the `autoclaw mcp install` CLI command.
 */
export function formatReport(results: InstallResult[]): string {
  const lines: string[] = ['Detected hosts:'];

  const hostWidth = Math.max(...results.map(r => r.host.length), 11);
  const outcomeWidth = Math.max(...results.map(r => r.outcome.length), 13);

  for (const r of results) {
    const glyph = OUTCOME_GLYPH[r.outcome];
    const host = r.host.padEnd(hostWidth);
    const outcome = r.outcome.padEnd(outcomeWidth);
    const where = r.path || (r.detail ? `(${r.detail})` : '');
    lines.push(`  ${host}  ${glyph}  ${outcome}  ${where}`.replace(/\s+$/, ''));
  }

  const added = results.filter(r => r.outcome === 'added' || r.outcome === 'updated').length;
  const unchanged = results.filter(r => r.outcome === 'unchanged').length;
  const missing = results.filter(r => r.outcome === 'not-installed').length;
  const errors = results.filter(r => r.outcome === 'error').length;

  lines.push('');
  const summary =
    `${added} host(s) wired, ${unchanged} already present, ` +
    `${missing} not detected` +
    (errors > 0 ? `, ${errors} error(s)` : '') + '.';
  lines.push(summary);
  if (added > 0 || unchanged > 0) {
    lines.push('Restart your chat sessions for the changes to take effect.');
  }

  return lines.join('\n');
}
