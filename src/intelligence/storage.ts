/**
 * storage.ts — user-controllable storage locations + a status/visibility summary
 * for the Intelligence Layer.
 *
 * Defaults keep ALL project data in the project root (`<workspace>/.autoclaw`) —
 * including the `sqlite-vec` native backend, which now installs project-local
 * (`<workspace>/.autoclaw/native`) instead of the user's C:/globalStorage. A
 * separate, user-chosen SYSTEM dir holds cross-project ("system-wide") intelligence
 * (off by default until a dir is set). Both are overridable via settings.
 *
 * Host-free: no `vscode` import. The command layer reads settings + the dashboard
 * summary and passes them in. Size/age reads are best-effort and never throw.
 */

import * as fs from 'fs';
import * as path from 'path';

import { toForwardSlash } from './paths';

/** Sub-dir (under the project `.autoclaw`) where the sqlite-vec native peer lands. */
export const BACKEND_SUBDIR = 'native';

/**
 * Resolve the directory the `sqlite-vec` native peer installs into.
 *  - explicit `override` (the `autoclaw.intelligence.backendDir` setting) wins;
 *  - else project-local `<workspaceRoot>/.autoclaw/native` (never C:);
 *  - else (no workspace) `globalStorageFallback` if provided.
 */
export function resolveBackendDir(
  workspaceRoot: string | undefined,
  override?: string,
  globalStorageFallback?: string,
): string {
  if (override && override.trim() !== '') {
    return toForwardSlash(path.resolve(override.trim()));
  }
  if (workspaceRoot && workspaceRoot.trim() !== '') {
    return toForwardSlash(path.join(workspaceRoot, '.autoclaw', BACKEND_SUBDIR));
  }
  if (globalStorageFallback) {
    return toForwardSlash(path.join(globalStorageFallback, BACKEND_SUBDIR));
  }
  return toForwardSlash(path.join(BACKEND_SUBDIR));
}

/** Paths for the cross-project SYSTEM intelligence tier under a user-chosen dir. */
export interface SystemPaths {
  root: string;
  vectorDir: string;
  dbPath: string;
  learningsDir: string;
  /** project ↔ store registry (cross-referencing foundation). */
  registryPath: string;
}

/** Resolve the system-tier paths, or `undefined` when no system dir is configured. */
export function systemPaths(systemDir?: string): SystemPaths | undefined {
  if (!systemDir || systemDir.trim() === '') {
    return undefined;
  }
  const root = path.resolve(systemDir.trim());
  const vectorDir = path.join(root, 'vector');
  return {
    root: toForwardSlash(root),
    vectorDir: toForwardSlash(vectorDir),
    dbPath: toForwardSlash(path.join(vectorDir, 'db.sqlite')),
    learningsDir: toForwardSlash(path.join(root, 'learnings')),
    registryPath: toForwardSlash(path.join(root, 'projects.json')),
  };
}

/** Recursive byte size of a dir/file; 0 when absent. Never throws. */
export function pathSizeBytes(target: string): number {
  let total = 0;
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return 0;
  }
  if (st.isFile()) {
    return st.size;
  }
  if (!st.isDirectory()) {
    return 0;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    total += pathSizeBytes(path.join(target, e.name));
  }
  return total;
}

/** Human-readable size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface StoreInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

export interface IndexInfo {
  dbPath: string;
  dbSizeBytes: number;
  indexedAt?: string;
  commit?: string;
}

export interface StorageStatus {
  /** `<workspace>/.autoclaw` */
  projectRoot: StoreInfo;
  /** vector index db */
  index: IndexInfo;
  /** where the sqlite-vec native peer lives + whether it's resolvable */
  backend: StoreInfo & { installed: boolean };
  /** cross-project system tier (enabled only when a system dir is configured) */
  system: (StoreInfo & { enabled: boolean }) | { enabled: false };
}

function storeInfo(p: string): StoreInfo {
  return { path: toForwardSlash(p), exists: fs.existsSync(p), sizeBytes: pathSizeBytes(p) };
}

function readIndexWatermark(
  lastIndexPath: string,
  workspaceRoot: string,
): { indexedAt?: string; commit?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(lastIndexPath, 'utf8')) as Record<string, unknown>;
    // last-index.json is keyed by absolute workspace path; match leniently.
    const keys = Object.keys(raw);
    const wsNorm = toForwardSlash(path.resolve(workspaceRoot)).toLowerCase();
    const key =
      keys.find((k) => toForwardSlash(k).toLowerCase() === wsNorm) ?? keys[0];
    const rec = key ? (raw[key] as Record<string, unknown>) : undefined;
    if (rec && typeof rec === 'object') {
      return {
        indexedAt: typeof rec.indexedAt === 'string' ? rec.indexedAt : undefined,
        commit: typeof rec.commit === 'string' ? rec.commit : undefined,
      };
    }
  } catch {
    /* absent / malformed — fine */
  }
  return {};
}

/**
 * Assemble a storage status snapshot. Pure aside from best-effort fs reads; takes
 * already-resolved paths so the command layer owns settings + the dashboard.
 */
export function gatherStorageStatus(args: {
  workspaceRoot: string;
  contractRoot: string;
  dbPath: string;
  lastIndexPath: string;
  backendDir: string;
  backendInstalled: boolean;
  systemDir?: string;
}): StorageStatus {
  const wm = readIndexWatermark(args.lastIndexPath, args.workspaceRoot);
  const sys = systemPaths(args.systemDir);
  return {
    projectRoot: storeInfo(args.contractRoot),
    index: {
      dbPath: toForwardSlash(args.dbPath),
      dbSizeBytes: pathSizeBytes(args.dbPath),
      indexedAt: wm.indexedAt,
      commit: wm.commit,
    },
    backend: { ...storeInfo(args.backendDir), installed: args.backendInstalled },
    system: sys ? { ...storeInfo(sys.root), enabled: true } : { enabled: false },
  };
}
