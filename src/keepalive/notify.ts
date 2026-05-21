/**
 * notify.ts — OS notification + "Awaiting You" panel-entry helper for the
 * `toast` keep-alive strategy.
 *
 * The `toast` strategy is the final, non-automated fallback: when every
 * automated re-kick has failed, AutoClaw asks a human to step in. This module
 * provides two effects:
 *
 *   1. An OS-native notification (Windows toast / macOS notification /
 *      Linux `notify-send`), so the human sees it even outside the editor.
 *   2. An "Awaiting You" entry written to
 *      `.autoclaw/runtime/awaiting-you.jsonl` — the Fleet panel tails this
 *      file to surface agents that need manual attention.
 *
 * VS Code's `window.showWarningMessage` is the preferred channel when running
 * inside the extension host; it is injected via {@link NotifyBridge} so this
 * module never hard-imports `vscode` and stays unit-testable.
 *
 * *** NO LLM CALLS. Pure child-process + file append. ***
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Optional VS Code surface — injected when running in the extension host. */
export interface NotifyBridge {
  showWarningMessage(message: string): void;
}

/** An "Awaiting You" record appended to `.autoclaw/runtime/awaiting-you.jsonl`. */
export interface AwaitingYouEntry {
  /** ISO timestamp the entry was created. */
  at: string;
  /** The agent that needs human attention. */
  agentId: string;
  /** Human-readable reason. */
  reason: string;
  /** The IDE/host label, when known. */
  ide?: string;
}

/** Fire an OS-native notification. Best-effort: never throws. */
function osNotification(title: string, body: string, platform: NodeJS.Platform): void {
  try {
    if (platform === 'win32') {
      // Windows toast via the BurntToast-free PowerShell balloon fallback.
      const safeTitle = title.replace(/'/g, "''");
      const safeBody = body.replace(/'/g, "''");
      const ps =
        `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;` +
        `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
        `$n.ShowBalloonTip(8000,'${safeTitle}','${safeBody}',` +
        `[System.Windows.Forms.ToolTipIcon]::Warning);Start-Sleep -Milliseconds 9000;$n.Dispose()`;
      const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true });
      child.unref();
    } else if (platform === 'darwin') {
      const safe = (s: string) => s.replace(/"/g, '\\"');
      const script = `display notification "${safe(body)}" with title "${safe(title)}"`;
      const child = execFile('osascript', ['-e', script]);
      child.unref();
    } else if (platform === 'linux') {
      const child = execFile('notify-send', [title, body]);
      child.unref();
    }
  } catch {
    // Notification is best-effort — swallow.
  }
}

/**
 * Append an "Awaiting You" entry to `.autoclaw/runtime/awaiting-you.jsonl`.
 * Creates the directory if needed. Best-effort; logs on failure.
 */
export function appendAwaitingYou(
  workspaceRoot: string,
  entry: AwaitingYouEntry,
  logger: { error: (m: string) => void } = console,
): void {
  const file = path.join(workspaceRoot, '.autoclaw', 'runtime', 'awaiting-you.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error(`[keepalive] notify: failed to append awaiting-you entry: ${String(err)}`);
  }
}

/**
 * Notify a human that `agentId` needs attention: fire an OS notification, push
 * a VS Code warning when a bridge is available, and record an "Awaiting You"
 * entry for the Fleet panel.
 *
 * @returns `true` once the entry was recorded (the OS notification itself is
 *          best-effort and does not affect the return value).
 */
export function notifyAwaitingYou(opts: {
  workspaceRoot: string;
  agentId: string;
  reason: string;
  ide?: string;
  bridge?: NotifyBridge;
  platform?: NodeJS.Platform;
  logger?: { error: (m: string) => void };
}): boolean {
  const platform = opts.platform ?? process.platform;
  const logger = opts.logger ?? console;
  const title = `AutoClaw — ${opts.agentId} needs you`;
  const body = opts.reason;

  osNotification(title, body, platform);

  if (opts.bridge) {
    try {
      opts.bridge.showWarningMessage(`[AutoClaw] ${title}: ${body}`);
    } catch {
      // bridge failure is non-fatal.
    }
  }

  appendAwaitingYou(
    opts.workspaceRoot,
    { at: new Date().toISOString(), agentId: opts.agentId, reason: opts.reason, ide: opts.ide },
    logger,
  );
  return true;
}
