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
  | 'codex'
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
  /**
   * Registry file format. Defaults to `json` (the `mcpServers` shape every
   * host but Codex uses). `toml` selects the `[mcp_servers.<name>]` table
   * writer used by the OpenAI Codex CLI (`~/.codex/config.toml`).
   */
  configFormat?: 'json' | 'toml';
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
    id: 'codex',
    // OpenAI Codex CLI keeps a single user-global TOML registry at
    // ~/.codex/config.toml and has no per-project config — both scopes
    // write the same file, differing only in the embedded AUTOCLAW_MCP_SCOPE
    // env value. The TOML writer (mergeTomlRegistryFile) handles the
    // [mcp_servers.autoclaw] table shape Codex expects.
    registryPath: (_scope, home) => path.join(home, '.codex', 'config.toml'),
    cliNames: ['codex'],
    configDirs: home => [path.join(home, '.codex')],
    configFormat: 'toml',
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
// TOML registry merge — the OpenAI Codex CLI (~/.codex/config.toml)
// ---------------------------------------------------------------------------
//
// Codex does not speak the `mcpServers` JSON shape; it reads MCP servers from
// `[mcp_servers.<name>]` tables in a TOML file. There is no TOML dependency in
// the public build, so this is a small, quote-aware writer scoped to ONLY the
// `[mcp_servers.autoclaw]` (+ `.env`) tables — every other line in the file is
// preserved verbatim. It is deliberately conservative: anything it cannot
// confidently rewrite, it refuses rather than risk clobbering an operator's
// hand-tuned config.

/**
 * Strip a TOML line comment (`#…`) without breaking a `#` that lives inside a
 * basic (`"…"`) or literal (`'…'`) string. Returns the line up to the comment.
 */
function stripTomlComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') {
        inBasic = false;
      }
      continue;
    }
    if (inLiteral) {
      if (c === "'") {
        inLiteral = false;
      }
      continue;
    }
    if (c === '"') {
      inBasic = true;
    } else if (c === "'") {
      inLiteral = true;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Match a standalone table header line, e.g. `[mcp_servers.autoclaw]`. */
function tomlTableHeader(line: string): string | null {
  const m = line.match(/^\[([^[\]]+)\]$/);
  return m ? m[1].trim() : null;
}

/** Parse a single TOML scalar string (basic `"…"` or literal `'…'`). */
function parseTomlScalarString(raw: string): string | null {
  const val = raw.trim();
  if (val.startsWith("'")) {
    const end = val.indexOf("'", 1);
    return end > 0 ? val.slice(1, end) : null;
  }
  if (val.startsWith('"')) {
    let out = '';
    for (let i = 1; i < val.length; i++) {
      const c = val[i];
      if (c === '\\') {
        const n = val[i + 1];
        i++;
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      } else if (c === '"') {
        return out;
      } else {
        out += c;
      }
    }
    return null; // unterminated
  }
  return null; // not a string scalar
}

/** True once `s` contains a balanced (closed) `[ … ]` array, quotes respected. */
function tomlArrayComplete(s: string): boolean {
  let inBasic = false;
  let inLiteral = false;
  let depth = 0;
  let seen = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inBasic) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') {
        inBasic = false;
      }
      continue;
    }
    if (inLiteral) {
      if (c === "'") {
        inLiteral = false;
      }
      continue;
    }
    if (c === '"') {
      inBasic = true;
    } else if (c === "'") {
      inLiteral = true;
    } else if (c === '[') {
      depth++;
      seen = true;
    } else if (c === ']') {
      depth--;
    }
  }
  return seen && depth <= 0;
}

/** Parse a single-or-multi-line TOML array of strings. Null if not all strings. */
function parseTomlStringArray(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) {
    return null;
  }
  const inner = t.slice(1, -1);
  const items: string[] = [];
  let buf = '';
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inBasic) {
      buf += c;
      if (c === '\\') {
        buf += inner[i + 1] ?? '';
        i++;
      } else if (c === '"') {
        inBasic = false;
      }
      continue;
    }
    if (inLiteral) {
      buf += c;
      if (c === "'") {
        inLiteral = false;
      }
      continue;
    }
    if (c === '"') {
      inBasic = true;
      buf += c;
    } else if (c === "'") {
      inLiteral = true;
      buf += c;
    } else if (c === ',') {
      if (buf.trim()) {
        items.push(buf.trim());
      }
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) {
    items.push(buf.trim());
  }
  const out: string[] = [];
  for (const it of items) {
    const s = parseTomlScalarString(it);
    if (s === null) {
      return null;
    }
    out.push(s);
  }
  return out;
}

/** Split `key = value` at the first top-level `=`. Keys here never contain `=`. */
function splitTomlKeyVal(line: string): { key: string; val: string } | null {
  const idx = line.indexOf('=');
  if (idx < 0) {
    return null;
  }
  return { key: line.slice(0, idx).trim(), val: line.slice(idx + 1).trim() };
}

/** A bare TOML key (e.g. an env-var name) needs no quoting; otherwise quote it. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Render a TOML string. Prefers a literal (`'…'`) string so Windows paths keep
 * their backslashes verbatim; falls back to a basic (`"…"`) string when the
 * value contains a single quote or a newline.
 */
function tomlString(s: string): string {
  if (!s.includes("'") && !/[\n\r]/.test(s)) {
    return `'${s}'`;
  }
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Detect an UNSUPPORTED inline `autoclaw` entry — `mcp_servers.autoclaw = {…}`
 * at the root, or `autoclaw = {…}` under a `[mcp_servers]` table. We only
 * rewrite the standalone `[mcp_servers.autoclaw]` table form; an inline form is
 * refused so we never silently create a duplicate server.
 */
function hasInlineAutoclaw(text: string): boolean {
  let table = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const header = tomlTableHeader(line);
    if (header !== null) {
      table = header;
      continue;
    }
    if (table === '' && /^mcp_servers\.autoclaw\b/.test(line)) {
      return true;
    }
    if (table === 'mcp_servers' && /^autoclaw\b/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the existing `[mcp_servers.autoclaw]` entry from a Codex TOML doc.
 * Returns null when no such table exists. Tolerant of basic/literal strings
 * and multi-line `args` arrays.
 */
export function parseTomlAutoclawEntry(text: string): McpServerEntry | null {
  const lines = text.split(/\r?\n/);
  let table = '';
  let command: string | undefined;
  let args: string[] | undefined;
  const env: Record<string, string> = {};
  let saw = false;

  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]).trim();
    if (!line) {
      continue;
    }
    const header = tomlTableHeader(line);
    if (header !== null) {
      table = header;
      continue;
    }
    if (table === 'mcp_servers.autoclaw') {
      saw = true;
      const kv = splitTomlKeyVal(line);
      if (!kv) {
        continue;
      }
      if (kv.key === 'command') {
        command = parseTomlScalarString(kv.val) ?? command;
      } else if (kv.key === 'args') {
        let arrText = kv.val;
        while (!tomlArrayComplete(arrText) && i + 1 < lines.length) {
          i++;
          arrText += '\n' + stripTomlComment(lines[i]).trim();
        }
        args = parseTomlStringArray(arrText) ?? args;
      }
    } else if (table === 'mcp_servers.autoclaw.env') {
      saw = true;
      const kv = splitTomlKeyVal(line);
      if (kv) {
        const v = parseTomlScalarString(kv.val);
        const k = parseTomlScalarString(kv.key) ?? kv.key;
        if (v !== null) {
          env[k] = v;
        }
      }
    }
  }

  if (!saw) {
    return null;
  }
  return {
    command: command ?? '',
    args: args ?? [],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Serialize an entry to the canonical `[mcp_servers.autoclaw]` table block. */
function serializeTomlEntry(entry: McpServerEntry): string {
  const lines = [
    '[mcp_servers.autoclaw]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
  const env = entry.env ?? {};
  const envKeys = Object.keys(env);
  if (envKeys.length) {
    lines.push('', '[mcp_servers.autoclaw.env]');
    for (const k of envKeys) {
      lines.push(`${tomlKey(k)} = ${tomlString(env[k])}`);
    }
  }
  return lines.join('\n');
}

/** Remove the `[mcp_servers.autoclaw]` / `.env` tables, preserving all else. */
function stripAutoclawTables(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const header = tomlTableHeader(stripTomlComment(rawLine).trim());
    if (header !== null) {
      skipping = header === 'mcp_servers.autoclaw' || header === 'mcp_servers.autoclaw.env';
      if (skipping) {
        continue;
      }
    }
    if (skipping) {
      continue;
    }
    out.push(rawLine);
  }
  return out.join('\n');
}

/**
 * Merge the `autoclaw` server entry into a Codex `config.toml` (RFC §6.3,
 * TOML variant). Mirrors {@link mergeRegistryFile}'s outcome contract:
 *
 *  - `added`     — no `[mcp_servers.autoclaw]` table existed; one was written.
 *  - `unchanged` — an identical table already existed (idempotent no-op).
 *  - `updated`   — a differing table existed and `force` was set.
 *  - `error`     — a differing table existed without `force`, or an
 *                  unsupported inline `autoclaw` entry was found.
 *
 * Round-trip safe: only the `[mcp_servers.autoclaw]` (+ `.env`) tables are
 * rewritten; every other table, key, and comment is preserved verbatim.
 */
export async function mergeTomlRegistryFile(
  filePath: string,
  entry: McpServerEntry,
  opts: { force: boolean }
): Promise<{ outcome: InstallOutcome; detail: string }> {
  let rawText = '';
  let fileExisted = false;
  try {
    rawText = await fsPromises.readFile(filePath, 'utf8');
    fileExisted = true;
  } catch {
    // File absent — we will create it.
  }
  const text = rawText.replace(/^﻿/, '');

  if (hasInlineAutoclaw(text)) {
    return {
      outcome: 'error',
      detail: 'an inline mcp_servers.autoclaw entry exists; edit ~/.codex/config.toml manually',
    };
  }

  const existing = parseTomlAutoclawEntry(text);
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

  const block = serializeTomlEntry(entry);
  const preserved = stripAutoclawTables(text).replace(/\s+$/, '');
  const body = (preserved.length ? preserved + '\n\n' + block : block) + '\n';

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, body, 'utf8');

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

    // Codex: TOML registry, not the `mcpServers` JSON shape.
    if (host.configFormat === 'toml') {
      try {
        const { outcome, detail } = await mergeTomlRegistryFile(registryPath, entry, { force });
        results.push({ host: host.id, outcome, path: registryPath, detail });
      } catch (err) {
        results.push({
          host: host.id,
          outcome: 'error',
          path: registryPath,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
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
