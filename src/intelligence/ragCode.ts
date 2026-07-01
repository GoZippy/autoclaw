/**
 * ragCode.ts — codebase RAG indexing + retrieval for the AutoClaw Intelligence
 * Layer (R4.1-R4.4, R7.1, D11).
 *
 * Three pieces:
 *   - `chunkCode` splits file content into line-aware, overlapping chunks while
 *     honoring a character budget (config.rag.codeChunkSize / codeOverlap).
 *   - `indexCodebase` walks the workspace (honoring ignoredDirs / fileExtensions),
 *     redacts each chunk before embedding, and stores embeddings tagged with the
 *     resolved project namespace + file metadata. Supports incremental git-diff
 *     selection backed by `.autoclaw/vector/last-index.json` (lock-protected) and
 *     a `--force` full reindex.
 *   - `retrieveCode` embeds a query and returns `{ file, content, score }` hits
 *     scoped to the current project namespace.
 *
 * Degrade path: when the vector backend is unavailable (FEAT-002 degraded mode),
 * `indexCodebase` reports 0 indexed and `retrieveCode` returns `[]`; neither
 * throws.
 *
 * No `vscode` import; the git invocation is injectable so tests stay offline and
 * independent of a real repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  LogFn,
  loadConfig,
  getActiveEmbeddingSignature,
} from './config';
import { IntelligenceConfig } from './types';
import { intelligencePaths, ensureDir, toForwardSlash } from './paths';
import { resolveProjectKey } from './project';
import { redactSecrets } from './redact';
import { getEmbedding, detectRouter, detectOllama } from './embeddings';
import { resolveEmbeddingConfig, applyEmbeddingPin } from './embeddingResolve';
import { acquireLock } from './fileLock';
import { initVectorDB, initVectorBackend, VectorRecord } from './vector';
import { clearDbRecoveredMarker, hasDurableLearningArtifacts } from './recovery';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single line-aware chunk produced by {@link chunkCode}. */
export interface CodeChunk {
  /** The chunk text (joined source lines). */
  content: string;
  /** 1-based line number of the first line in the chunk. */
  startLine: number;
  /** 1-based line number of the last line in the chunk. */
  endLine: number;
}

/**
 * Pluggable git command runner. Receives the git arguments (without the leading
 * `git`) and the working directory; returns stdout. Implementations should throw
 * on failure so callers can fall back to a full walk. Tests inject a stub.
 */
export type GitRunner = (args: string, cwd: string) => string;

/** Options for {@link indexCodebase}. */
export interface IndexCodebaseOptions {
  /** Directory that contains (or will contain) `.autoclaw`. */
  workspaceRoot: string;
  /** Ignore prior state and re-index everything (R4.3). */
  force?: boolean;
  /** Pre-resolved config. When omitted it is loaded from disk. */
  config?: IntelligenceConfig;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
  /** Injectable git runner (defaults to a real `git` via execSync). */
  gitRunner?: GitRunner;
  /**
   * Cooperative cancellation probe. Checked before each file is read so a
   * long index can be aborted (wired to the VS Code progress CancellationToken
   * by the command layer). When it returns true, indexing stops early and the
   * partial result is returned.
   */
  isCancelled?: () => boolean;
}

/** Summary returned by {@link indexCodebase}. */
export interface IndexResult {
  /** Number of files that were read + chunked + stored this pass. */
  filesIndexed: number;
  /** Total chunks embedded + stored this pass. */
  chunksIndexed: number;
  /** True when the run used incremental git-diff selection. */
  incremental: boolean;
  /** True when the vector backend was unavailable (nothing stored). */
  degraded: boolean;
  /** Number of stale chunks deleted this pass (modified/removed files). */
  chunksDeleted: number;
  /** True when the run was cancelled before completing. */
  cancelled: boolean;
  /**
   * True when the vector store still holds vectors from a previous embedding
   * model. A non-forced run surfaces this persisted signal; a `--force` run
   * rebuilds the corpus and clears it (so a forced result reports `false`).
   */
  staleIndex: boolean;
  /** Current HEAD commit recorded for the project, when resolvable. */
  commit?: string;
  /**
   * True when a `--force` rebuild was REFUSED up front because the configured
   * embedding provider was not serving embeddings — rebuilding would have cleared
   * the stale signal and poisoned the store with basic `none` vectors. The
   * existing index is left untouched. The command layer turns this into an
   * actionable "fix or switch the provider" prompt.
   */
  abortedProviderDown?: boolean;
}

/**
 * At-a-glance index health, persisted to `.autoclaw/vector/index-health.json`
 * (keyed by project) at the end of every index run. Lets panels/commands read
 * index status instantly WITHOUT opening + re-initializing the vector DB (which
 * is what made the stale signal invisible to the dashboard before).
 */
export interface IndexHealthSnapshot {
  schemaVersion: 1;
  project: string;
  /** Configured provider at index time (may be `auto`). */
  provider: string;
  /** Active embedding model the store was written with. */
  model: string;
  /** Vector dimension the store was provisioned with. */
  dimension: number;
  /** Total chunks stored for this project namespace after the run. */
  chunkCount: number;
  /** Persisted/effective stale signal (model boundary or mid-pass degrade). */
  staleIndex: boolean;
  /** True when a real provider fell back to `none` on some chunks this run. */
  embeddingDegraded: boolean;
  /** ISO timestamp of this snapshot. */
  indexedAt: string;
  /** HEAD commit at index time, when resolvable. */
  commit?: string;
  /** Compact stats from the run that produced this snapshot. */
  lastRun: {
    filesIndexed: number;
    chunksIndexed: number;
    chunksDeleted: number;
    incremental: boolean;
    cancelled: boolean;
  };
}

/** Options for {@link retrieveCode}. */
export interface RetrieveCodeOptions {
  /** Directory that contains `.autoclaw`. */
  workspaceRoot: string;
  /** Max results. Defaults to `config.search.defaultLimit`. */
  limit?: number;
  /** Pre-resolved config. When omitted it is loaded from disk. */
  config?: IntelligenceConfig;
  /** Optional warning sink. */
  log?: LogFn;
}

/** A single code retrieval hit. */
export interface CodeSearchResult {
  /** Forward-slash workspace-relative file path. */
  file: string;
  /** The stored (redacted) chunk content. */
  content: string;
  /** Cosine similarity in `[0, 1]` — higher is more similar. */
  score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_TAG = 'code-rag';

// ---------------------------------------------------------------------------
// chunkCode (R4.1)
// ---------------------------------------------------------------------------

/**
 * Split `content` into line-aware chunks. Lines are accumulated until the
 * running character count reaches `size`, then a chunk is emitted; the next
 * chunk re-includes a tail of lines whose combined length fits within `overlap`.
 *
 * Defensive behavior:
 *   - `size <= 0` is treated as 1 so progress is always made.
 *   - `overlap >= size` (or a tail that would not advance) still advances by at
 *     least one line, so the loop always terminates.
 *   - Files smaller than one chunk yield a single chunk spanning all lines.
 *   - Blank/whitespace-only chunks are skipped.
 *
 * @param content the raw file text
 * @param size    target characters per chunk (config.rag.codeChunkSize)
 * @param overlap characters of trailing context to repeat (config.rag.codeOverlap)
 */
export function chunkCode(content: string, size: number, overlap: number): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  if (typeof content !== 'string' || content.length === 0) {
    return chunks;
  }

  const effSize = size > 0 ? size : 1;
  const effOverlap = overlap >= 0 ? overlap : 0;
  const lines = content.split(/\r?\n/);

  let i = 0; // 0-based index of the first line of the current chunk
  while (i < lines.length) {
    const startLine = i + 1; // 1-based
    const buf: string[] = [];
    let charCount = 0;
    let j = i;
    while (j < lines.length) {
      buf.push(lines[j]);
      charCount += lines[j].length + 1; // +1 for the newline
      j++;
      if (charCount >= effSize) {
        break;
      }
    }
    const endLine = j; // 1-based line number of the last included line

    const text = buf.join('\n');
    if (text.trim() !== '') {
      chunks.push({ content: text, startLine, endLine });
    }

    if (j >= lines.length) {
      break; // consumed the whole file
    }

    // Re-include a tail of lines that fits within `overlap` characters.
    const overlapLines = trailingOverlapLines(buf, effOverlap);
    let next = j - overlapLines;
    if (next <= i) {
      next = i + 1; // guarantee forward progress (handles overlap >= size)
    }
    i = next;
  }

  return chunks;
}

/** Count trailing lines of `buf` whose cumulative length fits within `overlap`. */
function trailingOverlapLines(buf: string[], overlap: number): number {
  if (overlap <= 0) {
    return 0;
  }
  let chars = 0;
  let count = 0;
  for (let k = buf.length - 1; k >= 0; k--) {
    chars += buf[k].length + 1;
    if (chars > overlap) {
      break;
    }
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Default git runner — real `git` via execSync, stderr suppressed. */
const defaultGitRunner: GitRunner = (args, cwd) =>
  execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/** Run a git command, returning trimmed stdout or `null` on any failure. */
function tryGit(runner: GitRunner, args: string, cwd: string): string | null {
  try {
    const out = runner(args, cwd);
    const trimmed = typeof out === 'string' ? out.trim() : '';
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively collect eligible files, honoring ignoredDirs + fileExtensions. */
function collectFiles(
  dir: string,
  ignoredDirs: ReadonlySet<string>,
  extensions: ReadonlySet<string>,
  out: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        collectFiles(full, ignoredDirs, extensions, out);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        out.push(full);
      }
    }
  }
}

/** Normalize a filesystem path to an absolute forward-slash form for comparison. */
function normAbs(p: string): string {
  return toForwardSlash(path.resolve(p));
}

// ---------------------------------------------------------------------------
// last-index.json (per-project namespace, lock-protected)
// ---------------------------------------------------------------------------

interface LastIndexEntry {
  commit: string;
  indexedAt: string;
}

type LastIndexFile = Record<string, LastIndexEntry>;

function readLastIndex(lastIndexPath: string): LastIndexFile {
  try {
    if (!fs.existsSync(lastIndexPath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(lastIndexPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LastIndexFile;
    }
  } catch {
    // malformed file — treat as no prior state
  }
  return {};
}

function lastCommitFor(lastIndexPath: string, project: string): string | null {
  const entry = readLastIndex(lastIndexPath)[project];
  return entry && typeof entry.commit === 'string' && entry.commit !== '' ? entry.commit : null;
}

/** Merge + persist the current commit for `project`, lock-protected. Best-effort. */
async function writeLastIndex(
  lastIndexPath: string,
  vectorDir: string,
  project: string,
  commit: string,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    await ensureDir(vectorDir);
    release = await acquireLock(lastIndexPath);
    const data = readLastIndex(lastIndexPath);
    data[project] = { commit, indexedAt: new Date().toISOString() };
    fs.writeFileSync(lastIndexPath, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // best-effort — a contended/stale lock or write failure must never throw out
    // of indexCodebase and discard an already-completed index.
  } finally {
    release?.();
  }
}

// ---------------------------------------------------------------------------
// index-health.json (per-project namespace, lock-protected)
// ---------------------------------------------------------------------------

/** A tiny, fixed string embedded to verify a provider is serving embeddings. */
const HEALTH_PROBE_TEXT = 'autoclaw embedding provider probe';

type IndexHealthFile = Record<string, IndexHealthSnapshot>;

/**
 * Read the persisted index-health snapshot for `project` (or all projects when
 * `project` is omitted). Returns `undefined`/`{}` when absent or malformed —
 * never throws, so a missing snapshot reads as "never indexed".
 */
export function readIndexHealth(indexHealthPath: string): IndexHealthFile;
export function readIndexHealth(
  indexHealthPath: string,
  project: string,
): IndexHealthSnapshot | undefined;
export function readIndexHealth(
  indexHealthPath: string,
  project?: string,
): IndexHealthFile | IndexHealthSnapshot | undefined {
  let file: IndexHealthFile = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(indexHealthPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      file = parsed as IndexHealthFile;
    }
  } catch {
    // absent / malformed — treat as no prior snapshot
  }
  return project === undefined ? file : file[project];
}

/** Merge + persist the health snapshot for `project`, lock-protected. */
async function writeIndexHealth(
  indexHealthPath: string,
  vectorDir: string,
  project: string,
  snapshot: IndexHealthSnapshot,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    await ensureDir(vectorDir);
    release = await acquireLock(indexHealthPath);
    const data = readIndexHealth(indexHealthPath);
    data[project] = snapshot;
    fs.writeFileSync(indexHealthPath, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // best-effort — a health snapshot is advisory; a contended/stale lock or a
    // write failure must never throw out of indexCodebase and lose a completed
    // index result.
  } finally {
    release?.();
  }
}

/**
 * Cheap first, then meaningful: network providers must pass the bounded
 * liveness detectors before we run a real embed probe. A host can be reachable
 * while the model itself returns 5xx/shape errors, and a force rebuild in that
 * state would poison the store with fallback vectors.
 */
async function providerUnreachableForRebuild(
  config: IntelligenceConfig,
  log: LogFn,
): Promise<boolean> {
  const e = config.embedding;
  try {
    if (e.provider === 'router') {
      if (!(await detectRouter(e.routerHost))) {
        return true;
      }
    }
    if (e.provider === 'ollama') {
      if (!(await detectOllama(e.ollamaHost))) {
        return true;
      }
    }
    let degraded = false;
    await getEmbedding(HEALTH_PROBE_TEXT, e, log, () => {
      degraded = true;
    });
    return degraded;
  } catch {
    return true;
  }
}

/** A zeroed {@link IndexResult} for the early-return paths (cancel / abort). */
function emptyResult(over: Partial<IndexResult>): IndexResult {
  return {
    filesIndexed: 0,
    chunksIndexed: 0,
    incremental: false,
    degraded: false,
    chunksDeleted: 0,
    cancelled: false,
    staleIndex: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// indexCodebase (R4.2-R4.3, R7.1)
// ---------------------------------------------------------------------------

/**
 * Index the codebase rooted at `workspaceRoot` into the vector store. Honors
 * incremental git-diff selection and `--force`, redacts every chunk before
 * embedding, and tags each embedding with the project namespace + file metadata.
 */
export async function indexCodebase(options: IndexCodebaseOptions): Promise<IndexResult> {
  const { workspaceRoot, force = false } = options;
  const log: LogFn = options.log ?? (() => undefined);
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  let config = options.config ?? loadConfig(workspaceRoot, log);
  // Resolve an unresolved `auto` provider to a concrete one up front. The embed
  // calls below (and the force pre-flight) cannot run against `auto` — it throws
  // "must be resolved" — so a direct caller passing the default config would
  // otherwise degrade EVERY chunk to none. The command layer pre-resolves, so
  // this is a no-op there; it only fires for direct `auto` callers.
  if (config.embedding.provider === 'auto') {
    config = (await resolveEmbeddingConfig(config, workspaceRoot, { log })).config;
  }
  const project = resolveProjectKey(workspaceRoot);
  const paths = intelligencePaths(workspaceRoot);
  const signature = getActiveEmbeddingSignature(config);

  // Pre-flight (force only): a `--force` open CLEARS the persisted stale signal
  // and replaces the corpus. If the configured real provider is down, every
  // chunk degrades to `none` — clearing the signal AND poisoning geometry, which
  // is the "force re-index keeps failing / stays stale" loop. Probe once up front
  // and refuse the destructive rebuild, leaving the existing store untouched.
  if (force && config.embedding.provider !== 'none') {
    if (options.isCancelled?.()) {
      return emptyResult({ cancelled: true });
    }
    if (await providerUnreachableForRebuild(config, log)) {
      log(
        `rag: ABORTED force rebuild — the "${config.embedding.provider}" embedding provider is ` +
          `not serving embeddings right now, so a rebuild would clear the index and refill it with ` +
          `basic 'none' vectors. The existing index was left untouched. Fix the provider (or pick ` +
          `another via "AutoClaw: Intelligence — Set Embedding Provider"), then re-run a full re-index.`,
      );
      return emptyResult({ abortedProviderDown: true });
    }
  }

  const db = await initVectorBackend(config, paths.dbPath, signature, log, { forceRebuild: force });
  if (db.degraded) {
    log('rag: vector backend unavailable; indexed 0 files (no-RAG)');
    db.close();
    return {
      filesIndexed: 0,
      chunksIndexed: 0,
      incremental: false,
      degraded: true,
      chunksDeleted: 0,
      cancelled: false,
      staleIndex: false,
    };
  }

  try {
    const ignoredDirs = new Set(config.rag.ignoredDirs);
    const extensions = new Set<string>(config.rag.fileExtensions.map((e) => e.toLowerCase()));

    const allFiles: string[] = [];
    collectFiles(workspaceRoot, ignoredDirs, extensions, allFiles);

    // Decide the working set: incremental git-diff selection vs full walk.
    let filesToIndex = allFiles;
    let usedIncremental = false;
    if (db.dbRecovered) {
      log('rag: prior vector database was recovered from corruption; forcing a full re-index');
    } else if (!force && config.rag.incremental) {
      const lastCommit = lastCommitFor(paths.lastIndexPath, project);
      if (lastCommit) {
        const diff = tryGit(gitRunner, `diff --name-only ${lastCommit} HEAD`, workspaceRoot);
        if (diff !== null) {
          const changed = new Set(
            diff
              .split(/\r?\n/)
              .map((f) => f.trim())
              .filter((f) => f !== '')
              .map((f) => normAbs(path.resolve(workspaceRoot, f))),
          );
          filesToIndex = allFiles.filter((f) => changed.has(normAbs(f)));
          usedIncremental = true;
        } else {
          log('rag: git diff failed; falling back to a full index');
        }
      }
    }

    let chunksIndexed = 0;
    let cancelled = false;
    // Geometry safety: if a real provider fails on some chunks mid-pass,
    // getEmbedding degrades THAT chunk to `none` (hashed) — a different vector
    // geometry stored under the same signature. The dimension guard can't see it
    // (same dimension), so we track it and raise staleIndex to force a clean
    // re-index once the provider is healthy.
    let embeddingDegraded = false;
    const records: VectorRecord[] = [];
    // Delete each (re)indexed file's prior chunks before inserting current ones,
    // so an edit that shifts chunk line-ranges cannot orphan the old ids.
    const deleteIdPrefixes: string[] = [];
    for (const file of filesToIndex) {
      if (options.isCancelled?.()) {
        cancelled = true;
        break;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // unreadable file — skip
      }
      const relFile = toForwardSlash(path.relative(workspaceRoot, file));
      deleteIdPrefixes.push(filePrefix(project, relFile));
      const chunks = chunkCode(raw, config.rag.codeChunkSize, config.rag.codeOverlap);
      for (const chunk of chunks) {
        // R7.1 — redact before embed/store. Skip the generic long-token rule for
        // code: legitimate base64/hashes/URLs/minified lines are not secrets and
        // blanket-redacting them degrades retrieval. Targeted patterns still run.
        const redacted = redactSecrets(chunk.content, { skipGenericToken: true });
        const embedding = await getEmbedding(redacted, config.embedding, log, () => {
          embeddingDegraded = true;
        });
        records.push({
          id: `${filePrefix(project, relFile)}${chunk.startLine}-${chunk.endLine}`,
          content: redacted,
          embedding,
          source: SOURCE_TAG,
          project,
          metadata: {
            file: relFile,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          },
        });
        chunksIndexed++;
      }
    }

    // Single lock + transaction: delete each file's stale chunks, then insert
    // the fresh ones (R3.4, batched for responsiveness).
    await db.storeEmbeddings(records, { deleteIdPrefixes });

    // Deletion sweep: drop chunks for files that no longer exist on disk
    // (deleted/renamed). Compares the store against the freshly-walked tree, so
    // it converges on both full and incremental runs.
    let chunksDeleted = 0;
    if (!cancelled) {
      chunksDeleted = await sweepDeletedFiles(db, project, workspaceRoot, allFiles, log);
    }

    // Record the current HEAD for incremental selection next time.
    const currentCommit = tryGit(gitRunner, 'rev-parse HEAD', workspaceRoot);
    if (currentCommit) {
      await writeLastIndex(paths.lastIndexPath, paths.vectorDir, project, currentCommit);
    }

    if (embeddingDegraded) {
      // Persist the signal honestly: a forced open cleared `stale_index`, but the
      // rebuild stored mixed-geometry vectors, so the index is NOT clean. Without
      // this, the dashboard/next-open would falsely report a fresh index.
      await db.setStale(true);
      log(
        `rag: WARNING — the "${config.embedding.provider}" embedding provider failed on some ` +
          `chunks mid-index; those fell back to basic 'none' vectors, so this index now MIXES ` +
          `vector geometries and retrieval quality is degraded. Fix the provider and re-run ` +
          `/index-code --force for a clean rebuild.`,
      );
    }

    const staleIndex = db.staleIndex || embeddingDegraded;

    // Persist the at-a-glance health snapshot so panels/commands read index state
    // instantly without re-opening the DB. Count is namespace-scoped + best-effort.
    let chunkCount = chunksIndexed;
    try {
      // SQL-filtered to this project's code chunks (WHERE project = ? AND source = ?)
      // — never a full scan of the shared store (which also holds learn vectors
      // and other projects). Mirrors the sweepDeletedFiles call above.
      chunkCount = (await db.listIds({ project, source: SOURCE_TAG })).length;
    } catch {
      // fall back to this pass's count if listing fails
    }
    await writeIndexHealth(paths.indexHealthPath, paths.vectorDir, project, {
      schemaVersion: 1,
      project,
      provider: config.embedding.provider,
      model: db.model,
      dimension: db.dimension,
      chunkCount,
      staleIndex,
      embeddingDegraded,
      indexedAt: new Date().toISOString(),
      commit: currentCommit ?? undefined,
      lastRun: {
        filesIndexed: filesToIndex.length,
        chunksIndexed,
        chunksDeleted,
        incremental: usedIncremental,
        cancelled,
      },
    });

    if (!cancelled && !hasDurableLearningArtifacts(paths)) {
      await clearDbRecoveredMarker(paths.dbRecoveredPath);
    } else if (!cancelled && db.dbRecovered) {
      log(
        'rag: code vectors restored, but learned-memory artifacts exist; run /learn to ' +
          'rebuild learn vectors before clearing recovery state',
      );
    }

    return {
      filesIndexed: filesToIndex.length,
      chunksIndexed,
      incremental: usedIncremental,
      degraded: false,
      chunksDeleted,
      cancelled,
      // A mid-pass degradation poisons geometry under an unchanged signature, so
      // surface it through the same staleIndex channel as a model change.
      staleIndex,
      commit: currentCommit ?? undefined,
    };
  } finally {
    db.close();
  }
}

/** Stable id prefix for all chunks of one file under the project namespace. */
function filePrefix(project: string, relFile: string): string {
  return `${SOURCE_TAG}:${project}:${relFile}:`;
}

/** Recover the workspace-relative file path from a stored chunk id. */
function relFileFromId(id: string, project: string): string | null {
  const prefix = `${SOURCE_TAG}:${project}:`;
  if (!id.startsWith(prefix)) {
    return null;
  }
  const rest = id.slice(prefix.length);
  // rest === `<relFile>:<start>-<end>` — the range is the final colon segment.
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }
  return rest.slice(0, lastColon);
}

/**
 * Delete stored code chunks whose file no longer exists on disk. Returns the
 * number of chunks removed. Keeps the RAG index convergent across deletes and
 * renames, which incremental git-diff selection alone cannot do.
 */
async function sweepDeletedFiles(
  db: Awaited<ReturnType<typeof initVectorDB>>,
  project: string,
  workspaceRoot: string,
  allFiles: string[],
  log: LogFn,
): Promise<number> {
  const onDisk = new Set(allFiles.map((f) => toForwardSlash(path.relative(workspaceRoot, f))));
  const storedIds = await db.listIds({ project, source: SOURCE_TAG });
  const staleFiles = new Set<string>();
  for (const id of storedIds) {
    const rel = relFileFromId(id, project);
    if (rel && !onDisk.has(rel)) {
      staleFiles.add(rel);
    }
  }
  let deleted = 0;
  for (const rel of staleFiles) {
    deleted += await db.deleteByIdPrefix(filePrefix(project, rel));
  }
  if (deleted > 0) {
    log(`rag: swept ${deleted} stale chunk(s) from ${staleFiles.size} removed file(s)`);
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// retrieveCode (R4.4 / D11)
// ---------------------------------------------------------------------------

/**
 * Retrieve code chunks semantically similar to `query`, scoped to the current
 * project namespace. Returns `[]` (never throws) when the backend is degraded.
 */
export async function retrieveCode(
  query: string,
  options: RetrieveCodeOptions,
): Promise<CodeSearchResult[]> {
  const { workspaceRoot } = options;
  const log: LogFn = options.log ?? (() => undefined);
  // Open + embed with the provider the indexer PINNED, not the raw `auto` seed
  // model. Opening under the seed (`Xenova/...`) would rewrite the store's meta
  // `model` row and re-raise the stale-index signal on every retrieve — the
  // endless "embedding model changed → re-index" loop. Cheap + side-effect-free:
  // honors the on-disk pin, never probes the network (cf. indexCodebase, which
  // does the full resolve because it is a writer).
  const config = applyEmbeddingPin(options.config ?? loadConfig(workspaceRoot, log), workspaceRoot);
  const project = resolveProjectKey(workspaceRoot);
  const paths = intelligencePaths(workspaceRoot);
  const signature = getActiveEmbeddingSignature(config);

  const db = await initVectorBackend(config, paths.dbPath, signature, log);
  if (db.degraded) {
    log('rag: vector backend unavailable; retrieveCode returning no results');
    db.close();
    return [];
  }

  try {
    const limit =
      typeof options.limit === 'number' && options.limit > 0
        ? Math.floor(options.limit)
        : config.search.defaultLimit;
    const embedding = await getEmbedding(query, config.embedding, log);
    const hits = await db.semanticVectorSearch(embedding, {
      limit,
      minSimilarity: config.search.minSimilarity,
      project,
    });
    return hits.map((h) => ({
      file: typeof h.metadata?.file === 'string' ? (h.metadata.file as string) : h.source,
      content: h.content,
      score: h.score,
    }));
  } finally {
    db.close();
  }
}
