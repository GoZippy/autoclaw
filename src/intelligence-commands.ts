/**
 * intelligence-commands.ts — VS Code command surface for the AutoClaw
 * Intelligence Layer (R6.1-R6.4, tasks 7.1-7.4).
 *
 * This is the glue layer between the host (`vscode`) and the host-free
 * Intelligence module under `src/intelligence/`. It is the ONLY file (besides
 * `src/extension.ts`) permitted to import `vscode`. It registers four commands:
 *
 *   - `autoclaw.intelligence.learn`     → learnFromSessions
 *   - `autoclaw.intelligence.indexCode` → indexCodebase (with a --force toggle)
 *   - `autoclaw.intelligence.retrieve`  → retrieveCode
 *   - `autoclaw.intelligence.search`    → semantic search across the vector store
 *
 * Each command resolves the workspace root (warning and returning when none is
 * open), runs heavy work inside `vscode.window.withProgress`, routes module
 * logging into a dedicated OutputChannel, and surfaces results to the user. No
 * intelligence I/O happens at registration time — everything is lazy and runs
 * only on invocation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  installVectorBackend,
  isBackendInstalled,
  VEC_DIR_ENV,
} from './intelligence/installBackend';
import {
  resolveBackendDir,
  gatherStorageStatus,
  formatBytes,
} from './intelligence/storage';
import {
  LogFn,
  learnFromSessions,
  indexCodebase,
  retrieveCode,
  loadConfig,
  getActiveEmbeddingSignature,
  intelligencePaths,
  initVectorBackend,
  getEmbedding,
  resolveProjectKey,
  listSources,
  setSourceEnabled,
  pendingConsentSources,
  generateRAGPrompt,
  buildScaffold,
  getDashboardData,
  getEffectiveness,
} from './intelligence';

const OUTPUT_CHANNEL_NAME = 'AutoClaw — Intelligence';
const GUIDANCE = 'No index or learnings found yet. Run /index-code or /learn first.';

let channel: vscode.OutputChannel | undefined;

/**
 * Parse an optional `--limit N` flag (R6.2) out of a free-text query, returning
 * the cleaned query and the parsed limit (when valid and positive).
 */
function parseLimit(raw: string): { query: string; limit?: number } {
  const m = raw.match(/(?:^|\s)--limit(?:[=\s]+)(\d+)\b/i);
  if (!m) {
    return { query: raw.trim() };
  }
  const n = parseInt(m[1], 10);
  const query = raw.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  return { query, limit: Number.isFinite(n) && n > 0 ? n : undefined };
}

/** Lazily create (and cache) the dedicated Intelligence output channel. */
function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return channel;
}

/** Append a timestamped line to the output channel. */
function logLine(msg: string): void {
  getChannel().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Has the project ever produced a vector store? Used by the R6.4 guard: when the
 * db file is missing or empty, retrieval/search commands point the user at
 * /index-code or /learn instead of returning an empty/confusing result.
 */
function hasVectorStore(workspaceRoot: string): boolean {
  try {
    const { dbPath } = intelligencePaths(workspaceRoot);
    const stat = fs.statSync(dbPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function runLearn(workspaceRoot: string): Promise<void> {
  const log: LogFn = logLine;
  getChannel().show(true);
  logLine(`learn: analyzing sessions for ${workspaceRoot}`);

  const summary = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AutoClaw Intelligence: learning from sessions…',
      cancellable: false,
    },
    () => learnFromSessions({ workspaceRoot, log }),
  );

  logLine(
    `learn: analyzed ${summary.sessionsAnalyzed} session(s), ` +
      `${summary.kept} kept signal(s), ${summary.patterns} pattern(s), ` +
      `${summary.workflowsMined} workflow(s) from ` +
      `source(s): ${summary.sources.join(', ') || '(none)'}`,
  );
  void vscode.window.showInformationMessage(
    `Intelligence: learned ${summary.patterns} pattern(s) + ${summary.workflowsMined} workflow(s) ` +
      `from ${summary.sessionsAnalyzed} session(s).`,
  );
}

async function runIndexCode(workspaceRoot: string): Promise<void> {
  const log: LogFn = logLine;

  // Offer a full re-index toggle (R4.3 --force).
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Incremental index', description: 'Only files changed since the last index', force: false },
      { label: 'Full re-index', description: 'Re-index every file (--force)', force: true },
    ],
    { placeHolder: 'How should the codebase be indexed?' },
  );
  if (!pick) {
    return; // user dismissed the picker
  }

  getChannel().show(true);
  logLine(`index-code: ${pick.force ? 'full re-index' : 'incremental'} for ${workspaceRoot}`);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AutoClaw Intelligence: indexing codebase…',
      cancellable: true,
    },
    (_progress, token) =>
      indexCodebase({
        workspaceRoot,
        force: pick.force,
        log,
        isCancelled: () => token.isCancellationRequested,
      }),
  );

  if (result.degraded) {
    logLine('index-code: vector backend unavailable; nothing was indexed (no-RAG mode).');
    void vscode.window.showWarningMessage(
      'Intelligence: vector backend unavailable, codebase was not indexed.',
    );
    return;
  }

  if (result.cancelled) {
    logLine(
      `index-code: cancelled after ${result.chunksIndexed} chunk(s); partial index retained.`,
    );
    void vscode.window.showWarningMessage('Intelligence: indexing cancelled.');
    return;
  }

  logLine(
    `index-code: indexed ${result.filesIndexed} file(s), ${result.chunksIndexed} chunk(s), ` +
      `swept ${result.chunksDeleted} stale chunk(s) ` +
      `(${result.incremental ? 'incremental' : 'full'})${result.commit ? ` @ ${result.commit.slice(0, 8)}` : ''}`,
  );
  if (result.staleIndex) {
    logLine(
      'index-code: WARNING — the vector store still holds vectors from a previous ' +
        'embedding model; re-run /index-code --force to rebuild and clear the stale signal.',
    );
    void vscode.window.showWarningMessage(
      'Intelligence: the index is stale (embedding model changed). Run /index-code --force to rebuild.',
    );
  }
  void vscode.window.showInformationMessage(
    `Intelligence: indexed ${result.filesIndexed} file(s) / ${result.chunksIndexed} chunk(s).`,
  );
}

async function runRetrieve(workspaceRoot: string): Promise<void> {
  if (!hasVectorStore(workspaceRoot)) {
    void vscode.window.showWarningMessage(`Intelligence: ${GUIDANCE}`);
    logLine(`retrieve: ${GUIDANCE}`);
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: 'Retrieve code for…',
    placeHolder: 'Describe what you are looking for',
  });
  if (!query) {
    return;
  }

  const log: LogFn = logLine;
  getChannel().show(true);
  logLine(`retrieve: "${query}"`);

  const hits = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AutoClaw Intelligence: retrieving code…',
      cancellable: false,
    },
    () => retrieveCode(query, { workspaceRoot, log }),
  );

  if (hits.length === 0) {
    logLine('retrieve: no matching chunks. The index may be empty or degraded.');
    void vscode.window.showInformationMessage(`Intelligence: no matches. ${GUIDANCE}`);
    return;
  }

  logLine(`retrieve: ${hits.length} result(s):`);
  for (const hit of hits) {
    logLine(`  ${hit.score.toFixed(3)}  ${hit.file}`);
  }

  const picked = await vscode.window.showQuickPick(
    hits.map((h) => ({
      label: h.file,
      description: h.score.toFixed(3),
      detail: h.content.slice(0, 200),
    })),
    { placeHolder: `${hits.length} result(s) — select to open in the output channel` },
  );
  if (picked) {
    const match = hits.find((h) => h.file === picked.label);
    if (match) {
      logLine(`--- ${match.file} (score ${match.score.toFixed(3)}) ---`);
      logLine(match.content);
    }
  }
}

async function runSearch(workspaceRoot: string): Promise<void> {
  if (!hasVectorStore(workspaceRoot)) {
    void vscode.window.showWarningMessage(`Intelligence: ${GUIDANCE}`);
    logLine(`search: ${GUIDANCE}`);
    return;
  }

  const rawQuery = await vscode.window.showInputBox({
    prompt: 'Search knowledge (learnings + memory + indexed code)…',
    placeHolder: 'Describe what you are looking for (append --limit N to cap results)',
  });
  if (!rawQuery) {
    return;
  }
  const { query, limit } = parseLimit(rawQuery);
  if (!query) {
    return;
  }

  const log: LogFn = logLine;
  getChannel().show(true);
  logLine(`search: "${query}"${limit ? ` (--limit ${limit})` : ''}`);

  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AutoClaw Intelligence: searching knowledge…',
      cancellable: false,
    },
    async () => {
      const config = loadConfig(workspaceRoot, log);
      const { dbPath } = intelligencePaths(workspaceRoot);
      const db = await initVectorBackend(config, dbPath, getActiveEmbeddingSignature(config), log);
      if (db.degraded) {
        log('search: vector backend unavailable; no results');
        db.close();
        return [];
      }
      try {
        const embedding = await getEmbedding(query, config.embedding, log);
        return db.semanticVectorSearch(embedding, {
          limit: limit ?? config.search.defaultLimit,
          minSimilarity: config.search.minSimilarity,
          project: resolveProjectKey(workspaceRoot),
        });
      } finally {
        db.close();
      }
    },
  );

  if (results.length === 0) {
    logLine('search: no matching knowledge. The store may be empty or degraded.');
    void vscode.window.showInformationMessage(`Intelligence: no matches. ${GUIDANCE}`);
    return;
  }

  logLine(`search: ${results.length} result(s):`);
  for (const r of results) {
    const file = typeof r.metadata?.file === 'string' ? (r.metadata.file as string) : r.source;
    logLine(`  ${r.score.toFixed(3)}  [${r.source}] ${file}`);
  }

  const picked = await vscode.window.showQuickPick(
    results.map((r) => {
      const file = typeof r.metadata?.file === 'string' ? (r.metadata.file as string) : r.source;
      return {
        label: file,
        description: `${r.score.toFixed(3)} · ${r.source}`,
        detail: r.content.slice(0, 200),
        id: r.id,
      };
    }),
    { placeHolder: `${results.length} result(s) — select to view in the output channel` },
  );
  if (picked) {
    const match = results.find((r) => r.id === picked.id);
    if (match) {
      logLine(`--- [${match.source}] (score ${match.score.toFixed(3)}) ---`);
      logLine(match.content);
    }
  }
}

// ---------------------------------------------------------------------------
// Wave A command handlers (sources / rag-generate / scaffold / metrics)
// ---------------------------------------------------------------------------

async function runSources(workspaceRoot: string): Promise<void> {
  const log: LogFn = logLine;
  getChannel().show(true);

  // First-run consent: present available, undecided third-party sources (R3.4).
  const consent = await pendingConsentSources({ workspaceRoot, log });
  if (consent.toPrompt.length > 0) {
    const picks = await vscode.window.showQuickPick(
      consent.toPrompt.map((id) => ({ label: id, picked: false })),
      {
        canPickMany: true,
        placeHolder: 'Enable ingestion for these third-party sources? (opt-in, local-only)',
      },
    );
    if (picks) {
      const chosen = new Set(picks.map((p) => p.label));
      for (const id of consent.toPrompt) {
        await setSourceEnabled(workspaceRoot, id, chosen.has(id), log);
      }
    }
  }

  const rows = await listSources({ workspaceRoot, countSessions: true, log });
  logLine('Intelligence — Sources:');
  for (const r of rows) {
    logLine(
      `  [tier ${r.tier}] ${r.displayName} (${r.id}): ${r.enabled ? 'enabled' : 'disabled'}, ` +
        `${r.available ? 'available' : 'unavailable'}` +
        (typeof r.sessionCount === 'number' ? `, ${r.sessionCount} session(s)` : '') +
        (r.locations[0] ? ` @ ${r.locations[0]}` : '') +
        (r.hint && !r.available ? ` — ${r.hint}` : ''),
    );
  }

  const action = await vscode.window.showQuickPick(
    rows.map((r) => ({
      label: `${r.enabled ? 'Disable' : 'Enable'} ${r.displayName}`,
      id: r.id,
      enable: !r.enabled,
    })),
    { placeHolder: 'Toggle a source (Esc to skip)' },
  );
  if (action) {
    await setSourceEnabled(workspaceRoot, action.id, action.enable, log);
    void vscode.window.showInformationMessage(
      `Intelligence: ${action.enable ? 'enabled' : 'disabled'} ${action.id}.`,
    );
  }
}

async function runRagGenerate(workspaceRoot: string): Promise<void> {
  const task = await vscode.window.showInputBox({
    prompt: 'Describe the task for a RAG-augmented prompt',
    placeHolder: 'e.g. Add pagination to the /users endpoint',
  });
  if (!task) {
    return;
  }
  const log: LogFn = logLine;
  getChannel().show(true);
  logLine(`rag-generate: "${task}"`);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'AutoClaw Intelligence: generating RAG prompt…',
      cancellable: false,
    },
    () => generateRAGPrompt(task, { workspaceRoot, log }),
  );

  await vscode.env.clipboard.writeText(result.prompt);
  logLine(
    `rag-generate: ${result.usedCode ? `${result.codeHits} code chunk(s)` : 'no code (degraded/empty)'}, ` +
      `${result.learningHits} learning(s); copied to clipboard.`,
  );
  for (const note of result.notes) {
    logLine(`rag-generate: note — ${note}`);
  }
  logLine('--- RAG PROMPT ---');
  logLine(result.prompt);
  void vscode.window.showInformationMessage(
    `Intelligence: RAG prompt copied to clipboard${result.usedCode ? '' : ' (code retrieval unavailable)'}.`,
  );
}

async function runScaffold(workspaceRoot: string): Promise<void> {
  const focus = await vscode.window.showInputBox({
    prompt: 'Focus area for the scaffold (optional)',
    placeHolder: 'e.g. error handling',
  });
  // empty string = no focus; undefined = user cancelled
  if (focus === undefined) {
    return;
  }
  getChannel().show(true);
  const scaffold = buildScaffold({ workspaceRoot, focus: focus.trim() || undefined });
  await vscode.env.clipboard.writeText(scaffold);
  logLine(`scaffold:${focus.trim() ? ` focus="${focus.trim()}"` : ''} copied to clipboard.`);
  logLine('--- SCAFFOLD ---');
  logLine(scaffold);
  void vscode.window.showInformationMessage('Intelligence: scaffold copied to clipboard.');
}

async function runMetrics(workspaceRoot: string): Promise<void> {
  getChannel().show(true);
  const data = getDashboardData(workspaceRoot);
  if (data.empty) {
    logLine('metrics: no learning runs recorded yet. Run /learn first.');
    void vscode.window.showInformationMessage(
      'Intelligence: no metrics yet. Run /learn to record a run.',
    );
    return;
  }
  const s = data.summary;
  logLine('Intelligence — Metrics:');
  logLine(`  runs: ${s.totalRuns}, sessions: ${s.totalSessions}, patterns: ${s.totalPatterns}`);
  logLine(`  avg kept rate: ${(s.avgKeptRate * 100).toFixed(1)}%`);
  logLine(
    `  tokens: ${s.tokens.hasReal ? `${s.tokens.real} real` : `${s.tokens.estimated} estimated`}` +
      (s.totalCostUsd > 0 ? `, cost $${s.totalCostUsd.toFixed(4)}` : ''),
  );
  void vscode.window.showInformationMessage(
    `Intelligence: ${s.totalRuns} run(s), avg kept ${(s.avgKeptRate * 100).toFixed(0)}%.`,
  );
}

async function runEffectiveness(workspaceRoot: string): Promise<void> {
  getChannel().show(true);
  const matrix = getEffectiveness(workspaceRoot);
  if (matrix.byTool.length === 0) {
    logLine('effectiveness: no matrix recorded yet. Run /learn first.');
    void vscode.window.showInformationMessage(
      'Intelligence: no effectiveness data yet. Run /learn to build the matrix.',
    );
    return;
  }
  logLine(`Intelligence — Effectiveness (from ${matrix.totalSessions} session(s)):`);
  logLine('  By tool (ship rate · sessions · kept/session · tokens/kept):');
  for (const c of matrix.byTool) {
    logLine(
      `    ${c.tool}: ${(c.shipRate * 100).toFixed(0)}% · ${c.sessions} sess · ` +
        `${c.keptPerSession.toFixed(2)} kept/sess · ${Math.round(c.tokensPerKept)} tok/kept`,
    );
  }
  // Show the strongest tool×project rows (already ranked best-first).
  const topRows = matrix.byToolProject.slice(0, 15);
  if (topRows.length > 0) {
    logLine('  Top tool × project rows:');
    for (const c of topRows) {
      logLine(
        `    ${c.tool} @ ${c.projectLabel}: ${(c.shipRate * 100).toFixed(0)}% · ${c.sessions} sess`,
      );
    }
  }
  const best = matrix.byTool[0];
  void vscode.window.showInformationMessage(
    `Intelligence: best tool ${best.tool} (${(best.shipRate * 100).toFixed(0)}% ship over ${best.sessions} session(s)).`,
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wrap a command handler so it resolves the workspace root once, warns when no
 * folder is open, and surfaces unexpected errors without crashing the host.
 */
function withWorkspace(
  getWorkspaceRoot: () => string | undefined,
  handler: (workspaceRoot: string) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      void vscode.window.showWarningMessage(
        'AutoClaw Intelligence: open a workspace folder first.',
      );
      return;
    }
    try {
      await handler(workspaceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`AutoClaw Intelligence: ${message}`);
    }
  };
}

/** The optional `autoclaw.intelligence.backendDir` setting (empty ⇒ unset). */
function backendDirSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration('autoclaw.intelligence').get<string>('backendDir');
  return v && v.trim() !== '' ? v : undefined;
}

/** The optional `autoclaw.intelligence.systemDir` setting (cross-project tier). */
function systemDirSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration('autoclaw.intelligence').get<string>('systemDir');
  return v && v.trim() !== '' ? v : undefined;
}

/**
 * Where the `sqlite-vec` native peer installs. Defaults PROJECT-LOCAL
 * (`<workspace>/.autoclaw/native`) so nothing is forced onto C:; the
 * `backendDir` setting overrides; the extension globalStorage is only a
 * last-resort fallback when there is no workspace.
 */
function backendDir(context: vscode.ExtensionContext, workspaceRoot: string | undefined): string {
  return resolveBackendDir(workspaceRoot, backendDirSetting(), context.globalStorageUri.fsPath);
}

/** Pinned `sqlite-vec` version from the extension manifest's optionalDependencies. */
function pinnedSqliteVecVersion(context: vscode.ExtensionContext): string {
  const opt = (context.extension?.packageJSON?.optionalDependencies ?? {}) as Record<string, string>;
  return typeof opt['sqlite-vec'] === 'string' ? opt['sqlite-vec'] : 'latest';
}

/** Point the host-free vector loader at the installed backend when present. */
function wireInstalledBackend(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): void {
  const dir = backendDir(context, workspaceRoot);
  if (isBackendInstalled(dir)) {
    process.env[VEC_DIR_ENV] = dir;
  }
}

/**
 * `autoclaw.intelligence.installBackend` — install the `sqlite-vec` native peer
 * (the `vec0` loadable) so RAG/indexing works in the packaged extension, where
 * the native peers are excluded from the `.vsix`. Installs PROJECT-LOCAL by
 * default (`<workspace>/.autoclaw/native`, configurable via `backendDir`) — never
 * forced onto C:. The SQLite engine itself is Node-core `node:sqlite` (no
 * install). Idempotent + re-runnable.
 */
async function runInstallBackend(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<void> {
  const dir = backendDir(context, workspaceRoot);
  const version = pinnedSqliteVecVersion(context);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AutoClaw Intelligence: installing vector backend (sqlite-vec@${version}) → ${dir}…`,
      cancellable: false,
    },
    () => Promise.resolve(installVectorBackend({ targetDir: dir, version, log: logLine })),
  );

  if (result.ok) {
    process.env[VEC_DIR_ENV] = result.installedDir ?? dir;
    logLine(`install-backend: ready at ${result.installedDir ?? dir} (${result.loadablePath}).`);
    void vscode.window.showInformationMessage(
      `Intelligence vector backend installed (${dir}). Run "Index Codebase" to build the RAG index.`,
    );
    return;
  }
  logLine(`install-backend: FAILED — ${result.error}`);
  void vscode.window.showErrorMessage(
    `Intelligence backend install failed: ${result.error}. ` +
      'Ensure node:sqlite is available (Node 24 / recent Electron) and npm is on PATH.',
  );
}

/**
 * `autoclaw.intelligence.status` — a visibility report: WHERE every store lives
 * (project root, vector index, backend dir, optional system tier), HOW MUCH data
 * is there, the index watermark, and the learn summary. Read-only.
 */
async function runStatus(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage('AutoClaw Intelligence: open a workspace folder first.');
    return;
  }
  const paths = intelligencePaths(workspaceRoot);
  const bdir = backendDir(context, workspaceRoot);
  const status = gatherStorageStatus({
    workspaceRoot,
    contractRoot: paths.root,
    dbPath: paths.dbPath,
    lastIndexPath: paths.lastIndexPath,
    backendDir: bdir,
    backendInstalled: isBackendInstalled(bdir),
    systemDir: systemDirSetting(),
  });
  const s = getDashboardData(workspaceRoot).summary;

  const ch = getChannel();
  ch.show(true);
  ch.appendLine('────────────────────────────────────────────────────────');
  ch.appendLine('AutoClaw Intelligence — Status');
  ch.appendLine('────────────────────────────────────────────────────────');
  ch.appendLine('STORAGE (locations + sizes):');
  ch.appendLine(`  project data : ${status.projectRoot.path}  (${formatBytes(status.projectRoot.sizeBytes)})`);
  ch.appendLine(`  vector index : ${status.index.dbPath}  (${formatBytes(status.index.dbSizeBytes)})`);
  ch.appendLine(
    `  backend      : ${status.backend.path}  (${status.backend.installed ? 'installed' : 'NOT installed'})`,
  );
  ch.appendLine(
    `  system tier  : ${status.system.enabled ? `${(status.system as { path: string }).path}` : 'disabled (set autoclaw.intelligence.systemDir to enable)'}`,
  );
  ch.appendLine('INDEX:');
  ch.appendLine(
    `  last indexed : ${status.index.indexedAt ?? '(never)'}${status.index.commit ? `  @ ${status.index.commit.slice(0, 8)}` : ''}`,
  );
  ch.appendLine('LEARN:');
  ch.appendLine(
    `  sessions=${s.totalSessions}  patterns=${s.totalPatterns}  kept-rate=${(s.avgKeptRate * 100).toFixed(1)}%  runs=${s.totalRuns}`,
  );
  ch.appendLine(
    `  tokens(est)=${s.tokens.estimated}  cost=$${s.totalCostUsd.toFixed(4)}`,
  );
  ch.appendLine('────────────────────────────────────────────────────────');

  void vscode.window.showInformationMessage(
    `Intelligence: index ${formatBytes(status.index.dbSizeBytes)} at ${status.index.dbPath} · ${s.totalSessions} sessions learned. Details in the "AutoClaw — Intelligence" output.`,
  );
}

/**
 * Register the Intelligence commands. Registration is side-effect free beyond
 * pushing disposables onto `context.subscriptions` and pointing the vector
 * loader at an already-installed backend; no intelligence I/O runs until a
 * command is invoked.
 */
export function registerIntelligenceCommands(
  context: vscode.ExtensionContext,
  getWorkspaceRoot: () => string | undefined,
): void {
  wireInstalledBackend(context, getWorkspaceRoot());
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.installBackend', () =>
      runInstallBackend(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand('autoclaw.intelligence.status', () =>
      runStatus(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.learn',
      withWorkspace(getWorkspaceRoot, runLearn),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.indexCode',
      withWorkspace(getWorkspaceRoot, runIndexCode),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.retrieve',
      withWorkspace(getWorkspaceRoot, runRetrieve),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.search',
      withWorkspace(getWorkspaceRoot, runSearch),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.sources',
      withWorkspace(getWorkspaceRoot, runSources),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.ragGenerate',
      withWorkspace(getWorkspaceRoot, runRagGenerate),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.scaffold',
      withWorkspace(getWorkspaceRoot, runScaffold),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.metrics',
      withWorkspace(getWorkspaceRoot, runMetrics),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.effectiveness',
      withWorkspace(getWorkspaceRoot, runEffectiveness),
    ),
  );
}
