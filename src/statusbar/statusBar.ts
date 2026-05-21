/**
 * statusBar.ts — AutoClaw fleet presence indicator for the VS Code status bar.
 *
 * Renders the compact presence text ("3 agents working, 1 needs review") in
 * the VS Code status bar, refreshed on a poll tick from `gatherFleetData`.
 *
 * Design split:
 *   - `formatPresenceText` / `presenceTooltip` are *pure* (vscode-free,
 *     unit-testable in plain Node).
 *   - `FleetStatusBar` is the thin VS Code-facing wrapper.
 *   - `registerFleetStatusBar` is the entry point `extension.ts` should call.
 *
 * Sprint 4 — C5_statusbar (C.11). Net-new file; no prior `statusBar.ts`
 * existed despite the sprint note — this is the canonical implementation.
 */

import * as vscode from 'vscode';
import { gatherFleetData } from '../panel/fleetData';
import type { PresenceSummary } from '../views/fleetViewModel';
import {
  formatPresenceText,
  presenceTooltip,
  presenceColorKey,
} from './presenceFormat';

// Re-export the pure formatters so callers can import them from either module.
export { formatPresenceText, presenceTooltip, presenceColorKey };

// ---------------------------------------------------------------------------
// VS Code status-bar wrapper
// ---------------------------------------------------------------------------

/** Options for {@link FleetStatusBar}. */
export interface FleetStatusBarOptions {
  /** Workspace root containing `.autoclaw/`. */
  workspaceRoot: string;
  /** The agent id this status bar renders "for" (drives the needs-review count). */
  selfAgentId: string;
  /** Refresh interval in milliseconds. Defaults to 15 000 (15 s). */
  intervalMs?: number;
  /** Command id fired when the item is clicked. Defaults to `autoclaw.openFleetPanel`. */
  command?: string;
}

/**
 * Manages a single VS Code status-bar item that shows fleet presence.
 *
 * Lifecycle: construct → `start()` → `dispose()`. `start()` is idempotent.
 */
export class FleetStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly opts: Required<FleetStatusBarOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: FleetStatusBarOptions) {
    this.opts = {
      intervalMs: 15_000,
      command: 'autoclaw.openFleetPanel',
      ...options,
    };
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = this.opts.command;
    this.item.text = '$(rocket) AutoClaw';
    this.item.tooltip = 'AutoClaw Fleet — loading…';
  }

  /** Start the refresh loop and show the item. Safe to call repeatedly. */
  start(): void {
    if (this.timer !== null) { return; }
    this.item.show();
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.opts.intervalMs);
  }

  /** Pull the latest fleet data and update the item text/tooltip/colour. */
  async refresh(): Promise<void> {
    try {
      const model = await gatherFleetData({
        workspaceRoot: this.opts.workspaceRoot,
        selfAgentId: this.opts.selfAgentId,
      });
      this.apply(model.presence);
    } catch (err) {
      // Never throw out of a poll tick — degrade to an error glyph.
      this.item.text = '$(rocket) AutoClaw: error';
      this.item.tooltip = `AutoClaw Fleet — failed to read state: ${String(err)}`;
    }
  }

  /** Apply a presence summary to the status-bar item (pure-ish; vscode only). */
  apply(presence: PresenceSummary): void {
    this.item.text = formatPresenceText(presence);
    this.item.tooltip = presenceTooltip(presence);
    const colorKey = presenceColorKey(presence);
    this.item.backgroundColor = colorKey
      ? new vscode.ThemeColor(colorKey)
      : undefined;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.item.dispose();
  }
}

/**
 * Create, start, and register a {@link FleetStatusBar} on the extension
 * context.
 *
 * TODO(extension.ts): `extension.ts` is owned by a concurrent session — call
 * this from `activate()`:
 *
 *   import { registerFleetStatusBar } from './statusbar/statusBar';
 *   registerFleetStatusBar(context, {
 *     workspaceRoot: <workspace folder fsPath>,
 *     selfAgentId: 'claude-code',
 *   });
 */
export function registerFleetStatusBar(
  context: vscode.ExtensionContext,
  options: FleetStatusBarOptions,
): FleetStatusBar {
  const bar = new FleetStatusBar(options);
  bar.start();
  context.subscriptions.push(bar);
  return bar;
}
