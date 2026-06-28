/**
 * mergeGate.ts — Coordination Kernel: the enforced-scope atomic landing gate.
 *
 * Problem (observed repeatedly): agents share one master working tree and
 * "claims"/"leases" are advisory JSON. A peer can — and does — edit files
 * outside its declared scope, and a half-finished edit reds the build for
 * everyone. Honor-system coordination does not survive a heterogeneous swarm.
 *
 * Fix: agents work on isolated branches/worktrees (see worktree.ts) and a
 * branch lands ONLY through this gate, which MECHANICALLY rejects a diff that
 * touched files outside the agent's claimed scope (and, optionally, a branch
 * that does not build / pass tests). The lease stops being a promise and
 * becomes an enforced precondition for merge.
 *
 * Design mirrors scopeLease.ts: a pure, dependency-free CORE (glob → path
 * matching, scope partition, decision) that unit-tests without git, plus a thin
 * IO layer (git diff / merge) that takes an injectable runner.
 *
 * Matching is SEGMENT-BASED and FAIL-CLOSED (hardened after adversarial review):
 *   - `**` is the cross-directory wildcard ONLY as a whole path segment
 *     (`dir/**`), never glued to text (`foo**` does not escape `foo`'s dir).
 *   - `*`/`?` stay within one segment.
 *   - A changed-file path containing a `..` segment, or an absolute path
 *     (leading `/` or a `X:` drive), is treated as OUT OF SCOPE — never silently
 *     relativized into a match.
 * scopeLease.ts deliberately uses a LOOSE overlap heuristic (a cheap advisory
 * nudge); a gate is the opposite — a loose match that lets an out-of-scope file
 * through is a security hole. The two are complementary, not duplicates.
 */

// ---------------------------------------------------------------------------
// Precise glob → path matching (segment-based)
// ---------------------------------------------------------------------------

/** Compile one path segment (no `/`): `*` → `[^/]*`, `?` → `[^/]`, else literal. */
function segmentToRegex(seg: string): string {
  let re = '';
  for (const ch of seg) {
    if (ch === '*') { re += '[^/]*'; }
    else if (ch === '?') { re += '[^/]'; }
    else { re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return re;
}

/**
 * Compile a path glob to an anchored RegExp using whole-segment semantics:
 * - `dir/**`  → `dir/` then any depth (`.*`).
 * - `a/**​/b`  → zero or more intermediate segments.
 * - `*` / `?` → within a single segment only (never cross `/`).
 * - `foo**`   → `foo` + single-segment wildcard (does NOT cross `/`).
 * - a literal path matches itself exactly (`src/foo` ≠ `src/foobar`).
 */
export function globToRegExp(glob: string): RegExp {
  const norm = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  // Collapse runs of consecutive `**` segments (`a/**/**/c` ≡ `a/**/c`). Adjacent
  // `(?:[^/]+/)*` groups otherwise cause polynomial-backtracking ReDoS on deep
  // non-matching paths (a denial-of-merge). Also drops empty segments from `//`.
  const segs = norm.split('/').filter((s, i, arr) => s !== '' && !(s === '**' && arr[i - 1] === '**'));
  let re = '^';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      // Whole-segment ** : trailing → rest of path; interior → zero+ segments.
      re += last ? '.*' : '(?:[^/]+/)*';
    } else {
      re += segmentToRegex(seg);
      if (!last) { re += '/'; }
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * Normalize a changed-file path for matching, FAIL-CLOSED on anything that
 * could escape the repo: returns '' (→ out of scope) for absolute paths
 * (leading `/` or `X:` drive) and for any path containing a `..` segment.
 */
export function normalizePath(p: string): string {
  let s = (p ?? '').replace(/\\/g, '/').trim();
  if (!s) { return ''; }
  // Absolute paths are never repo-relative scope members.
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) { return ''; }
  s = s.replace(/^\.\//, '');
  // A `..` segment escapes scope — refuse it (do not collapse, which could
  // surprisingly create an in-scope match).
  if (s.split('/').includes('..')) { return ''; }
  return s;
}

/** True when `file` matches at least one of the allowed scope globs. */
export function fileInScope(file: string, allowedGlobs: readonly string[]): boolean {
  const f = normalizePath(file);
  if (!f) { return false; }
  for (const g of allowedGlobs) {
    const gg = (g ?? '').trim();
    if (!gg) { continue; }
    if (globToRegExp(gg).test(f)) { return true; }
  }
  return false;
}

export interface ScopeCheck {
  inScope: string[];
  outOfScope: string[];
  clean: boolean;
}

/**
 * Partition changed files into in-scope / out-of-scope against allowed globs.
 * A path that fails normalization (absolute / `..`) is routed to outOfScope
 * (fail-closed), NOT skipped — so a `..`-escaped path can never read as clean.
 */
export function checkScope(changedFiles: readonly string[], allowedGlobs: readonly string[]): ScopeCheck {
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const raw of changedFiles) {
    if (!raw || !String(raw).trim()) { continue; } // blank line only
    const f = normalizePath(raw);
    if (!f) { outOfScope.push(String(raw).trim()); continue; } // suspicious → out of scope
    (fileInScope(f, allowedGlobs) ? inScope : outOfScope).push(f);
  }
  return { inScope, outOfScope, clean: outOfScope.length === 0 };
}

// ---------------------------------------------------------------------------
// Merge decision (pure)
// ---------------------------------------------------------------------------

export interface MergeGateInput {
  changedFiles: readonly string[];
  allowedGlobs: readonly string[];
  /** Result of building the branch IN ISOLATION (see note on buildOk below). */
  buildOk?: boolean;
  /** Result of the branch's tests in isolation. */
  testsOk?: boolean;
  /** Require a green build before landing (default true). */
  requireBuild?: boolean;
  /** Require green tests before landing (default false). */
  requireTests?: boolean;
}

export interface MergeGateResult {
  allowed: boolean;
  outOfScope: string[];
  /** Human-readable reasons a merge was denied (empty when allowed). */
  reasons: string[];
  scope: ScopeCheck;
}

/**
 * The core gate decision. A branch may land iff every changed file is in scope
 * AND (when required) the build and tests are green. Pure — no IO.
 *
 * NOTE (buildOk/testsOk semantics): these describe the branch IN ISOLATION, not
 * the merge product. They are pre-checks; the authoritative post-merge guarantee
 * is `landBranch`'s optional `postMergeBuild` hook + the post-merge scope
 * re-diff. Do not treat a green isolated build as proof the merge builds.
 */
export function evaluateMerge(input: MergeGateInput): MergeGateResult {
  const requireBuild = input.requireBuild ?? true;
  const requireTests = input.requireTests ?? false;
  const scope = checkScope(input.changedFiles, input.allowedGlobs);
  const reasons: string[] = [];

  if (!scope.clean) {
    reasons.push(`branch touched ${scope.outOfScope.length} file(s) outside claimed scope: ${scope.outOfScope.join(', ')}`);
  }
  if (requireBuild && input.buildOk === false) { reasons.push('branch does not build (buildOk=false)'); }
  if (requireBuild && input.buildOk === undefined) { reasons.push('build result missing but required (buildOk=undefined)'); }
  if (requireTests && input.testsOk === false) { reasons.push('branch tests fail (testsOk=false)'); }
  if (requireTests && input.testsOk === undefined) { reasons.push('test result missing but required (testsOk=undefined)'); }

  return { allowed: reasons.length === 0, outOfScope: scope.outOfScope, reasons, scope };
}

// ---------------------------------------------------------------------------
// IO layer (injectable git runner — tests pass a fake)
// ---------------------------------------------------------------------------

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable git runner: production wires child_process; tests stub it. */
export type GitRunner = (args: string[], opts?: { cwd?: string }) => Promise<GitResult>;

/** Run `git diff --name-only -z <range>` and return decoded, de-duplicated paths. */
async function diffRange(git: GitRunner, range: string, opts?: { cwd?: string }): Promise<string[]> {
  // `-z` → NUL-separated, NO C-quoting/octal-escaping of non-ASCII names.
  const res = await git(['diff', '--name-only', '-z', range], opts);
  if (res.exitCode !== 0) {
    throw new Error(`git diff failed (${res.exitCode}): ${res.stderr.trim()}`);
  }
  const seen = new Set<string>();
  for (const part of res.stdout.split('\0')) {
    const f = part.replace(/\r?\n$/, '').trim();
    if (f) { seen.add(f); }
  }
  return [...seen];
}

/**
 * List files changed on `ref` relative to the merge base with `base`
 * (`git diff --name-only base...ref`). Returns decoded, de-duplicated paths
 * (NOT scope-normalized — checkScope is the single place that fail-closes).
 */
export async function changedFiles(
  git: GitRunner,
  base: string,
  ref: string,
  opts?: { cwd?: string },
): Promise<string[]> {
  return diffRange(git, `${base}...${ref}`, opts);
}

export interface LandBranchInput {
  base: string;
  ref: string;
  allowedGlobs: readonly string[];
  buildOk?: boolean;
  testsOk?: boolean;
  requireBuild?: boolean;
  requireTests?: boolean;
  cwd?: string;
  /** When true, only evaluate; never run the merge (dry-run preview). */
  dryRun?: boolean;
  /** Commit message for the merge commit. */
  message?: string;
  /**
   * Optional authoritative post-merge verification of the MERGED tree (build /
   * tests run against the merge product). If it returns false the merge is
   * reset and the land fails. This is the only real guarantee the merge builds.
   */
  postMergeBuild?: () => Promise<boolean>;
}

export interface LandBranchResult extends MergeGateResult {
  merged: boolean;
  /** The branch had no changes relative to base — nothing to land. */
  noop?: boolean;
  /** Set when the merge/verification failed after the gate allowed it. */
  mergeError?: string;
}

/**
 * Gate + (optionally) land a branch, hardened against the adversarial findings:
 *   - empty diff short-circuits as a no-op (never reports a phantom merge);
 *   - the gate is evaluated BEFORE any checkout/merge;
 *   - the base SHA is pinned at diff time; after checkout we refuse to land on a
 *     DETACHED HEAD (remote/tag/SHA base) where the merge would dangle;
 *   - a conflicting merge is aborted, leaving base clean;
 *   - after merge we RE-DIFF the produced commit against the pinned base SHA and
 *     re-run the scope check (catches a base that moved during the land / TOCTOU),
 *     resetting if an out-of-scope file slipped in;
 *   - an optional postMergeBuild verifies the merged tree, resetting on failure.
 */
export async function landBranch(git: GitRunner, input: LandBranchInput): Promise<LandBranchResult> {
  const cwd = input.cwd;
  const files = await changedFiles(git, input.base, input.ref, { cwd });

  const gate = evaluateMerge({
    changedFiles: files,
    allowedGlobs: input.allowedGlobs,
    buildOk: input.buildOk,
    testsOk: input.testsOk,
    requireBuild: input.requireBuild,
    requireTests: input.requireTests,
  });

  if (files.length === 0) {
    return { ...gate, merged: false, noop: true, reasons: [...gate.reasons, 'branch has no changes relative to base'] };
  }
  if (!gate.allowed || input.dryRun) {
    return { ...gate, merged: false };
  }

  // FAIL-CLOSED pre-merge guard: the abort/reset recovery contract only holds
  // from a clean start, and reset --hard would destroy uncommitted edits.
  const status = await git(['status', '--porcelain'], { cwd });
  if (status.exitCode !== 0) {
    return { ...gate, merged: false, mergeError: `git status failed (${status.exitCode}): ${status.stderr.trim()}` };
  }
  if (status.stdout.trim() !== '') {
    return { ...gate, merged: false, mergeError: 'land target tree is dirty (uncommitted changes) — refusing to checkout/merge/reset over uncommitted work' };
  }

  // Pin the base SHA. A missing SHA is FATAL (not skippable) — without it the
  // post-merge re-check and reset cannot run, which is the canonical fail-open.
  const baseRev = await git(['rev-parse', input.base], { cwd });
  const baseSha = baseRev.exitCode === 0 ? baseRev.stdout.trim() : '';
  if (!baseSha) {
    return { ...gate, merged: false, mergeError: `could not pin base SHA for '${input.base}' (rev-parse failed); refusing to land` };
  }

  const co = await git(['checkout', input.base], { cwd });
  if (co.exitCode !== 0) {
    return { ...gate, merged: false, mergeError: `checkout ${input.base} failed: ${co.stderr.trim()}` };
  }
  // Refuse to land on a detached HEAD — the merge would create a dangling commit
  // and the base ref would never advance. Compare on the SHORT branch name so a
  // fully-qualified base ('refs/heads/master') is not falsely rejected.
  const sym = await git(['symbolic-ref', '-q', 'HEAD'], { cwd });
  const head = sym.stdout.trim().replace(/^refs\/heads\//, '');
  const wantBase = input.base.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  if (sym.exitCode !== 0 || head !== wantBase) {
    return { ...gate, merged: false, mergeError: `base '${input.base}' is not the checked-out local branch (HEAD='${sym.stdout.trim() || 'detached'}'); refusing to land on a dangling commit` };
  }

  const msg = input.message ?? `merge ${input.ref} into ${input.base} (gate: scope-clean)`;
  const mg = await git(['merge', '--no-ff', '-m', msg, input.ref], { cwd });
  if (mg.exitCode !== 0) {
    const ab = await git(['merge', '--abort'], { cwd });
    if (ab.exitCode !== 0) {
      const rb = await safeReset(git, baseSha, cwd);
      return { ...gate, merged: false, mergeError: `merge failed AND abort failed — ${rb}` };
    }
    return { ...gate, merged: false, mergeError: `merge failed (aborted, base clean): ${mg.stderr.trim() || mg.stdout.trim()}` };
  }

  // Post-merge scope re-check against the pinned base (TOCTOU / base moved).
  // FAIL CLOSED: a diff error resets and denies rather than assuming clean.
  let postFiles: string[];
  try {
    postFiles = await diffRange(git, `${baseSha}..HEAD`, { cwd });
  } catch (e) {
    const rb = await safeReset(git, baseSha, cwd);
    return { ...gate, merged: false, mergeError: `post-merge verification diff failed (${(e as Error).message}); could not confirm scope — ${rb}` };
  }
  const post = checkScope(postFiles, input.allowedGlobs);
  if (!post.clean) {
    const rb = await safeReset(git, baseSha, cwd);
    return { ...gate, merged: false, outOfScope: post.outOfScope, mergeError: `post-merge diff touched out-of-scope files (base moved during land): ${post.outOfScope.join(', ')} — ${rb}` };
  }

  // Authoritative post-merge build/test of the MERGED tree.
  if (input.postMergeBuild) {
    const ok = await input.postMergeBuild();
    if (!ok) {
      const rb = await safeReset(git, baseSha, cwd);
      return { ...gate, merged: false, mergeError: `post-merge build/test failed — ${rb}` };
    }
  }

  return { ...gate, merged: true };
}

/**
 * `git reset --hard <sha>` that NEVER swallows failure: "could not undo" must
 * never be reported as "undone". Returns a human-readable status string.
 */
async function safeReset(git: GitRunner, sha: string, cwd?: string): Promise<string> {
  const rb = await git(['reset', '--hard', sha], { cwd });
  return rb.exitCode === 0
    ? `reset to ${sha.slice(0, 8)}`
    : `CRITICAL: reset --hard ${sha.slice(0, 8)} FAILED (${rb.stderr.trim()}) — base tip is DIRTY, manual intervention required`;
}
