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
import * as vscode from 'vscode';

import {
  LogFn,
  learnFromSessions,
  indexCodebase,
  retrieveCode,
  loadConfig,
  getActiveEmbeddingSignature,
  intelligencePaths,
  initVectorDB,
  getEmbedding,
  resolveProjectKey,
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
      `${summary.kept} kept signal(s), ${summary.patterns} pattern(s) from ` +
      `source(s): ${summary.sources.join(', ') || '(none)'}`,
  );
  void vscode.window.showInformationMessage(
    `Intelligence: learned ${summary.patterns} pattern(s) from ${summary.sessionsAnalyzed} session(s).`,
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
      const db = await initVectorDB(dbPath, getActiveEmbeddingSignature(config), log);
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

/**
 * Register the four Intelligence commands. Registration is side-effect free
 * beyond pushing disposables onto `context.subscriptions`; no intelligence I/O
 * runs until a command is invoked.
 */
export function registerIntelligenceCommands(
  context: vscode.ExtensionContext,
  getWorkspaceRoot: () => string | undefined,
): void {
  context.subscriptions.push(
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
  );
}
