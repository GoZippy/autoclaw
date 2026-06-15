/**
 * namespaces.ts — project-scoped + global memory namespace resolution for the
 * AutoClaw Intelligence Layer (R4.1-R4.4, D11).
 *
 * The layer keeps per-project vector namespaces (keyed by git-root / workspace,
 * as produced by {@link import('./project').resolveProjectKey}) PLUS a single
 * global rollup layer. Retrieval prefers project-scoped signals and falls back
 * to the global rollup; raw code from different projects is never mixed in one
 * result set (R4.3) because each project resolves to a DISTINCT namespace.
 *
 * This module is the single source of truth for how a project key becomes a
 * namespace string written to the vector store's `project` column. Keeping it
 * standalone (no I/O, no `vscode`) makes the mapping deterministic and
 * unit-testable, and lets `ragCode.ts` / `learn.ts` agree on the same scope.
 *
 * No `vscode` import; pure functions only.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The stable identifier for the cross-project rollup layer. Chosen so it can
 * never collide with a {@link projectNamespace} value (those always carry the
 * {@link PROJECT_PREFIX}).
 */
const GLOBAL_NAMESPACE = 'global';

/** Prefix applied to every project-scoped namespace. */
const PROJECT_PREFIX = 'project:';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two namespaces a retrieval consults, in preference order: the
 * project-scoped `primary`, then the `global` rollup `fallback` (R4.2).
 */
export interface SearchScope {
  /** Project-scoped namespace — consulted first. */
  primary: string;
  /** Global rollup namespace — consulted only as a fallback. */
  fallback: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw project key into a stable form: forward slashes, no trailing
 * slash, trimmed. Identical workspaces therefore always map to the identical
 * namespace regardless of how the path was spelled.
 */
function normalizeKey(projectKey: string): string {
  return projectKey
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the per-project namespace for `projectKey` (the value returned by
 * {@link import('./project').resolveProjectKey} — a forward-slash git root or
 * workspace path).
 *
 * Distinct project keys ALWAYS produce distinct namespaces, which is what keeps
 * one project's raw code out of another's result set (R4.3). A blank/unknown
 * key has no isolation boundary, so it degrades to the {@link globalNamespace}
 * rollup rather than inventing a private namespace.
 */
export function projectNamespace(projectKey: string): string {
  const key = normalizeKey(projectKey ?? '');
  if (key === '') {
    return GLOBAL_NAMESPACE;
  }
  return `${PROJECT_PREFIX}${key}`;
}

/**
 * The global rollup namespace — aggregated learnings/preferences contributed
 * across every project. Stable and distinct from any {@link projectNamespace}.
 */
export function globalNamespace(): string {
  return GLOBAL_NAMESPACE;
}

/**
 * True when `namespace` is the global rollup layer (vs a project-scoped one).
 * Useful for inspection output that labels learnings project-local vs global
 * (R4.4).
 */
export function isGlobalNamespace(namespace: string): boolean {
  return namespace === GLOBAL_NAMESPACE;
}

/**
 * Resolve the ordered search scope for `projectKey`: prefer the project-scoped
 * namespace, fall back to the global rollup (R4.2). Callers run the `primary`
 * query first and only consult `fallback` to fill gaps — never merging raw code
 * across the boundary.
 */
export function resolveSearchScope(projectKey: string): SearchScope {
  return {
    primary: projectNamespace(projectKey),
    fallback: globalNamespace(),
  };
}
