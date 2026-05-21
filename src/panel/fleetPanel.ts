/**
 * fleetPanel.ts — AutoClaw Fleet dashboard webview.
 *
 * Self-contained `WebviewViewProvider` that renders the Fleet view: agent
 * identity cards, the parent→subagent tree, the "Awaiting You" section, the
 * activity feed, the cost ledger, the LMD health grid, and a status-bar
 * presence indicator.
 *
 * Wiring contract
 * ---------------
 * This module exports `registerFleetPanel(context, opts?)`. It does NOT wire
 * itself into `src/extension.ts` — a separate session owns that file.
 *
 *   TODO(extension.ts): in `activate()`, call
 *     `registerFleetPanel(context)`
 *   and add a view contribution to package.json:
 *     "views": { "autoclaw-kdream": [
 *       { "id": "autoclawFleet", "name": "Fleet", "type": "webview" } ] }
 *   The view id MUST equal `FleetPanelProvider.viewType` ("autoclawFleet").
 *
 * Webview assets live in `media/panel/` (fleet.html / fleet.css / fleet.js) and
 * ship inside the extension package, so `localResourceRoots` points at that
 * directory. The HTML is CSP-locked with a per-load nonce.
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { gatherFleetData } from './fleetData';
import type { FleetDashboardModel } from '../views/fleetViewModel';

// ---------------------------------------------------------------------------
// Nonce helper (CSP-safe inline script gating)
// ---------------------------------------------------------------------------

/** Generate a 32-char alphanumeric nonce for the Content-Security-Policy. */
function makeNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options accepted by {@link registerFleetPanel}. */
export interface FleetPanelOptions {
  /**
   * The agent id this panel renders "for". Drives the Awaiting-You filter.
   * Defaults to `"claude-code"` (the host agent on this install).
   */
  selfAgentId?: string;
  /**
   * Optional supplier of a live LMD health snapshot. When provided, the panel
   * uses it instead of deriving health from heartbeat-file ages. Pass the
   * running LMD's `getHealthGrid()` here when extension.ts wires this up.
   */
  healthSupplier?: () => import('../lmd/types').AgentHealth[];
  /** Refresh cadence in milliseconds. Default 5000. */
  refreshIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// FleetPanelProvider
// ---------------------------------------------------------------------------

/**
 * Renders the Fleet dashboard inside a VS Code webview view.
 *
 * Refresh model: polls `gatherFleetData` on an interval and on explicit
 * `refresh` messages from the webview. The data layer is pure file I/O, so
 * polling is cheap (no LLM, no network).
 */
export class FleetPanelProvider implements vscode.WebviewViewProvider {
  /** The view id — must match the `views` contribution in package.json. */
  public static readonly viewType = 'autoclawFleet';

  private view?: vscode.WebviewView;
  private timer?: ReturnType<typeof setInterval>;
  private readonly selfAgentId: string;
  private readonly healthSupplier?: () => import('../lmd/types').AgentHealth[];
  private readonly refreshIntervalMs: number;

  constructor(
    private readonly extensionUri: vscode.Uri,
    opts: FleetPanelOptions = {}
  ) {
    this.selfAgentId = opts.selfAgentId ?? 'claude-code';
    this.healthSupplier = opts.healthSupplier;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5000;
  }

  /** Directory holding the webview assets (`media/panel/`). */
  private mediaDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media', 'panel');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.mediaDir()],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === 'refresh' || msg?.command === 'ready') {
        void this.refresh();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });

    webviewView.onDidDispose(() => {
      this.stopPolling();
      this.view = undefined;
    });

    this.startPolling();
    void this.refresh();
  }

  /** Begin the refresh-poll loop (idempotent). */
  private startPolling(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => {
      if (this.view?.visible) {
        void this.refresh();
      }
    }, this.refreshIntervalMs);
  }

  /** Stop the refresh-poll loop. */
  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Gather fresh data and push it to the webview.
   * Errors are surfaced as an `error` message rather than thrown — the panel
   * must never crash the extension host.
   */
  async refresh(): Promise<FleetDashboardModel | undefined> {
    if (!this.view) { return undefined; }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.view.webview.postMessage({
        type: 'error',
        message: 'No workspace folder open.',
      });
      return undefined;
    }
    try {
      const model = await gatherFleetData({
        workspaceRoot,
        selfAgentId: this.selfAgentId,
        health: this.healthSupplier?.(),
      });
      this.view.webview.postMessage({ type: 'model', model });
      return model;
    } catch (err) {
      this.view.webview.postMessage({
        type: 'error',
        message: `Fleet data error: ${String(err)}`,
      });
      return undefined;
    }
  }

  /** Build the CSP-locked HTML shell from `media/panel/fleet.html`. */
  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaDir(), 'fleet.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaDir(), 'fleet.js')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    // Prefer the template on disk; fall back to an inline shell if the asset
    // is missing (keeps the panel resilient in dev builds).
    let template = this.readTemplate();
    if (template === null) {
      template = FleetPanelProvider.inlineFallbackHtml();
    }

    return template
      .replace(/%%CSP%%/g, csp)
      .replace(/%%CSS_URI%%/g, cssUri.toString())
      .replace(/%%JS_URI%%/g, jsUri.toString())
      .replace(/%%NONCE%%/g, nonce);
  }

  /** Read `media/panel/fleet.html`, or null when it is not present. */
  private readTemplate(): string | null {
    try {
      return fs.readFileSync(
        path.join(this.mediaDir().fsPath, 'fleet.html'),
        'utf8'
      );
    } catch {
      return null;
    }
  }

  /** Minimal inline HTML used only when the template asset is missing. */
  private static inlineFallbackHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="%%CSP%%" />
  <link rel="stylesheet" href="%%CSS_URI%%" />
  <title>AutoClaw Fleet</title>
</head>
<body>
  <div id="fleet-root" role="main"><p class="empty">Loading fleet…</p></div>
  <script nonce="%%NONCE%%" src="%%JS_URI%%"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

/**
 * Register the Fleet dashboard webview view provider.
 *
 * Call this from `extension.ts` `activate()` — it is intentionally NOT wired
 * automatically (see the module-level TODO). Returns the provider so the host
 * can drive `refresh()` from a command if desired.
 *
 * @param context  The extension context (used for `extensionUri` + disposal).
 * @param opts     Optional panel configuration.
 */
export function registerFleetPanel(
  context: vscode.ExtensionContext,
  opts: FleetPanelOptions = {}
): FleetPanelProvider {
  const provider = new FleetPanelProvider(context.extensionUri, opts);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      FleetPanelProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Optional explicit refresh command. Registered defensively: if a host has
  // already contributed this id, swallow the duplicate-registration error.
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand('autoclaw.fleet.refresh', () => {
        void provider.refresh();
      })
    );
  } catch {
    /* command already registered by the host — ignore */
  }

  return provider;
}
