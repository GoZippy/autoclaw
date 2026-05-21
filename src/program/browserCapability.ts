/**
 * browserCapability.ts — Browser sub-agent capability flag (Workstream C.13).
 *
 * The V3 plan §6 C.13 calls for a `needs_browser` flag on the agent profile:
 *
 *   "Browser sub-agent capability flag (`needs_browser: true` on agent
 *    profile). For Gemini runner, pass through; for others, back with a
 *    Playwright MCP server."
 *
 * Distinction from `ScopeDeclaration.browserAllowed` (src/runners/types.ts):
 *   - `browserAllowed`  — a *permission gate*: may this agent touch a browser.
 *   - `needs_browser`   — a *requirement declaration*: this agent's task
 *                         cannot proceed without a browser sub-agent.
 *
 * The two compose: a task with `needs_browser: true` dispatched to an agent
 * whose scope sets `browserAllowed: false` is a hard mismatch the orchestrator
 * must reject. When `browserAllowed` is true, this module decides *how* the
 * browser is provided per runner.
 *
 * Resolution rule:
 *   - The `gemini-cli` runner (Antigravity / Gemini) has a native browser
 *     sub-agent → pass the requirement straight through.
 *   - Every other runner (claude-code, cursor, kiro, …) has no native browser
 *     → AutoClaw backs the requirement with a **Playwright MCP server** added
 *     to that runner's MCP registry (see §5 of the V3 plan for per-host MCP
 *     registry paths). The Playwright MCP server exposes browser tools the
 *     non-Gemini agent can call.
 *
 * This module is `vscode`-free and pure → unit-testable in plain Node.
 *
 * Sprint 4 — C5_statusbar (C.13).
 */

// ---------------------------------------------------------------------------
// Agent profile flag
// ---------------------------------------------------------------------------

/**
 * The browser-capability fields on an agent profile / task spec.
 *
 * These are *additive* to `RegisteredAgent` (src/comms.ts) and to a task
 * spec — both may carry `needs_browser`. A profile with `needs_browser: true`
 * declares every task it runs needs a browser; a task can set it per-task.
 */
export interface BrowserCapabilityFields {
  /**
   * When true, the agent / task requires a browser sub-agent to do its work
   * (web automation, screenshot capture, DOM scraping). Absence ⇒ false.
   */
  needs_browser?: boolean;
}

/** Type guard: does this profile/task declare a browser requirement? */
export function needsBrowser(profile: BrowserCapabilityFields | null | undefined): boolean {
  return profile?.needs_browser === true;
}

// ---------------------------------------------------------------------------
// Playwright MCP server fallback
// ---------------------------------------------------------------------------

/**
 * Canonical MCP server entry that backs the browser requirement for runners
 * with no native browser sub-agent.
 *
 * This is the standard `@playwright/mcp` server. It is written into the
 * non-Gemini runner's MCP registry (`~/.claude/settings.json`,
 * `~/.cursor/mcp.json`, Kiro `mcp add`, …) by `autoclaw mcp install` so the
 * agent can call browser tools through MCP.
 *
 * Shape matches the universal `mcpServers` entry every host speaks (V3 §5).
 */
export interface PlaywrightMcpServerEntry {
  /** Command to launch the MCP server. */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
}

/** The canonical `mcpServers["playwright"]` entry for the fallback. */
export const PLAYWRIGHT_MCP_SERVER: PlaywrightMcpServerEntry = {
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest'],
};

/** Stable key under which the Playwright MCP server is registered. */
export const PLAYWRIGHT_MCP_KEY = 'playwright';

// ---------------------------------------------------------------------------
// Per-runner resolution
// ---------------------------------------------------------------------------

/** How a browser requirement is satisfied for a given runner. */
export type BrowserProvision =
  | {
      /** The runner has a native browser sub-agent — pass the flag through. */
      mode: 'native';
      runnerId: string;
    }
  | {
      /** The runner gets a Playwright MCP server registered as the backing. */
      mode: 'playwright-mcp';
      runnerId: string;
      /** The MCP key + entry to write into the runner's MCP registry. */
      mcpKey: string;
      mcpServer: PlaywrightMcpServerEntry;
    }
  | {
      /** The agent/task does not need a browser — nothing to do. */
      mode: 'not-required';
      runnerId: string;
    };

/**
 * Runner ids that expose a native browser sub-agent. Currently only the
 * Gemini CLI / Antigravity runner. Kept as a set so adding future native
 * browser runners is a one-line change.
 */
export const NATIVE_BROWSER_RUNNERS: ReadonlySet<string> = new Set([
  'gemini-cli',
]);

/** True when `runnerId` has a native browser sub-agent. */
export function hasNativeBrowser(runnerId: string): boolean {
  return NATIVE_BROWSER_RUNNERS.has(runnerId);
}

/**
 * Resolve how the browser requirement is satisfied for a given runner.
 *
 * - requirement false               → `not-required`
 * - requirement true, native runner → `native` (Gemini pass-through)
 * - requirement true, other runner  → `playwright-mcp` (register the server)
 *
 * @param runnerId   - the runner id the task will dispatch to.
 * @param requirement - the agent/task browser-capability fields.
 */
export function resolveBrowserProvision(
  runnerId: string,
  requirement: BrowserCapabilityFields | null | undefined,
): BrowserProvision {
  if (!needsBrowser(requirement)) {
    return { mode: 'not-required', runnerId };
  }
  if (hasNativeBrowser(runnerId)) {
    return { mode: 'native', runnerId };
  }
  return {
    mode: 'playwright-mcp',
    runnerId,
    mcpKey: PLAYWRIGHT_MCP_KEY,
    mcpServer: PLAYWRIGHT_MCP_SERVER,
  };
}

/**
 * Apply a {@link BrowserProvision} to a host's `mcpServers` map.
 *
 * For `playwright-mcp` provisions, adds the Playwright entry (idempotent — an
 * existing entry under the same key is left untouched). For every other mode
 * the map is returned unchanged. The input map is not mutated; a shallow copy
 * is returned.
 */
export function applyBrowserProvisionToMcp(
  provision: BrowserProvision,
  mcpServers: Record<string, PlaywrightMcpServerEntry>,
): Record<string, PlaywrightMcpServerEntry> {
  if (provision.mode !== 'playwright-mcp') {
    return { ...mcpServers };
  }
  if (mcpServers[provision.mcpKey]) {
    return { ...mcpServers }; // already registered — idempotent
  }
  return { ...mcpServers, [provision.mcpKey]: provision.mcpServer };
}
