/**
 * intelligenceDashboard.ts — the Intelligence metrics dashboard webview
 * (intelligence-metrics-dashboard R4.1-R4.5).
 *
 * A self-contained `vscode.WebviewViewProvider` registered under the EXISTING
 * `autoclaw-kdream` activity-bar container (no new container — R4.1). It:
 *   - posts {@link getDashboardData} from the HOST-FREE metrics store to the
 *     webview, which renders summary cards + a kept-rate line chart + a token
 *     bar chart (Real vs Estimated) with pure Canvas (no CDN — R4.3);
 *   - wires one-click learn / index / search / rag-generate buttons to the
 *     existing `autoclaw.intelligence.*` commands (R4.2);
 *   - auto-refreshes after a learning run (R4.4) via the
 *     `autoclaw.intelligence.dashboard.refresh` command the learn command fires;
 *   - shows a clear empty state when no metrics exist (R4.5).
 *
 * This is the ONLY file in this feature permitted to import `vscode`; all data
 * shaping lives in the host-free `src/intelligence/metrics/*` modules.
 *
 * Webview assets live in `media/intelligence/` (dashboard.html/.css/.js) and are
 * copied into the package by `scripts/copy-webview.js`. The HTML is CSP-locked
 * with a per-load nonce.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { getDashboardData } from '../intelligence/metrics/store';
import { resolvePanelBackendStatus } from '../intelligence/installBackend';
import { getIntelligenceHealth, HEALTH_ACTIONS, IntelligenceHealth } from '../intelligence/health';

// ---------------------------------------------------------------------------
// Command ids the dashboard buttons drive (existing intelligence commands).
// ---------------------------------------------------------------------------

/** Maps a webview button action → the command it executes. */
const ACTION_COMMANDS: Record<string, string> = {
  learn: 'autoclaw.intelligence.learn',
  index: 'autoclaw.intelligence.indexCode',
  search: 'autoclaw.intelligence.search',
  'rag-generate': 'autoclaw.intelligence.ragGenerate',
  // Manage row (storage/backend control + cross-project tier).
  status: 'autoclaw.intelligence.status',
  'install-backend': 'autoclaw.intelligence.installBackend',
  relocate: 'autoclaw.intelligence.relocateBackend',
  'system-tier': 'autoclaw.intelligence.systemTier',
  steering: 'autoclaw.intelligence.generateSteering',
  scaffold: 'autoclaw.intelligence.generateScaffold',
};

/** Settings query the ⚙ button opens (the Intelligence settings). */
const SETTINGS_QUERY = 'autoclaw.intelligence';

/**
 * Whitelist of command ids the health-card nudge buttons may execute. Derived
 * verbatim from {@link HEALTH_ACTIONS} so it stays in lockstep with the health
 * contract. A `run-action` message whose `commandId` is not in this set is
 * rejected — the webview can never drive an arbitrary command.
 */
const HEALTH_ACTION_COMMANDS: ReadonlySet<string> = new Set(Object.values(HEALTH_ACTIONS));

/** Generate a 32-char alphanumeric nonce for the Content-Security-Policy. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Inbound messages the webview posts to the host. */
interface InboundMessage {
  command?: 'ready' | 'refresh' | 'run' | 'run-action';
  /** For `run`: the button action (`learn` | `index` | `search` | `rag-generate`). */
  action?: string;
  /** For `run-action`: a VS Code command id (validated against the health whitelist). */
  commandId?: string;
}

/**
 * Renders the Intelligence metrics dashboard inside a webview view.
 *
 * Refresh model: pushes fresh data on `ready`/`refresh`, on visibility change,
 * and whenever {@link refresh} is invoked (the learn command fires the refresh
 * command after a run). No polling — the store is only written by `/learn`.
 */
export class IntelligenceDashboardProvider implements vscode.WebviewViewProvider {
  /** The view id — must match the `views` contribution in package.json. */
  public static readonly viewType = 'autoclawIntelligenceDashboard';

  private view?: vscode.WebviewView;

  /**
   * The extension's global-storage path, forwarded to the health snapshot as the
   * backend-resolution fallback (`globalStorageUri.fsPath`). Optional so callers
   * that only have an `extensionUri` still work.
   */
  private readonly globalStoragePath?: string;

  constructor(private readonly extensionUri: vscode.Uri, globalStoragePath?: string) {
    this.globalStoragePath = globalStoragePath;
  }

  /** Directory holding the webview assets (`media/intelligence/`). */
  private mediaDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media', 'intelligence');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.mediaDir()],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => {
      if (!msg || !msg.command) {
        return;
      }
      if (msg.command === 'ready' || msg.command === 'refresh') {
        this.refresh();
        return;
      }
      if (msg.command === 'run' && typeof msg.action === 'string') {
        void this.runAction(msg.action);
        return;
      }
      if (msg.command === 'run-action' && typeof msg.commandId === 'string') {
        void this.runHealthAction(msg.commandId);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.refresh();
  }

  /**
   * Re-read the metrics store and push the shaped data to the webview. Never
   * throws — a data error surfaces as an `error` message so the panel cannot
   * crash the extension host. No workspace ⇒ explicit empty/error state.
   */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.view.webview.postMessage({
        type: 'data',
        data: { empty: true, noWorkspace: true },
      });
      this.view.webview.postMessage({ type: 'health', health: null });
      return;
    }

    const view = this.view;
    const intelCfg = vscode.workspace.getConfiguration('autoclaw.intelligence');
    const backendDir = intelCfg.get<string>('backendDir') || undefined;
    const systemDir = intelCfg.get<string>('systemDir') || undefined;

    // Metrics (synchronous store read) and the health snapshot (async probes)
    // are posted as TWO independent messages so a failure in one never blanks
    // the other. Run them in parallel; each path swallows its own error.
    const metricsTask = Promise.resolve().then(() => {
      try {
        const data = getDashboardData(workspaceRoot);
        // Backend presence drives the "online" pill + conditional Deploy CTA in the
        // webview. Best-effort — a detection hiccup must not blank the metrics.
        let backend: { installed: boolean; path: string } | undefined;
        try {
          backend = resolvePanelBackendStatus(workspaceRoot, backendDir);
        } catch { /* leave backend undefined; panel falls back to showing the CTA */ }
        view.webview.postMessage({ type: 'data', data: { ...data, backend } });
      } catch (err) {
        view.webview.postMessage({
          type: 'error',
          message: `Intelligence metrics error: ${String(err)}`,
        });
      }
    });

    const healthTask = (async () => {
      try {
        const health: IntelligenceHealth = await getIntelligenceHealth(workspaceRoot, {
          probe: true,
          backendDirOverride: backendDir,
          globalStorageFallback: this.globalStoragePath,
          systemDir,
        });
        view.webview.postMessage({ type: 'health', health });
      } catch {
        // A health-probe failure (e.g. provider timeout) must not affect metrics.
        view.webview.postMessage({ type: 'health', health: null });
      }
    })();

    void Promise.all([metricsTask, healthTask]);
  }

  /**
   * Execute the existing intelligence command behind a dashboard button. Unknown
   * actions / unregistered commands surface a warning rather than throwing.
   */
  private async runAction(action: string): Promise<void> {
    // The ⚙ button opens the Intelligence settings (no dedicated command).
    if (action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY);
      return;
    }
    const commandId = ACTION_COMMANDS[action];
    if (!commandId) {
      void vscode.window.showWarningMessage(`Unknown dashboard action: ${action}`);
      return;
    }
    const registered = await vscode.commands.getCommands(true);
    if (!registered.includes(commandId)) {
      void vscode.window.showWarningMessage(
        `Command "${commandId}" is not available in this build.`,
      );
      return;
    }
    try {
      await vscode.commands.executeCommand(commandId);
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to run ${commandId}: ${String(err)}`);
    }
  }

  /**
   * Execute a health-card nudge's one-click remediation. The `commandId` MUST be
   * one of the whitelisted {@link HEALTH_ACTIONS} values — an arbitrary command
   * id from the webview is refused with a warning, never executed. Re-refreshes
   * after a successful run so the health card reflects the new state.
   */
  private async runHealthAction(commandId: string): Promise<void> {
    if (!HEALTH_ACTION_COMMANDS.has(commandId)) {
      void vscode.window.showWarningMessage(
        `Refused to run non-whitelisted health action: ${commandId}`,
      );
      return;
    }
    const registered = await vscode.commands.getCommands(true);
    if (!registered.includes(commandId)) {
      void vscode.window.showWarningMessage(
        `Command "${commandId}" is not available in this build.`,
      );
      return;
    }
    try {
      await vscode.commands.executeCommand(commandId);
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to run ${commandId}: ${String(err)}`);
      return;
    }
    this.refresh();
  }

  /** Build the CSP-locked HTML shell from `media/intelligence/dashboard.html`. */
  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaDir(), 'dashboard.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.mediaDir(), 'dashboard.js'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    let template = this.readTemplate();
    if (template === null) {
      template = IntelligenceDashboardProvider.inlineFallbackHtml();
    }

    return template
      .replace(/%%CSP%%/g, csp)
      .replace(/%%CSS_URI%%/g, cssUri.toString())
      .replace(/%%JS_URI%%/g, jsUri.toString())
      .replace(/%%NONCE%%/g, nonce);
  }

  /** Read `media/intelligence/dashboard.html`, or null when not present. */
  private readTemplate(): string | null {
    try {
      return fs.readFileSync(path.join(this.mediaDir().fsPath, 'dashboard.html'), 'utf8');
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
  <title>AutoClaw Intelligence</title>
</head>
<body>
  <div id="dashboard-root" role="main"><p class="empty">Loading metrics…</p></div>
  <script nonce="%%NONCE%%" src="%%JS_URI%%"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

/**
 * Register the Intelligence dashboard webview view provider and its refresh
 * command. Call from `extension.ts` `activate()`. The view id MUST match the
 * `views` contribution under the `autoclaw-kdream` container in package.json.
 *
 * Returns the provider so the host can drive `refresh()` directly.
 */
export function registerIntelligenceDashboard(
  context: vscode.ExtensionContext,
): IntelligenceDashboardProvider {
  const provider = new IntelligenceDashboardProvider(
    context.extensionUri,
    context.globalStorageUri?.fsPath,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      IntelligenceDashboardProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Auto-refresh after a learning run (R4.4), two ways, so the panel updates
  // whether or not another surface fires the command:
  //   1. an explicit refresh command the learn command (or any caller) can fire;
  //   2. a filesystem watcher on the metrics file — `/learn` rewrites it on
  //      completion, which triggers a refresh with no cross-module coupling.
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand('autoclaw.intelligence.dashboard.refresh', () => {
        provider.refresh();
      }),
    );
  } catch {
    /* already registered by the host — ignore */
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/.autoclaw/metrics/token-metrics.json',
  );
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidChange(() => provider.refresh());
  context.subscriptions.push(watcher);

  return provider;
}
