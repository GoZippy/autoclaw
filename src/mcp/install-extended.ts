/**
 * install-extended.ts — `autoclaw mcp install --extended` (Workstream H.3).
 *
 * The base `autoclaw mcp install` (install.ts) wires the local stdio
 * `autoclaw-mcp` server into every detected AI host. This module EXTENDS that
 * with the optional REST-endpoint integrations the V3 plan calls for:
 *
 *   - Hermes  — a remote AutoClaw fleet-dispatch service.
 *   - OpenClaw — a remote open-core runner pool.
 *   - VoidSpec — the canonical task-spec service (`voidspec.sync()`).
 *
 * It also registers two new MCP tools on top of the BP1/BP3 surface:
 *   - `fleet.dispatch(runner, prompt)` — hand a prompt to a named runner via
 *     a configured REST endpoint.
 *   - `voidspec.sync()` — pull/refresh task specs from a VoidSpec endpoint.
 *
 * Security / inert-by-default posture (consistent with the cloud relay):
 *   - The extended endpoints come from `.autoclaw/mcp/extended.json` and
 *     DEFAULT TO EMPTY. With nothing configured, `fleet.dispatch` and
 *     `voidspec.sync` return a typed `{ ok: false, reason: 'not_implemented' }`
 *     no-op — they never make a network call.
 *   - Endpoint auth tokens (when configured) ride only in the `Authorization`
 *     header and are NEVER echoed into the install report or a tool result.
 *
 * The extended tools are exported as a tool-handler array so `server.ts` can
 * append them to the active set; this file does not modify `server.ts`.
 *
 * Self-contained: no imports from src/orchestrator or src/comms.
 *
 * Sprint 4 — H3 (WA-4).
 */

import * as fs from 'fs';
import * as path from 'path';

import { installAll, formatReport, type InstallOptions, type InstallResult } from './install';
import type { ToolContext, ToolHandler, ToolResult } from './types';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Extended endpoint configuration — defaults to EMPTY (inert)
// ---------------------------------------------------------------------------

/** One configurable REST endpoint AutoClaw can talk to. */
export interface ExtendedEndpoint {
  /** Base URL. Empty / absent ⇒ this integration is OFF. */
  url: string;
  /**
   * Name of an environment variable holding the bearer token. The token
   * itself is NEVER stored in the config file or echoed anywhere — only the
   * env-var name is configured here.
   */
  tokenEnv?: string;
  /** Per-request timeout (ms). Defaults to 15s. */
  timeoutMs?: number;
}

/** The `.autoclaw/mcp/extended.json` document. All endpoints default empty. */
export interface ExtendedConfig {
  hermes: ExtendedEndpoint;
  openclaw: ExtendedEndpoint;
  voidspec: ExtendedEndpoint;
}

/** The inert default — every extended endpoint OFF. */
export function defaultExtendedConfig(): ExtendedConfig {
  const empty: ExtendedEndpoint = { url: '' };
  return { hermes: { ...empty }, openclaw: { ...empty }, voidspec: { ...empty } };
}

/** Path to the extended-endpoint config under a workspace `.autoclaw/`. */
export function extendedConfigPath(autoclawDir: string): string {
  return path.join(autoclawDir, 'mcp', 'extended.json');
}

/**
 * Read `.autoclaw/mcp/extended.json`. A missing / empty / unparseable file
 * resolves to {@link defaultExtendedConfig} — i.e. every integration is OFF.
 */
export async function readExtendedConfig(autoclawDir: string): Promise<ExtendedConfig> {
  const base = defaultExtendedConfig();
  let raw: string;
  try {
    raw = await fsPromises.readFile(extendedConfigPath(autoclawDir), 'utf8');
  } catch {
    return base;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as Partial<Record<keyof ExtendedConfig, unknown>>;
    return {
      hermes: normalizeEndpoint(parsed.hermes),
      openclaw: normalizeEndpoint(parsed.openclaw),
      voidspec: normalizeEndpoint(parsed.voidspec),
    };
  } catch {
    return base;
  }
}

/** Coerce a loosely-typed endpoint into a safe {@link ExtendedEndpoint}. */
function normalizeEndpoint(v: unknown): ExtendedEndpoint {
  if (!v || typeof v !== 'object') {
    return { url: '' };
  }
  const o = v as Record<string, unknown>;
  return {
    url: typeof o.url === 'string' ? o.url.trim() : '',
    ...(typeof o.tokenEnv === 'string' && o.tokenEnv ? { tokenEnv: o.tokenEnv } : {}),
    ...(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? { timeoutMs: o.timeoutMs } : {}),
  };
}

/** True when an endpoint is genuinely configured (non-empty URL). */
export function endpointIsConfigured(ep: ExtendedEndpoint): boolean {
  return typeof ep.url === 'string' && ep.url.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Extended install — base hosts + extended REST endpoints, in one report
// ---------------------------------------------------------------------------

/** One row of the extended-endpoint section of the install report. */
export interface ExtendedEndpointResult {
  /** Integration name. */
  service: 'hermes' | 'openclaw' | 'voidspec';
  /** `configured` when a URL is set; `not-configured` otherwise. */
  outcome: 'configured' | 'not-configured';
  /** The configured URL (or empty). Tokens are NEVER included. */
  url: string;
  /** Human-readable detail. */
  detail: string;
}

/** The combined result of an extended install run. */
export interface ExtendedInstallReport {
  /** Per-host base install rows (from `installAll`). */
  hosts: InstallResult[];
  /** Per-integration extended-endpoint rows. */
  endpoints: ExtendedEndpointResult[];
}

/** Options for {@link installExtended}. */
export interface ExtendedInstallOptions extends InstallOptions {
  /** Absolute path to the `.autoclaw/` directory (for the extended config). */
  autoclawDir: string;
}

/**
 * Run `autoclaw mcp install` AND survey the extended REST endpoints.
 *
 * The base host-registry install is unchanged; this layers the
 * Hermes/OpenClaw/VoidSpec endpoint survey on top so the user sees, in one
 * report, what was wired locally and which remote integrations are live.
 *
 * This is read-only with respect to the extended config — surveying which
 * endpoints are configured never writes `extended.json`.
 */
export async function installExtended(
  opts: ExtendedInstallOptions,
): Promise<ExtendedInstallReport> {
  const hosts = await installAll(opts);
  const cfg = await readExtendedConfig(opts.autoclawDir);

  const endpoints: ExtendedEndpointResult[] = (
    [
      ['hermes', cfg.hermes],
      ['openclaw', cfg.openclaw],
      ['voidspec', cfg.voidspec],
    ] as Array<['hermes' | 'openclaw' | 'voidspec', ExtendedEndpoint]>
  ).map(([service, ep]) => {
    const configured = endpointIsConfigured(ep);
    return {
      service,
      outcome: configured ? 'configured' : 'not-configured',
      url: configured ? ep.url : '',
      detail: configured
        ? `REST endpoint registered${ep.tokenEnv ? ` (auth via $${ep.tokenEnv})` : ''}`
        : `not configured — set "${service}.url" in .autoclaw/mcp/extended.json to enable`,
    };
  });

  return { hosts, endpoints };
}

// ---------------------------------------------------------------------------
// Extended install report — base host table + extended endpoint table
// ---------------------------------------------------------------------------

const EXT_GLYPH: Record<ExtendedEndpointResult['outcome'], string> = {
  configured: '✓',
  'not-configured': '-',
};

/**
 * Render the full extended install report: the base host table from
 * {@link formatReport}, followed by the extended REST-endpoint table.
 *
 * Pure string formatter — no secrets, no I/O.
 */
export function formatExtendedReport(report: ExtendedInstallReport): string {
  const lines: string[] = [formatReport(report.hosts), '', 'Extended REST endpoints:'];

  const serviceWidth = Math.max(
    ...report.endpoints.map(e => e.service.length),
    'service'.length,
  );
  const outcomeWidth = Math.max(
    ...report.endpoints.map(e => e.outcome.length),
    'not-configured'.length,
  );

  for (const e of report.endpoints) {
    const glyph = EXT_GLYPH[e.outcome];
    const service = e.service.padEnd(serviceWidth);
    const outcome = e.outcome.padEnd(outcomeWidth);
    const where = e.url || `(${e.detail})`;
    lines.push(`  ${service}  ${glyph}  ${outcome}  ${where}`.replace(/\s+$/, ''));
  }

  const configured = report.endpoints.filter(e => e.outcome === 'configured').length;
  const missing = report.endpoints.length - configured;
  lines.push('');
  lines.push(
    `${configured} extended endpoint(s) configured, ${missing} not configured. ` +
      'Extended tools (fleet.dispatch, voidspec.sync) are inert until an endpoint is set.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTTP helper — shared by the extended tools
// ---------------------------------------------------------------------------

/** Resolve the bearer token for an endpoint from its configured env var. */
function endpointToken(ep: ExtendedEndpoint, env: NodeJS.ProcessEnv): string | undefined {
  if (!ep.tokenEnv) {
    return undefined;
  }
  const v = env[ep.tokenEnv];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * POST a JSON body to `{ep.url}{pathSuffix}`. The token (when configured)
 * rides only in the `Authorization` header. Uses the Node global `fetch`.
 */
async function postToEndpoint(
  ep: ExtendedEndpoint,
  pathSuffix: string,
  body: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; status: number; data: unknown; detail: string }> {
  const url = ep.url.replace(/\/+$/, '') + pathSuffix;
  const token = endpointToken(ep, env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ep.timeoutMs ?? 15_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return {
      ok: resp.ok,
      status: resp.status,
      data,
      detail: resp.ok ? 'ok' : `endpoint returned HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool: fleet.dispatch(runner, prompt)
// ---------------------------------------------------------------------------

/**
 * `fleet.dispatch` — hand a prompt to a named runner via the Hermes REST
 * endpoint (falling back to OpenClaw when Hermes is not configured).
 *
 * Inert by default: when neither endpoint is configured the tool returns
 * `{ ok: false, reason: 'not_implemented' }` and makes NO network call.
 */
export const fleetDispatchTool: ToolHandler = {
  definition: {
    name: 'fleet.dispatch',
    description:
      'Dispatch a prompt to a named fleet runner via a configured REST endpoint ' +
      '(Hermes / OpenClaw). Inert until an endpoint is set in .autoclaw/mcp/extended.json.',
    inputSchema: {
      type: 'object',
      properties: {
        runner: {
          type: 'string',
          description: 'Target runner id (e.g. claude-code, cursor, kiro, gemini-cli).',
        },
        prompt: { type: 'string', description: 'The prompt / task text to dispatch.' },
      },
      required: ['runner', 'prompt'],
    },
  },
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const runner = typeof args.runner === 'string' ? args.runner.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!runner || !prompt) {
      return { ok: false, reason: 'invalid_params', detail: 'runner and prompt are required' };
    }
    const cfg = await readExtendedConfig(ctx.autoclawDir);
    // Prefer Hermes; fall back to OpenClaw.
    const ep = endpointIsConfigured(cfg.hermes)
      ? cfg.hermes
      : endpointIsConfigured(cfg.openclaw)
        ? cfg.openclaw
        : null;
    if (!ep) {
      return {
        ok: false,
        reason: 'not_implemented',
        detail:
          'no fleet-dispatch endpoint configured; set hermes.url or openclaw.url ' +
          'in .autoclaw/mcp/extended.json',
      };
    }
    const res = await postToEndpoint(
      ep,
      '/v1/dispatch',
      { runner, prompt, dispatched_by: ctx.host, ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}) },
      process.env,
    );
    if (!res.ok) {
      return { ok: false, reason: 'state_unreachable', detail: res.detail };
    }
    return { ok: true, data: { runner, dispatched: true, response: res.data } };
  },
};

// ---------------------------------------------------------------------------
// Tool: voidspec.sync()
// ---------------------------------------------------------------------------

/**
 * `voidspec.sync` — pull / refresh task specs from the VoidSpec REST endpoint.
 *
 * Inert by default: when no VoidSpec endpoint is configured the tool returns
 * `{ ok: false, reason: 'not_implemented' }` and makes NO network call.
 */
export const voidspecSyncTool: ToolHandler = {
  definition: {
    name: 'voidspec.sync',
    description:
      'Pull / refresh canonical task specs from a configured VoidSpec REST endpoint. ' +
      'Inert until voidspec.url is set in .autoclaw/mcp/extended.json.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'Optional ISO timestamp — only sync specs changed since then.',
        },
      },
    },
  },
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = await readExtendedConfig(ctx.autoclawDir);
    if (!endpointIsConfigured(cfg.voidspec)) {
      return {
        ok: false,
        reason: 'not_implemented',
        detail:
          'no VoidSpec endpoint configured; set voidspec.url in .autoclaw/mcp/extended.json',
      };
    }
    const since = typeof args.since === 'string' ? args.since.trim() : '';
    const res = await postToEndpoint(
      cfg.voidspec,
      '/v1/sync',
      { installation_host: ctx.host, ...(since ? { since } : {}) },
      process.env,
    );
    if (!res.ok) {
      return { ok: false, reason: 'state_unreachable', detail: res.detail };
    }
    return { ok: true, data: { synced: true, result: res.data } };
  },
};

/**
 * The extended MCP tools (H.3). `server.ts` can append these to its active
 * tool set; they are network-capable but inert until an endpoint is configured.
 */
export const EXTENDED_TOOLS: ToolHandler[] = [fleetDispatchTool, voidspecSyncTool];
