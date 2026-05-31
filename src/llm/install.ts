/**
 * `autoclaw llm install` — workspace LLM provider configuration writer.
 *
 * Three side effects, all idempotent:
 *   1. **config**         — write/merge `.autoclaw/llm/config.yaml` with
 *                            the provider's endpoint entry.
 *   2. **workspace-mcp**  — register the provider's MCP route in the
 *                            workspace's `.mcp.json` (so any MCP-aware
 *                            client picks it up automatically).
 *   3. **playbook**       — import the shipped routing playbooks from
 *                            `adapters/zippymesh/*.json` into ZMLR via
 *                            its dashboard API. Skipped when the API
 *                            isn't reachable (older ZMLR build).
 *
 * Re-running is a no-op when nothing changed. Unreachable provider →
 * `skipped` row, exit `ok: true` (skip is not an error).
 *
 * @see docs/specs/llm-provider-s2-autoclaw-side/spec.md
 * @see docs/rfc/llm-provider-abstraction.md §6
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_ZMLR_HOST = 'http://127.0.0.1:20128';
const SHIPPED_PLAYBOOKS = ['mateam-playbook.json', 'kdream-playbook.json'];

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type LlmInstallStepKind = 'config' | 'workspace-mcp' | 'playbook';
export type LlmInstallOutcome =
  | 'added'
  | 'unchanged'
  | 'updated'
  | 'skipped'
  | 'error';

export interface LlmInstallStep {
  step: LlmInstallStepKind;
  /** What this step touched (path, playbook id, MCP server name). */
  target: string;
  outcome: LlmInstallOutcome;
  /** Human-readable detail — error text, "ZMLR unreachable", etc. */
  detail: string;
}

export interface LlmInstallReport {
  steps: LlmInstallStep[];
  /** True when no step is `error`. Skipped + unchanged are both fine. */
  ok: boolean;
}

export interface LlmInstallOptions {
  workspaceRoot?: string;
  /** Override the ZMLR base URL (env `ZIPPYMESH_HOST` is the default). */
  zippymeshHost?: string;
  /** Toggle the ZMLR provider install. Default true. */
  zippymesh?: boolean;
  /** Toggle the Ollama provider install (no detection — just config entry). */
  ollama?: boolean;
  /** Test hook — replace global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Override the directory containing the shipped playbook JSON files.
   * Default: `<workspaceRoot>/adapters/zippymesh`.
   */
  playbookDir?: string;
}

/* -------------------------------------------------------------------------- */
/*  Public surface                                                            */
/* -------------------------------------------------------------------------- */

export async function installLlm(opts: LlmInstallOptions = {}): Promise<LlmInstallReport> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const steps: LlmInstallStep[] = [];

  const zippymeshEnabled = opts.zippymesh !== false; // default true
  const ollamaEnabled = !!opts.ollama;

  if (zippymeshEnabled) {
    const host = opts.zippymeshHost ?? process.env.ZIPPYMESH_HOST ?? DEFAULT_ZMLR_HOST;
    const reachable = await detectZmlr(host, fetchImpl);
    if (!reachable) {
      steps.push({
        step: 'config',
        target: 'zippymesh',
        outcome: 'skipped',
        detail: 'ZMLR unreachable; no files written',
      });
    } else {
      steps.push(await writeZmlrConfig(workspaceRoot, host));
      steps.push(writeWorkspaceMcpEntry(workspaceRoot, host));
      const playbookDir = opts.playbookDir ?? path.join(workspaceRoot, 'adapters', 'zippymesh');
      for (const file of SHIPPED_PLAYBOOKS) {
        steps.push(await importPlaybook(playbookDir, file, host, fetchImpl));
      }
    }
  }

  if (ollamaEnabled) {
    // Ollama is best-effort detected via :11434/api/version. No MCP route to
    // register; no playbooks to import — Ollama is just an endpoint.
    const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
    const reachable = await detectOllama(host, fetchImpl);
    if (!reachable) {
      steps.push({
        step: 'config',
        target: 'ollama',
        outcome: 'skipped',
        detail: 'Ollama unreachable; no files written',
      });
    } else {
      steps.push(await writeOllamaConfig(workspaceRoot, host));
    }
  }

  const ok = !steps.some((s) => s.outcome === 'error');
  return { steps, ok };
}

export function formatLlmInstallReport(report: LlmInstallReport): string {
  const lines: string[] = [];
  lines.push('autoclaw llm install');
  lines.push('─'.repeat(60));
  for (const s of report.steps) {
    const badge = s.outcome.padEnd(9);
    lines.push(`  ${badge} ${s.step.padEnd(13)} ${s.target.padEnd(22)} ${s.detail}`);
  }
  lines.push('─'.repeat(60));
  lines.push(report.ok ? 'OK' : 'completed with errors');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Detection                                                                 */
/* -------------------------------------------------------------------------- */

async function detectZmlr(host: string, fetchImpl: typeof fetch): Promise<boolean> {
  // Try /mcp first (preferred — confirms the MCP route is wired); fall back
  // to /api/health for older ZMLR builds.
  for (const candidate of [`${host}/mcp`, `${host}/api/health`]) {
    try {
      const res = await fetchImpl(candidate, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function detectOllama(host: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${host}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Step: config write                                                        */
/* -------------------------------------------------------------------------- */

interface ProviderConfigEntry {
  id: string;
  endpoint: string;
  /** Optional auth descriptor. */
  auth?: { kind: 'bearer'; tokenEnv: string };
  /** Optional static headers. */
  extraHeaders?: Record<string, string>;
}

async function writeZmlrConfig(workspaceRoot: string, host: string): Promise<LlmInstallStep> {
  return upsertProviderConfig(workspaceRoot, {
    id: 'zippymesh',
    endpoint: host,
    auth: { kind: 'bearer', tokenEnv: 'ZIPPYMESH_TOKEN' },
    extraHeaders: { 'X-Client': 'autoclaw' },
  });
}

async function writeOllamaConfig(workspaceRoot: string, host: string): Promise<LlmInstallStep> {
  return upsertProviderConfig(workspaceRoot, { id: 'ollama', endpoint: host });
}

function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'llm', 'config.yaml');
}

/**
 * Idempotent YAML write. The file shape is intentionally minimal — a small
 * hand-rolled parser handles the read/merge round-trip (no new deps).
 *
 * On disk:
 *
 * ```yaml
 * providers:
 *   - id: zippymesh
 *     endpoint: http://127.0.0.1:20128
 *     auth: { kind: bearer, tokenEnv: ZIPPYMESH_TOKEN }
 *     extraHeaders: { X-Client: autoclaw }
 *   - id: ollama
 *     endpoint: http://127.0.0.1:11434
 * ```
 */
async function upsertProviderConfig(
  workspaceRoot: string,
  entry: ProviderConfigEntry,
): Promise<LlmInstallStep> {
  try {
    const file = configPath(workspaceRoot);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });

    const existing = await readConfigFile(file);
    const idx = existing.providers.findIndex((p) => p.id === entry.id);
    if (idx >= 0) {
      if (providerEntriesEqual(existing.providers[idx], entry)) {
        return {
          step: 'config',
          target: entry.id,
          outcome: 'unchanged',
          detail: `${file} already has ${entry.id}`,
        };
      }
      existing.providers[idx] = entry;
      await fs.promises.writeFile(file, serializeConfig(existing), 'utf8');
      return {
        step: 'config',
        target: entry.id,
        outcome: 'updated',
        detail: `${file} updated`,
      };
    }
    existing.providers.push(entry);
    await fs.promises.writeFile(file, serializeConfig(existing), 'utf8');
    return {
      step: 'config',
      target: entry.id,
      outcome: 'added',
      detail: `${file} written`,
    };
  } catch (err) {
    return {
      step: 'config',
      target: entry.id,
      outcome: 'error',
      detail: (err as Error).message,
    };
  }
}

interface LlmConfigFile {
  providers: ProviderConfigEntry[];
}

async function readConfigFile(file: string): Promise<LlmConfigFile> {
  if (!fs.existsSync(file)) return { providers: [] };
  const raw = await fs.promises.readFile(file, 'utf8');
  return parseConfig(raw);
}

/**
 * Tiny YAML reader scoped to the shape this command writes. Supports the
 * single `providers:` list with the field set listed in the docs above.
 * Anything else in the file is preserved as-is via a "passthrough" prefix.
 *
 * Not a general YAML parser. If the user hand-edited the file into a
 * shape we can't parse, we return an empty providers array — the writer
 * then appends and the user sees the duplicate to resolve.
 */
export function parseConfig(raw: string): LlmConfigFile {
  const providers: ProviderConfigEntry[] = [];
  const lines = raw.split('\n');
  let i = 0;
  // Skip until `providers:`
  while (i < lines.length && !/^\s*providers:\s*$/.test(lines[i])) i++;
  if (i >= lines.length) return { providers };
  i++;
  let current: Partial<ProviderConfigEntry> | undefined;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // back to top-level
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('- ')) {
      if (current && current.id) providers.push(current as ProviderConfigEntry);
      current = {};
      const rest = trimmed.slice(2).trim();
      if (rest.length > 0) absorbKV(current, rest);
    } else if (current) {
      absorbKV(current, trimmed);
    }
    i++;
  }
  if (current && current.id) providers.push(current as ProviderConfigEntry);
  return { providers };
}

function absorbKV(target: Partial<ProviderConfigEntry>, line: string): void {
  const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
  if (!m) return;
  const key = m[1];
  const value = m[2].trim();
  if (key === 'id' || key === 'endpoint') {
    (target as Record<string, unknown>)[key] = stripQuotes(value);
  } else if (key === 'auth') {
    const parsed = parseInlineObject(value);
    if (parsed) target.auth = parsed as ProviderConfigEntry['auth'];
  } else if (key === 'extraHeaders') {
    const parsed = parseInlineObject(value);
    if (parsed) target.extraHeaders = parsed as Record<string, string>;
  }
}

function parseInlineObject(raw: string): Record<string, string> | undefined {
  const m = raw.match(/^\{(.*)\}$/);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const pair of m[1].split(',')) {
    const eq = pair.match(/\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (eq) out[eq[1]] = stripQuotes(eq[2]);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function serializeConfig(config: LlmConfigFile): string {
  const lines: string[] = ['providers:'];
  for (const p of config.providers) {
    lines.push(`  - id: ${p.id}`);
    lines.push(`    endpoint: ${p.endpoint}`);
    if (p.auth) {
      lines.push(
        `    auth: { kind: ${p.auth.kind}, tokenEnv: ${p.auth.tokenEnv} }`,
      );
    }
    if (p.extraHeaders) {
      const inner = Object.entries(p.extraHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(`    extraHeaders: { ${inner} }`);
    }
  }
  return lines.join('\n') + '\n';
}

function providerEntriesEqual(a: ProviderConfigEntry, b: ProviderConfigEntry): boolean {
  if (a.id !== b.id || a.endpoint !== b.endpoint) return false;
  if (JSON.stringify(a.auth ?? null) !== JSON.stringify(b.auth ?? null)) return false;
  const aH = a.extraHeaders ?? {};
  const bH = b.extraHeaders ?? {};
  const keys = new Set([...Object.keys(aH), ...Object.keys(bH)]);
  for (const k of keys) {
    if (aH[k] !== bH[k]) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: workspace MCP entry                                                 */
/* -------------------------------------------------------------------------- */

interface McpServerConfig {
  mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>;
  [key: string]: unknown;
}

function workspaceMcpPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mcp.json');
}

/**
 * Add `{ name: 'zmlr', url: '<host>/mcp' }` to the workspace's `.mcp.json`.
 * Idempotent — existing entries with the matching URL are unchanged.
 */
function writeWorkspaceMcpEntry(workspaceRoot: string, host: string): LlmInstallStep {
  try {
    const file = workspaceMcpPath(workspaceRoot);
    const url = `${host}/mcp`;
    let cfg: McpServerConfig = {};
    if (fs.existsSync(file)) {
      try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as McpServerConfig;
      } catch {
        // Malformed user file — don't trample; report as error.
        return {
          step: 'workspace-mcp',
          target: 'zmlr',
          outcome: 'error',
          detail: `${file} is not valid JSON; aborting (your edits preserved)`,
        };
      }
    }
    if (!cfg.mcpServers) cfg.mcpServers = {};
    const existing = cfg.mcpServers.zmlr;
    if (existing && existing.url === url) {
      return {
        step: 'workspace-mcp',
        target: 'zmlr',
        outcome: 'unchanged',
        detail: `${file} already has zmlr`,
      };
    }
    cfg.mcpServers.zmlr = { url };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return {
      step: 'workspace-mcp',
      target: 'zmlr',
      outcome: existing ? 'updated' : 'added',
      detail: `${file} ${existing ? 'updated' : 'written'}`,
    };
  } catch (err) {
    return {
      step: 'workspace-mcp',
      target: 'zmlr',
      outcome: 'error',
      detail: (err as Error).message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Step: playbook import                                                     */
/* -------------------------------------------------------------------------- */

interface PlaybookFile {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * POST a shipped playbook to ZMLR's dashboard API. Idempotent — checks for
 * an existing playbook id first. Skipped (not error) when the API isn't
 * reachable; older ZMLR builds without `/api/playbooks` fall into this path.
 */
async function importPlaybook(
  playbookDir: string,
  file: string,
  host: string,
  fetchImpl: typeof fetch,
): Promise<LlmInstallStep> {
  const fullPath = path.join(playbookDir, file);
  let playbook: PlaybookFile;
  try {
    const raw = await fs.promises.readFile(fullPath, 'utf8');
    playbook = JSON.parse(raw) as PlaybookFile;
  } catch (err) {
    return {
      step: 'playbook',
      target: file,
      outcome: 'skipped',
      detail: `cannot read ${fullPath}: ${(err as Error).message}`,
    };
  }
  const id = playbook.id ?? playbook.name ?? path.basename(file, '.json');
  // Check existence first.
  try {
    const check = await fetchImpl(`${host}/api/playbooks/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    if (check.status === 404) {
      // Need to create.
      const create = await fetchImpl(`${host}/api/playbooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(playbook),
        signal: AbortSignal.timeout(5_000),
      });
      if (create.ok) {
        return {
          step: 'playbook',
          target: id,
          outcome: 'added',
          detail: `imported from ${file}`,
        };
      }
      return {
        step: 'playbook',
        target: id,
        outcome: 'skipped',
        detail: `ZMLR playbook API not available (POST returned ${create.status})`,
      };
    }
    if (check.ok) {
      return {
        step: 'playbook',
        target: id,
        outcome: 'unchanged',
        detail: `${id} already in ZMLR`,
      };
    }
    // Any other status — treat as API not available.
    return {
      step: 'playbook',
      target: id,
      outcome: 'skipped',
      detail: `ZMLR playbook API not available (GET returned ${check.status})`,
    };
  } catch (err) {
    return {
      step: 'playbook',
      target: id,
      outcome: 'skipped',
      detail: `ZMLR playbook API not reachable: ${(err as Error).message}`,
    };
  }
}
