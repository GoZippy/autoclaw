/**
 * paths.ts — resolver for the `.autoclaw/` on-disk contract owned by the
 * Intelligence Layer.
 *
 * Every path is returned with forward slashes (Node, git, and every supported
 * shell accept them — see the AutoClaw operating rules). Nothing here resolves
 * a location outside `<workspaceRoot>/.autoclaw`. No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Convert any OS path to forward-slash form for stable, cross-platform output. */
export function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The set of paths the Intelligence Layer reads/writes. Directories are created
 * lazily by {@link ensureDir}; foundation never creates them on activation.
 */
export interface IntelligencePaths {
  /** `<root>/.autoclaw` */
  root: string;
  /** `<root>/.autoclaw/vector` */
  vectorDir: string;
  /** `<root>/.autoclaw/vector/db.sqlite` */
  dbPath: string;
  /** `<root>/.autoclaw/vector/config.json` */
  configPath: string;
  /** `<root>/.autoclaw/learnings` */
  learningsDir: string;
  /** `<root>/.autoclaw/metrics` */
  metricsDir: string;
  /** `<root>/.autoclaw/.locks` */
  locksDir: string;
  /** `<root>/.autoclaw/history` (incremental watermarks, later specs) */
  historyDir: string;
  /** `<root>/.autoclaw/vector/last-index.json` */
  lastIndexPath: string;
  /** `<root>/.autoclaw/vector/index-health.json` — at-a-glance index health snapshot. */
  indexHealthPath: string;
  /** `<root>/.autoclaw/kg` — Knowledge Graph store directory. */
  kgDir: string;
  /** `<root>/.autoclaw/kg/kg.db` — Knowledge Graph SQLite file. */
  kgDbPath: string;
  /** Existing KDream memory — referenced, never overwritten. */
  memoryPath: string;
}

/**
 * Resolve the Intelligence contract paths under `<workspaceRoot>/.autoclaw`.
 * `workspaceRoot` is the directory that contains (or will contain) `.autoclaw`.
 */
export function intelligencePaths(workspaceRoot: string): IntelligencePaths {
  const root = path.join(workspaceRoot, '.autoclaw');
  const vectorDir = path.join(root, 'vector');
  return {
    root: toForwardSlash(root),
    vectorDir: toForwardSlash(vectorDir),
    dbPath: toForwardSlash(path.join(vectorDir, 'db.sqlite')),
    configPath: toForwardSlash(path.join(vectorDir, 'config.json')),
    learningsDir: toForwardSlash(path.join(root, 'learnings')),
    metricsDir: toForwardSlash(path.join(root, 'metrics')),
    locksDir: toForwardSlash(path.join(root, '.locks')),
    historyDir: toForwardSlash(path.join(root, 'history')),
    lastIndexPath: toForwardSlash(path.join(vectorDir, 'last-index.json')),
    indexHealthPath: toForwardSlash(path.join(vectorDir, 'index-health.json')),
    kgDir: toForwardSlash(path.join(root, 'kg')),
    kgDbPath: toForwardSlash(path.join(root, 'kg', 'kg.db')),
    // Owned by KDream (skills/kdream); the layer appends, never overwrites.
    memoryPath: toForwardSlash(path.join(root, 'kdream', 'memory', 'MEMORY.md')),
  };
}

/**
 * Idempotent recursive directory create using file APIs (never shell `mkdir`).
 * Resolving an existing directory is a no-op. Errors bubble with the offending
 * path attached so callers can surface a clear message.
 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      return; // already present — idempotent success
    }
    throw new Error(`failed to create directory ${toForwardSlash(dir)}: ${e.message}`);
  }
}

/**
 * Guard: true when `candidate` resolves to a location inside
 * `<workspaceRoot>/.autoclaw`. Used to enforce R3.3 (never write outside the
 * contract).
 */
export function isInsideContract(workspaceRoot: string, candidate: string): boolean {
  const contractRoot = path.resolve(workspaceRoot, '.autoclaw');
  const resolved = path.resolve(candidate);
  const rel = path.relative(contractRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
