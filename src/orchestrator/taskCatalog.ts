/**
 * taskCatalog.ts — materialize a project's task catalog into the shape the board
 * reads (`state.tasks[]`).
 *
 * The board (`boardWriter.readTasks`) builds its lanes from `state.tasks[]`, but
 * the planner's `OrchestratorState` never wrote that array — tasks lived only in
 * `manifests/*.yaml`, generated `sprints/sprint-N.yaml`, or hand-authored
 * `specs/**​/tasks.md`. The result: `state.tasks` is empty, `board.claimable` is
 * empty, and agents have nothing to coordinate over (they fall back to chatting).
 *
 * This module is the keystone fix (L0). It is PURE — no fs, no vscode — so the
 * merge logic is trivially unit-testable. The fs runner that locates the sources
 * and writes `state.json` lives in `taskCatalogIngest.ts`.
 */

/** A normalized catalog task — exactly the `state.tasks[]` element the board reads. */
export interface CatalogTask {
  id: string;
  title?: string;
  sprint?: number;
  priority?: 'high' | 'medium' | 'low';
  status?: 'open' | 'claimed' | 'in_progress' | 'in_review' | 'merged' | 'done' | 'blocked';
  depends_on: string[];
  files: string[];
}

/** Manifest-derived task (authoritative for static metadata). Already structured. */
export interface ManifestTaskInput {
  id: string;
  name?: string;
  depends_on?: string[];
  /** Path globs the task is scoped to → `files`. */
  scope?: string[];
  priority?: 'high' | 'medium' | 'low';
}

/** Sprint-YAML-derived task (authoritative for runtime status + sprint number). */
export interface SprintTaskInput {
  id: string;
  name?: string;
  /** Raw sprint-YAML status word (pending/assigned/in_progress/review/…). */
  status?: string;
  sprint?: number;
}

/** Spec `tasks.md` checkbox task (the fallback for un-planned, spec-driven repos). */
export interface MarkdownTaskInput {
  id: string;
  title?: string;
  done?: boolean;
}

/** The three source streams that feed {@link normalizeCatalog}. */
export interface CatalogSources {
  manifestTasks?: ManifestTaskInput[];
  sprintTasks?: SprintTaskInput[];
  markdownTasks?: MarkdownTaskInput[];
}

// ---------------------------------------------------------------------------
// Parsers (pure string → structured input)
// ---------------------------------------------------------------------------

/**
 * Parse a spec `tasks.md` checkbox list into {@link MarkdownTaskInput}s.
 *
 * Accepts the common shapes:
 *   - `[ ] **T-12** Title`        → id "T-12"
 *   - `[x] 3. Title`              → id "3", done
 *   - `[ ] T3: Title`             → id "T3"
 *   - `[ ] Title with no id`      → id derived from the 1-based match index
 *
 * Indentation is ignored (sub-bullets / descriptions under a task are skipped —
 * only checkbox lines become tasks).
 */
export function parseTasksMarkdown(text: string): MarkdownTaskInput[] {
  const out: MarkdownTaskInput[] = [];
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.*\S)\s*$/);
    if (!m) { continue; }
    n += 1;
    const done = m[1].toLowerCase() === 'x';
    const rest = m[2];
    // Pull an explicit id prefix when present: **ID**, ID., ID), ID:
    const idM = rest.match(/^(?:\*\*([\w][\w.\-]*)\*\*|([\w][\w.\-]*)[.):])\s*(.*)$/);
    let id: string;
    let title: string;
    if (idM) {
      id = (idM[1] ?? idM[2]).trim();
      title = (idM[3] ?? '').trim() || rest.trim();
    } else {
      id = `T-${n}`;
      title = rest.trim();
    }
    out.push({ id, title: title || undefined, done });
  }
  return out;
}

/**
 * Extract tasks from a generated `sprint-N.yaml` (AutoClaw's own plan artifact).
 *
 * The generator writes, under each assignment:
 * ```
 * sprint: 2
 * assignments:
 *   - agent: WA-1
 *     tasks:
 *       - id: B1
 *         name: "Do the thing"
 *         status: in_progress
 *     scope: …
 * ```
 * Line-based (not a full YAML parse — the codebase has no YAML lib): a 4-space
 * `tasks:` opens a block, 6-space `- id:` starts a task, 8-space `name:`/`status:`
 * attach, and any line indented ≤4 closes the block. The top-level `sprint:`
 * number is stamped on every task.
 */
export function extractSprintTasks(yamlText: string): SprintTaskInput[] {
  const lines = yamlText.split(/\r?\n/);
  const sprintM = yamlText.match(/^sprint:\s*"?(\d+)"?/m);
  const sprint = sprintM ? Number(sprintM[1]) : undefined;
  const indentOf = (l: string): number => (l.match(/^[ ]*/)?.[0].length ?? 0);

  const out: SprintTaskInput[] = [];
  let inTasks = false;
  let cur: SprintTaskInput | null = null;

  for (const line of lines) {
    if (/^\s{4}tasks:\s*$/.test(line)) { inTasks = true; cur = null; continue; }
    if (!inTasks) { continue; }
    if (line.trim() && indentOf(line) <= 4) { inTasks = false; cur = null; continue; }

    const idM = line.match(/^\s{6}-\s+id:\s*"?([\w.\-]+)"?/);
    if (idM) { cur = { id: idM[1], sprint }; out.push(cur); continue; }
    if (!cur) { continue; }
    const nameM = line.match(/^\s{8}name:\s*"?([^"\n]+?)"?\s*$/);
    if (nameM) { cur.name = nameM[1].trim(); continue; }
    const stM = line.match(/^\s{8}status:\s*"?([^"\n]+?)"?\s*$/);
    if (stM) { cur.status = stM[1].trim(); continue; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Map a raw sprint-YAML status word onto a board status. Unknown → undefined. */
export function mapSprintStatus(raw?: string): CatalogTask['status'] | undefined {
  if (!raw) { return undefined; }
  switch (raw.trim().toLowerCase()) {
    case 'pending':
    case 'assigned':
    case 'open':
    case 'todo':
      return 'open';
    case 'in_progress':
    case 'in-progress':
    case 'working':
    case 'active':
      return 'in_progress';
    case 'review':
    case 'in_review':
    case 'in-review':
      return 'in_review';
    case 'approved':
    case 'merged':
      return 'merged';
    case 'done':
    case 'complete':
    case 'completed':
      return 'done';
    case 'blocked':
      return 'blocked';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge the three source streams into one catalog, deduped by `id`.
 *
 * Precedence:
 *   - static metadata (title, depends_on, files, priority) — manifest wins, then
 *     sprint name, then markdown title;
 *   - status — sprint status wins, else markdown checkbox (done→done), else `open`;
 *   - sprint number — sprint source wins.
 *
 * Order is stable: manifest order first, then any sprint-only ids, then any
 * markdown-only ids, each in first-seen order.
 */
export function normalizeCatalog(sources: CatalogSources): CatalogTask[] {
  const order: string[] = [];
  const byId = new Map<string, CatalogTask>();

  const ensure = (id: string): CatalogTask => {
    let t = byId.get(id);
    if (!t) {
      t = { id, depends_on: [], files: [] };
      byId.set(id, t);
      order.push(id);
    }
    return t;
  };

  for (const m of sources.manifestTasks ?? []) {
    if (!m?.id) { continue; }
    const t = ensure(m.id);
    if (m.name && !t.title) { t.title = m.name; }
    if (m.depends_on?.length) { t.depends_on = [...m.depends_on]; }
    if (m.scope?.length) { t.files = [...m.scope]; }
    if (m.priority) { t.priority = m.priority; }
  }

  for (const s of sources.sprintTasks ?? []) {
    if (!s?.id) { continue; }
    const t = ensure(s.id);
    if (s.name && !t.title) { t.title = s.name; }
    if (typeof s.sprint === 'number') { t.sprint = s.sprint; }
    const mapped = mapSprintStatus(s.status);
    if (mapped) { t.status = mapped; }
  }

  for (const md of sources.markdownTasks ?? []) {
    if (!md?.id) { continue; }
    const t = ensure(md.id);
    if (md.title && !t.title) { t.title = md.title; }
    if (!t.status) { t.status = md.done ? 'done' : 'open'; }
  }

  // Default any still-unset status to open so the board's claimable gate applies.
  for (const t of byId.values()) {
    if (!t.status) { t.status = 'open'; }
  }

  return order.map(id => byId.get(id)!);
}

/** Stable digest of a catalog for idempotency — equal catalogs serialize equal. */
export function catalogDigest(tasks: CatalogTask[]): string {
  const canon = [...tasks]
    .map(t => ({
      id: t.id,
      title: t.title ?? '',
      sprint: t.sprint ?? null,
      priority: t.priority ?? null,
      status: t.status ?? 'open',
      depends_on: [...t.depends_on].sort(),
      files: [...t.files].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(canon);
}
