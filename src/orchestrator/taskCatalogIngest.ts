/**
 * taskCatalogIngest.ts — fs runner that materializes `state.tasks[]` (L0).
 *
 * Locates a project's task sources — AutoClaw's generated `sprints/sprint-N.yaml`
 * and hand-authored spec `tasks.md` files — normalizes them via the pure
 * {@link normalizeCatalog}, and writes the result into `state.json` so the board
 * (`boardWriter.readTasks`) can populate `claimable`. Idempotent: a tick whose
 * catalog matches the stored one is a no-op (digest-gated), so it is cheap to call
 * every orchestrator tick.
 *
 * Read-modify-write: only the `tasks[]` array + `tasks_total` are owned here; the
 * planner's `agents{}` / `current_sprint` are left untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readStateFile, writeStateFile, type OrchestratorState } from '../orchestrate';
import {
  normalizeCatalog,
  parseTasksMarkdown,
  extractSprintTasks,
  catalogDigest,
  type CatalogTask,
  type SprintTaskInput,
  type MarkdownTaskInput,
} from './taskCatalog';

const fsp = fs.promises;

function orchestratorDir(ws: string): string {
  return path.join(ws, '.autoclaw', 'orchestrator');
}
function statePath(ws: string): string {
  return path.join(orchestratorDir(ws), 'state.json');
}
function sprintsDir(ws: string): string {
  return path.join(orchestratorDir(ws), 'sprints');
}

/** Roots scanned for spec `tasks.md` files (the un-planned, spec-driven fallback). */
const DEFAULT_SPEC_ROOTS = ['specs', '.kiro/specs', '.autoclaw/specs', 'docs/specs'];

async function readFileSafe(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}
async function listDir(p: string): Promise<string[]> {
  try { return await fsp.readdir(p); } catch { return []; }
}

/** Hard ceiling on directories visited by a single spec scan (cheap-by-design). */
const MAX_SCAN_DIRS = 500;

/** Recursively collect `tasks.md` files under `root` (depth- and budget-capped). */
async function collectTasksMd(
  root: string,
  out: Set<string>,
  budget = { dirs: MAX_SCAN_DIRS },
  depth = 0,
): Promise<void> {
  if (depth > 4 || budget.dirs <= 0) { return; }
  budget.dirs -= 1;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) { continue; }
      await collectTasksMd(full, out, budget, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase() === 'tasks.md') {
      out.add(full);
    }
  }
}

function createMinimalState(ws: string): OrchestratorState {
  return {
    project: path.basename(ws),
    current_sprint: null,
    total_sprints: 0,
    tasks_complete: 0,
    tasks_total: 0,
    agents: {},
    last_updated: new Date().toISOString(),
  };
}

export interface IngestResult {
  /** Whether `state.json` was written (catalog differed from the stored one). */
  changed: boolean;
  /** Number of catalog tasks after the merge. */
  count: number;
  /** Per-source task counts (pre-merge), for diagnostics. */
  sources: { sprints: number; markdown: number };
}

export interface IngestOptions {
  workspaceRoot: string;
  /** Extra absolute `tasks.md` paths to ingest (beyond the default spec roots). */
  tasksMdFiles?: string[];
  /** Override the spec roots scanned for `tasks.md` (relative to the workspace). */
  specRoots?: string[];
  /** Skip the recursive spec scan entirely (only sprint YAMLs + explicit files). */
  skipSpecScan?: boolean;
  /**
   * Force the recursive spec scan even when sprint YAMLs exist. Default behaviour
   * scans specs ONLY when there are no sprint tasks, so the hot loop path stays
   * cheap once a project is planned (sprint YAMLs are the authoritative source).
   */
  forceSpecScan?: boolean;
}

/**
 * Ingest the task catalog into `state.json`. Returns `{changed:false}` when there
 * is nothing to do (no sources and no pre-existing state), so it is safe to call
 * on every tick.
 */
export async function ingestTaskCatalog(opts: IngestOptions): Promise<IngestResult> {
  const ws = opts.workspaceRoot;

  // 1. Sprint YAMLs (AutoClaw's generated plan artifacts).
  const sprintFiles = (await listDir(sprintsDir(ws))).filter(f => /^sprint-\d+\.ya?ml$/i.test(f));
  const sprintTasks: SprintTaskInput[] = [];
  for (const f of sprintFiles) {
    const text = await readFileSafe(path.join(sprintsDir(ws), f));
    if (text) { sprintTasks.push(...extractSprintTasks(text)); }
  }

  // 2. Spec tasks.md (the un-planned, spec-driven fallback). Scanned only when
  //    there are no sprint tasks (or explicitly forced), so a planned project's
  //    hot loop never pays for a recursive tree walk.
  const mdFiles = new Set<string>(opts.tasksMdFiles ?? []);
  const doSpecScan = !opts.skipSpecScan && (opts.forceSpecScan || sprintTasks.length === 0);
  if (doSpecScan) {
    for (const rel of opts.specRoots ?? DEFAULT_SPEC_ROOTS) {
      await collectTasksMd(path.join(ws, rel), mdFiles);
    }
  }
  const markdownTasks: MarkdownTaskInput[] = [];
  for (const f of mdFiles) {
    const text = await readFileSafe(f);
    if (text) { markdownTasks.push(...parseTasksMarkdown(text)); }
  }

  const catalog = normalizeCatalog({ sprintTasks, markdownTasks });
  const result = (changed: boolean): IngestResult => ({
    changed, count: catalog.length, sources: { sprints: sprintTasks.length, markdown: markdownTasks.length },
  });

  // 3. Read-modify-write state.json, idempotent via digest.
  const sp = statePath(ws);
  const existed = await readStateFile(sp);
  if (!existed && catalog.length === 0) {
    // Nothing to ingest and no state to seed — don't fabricate an empty file.
    return result(false);
  }
  const state = (existed ?? createMinimalState(ws)) as OrchestratorState & { tasks?: CatalogTask[] };
  const current = Array.isArray(state.tasks) ? state.tasks : [];
  if (existed && catalogDigest(current) === catalogDigest(catalog)) {
    return result(false);
  }

  state.tasks = catalog;
  state.tasks_total = catalog.length;
  state.last_updated = new Date().toISOString();
  await writeStateFile(sp, state);
  return result(true);
}
