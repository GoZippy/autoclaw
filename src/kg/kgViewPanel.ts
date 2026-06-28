/**
 * kgViewPanel.ts — the "Knowledge Graph — Browse & Visualize" full-tab webview.
 *
 * AutoClaw's in-process Knowledge Graph (`.autoclaw/kg/kg.db`) accumulates
 * agent "thoughts" (decisions / observations / findings, each attributed to a
 * project / agent / task with a bi-temporal validity window) and typed edges
 * between them. Until now the only UI was the `kg:` health chip — there was no
 * way to actually READ the graph. This panel is that surface: a two-tab editor
 * tab with (1) a searchable / filterable Browser of thoughts + a detail
 * inspector, and (2) an interactive force-directed node-edge Graph.
 *
 * Mirrors `manager/managerPanel.ts` for the host shell (singleton WebviewPanel,
 * nonce + CSP, `asWebviewUri`, message handshake). The data layer is the pure
 * in-process KG store (`getKnowledgeGraph`), read-only here.
 *
 * Derived edges: the stored `edges` table is usually empty (relations are only
 * written via `kg.relate`). To make the graph meaningful on day one we synthesize
 * "same-task" edges (thoughts sharing a `task_id`, chained in time) and flag them
 * `derived:true` so the webview can style + toggle them apart from real edges.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getKnowledgeGraph } from '../intelligence/kg/service';
import type { Edge, Thought } from '../intelligence/kg/types';

/** Singleton — one KG tab at a time; re-invoking reveals the existing one. */
let panel: vscode.WebviewPanel | undefined;
/** Watches the KG db so the open viewer refreshes as thoughts are recorded. */
let watcher: vscode.FileSystemWatcher | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Hard cap on thoughts pulled into the viewer (the graph degrades past a few k nodes). */
const THOUGHT_LIMIT = 2000;

/** An edge as sent to the webview — stored edges plus synthesized "derived" ones. */
type ViewEdge = Edge & { derived?: boolean };

/** Everything the webview needs for one render. */
interface KgViewData {
  health: {
    ok: boolean;
    degraded: boolean;
    sqlite: boolean;
    vec: boolean;
    fts: boolean;
    driver: string | null;
    embedding: string;
    dbPath: string;
  };
  thoughts: Thought[];
  edges: ViewEdge[];
  stats: {
    thoughts: number;
    edges: number;
    derivedEdges: number;
    kinds: Record<string, number>;
    agents: Record<string, number>;
    projects: Record<string, number>;
  };
}

/** Generate a 32-char alphanumeric nonce for the Content-Security-Policy. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** The directory holding the KG webview assets (+ vendored force-graph UMD). */
function mediaDir(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'kg');
}

/**
 * Chain thoughts that share a `task_id` into "same-task" edges (ordered by
 * created_at) so the graph clusters by task even when no relations are stored.
 * Skips groups of one. Bounded — only the most recent THOUGHT_LIMIT thoughts
 * feed this, so the edge count stays linear.
 */
function deriveSameTaskEdges(thoughts: Thought[]): ViewEdge[] {
  const byTask = new Map<string, Thought[]>();
  for (const t of thoughts) {
    const task = (t.task_id ?? '').trim();
    if (!task) { continue; }
    const arr = byTask.get(task) ?? [];
    arr.push(t);
    byTask.set(task, arr);
  }
  const edges: ViewEdge[] = [];
  for (const group of byTask.values()) {
    if (group.length < 2) { continue; }
    const ordered = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (let i = 1; i < ordered.length; i++) {
      edges.push({ from: ordered[i - 1].id, kind: 'same-task', to: ordered[i].id, derived: true });
    }
  }
  return edges;
}

/** Open the KG read-only and assemble the view model. Never throws. */
export async function gatherKgData(workspaceRoot: string): Promise<KgViewData> {
  const handle = getKnowledgeGraph({ workspaceRoot });
  const health = {
    ok: !handle.degraded,
    degraded: handle.degraded,
    sqlite: handle.caps.sqlite,
    vec: handle.caps.vec,
    fts: handle.caps.fts,
    driver: handle.driverKind,
    embedding: `${handle.embedding.provider}/${handle.embedding.model}@${handle.embedding.dimension}`,
    dbPath: handle.dbPath,
  };

  let thoughts: Thought[] = [];
  let stored: Edge[] = [];
  try {
    thoughts = await handle.kg.allThoughts({ limit: THOUGHT_LIMIT });
    stored = await handle.kg.listEdges({ limit: 50000 });
  } catch {
    /* degrade to whatever we got */
  }

  // Keep derived edges to thoughts we actually loaded (avoid dangling node refs).
  const known = new Set(thoughts.map((t) => t.id));
  const derived = deriveSameTaskEdges(thoughts).filter((e) => known.has(e.from) && known.has(e.to));
  const storedView: ViewEdge[] = stored
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e) => ({ ...e, derived: false }));
  const edges = [...storedView, ...derived];

  const kinds: Record<string, number> = {};
  const agents: Record<string, number> = {};
  const projects: Record<string, number> = {};
  for (const t of thoughts) {
    kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
    agents[t.agent] = (agents[t.agent] ?? 0) + 1;
    projects[t.project] = (projects[t.project] ?? 0) + 1;
  }

  return {
    health,
    thoughts,
    edges,
    stats: {
      thoughts: thoughts.length,
      edges: storedView.length,
      derivedEdges: derived.length,
      kinds,
      agents,
      projects,
    },
  };
}

/** Build the CSP-locked HTML shell from `media/kg/kg-view.html`. */
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const dir = mediaDir(extensionUri);
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(dir, 'kg-view.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(dir, 'kg-view.js'));
  const forceGraphUri = webview.asWebviewUri(vscode.Uri.joinPath(dir, 'force-graph.min.js'));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  let template: string;
  try {
    template = fs.readFileSync(path.join(dir.fsPath, 'kg-view.html'), 'utf8');
  } catch {
    template = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />`
      + `<meta http-equiv="Content-Security-Policy" content="%%CSP%%" />`
      + `<link rel="stylesheet" href="%%CSS_URI%%" /><title>AutoClaw Knowledge Graph</title></head>`
      + `<body><div id="kg-root"><p class="empty">Loading knowledge graph…</p></div>`
      + `<script nonce="%%NONCE%%" src="%%FORCEGRAPH_URI%%"></script>`
      + `<script nonce="%%NONCE%%" src="%%JS_URI%%"></script></body></html>`;
  }

  return template
    .replace(/%%CSP%%/g, csp)
    .replace(/%%CSS_URI%%/g, cssUri.toString())
    .replace(/%%JS_URI%%/g, jsUri.toString())
    .replace(/%%FORCEGRAPH_URI%%/g, forceGraphUri.toString())
    .replace(/%%NONCE%%/g, nonce);
}

/** Gather fresh KG data and push it to the open panel. Never throws. */
async function refresh(): Promise<void> {
  if (!panel) { return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    panel.webview.postMessage({ type: 'error', message: 'No workspace folder open.' });
    return;
  }
  try {
    const data = await gatherKgData(workspaceRoot);
    panel.webview.postMessage({ type: 'data', data });
  } catch (err) {
    panel.webview.postMessage({ type: 'error', message: `KG data error: ${String(err)}` });
  }
}

/**
 * Open (or reveal) the Knowledge Graph viewer. Idempotent: a second call focuses
 * the existing tab rather than spawning another.
 */
export function openKgViewPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void refresh();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'autoclaw.kgView',
    'AutoClaw Knowledge Graph',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaDir(context.extensionUri)],
    },
  );

  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage(
    (msg: { command?: string; id?: string; text?: string }) => {
      switch (msg?.command) {
        case 'ready':
        case 'refresh':
          void refresh();
          break;
        case 'copyId':
          if (typeof msg.id === 'string' && msg.id) {
            void vscode.env.clipboard.writeText(msg.id).then(() =>
              vscode.window.setStatusBarMessage(`Copied thought id: ${msg.id}`, 2500),
            );
          }
          break;
        case 'copyText':
          if (typeof msg.text === 'string' && msg.text) {
            void vscode.env.clipboard.writeText(msg.text).then(() =>
              vscode.window.setStatusBarMessage('Copied thought text', 2500),
            );
          }
          break;
        case 'openHealth':
          void vscode.commands.executeCommand('autoclaw.kg.healthCheck');
          break;
        default:
          break;
      }
    },
    undefined,
    context.subscriptions,
  );

  // Live refresh: the KG runs WAL, so writes land in kg.db / kg.db-wal. Watch both
  // and debounce — the orchestrator + /learn record thoughts during normal work,
  // and an open viewer should reflect them without a manual Refresh click.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, '.autoclaw/kg/kg.db*'),
    );
    const onChange = (): void => {
      if (refreshTimer) { clearTimeout(refreshTimer); }
      refreshTimer = setTimeout(() => { void refresh(); }, 800);
    };
    watcher.onDidChange(onChange, undefined, context.subscriptions);
    watcher.onDidCreate(onChange, undefined, context.subscriptions);
    watcher.onDidDelete(onChange, undefined, context.subscriptions);
    context.subscriptions.push(watcher);
  }

  panel.onDidDispose(
    () => {
      panel = undefined;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
      if (watcher) { watcher.dispose(); watcher = undefined; }
    },
    undefined,
    context.subscriptions,
  );

  void refresh();
}

/** Register the `autoclaw.kg.browse` command. Call from `activate()`. */
export function registerKgViewPanel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.browse', () => openKgViewPanel(context)),
  );
}
