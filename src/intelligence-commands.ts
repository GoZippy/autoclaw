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
  installEmbeddingsProvider,
  isEmbeddingsInstalled,
  TRANSFORMERS_DIR_ENV,
  TRANSFORMERS_CACHE_ENV,
} from './intelligence/installEmbeddings';
import {
  resolveBackendDir,
  gatherStorageStatus,
  formatBytes,
  systemPaths,
  relocateStore,
} from './intelligence/storage';
import {
  ensureSystemStore,
  upsertProject,
  readRegistry,
  promoteInsight,
  readSystemLearnings,
  searchSystemLearnings,
  parseInsightItems,
} from './intelligence/systemStore';
import { buildSteeringMarkdown } from './intelligence/steering';
import { buildSkillScaffold, slugify } from './intelligence/toolScaffold';
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
  detectOllama,
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
  recordProjectInSystemTier(workspaceRoot, {
    learnSessions: summary.sessionsAnalyzed,
    lastLearnedAt: new Date().toISOString(),
  });
  promoteLatestInsightToSystem(workspaceRoot);
}

async function runIndexCode(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<void> {
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

  // First-run embeddings guide: offer to install semantic embeddings (or pick
  // Ollama / basic) before indexing, instead of silently degrading to `none`.
  await guideEmbeddingsBeforeIndex(context, workspaceRoot);

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
  recordProjectInSystemTier(workspaceRoot, {
    indexChunks: result.chunksIndexed,
    lastIndexedAt: new Date().toISOString(),
  });
}

/**
 * Register the project + run stats in the cross-project system registry. No-op
 * unless `autoclaw.intelligence.systemDir` is configured. Best-effort: never
 * blocks or throws into the command.
 */
function recordProjectInSystemTier(
  workspaceRoot: string,
  fields: {
    indexChunks?: number;
    lastIndexedAt?: string;
    learnSessions?: number;
    lastLearnedAt?: string;
  },
): void {
  const sys = systemPaths(systemDirSetting());
  if (!sys) {
    return;
  }
  try {
    ensureSystemStore(sys);
    upsertProject(sys.registryPath, {
      path: workspaceRoot,
      name: path.basename(workspaceRoot),
      ...fields,
    });
    logLine(`system-tier: registered ${path.basename(workspaceRoot)} in ${sys.registryPath}`);
  } catch {
    /* best effort */
  }
}

/**
 * After a learn run, promote the distilled pattern bullets of the newest insight
 * into the cross-project system store (deduped). No-op unless a system dir is set.
 * Best-effort.
 */
/** Read the newest `insight-*.md` from the project's learnings dir, or undefined. */
function latestInsightMarkdown(workspaceRoot: string): string | undefined {
  try {
    const learningsDir = intelligencePaths(workspaceRoot).learningsDir;
    const insights = fs
      .readdirSync(learningsDir)
      .filter((f) => /^insight-.*\.md$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(learningsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (insights.length === 0) {
      return undefined;
    }
    return fs.readFileSync(path.join(learningsDir, insights[0].f), 'utf8');
  } catch {
    return undefined;
  }
}

function promoteLatestInsightToSystem(workspaceRoot: string): void {
  const sys = systemPaths(systemDirSetting());
  if (!sys) {
    return;
  }
  const md = latestInsightMarkdown(workspaceRoot);
  if (!md) {
    return;
  }
  try {
    const res = promoteInsight(sys, {
      project: workspaceRoot,
      insightMarkdown: md,
      capturedAt: new Date().toISOString(),
    });
    if (res.promoted > 0) {
      logLine(`system-tier: promoted ${res.promoted}/${res.scanned} distilled learning(s) to ${sys.root}`);
    }
  } catch {
    /* best effort */
  }
}

/**
 * `autoclaw.intelligence.generateSteering` — write a steering file from the
 * distilled learnings (latest insight + optional system tier) so any agent can
 * pick up this project's learned conventions. Writes `<workspace>/.autoclaw/steering.md`.
 */
async function runGenerateSteering(workspaceRoot: string): Promise<void> {
  const md = latestInsightMarkdown(workspaceRoot);
  if (!md) {
    void vscode.window.showWarningMessage(
      'Intelligence: no learnings yet. Run "Learn from Sessions" first, then generate steering.',
    );
    return;
  }
  const items = parseInsightItems(md);
  const byKind = (kind: string): string[] => items.filter((i) => i.kind === kind).map((i) => i.text);

  const sys = systemPaths(systemDirSetting());
  const systemLearnings = sys
    ? readSystemLearnings(sys).slice(-12).map((l) => ({ text: l.text, kind: l.kind, project: path.basename(l.project) }))
    : undefined;

  const steering = buildSteeringMarkdown({
    projectName: path.basename(workspaceRoot),
    generatedAt: new Date().toISOString(),
    patterns: byKind('pattern'),
    avoid: byKind('avoid'),
    tools: byKind('tool'),
    systemLearnings,
  });

  const outPath = path.join(intelligencePaths(workspaceRoot).root, 'steering.md');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, steering, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to write steering file: ${String(err)}`);
    return;
  }
  logLine(`generate-steering: wrote ${toForwardSlashLocal(outPath)}`);
  const choice = await vscode.window.showInformationMessage(
    `Intelligence: steering written to .autoclaw/steering.md (${items.length} learned item(s)).`,
    'Open',
  );
  if (choice === 'Open') {
    const doc = await vscode.workspace.openTextDocument(outPath);
    void vscode.window.showTextDocument(doc);
  }
}

/** Local forward-slash helper for log output (paths.ts' toForwardSlash is host-free too). */
function toForwardSlashLocal(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `autoclaw.intelligence.generateScaffold` — scaffold a new skill/tool stub
 * (SKILL.md) seeded with this project's learned conventions, written under
 * `<workspace>/.autoclaw/scaffolds/<slug>.md`.
 */
async function runGenerateScaffold(workspaceRoot: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Generate Skill/Tool Scaffold',
    prompt: 'Name of the new skill/tool',
    placeHolder: 'e.g. Release Checklist',
    ignoreFocusOut: true,
  });
  if (!name || name.trim() === '') {
    return;
  }
  const purpose =
    (await vscode.window.showInputBox({
      title: 'Generate Skill/Tool Scaffold',
      prompt: 'One-line purpose (optional)',
      ignoreFocusOut: true,
    })) ?? '';

  const md = latestInsightMarkdown(workspaceRoot);
  const items = md ? parseInsightItems(md) : [];
  const scaffold = buildSkillScaffold({
    name: name.trim(),
    purpose: purpose.trim(),
    projectName: path.basename(workspaceRoot),
    conventions: items.filter((i) => i.kind === 'pattern').map((i) => i.text),
    avoid: items.filter((i) => i.kind === 'avoid').map((i) => i.text),
    generatedAt: new Date().toISOString(),
  });

  const outPath = path.join(
    intelligencePaths(workspaceRoot).root,
    'scaffolds',
    `${slugify(name)}.md`,
  );
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, scaffold, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to write scaffold: ${String(err)}`);
    return;
  }
  logLine(`generate-scaffold: wrote ${toForwardSlashLocal(outPath)}`);
  const choice = await vscode.window.showInformationMessage(
    `Intelligence: scaffold written to .autoclaw/scaffolds/${slugify(name)}.md.`,
    'Open',
  );
  if (choice === 'Open') {
    const doc = await vscode.workspace.openTextDocument(outPath);
    void vscode.window.showTextDocument(doc);
  }
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
    appendSystemTierCrossRef(query);
    void vscode.window.showInformationMessage(`Intelligence: no local matches. ${GUIDANCE}`);
    return;
  }

  logLine(`retrieve: ${hits.length} result(s):`);
  for (const hit of hits) {
    logLine(`  ${hit.score.toFixed(3)}  ${hit.file}`);
  }
  appendSystemTierCrossRef(query);

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
    appendSystemTierCrossRef(query);
    void vscode.window.showInformationMessage(`Intelligence: no local matches. ${GUIDANCE}`);
    return;
  }

  logLine(`search: ${results.length} result(s):`);
  for (const r of results) {
    const file = typeof r.metadata?.file === 'string' ? (r.metadata.file as string) : r.source;
    logLine(`  ${r.score.toFixed(3)}  [${r.source}] ${file}`);
  }
  appendSystemTierCrossRef(query);

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

/**
 * Local→system retrieval fallback: when the system tier is enabled, surface
 * matching cross-project learnings AND which other projects know about the query
 * (from the registry) alongside the local results. No-op when systemDir is unset.
 */
function appendSystemTierCrossRef(query: string): void {
  const sys = systemPaths(systemDirSetting());
  if (!sys) {
    return;
  }
  try {
    const ch = getChannel();
    const hits = searchSystemLearnings(sys, query, 6);
    if (hits.length > 0) {
      ch.appendLine(`  ↳ cross-project system knowledge (${hits.length}):`);
      for (const h of hits) {
        ch.appendLine(`      [${h.kind}/${h.tier}] ${h.text}   — ${path.basename(h.project)}`);
      }
    }
    // Which other projects mention the query (registry name/topic match).
    const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 3);
    const projects = readRegistry(sys.registryPath).projects.filter((p) => {
      const hay = `${p.name} ${(p.topics ?? []).join(' ')}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    });
    if (projects.length > 0) {
      ch.appendLine(`  ↳ projects that may know about this: ${projects.map((p) => p.name).join(', ')}`);
    }
  } catch {
    /* best effort — cross-ref is additive */
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

/** The optional `autoclaw.intelligence.modelCacheDir` setting (empty ⇒ unset). */
function modelCacheDirSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration('autoclaw.intelligence').get<string>('modelCacheDir');
  return v && v.trim() !== '' ? v : undefined;
}

/**
 * Where the embeddings model weights cache. Defaults PROJECT-LOCAL
 * (`<workspace>/.autoclaw/models`) so multi-hundred-MB downloads stay in the
 * project root and are never forced onto C:; the `modelCacheDir` setting
 * overrides; the extension globalStorage is a last resort when no workspace.
 */
function modelCacheDir(context: vscode.ExtensionContext, workspaceRoot: string | undefined): string {
  const override = modelCacheDirSetting();
  if (override) {
    return override;
  }
  if (workspaceRoot) {
    return intelligencePaths(workspaceRoot).root + '/models';
  }
  return context.globalStorageUri.fsPath + '/models';
}

/** Pinned `@xenova/transformers` version from the extension manifest's optionalDependencies. */
function pinnedTransformersVersion(context: vscode.ExtensionContext): string {
  const opt = (context.extension?.packageJSON?.optionalDependencies ?? {}) as Record<string, string>;
  return typeof opt['@xenova/transformers'] === 'string' ? opt['@xenova/transformers'] : 'latest';
}

/**
 * Point the host-free embeddings loader at an installed `@xenova/transformers`
 * (and its project-local model cache) when present, so semantic embeddings work
 * after a window reload without re-running the install command. The package
 * shares the backend `native` dir.
 */
function wireInstalledEmbeddings(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): void {
  const dir = backendDir(context, workspaceRoot);
  if (isEmbeddingsInstalled(dir)) {
    process.env[TRANSFORMERS_DIR_ENV] = dir;
    process.env[TRANSFORMERS_CACHE_ENV] = modelCacheDir(context, workspaceRoot);
  }
}

/**
 * Persist the Intelligence embedding provider into `<workspace>/.autoclaw/vector/
 * config.json` (read → merge → write), so the choice survives reloads. Mirrors
 * the direct-write pattern in `sources/consent.ts`. Best-effort dir creation.
 */
function setEmbeddingProvider(
  workspaceRoot: string,
  provider: 'transformers' | 'ollama' | 'none',
  model?: string,
): void {
  const { configPath, vectorDir } = intelligencePaths(workspaceRoot);
  fs.mkdirSync(vectorDir, { recursive: true });
  let onDisk: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        onDisk = parsed as Record<string, unknown>;
      }
    }
  } catch {
    onDisk = {}; // malformed config — overwrite with a clean minimal object
  }
  const embedding =
    onDisk.embedding && typeof onDisk.embedding === 'object' && !Array.isArray(onDisk.embedding)
      ? (onDisk.embedding as Record<string, unknown>)
      : {};
  embedding.provider = provider;
  if (model) {
    embedding.model = model;
  }
  onDisk.embedding = embedding;
  fs.writeFileSync(configPath, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
}

/** Ollama's drop-in 768-dim embedding model (matches the default dimension). */
const OLLAMA_EMBED_MODEL = 'nomic-embed-text';

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
 * Download + install `@xenova/transformers` into the project-local `native` dir,
 * point the loader at it, and persist `embedding.provider = transformers`.
 * Shared by the install command and the first-run guide. Returns whether the
 * provider is now ready. Behind a progress notification — the install is large
 * (~135 MB with native builds) and the model downloads on the first index.
 */
async function installTransformersProvider(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<boolean> {
  const dir = backendDir(context, workspaceRoot);
  const version = pinnedTransformersVersion(context);
  const cache = modelCacheDir(context, workspaceRoot);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AutoClaw Intelligence: installing embeddings provider (@xenova/transformers@${version}, ~135 MB, one time) → ${dir}…`,
      cancellable: false,
    },
    () => installEmbeddingsProvider({ targetDir: dir, version, log: logLine }),
  );

  if (result.ok) {
    process.env[TRANSFORMERS_DIR_ENV] = result.installedDir ?? dir;
    process.env[TRANSFORMERS_CACHE_ENV] = cache;
    if (workspaceRoot) {
      setEmbeddingProvider(workspaceRoot, 'transformers');
    }
    logLine(
      `install-embeddings: ready at ${result.installedDir ?? dir} (entry ${result.entryPath}); ` +
        `model cache → ${cache}`,
    );
    void vscode.window.showInformationMessage(
      `Intelligence: semantic embeddings installed. The embedding model downloads to ${cache} ` +
        `on the first index (one time). Run "Index Codebase" to (re)build the semantic index.`,
    );
    return true;
  }
  logLine(`install-embeddings: FAILED — ${result.error}`);
  void vscode.window.showErrorMessage(
    `Intelligence embeddings install failed: ${result.error}. Ensure npm is on PATH and you have ` +
      `network access. You can use Ollama instead, or stay on basic 'none' embeddings.`,
  );
  return false;
}

/**
 * `autoclaw.intelligence.installEmbeddings` — choose + provision the embedding
 * provider so RAG uses real semantic vectors instead of the low-quality `none`
 * fallback. Explains what each option installs + where, then provisions it:
 *   - transformers → local ONNX via `@xenova/transformers` (project-local, ~135 MB)
 *   - ollama       → your local Ollama server (no download here)
 *   - none         → fast hashed embeddings, no download (lower quality)
 * Project-local + user-relocatable; never forced onto C:.
 */
async function runInstallEmbeddings(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<void> {
  const dir = backendDir(context, workspaceRoot);
  const cache = modelCacheDir(context, workspaceRoot);
  const ollamaUp = await detectOllama();

  const TRANSFORMERS = `Semantic embeddings (recommended) — install @xenova/transformers`;
  const OLLAMA = ollamaUp
    ? 'Use Ollama (detected) — local server, no download here'
    : 'Use Ollama — requires installing Ollama separately';
  const NONE = 'Basic only — fast, no download, lower retrieval quality';

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: TRANSFORMERS,
        detail: `~135 MB one-time install → ${dir}; model downloads to ${cache} on first index. Best quality, fully local/offline after.`,
      },
      {
        label: OLLAMA,
        detail: ollamaUp
          ? `Uses your running Ollama with the "${OLLAMA_EMBED_MODEL}" model (run: ollama pull ${OLLAMA_EMBED_MODEL}). No npm download.`
          : `Install Ollama from ollama.com, then: ollama pull ${OLLAMA_EMBED_MODEL}. No npm download here.`,
      },
      {
        label: NONE,
        detail: 'Deterministic hashed vectors. Works instantly with zero dependencies, but retrieval is weaker.',
      },
    ],
    {
      placeHolder: 'Choose how AutoClaw Intelligence should compute embeddings',
      ignoreFocusOut: true,
    },
  );
  if (!pick) {
    return; // dismissed
  }
  getChannel().show(true);

  if (pick.label === TRANSFORMERS) {
    await installTransformersProvider(context, workspaceRoot);
    return;
  }
  if (pick.label === OLLAMA) {
    if (workspaceRoot) {
      setEmbeddingProvider(workspaceRoot, 'ollama', OLLAMA_EMBED_MODEL);
    }
    logLine(
      `install-embeddings: provider set to ollama (model ${OLLAMA_EMBED_MODEL}); ` +
        `ollama ${ollamaUp ? 'detected' : 'NOT detected — install it + pull the model'}.`,
    );
    void vscode.window.showInformationMessage(
      ollamaUp
        ? `Intelligence: using Ollama embeddings ("${OLLAMA_EMBED_MODEL}"). If you haven't yet, run: ollama pull ${OLLAMA_EMBED_MODEL}. Then "Index Codebase".`
        : `Intelligence: set to Ollama. Install Ollama (ollama.com), run "ollama pull ${OLLAMA_EMBED_MODEL}", then "Index Codebase".`,
    );
    return;
  }
  // NONE
  if (workspaceRoot) {
    setEmbeddingProvider(workspaceRoot, 'none');
  }
  logLine('install-embeddings: provider set to none (basic hashed embeddings).');
  void vscode.window.showInformationMessage(
    'Intelligence: using basic embeddings (no download). Re-run "Install Embeddings Provider" anytime to enable semantic embeddings.',
  );
}

/**
 * First-run guide invoked before indexing: when the active provider is
 * `transformers` but the package is not installed, offer to install it, switch
 * to Ollama, or stay on basic — instead of silently degrading + warning per
 * chunk. Returns after the user's choice; indexing then proceeds either way.
 * No-op (proceeds silently) when the provider is already usable or the user has
 * deliberately chosen ollama/none.
 */
async function guideEmbeddingsBeforeIndex(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): Promise<void> {
  const cfg = loadConfig(workspaceRoot);
  if (cfg.embedding.provider !== 'transformers') {
    return; // user picked ollama/none — respect it, no nagging
  }
  const dir = backendDir(context, workspaceRoot);
  if (isEmbeddingsInstalled(dir)) {
    // Already installed — make sure the loader + model cache are wired this session.
    wireInstalledEmbeddings(context, workspaceRoot);
    return;
  }

  const INSTALL = 'Install semantic (recommended)';
  const OLLAMA = 'Use Ollama';
  const BASIC = 'Keep basic (none)';
  const choice = await vscode.window.showInformationMessage(
    'AutoClaw Intelligence: semantic embeddings (@xenova/transformers) are not installed, so indexing ' +
      "will use basic 'none' embeddings (lower retrieval quality). Install the semantic provider for " +
      'best results? You can change this anytime via "Install Embeddings Provider".',
    INSTALL,
    OLLAMA,
    BASIC,
  );

  if (choice === INSTALL) {
    await installTransformersProvider(context, workspaceRoot);
  } else if (choice === OLLAMA) {
    setEmbeddingProvider(workspaceRoot, 'ollama', OLLAMA_EMBED_MODEL);
    const ollamaUp = await detectOllama();
    void vscode.window.showInformationMessage(
      ollamaUp
        ? `Intelligence: using Ollama embeddings ("${OLLAMA_EMBED_MODEL}").`
        : `Intelligence: set to Ollama. Install it (ollama.com) + run "ollama pull ${OLLAMA_EMBED_MODEL}".`,
    );
  } else if (choice === BASIC) {
    setEmbeddingProvider(workspaceRoot, 'none'); // persist so it won't ask again
    logLine('index-code: keeping basic embeddings (provider set to none).');
  }
  // dismissed → proceed this run on the de-spammed none fallback, ask again next time
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
  const cfg = loadConfig(workspaceRoot);
  const embInstalled = isEmbeddingsInstalled(bdir);
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
  ch.appendLine('EMBEDDINGS:');
  ch.appendLine(
    `  provider     : ${cfg.embedding.provider}  (model ${cfg.embedding.model}, ${cfg.embedding.dimension}-dim)` +
      (cfg.embedding.provider === 'transformers'
        ? `  — ${embInstalled ? 'installed' : "NOT installed; using basic 'none' fallback. Run \"Install Embeddings Provider\""}`
        : ''),
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
 * `autoclaw.intelligence.systemTier` — view the cross-project SYSTEM tier: its
 * store location and the project↔store registry (which projects have intelligence,
 * how much). Off until `autoclaw.intelligence.systemDir` is set.
 */
async function runSystemTier(): Promise<void> {
  const sys = systemPaths(systemDirSetting());
  if (!sys) {
    const choice = await vscode.window.showInformationMessage(
      'The cross-project system intelligence tier is OFF. Set "autoclaw.intelligence.systemDir" to a directory (any drive) to enable it.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'autoclaw.intelligence.systemDir',
      );
    }
    return;
  }
  ensureSystemStore(sys);
  const reg = readRegistry(sys.registryPath);
  const learnings = readSystemLearnings(sys);
  const ch = getChannel();
  ch.show(true);
  ch.appendLine('────────────────────────────────────────────────────────');
  ch.appendLine('AutoClaw Intelligence — System Tier (cross-project)');
  ch.appendLine('────────────────────────────────────────────────────────');
  ch.appendLine(`  store     : ${sys.root}`);
  ch.appendLine(`  registry  : ${sys.registryPath}`);
  ch.appendLine(`  projects  : ${reg.projects.length}`);
  ch.appendLine(`  learnings : ${learnings.length} (distilled cross-project patterns)`);
  for (const p of reg.projects) {
    ch.appendLine(
      `   • ${p.name}  (${p.path})` +
        `${p.indexChunks != null ? `  chunks=${p.indexChunks}` : ''}` +
        `${p.learnSessions != null ? `  sessions=${p.learnSessions}` : ''}` +
        `${p.lastIndexedAt ? `  indexed=${p.lastIndexedAt.slice(0, 10)}` : ''}`,
    );
  }
  ch.appendLine('────────────────────────────────────────────────────────');

  // Offer a cross-project search over the promoted learnings.
  const query = await vscode.window.showInputBox({
    title: 'Search System Intelligence',
    prompt: `Search ${learnings.length} cross-project learning(s) — leave empty to skip`,
    ignoreFocusOut: true,
  });
  if (query && query.trim() !== '') {
    const hits = searchSystemLearnings(sys, query.trim(), 15);
    ch.appendLine(`\nSearch "${query.trim()}" → ${hits.length} hit(s):`);
    for (const h of hits) {
      ch.appendLine(`   [${h.kind}/${h.tier}] ${h.text}   — ${path.basename(h.project)}`);
    }
    ch.appendLine('────────────────────────────────────────────────────────');
    void vscode.window.showInformationMessage(
      `System search "${query.trim()}": ${hits.length} hit(s). See the "AutoClaw — Intelligence" output.`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Intelligence system tier: ${reg.projects.length} project(s), ${learnings.length} learning(s) at ${sys.root}.`,
  );
}

/**
 * `autoclaw.intelligence.relocateBackend` — move the installed vector backend
 * (sqlite-vec) to a new directory/drive and persist the choice in the
 * `backendDir` setting. Post-install control over where data lives.
 */
async function runRelocateBackend(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<void> {
  const current = backendDir(context, workspaceRoot);
  const target = await vscode.window.showInputBox({
    title: 'Relocate Intelligence Vector Backend',
    prompt: 'New directory for the sqlite-vec backend (any drive). Its contents will be moved here.',
    value: current,
    ignoreFocusOut: true,
  });
  if (!target || target.trim() === '' || target.trim() === current) {
    return;
  }
  const dest = target.trim();
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AutoClaw Intelligence: relocating backend → ${dest}…`,
      cancellable: false,
    },
    () => Promise.resolve(relocateStore(current, dest)),
  );

  if (!result.ok) {
    logLine(`relocate-backend: FAILED — ${result.error}`);
    void vscode.window.showErrorMessage(
      `Relocate failed: ${result.error}. (If the backend is in use, reload the window and retry.)`,
    );
    return;
  }
  // Persist the choice so future resolves + installs use the new dir.
  await vscode.workspace
    .getConfiguration('autoclaw.intelligence')
    .update('backendDir', dest, vscode.ConfigurationTarget.Global);
  process.env[VEC_DIR_ENV] = dest;
  logLine(`relocate-backend: moved ${formatBytes(result.movedBytes ?? 0)} → ${result.to}`);
  void vscode.window.showInformationMessage(
    `Intelligence backend relocated to ${result.to} (${formatBytes(result.movedBytes ?? 0)}). Reload the window if retrieval was active.`,
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
  wireInstalledEmbeddings(context, getWorkspaceRoot());
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.installBackend', () =>
      runInstallBackend(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand('autoclaw.intelligence.installEmbeddings', () =>
      runInstallEmbeddings(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand('autoclaw.intelligence.status', () =>
      runStatus(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand('autoclaw.intelligence.systemTier', () => runSystemTier()),
    vscode.commands.registerCommand('autoclaw.intelligence.relocateBackend', () =>
      runRelocateBackend(context, getWorkspaceRoot()),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.generateSteering',
      withWorkspace(getWorkspaceRoot, runGenerateSteering),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.generateScaffold',
      withWorkspace(getWorkspaceRoot, runGenerateScaffold),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.learn',
      withWorkspace(getWorkspaceRoot, runLearn),
    ),
    vscode.commands.registerCommand(
      'autoclaw.intelligence.indexCode',
      withWorkspace(getWorkspaceRoot, (ws) => runIndexCode(context, ws)),
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
