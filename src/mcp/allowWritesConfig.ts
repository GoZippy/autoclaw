/**
 * allowWritesConfig.ts — Read/flip the MCP write gate from the extension side.
 *
 * The `autoclaw-mcp` server keeps an MCP-lane peer (Codex desktop, Claude
 * Desktop / "cowork", any tool that mounts the server) **read-only** until
 * `allowWrites: true` lives in `.autoclaw/mcp/config.json` (or the env override
 * `AUTOCLAW_MCP_ALLOW_WRITES`). The coarse gate is `checkWriteGate`
 * (src/mcp/writeTools.ts:91) and `readAllowWrites` (writeTools.ts:114); the
 * finer per-tool policy is `parseToolAuthPolicy` (src/mcp/scoping.ts:144),
 * which reads the SAME file's `tools` sub-object.
 *
 * Until now, enabling writes meant the human hand-editing that JSON. The
 * one-click join flow (src/fleet/joinPrompt.ts) renders an MCP-lane prompt that
 * *tells* the agent to flip the flag, but cannot do it for them — an MCP-lane
 * peer can't claim/vote until writes are on. This module closes that gap so the
 * extension can flip the flag for the user (an explicit, opt-in TRUST decision —
 * never silent).
 *
 * Self-contained and vscode-free so it is trivially unit-testable. It mirrors
 * EXACTLY how the gate reads the file:
 *   - same path: `<workspaceRoot>/.autoclaw/mcp/config.json`
 *   - same BOM strip + tolerant parse (missing/corrupt ⇒ deny-by-default)
 *   - same env-override precedence + truthy/falsy vocabulary
 *   - `allowWrites === true` (strict boolean), so a flip the extension writes is
 *     a flip the gate honours.
 *
 * Crucially, {@link setAllowWrites} performs a read-MERGE-write: it preserves
 * any existing `tools` policy map and every other key, only flipping the
 * `allowWrites` field. Clobbering a hand-tuned `tools` map would be a footgun.
 *
 * Follow-up #1 (agent-join follow-ups)
 *
 * @see src/mcp/writeTools.ts §checkWriteGate / readAllowWrites
 * @see src/mcp/scoping.ts §parseToolAuthPolicy
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

/** Env var the gate consults BEFORE the file (writeTools.ts:115). */
export const ALLOW_WRITES_ENV = 'AUTOCLAW_MCP_ALLOW_WRITES';

/**
 * The shape we read/write. `allowWrites` is the only field this module owns;
 * `tools` and any other keys are passed through untouched. Kept permissive
 * (index signature) so a merge never drops an operator's extra keys.
 */
export interface McpConfig {
  /** The coarse write gate. `true` (strict) enables writes; absent/false denies. */
  allowWrites?: boolean;
  /** Per-tool policy map consumed by scoping.ts — preserved verbatim on a flip. */
  tools?: Record<string, unknown>;
  /** Any other operator-supplied keys are preserved through a merge. */
  [key: string]: unknown;
}

/** Absolute path to `<workspaceRoot>/.autoclaw/mcp/config.json` (gate's path). */
export function mcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'mcp', 'config.json');
}

/** The `.autoclaw/mcp` directory that holds the config. */
export function mcpConfigDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'mcp');
}

/** Strip a leading UTF-8 BOM exactly as the gate does (writeTools.ts:124). */
function stripBom(raw: string): string {
  return raw.replace(/^﻿/, '');
}

/**
 * Read and parse `.autoclaw/mcp/config.json`.
 *
 * Tolerant by design — mirrors the gate's `try/catch` posture:
 *   - missing file ⇒ `{}`
 *   - BOM-prefixed ⇒ stripped before parse
 *   - malformed JSON / non-object / array ⇒ `{}` (safe default; never throws)
 *
 * Returns a plain object the caller can inspect; it is a parsed COPY, so
 * mutating it does not touch disk until {@link setAllowWrites} writes.
 */
export function readMcpConfig(workspaceRoot: string): McpConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(mcpConfigPath(workspaceRoot), 'utf8');
  } catch {
    return {}; // missing/unreadable ⇒ empty (deny-by-default)
  }
  try {
    const parsed = JSON.parse(stripBom(raw)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}; // not an object ⇒ safe default
    }
    return parsed as McpConfig;
  } catch {
    return {}; // malformed ⇒ safe default (never widens access)
  }
}

/**
 * Resolve whether MCP writes are currently allowed for this workspace.
 *
 * Mirrors `readAllowWrites` (writeTools.ts:114) EXACTLY so the extension's view
 * matches the gate's:
 *   1. The `AUTOCLAW_MCP_ALLOW_WRITES` env override wins when set to a
 *      truthy (`true`/`1`/`yes`) or falsy (`false`/`0`/`no`) value.
 *   2. Otherwise consult the file: `allowWrites === true` (strict boolean).
 * Any read/parse failure ⇒ `false` (deny by default).
 *
 * `env` defaults to `process.env`; pass an explicit map in tests so the env
 * override is deterministic and isolated.
 */
export function isWritesAllowed(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envRaw = (env[ALLOW_WRITES_ENV] ?? '').trim().toLowerCase();
  if (envRaw === 'true' || envRaw === '1' || envRaw === 'yes') {
    return true;
  }
  if (envRaw === 'false' || envRaw === '0' || envRaw === 'no') {
    return false;
  }
  return readMcpConfig(workspaceRoot).allowWrites === true;
}

/**
 * Idempotently set the coarse `allowWrites` flag in `.autoclaw/mcp/config.json`.
 *
 * Read-MERGE-write: creates `.autoclaw/mcp/` if absent, reads any existing
 * config, flips ONLY `allowWrites`, and preserves every other key — most
 * importantly the per-tool `tools` policy map scoping.ts reads. Writes pretty
 * JSON with a trailing newline (matching the gate's writers elsewhere).
 *
 * Idempotent: calling it twice with the same `allow` produces the same file.
 * Returns the resulting config object actually written to disk.
 *
 * NOTE: this writes the FILE flag only. If `AUTOCLAW_MCP_ALLOW_WRITES` is set in
 * the server's environment, the env override still wins at read time — by
 * design, mirroring the gate's precedence.
 */
export async function setAllowWrites(
  workspaceRoot: string,
  allow: boolean,
): Promise<McpConfig> {
  const existing = readMcpConfig(workspaceRoot);
  const next: McpConfig = { ...existing, allowWrites: allow };

  const dir = mcpConfigDir(workspaceRoot);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    mcpConfigPath(workspaceRoot),
    JSON.stringify(next, null, 2) + '\n',
    'utf8',
  );
  return next;
}
