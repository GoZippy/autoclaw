/**
 * managerPanel.ts — the full-tab "Manager Surface".
 *
 * The sidebar dashboard is cramped once more than a couple of agents/sessions
 * are live. This opens the same Fleet dashboard (presence, agendaboard, awaiting,
 * health grid, agent cards, subagent tree, cost ledger, activity) as a
 * full-screen editor-tab WebviewPanel, so a human "manager" gets a roomy single
 * pane for oversight.
 *
 * It deliberately REUSES the Fleet render stack — the `media/panel/fleet.*`
 * assets and the pure `gatherFleetData` data layer (already unit-tested in
 * fleet-panel.test.ts) — rather than introducing a second renderer. The only
 * new thing here is the full-tab host shell + refresh loop. A WebviewPanel is an
 * editor tab (vs the FleetPanel's sidebar WebviewView), which is why this is a
 * separate, small wrapper.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { gatherFleetData } from '../panel/fleetData';

/** Singleton — one Manager tab at a time; re-invoking reveals the existing one. */
let panel: vscode.WebviewPanel | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/** The host agent on this install — drives the Awaiting-You filter. */
const SELF_AGENT_ID = 'claude-code';
/** Poll cadence; the data layer is pure file I/O so this is cheap. */
const REFRESH_INTERVAL_MS = 5000;

/** Generate a 32-char alphanumeric nonce for the Content-Security-Policy. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** The directory holding the shared Fleet webview assets. */
function mediaDir(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'panel');
}

/**
 * Read `.autoclaw/orchestrator/board.json` if the orchestrator loop wrote one.
 * Missing / unparseable → null (the panel renders without the board section).
 */
async function readBoardJsonIfExists(workspaceRoot: string): Promise<unknown | null> {
  try {
    const raw = await fs.promises.readFile(
      path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'board.json'),
      'utf8',
    );
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Build the CSP-locked HTML shell from `media/panel/fleet.html`. */
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const dir = mediaDir(extensionUri);
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(dir, 'fleet.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(dir, 'fleet.js'));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  let template: string;
  try {
    template = fs.readFileSync(path.join(dir.fsPath, 'fleet.html'), 'utf8');
  } catch {
    template = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />`
      + `<meta http-equiv="Content-Security-Policy" content="%%CSP%%" />`
      + `<link rel="stylesheet" href="%%CSS_URI%%" /><title>AutoClaw Manager</title></head>`
      + `<body><div id="fleet-root" role="main"><p class="empty">Loading fleet…</p></div>`
      + `<script nonce="%%NONCE%%" src="%%JS_URI%%"></script></body></html>`;
  }

  return template
    .replace(/%%CSP%%/g, csp)
    .replace(/%%CSS_URI%%/g, cssUri.toString())
    .replace(/%%JS_URI%%/g, jsUri.toString())
    .replace(/%%NONCE%%/g, nonce);
}

/** Gather fresh fleet data and push it to the open Manager panel. Never throws. */
async function refresh(): Promise<void> {
  if (!panel) { return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    panel.webview.postMessage({ type: 'error', message: 'No workspace folder open.' });
    return;
  }
  try {
    const model = await gatherFleetData({ workspaceRoot, selfAgentId: SELF_AGENT_ID });
    const board = await readBoardJsonIfExists(workspaceRoot);
    panel.webview.postMessage({ type: 'model', model: board ? { ...model, board } : model });
  } catch (err) {
    panel.webview.postMessage({ type: 'error', message: `Fleet data error: ${String(err)}` });
  }
}

/**
 * Open (or reveal) the full-tab Manager Surface. Idempotent: a second call
 * focuses the existing tab rather than spawning another.
 */
export function openManagerPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void refresh();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'autoclaw.manager',
    'AutoClaw Manager',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaDir(context.extensionUri)],
    },
  );

  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage(
    (msg: { command?: string; agentId?: string; sessionId?: string }) => {
      switch (msg?.command) {
        case 'refresh':
        case 'ready':
          void refresh();
          break;
        // Command Center P1 — safe fleet actions. Each delegates to an
        // already-registered command; no fleet logic is reimplemented here.
        case 'generateJoinPrompt':
          void vscode.commands.executeCommand('autoclaw.fleet.joinPrompt');
          break;
        case 'inviteAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.invite');
          break;
        case 'admitAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.admit');
          break;
        case 'declineAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.decline');
          break;
        // LANE B — per-agent Command & Control. The card-detail buttons post
        // {command, agentId}; forward straight to the matching fleet command
        // (which prompts/confirms as needed). evict opens a REQUIRED modal in
        // its command. Local single-operator only — no relay path.
        case 'messageAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.messageAgent', { agentId: msg.agentId, sessionId: msg.sessionId });
          break;
        case 'pauseAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.pauseAgent', { agentId: msg.agentId, sessionId: msg.sessionId });
          break;
        case 'resumeAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.resumeAgent', { agentId: msg.agentId, sessionId: msg.sessionId });
          break;
        case 'reassignAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.reassignAgent', { agentId: msg.agentId, sessionId: msg.sessionId });
          break;
        case 'evictAgent':
          void vscode.commands.executeCommand('autoclaw.fleet.evict', { agentId: msg.agentId, sessionId: msg.sessionId });
          break;
        case 'ping':
          // The Manager card already had a Ping button; surface it as a message
          // doorbell so the click does something rather than silently dropping.
          void vscode.commands.executeCommand('autoclaw.fleet.messageAgent', { agentId: msg.agentId });
          break;
        default:
          break;
      }
    },
    undefined,
    context.subscriptions,
  );

  // Refresh when the tab regains focus, plus a cheap poll while visible.
  panel.onDidChangeViewState(
    () => { if (panel?.visible) { void refresh(); } },
    undefined,
    context.subscriptions,
  );
  timer = setInterval(() => { if (panel?.visible) { void refresh(); } }, REFRESH_INTERVAL_MS);

  panel.onDidDispose(
    () => {
      if (timer) { clearInterval(timer); timer = undefined; }
      panel = undefined;
    },
    undefined,
    context.subscriptions,
  );

  void refresh();
}

/** Register the `autoclaw.manager.open` command. Call from `activate()`. */
export function registerManagerPanel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.manager.open', () => openManagerPanel(context)),
  );
}
