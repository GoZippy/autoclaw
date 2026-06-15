/**
 * sources/watermark.ts — per-source incremental extraction bookmarks (R4.1).
 *
 * Adapters persist a watermark (last-extracted epoch-ms timestamp / opaque
 * offset) per `(sourceId, project)` so a re-run only pulls newer sessions
 * instead of re-ingesting the full history every time.
 *
 * Storage: a single lock-protected JSON file at
 * `<workspaceRoot>/.autoclaw/sources/watermarks.json`, keyed
 * `"<sourceId>::<project>"`. The write path takes the advisory `.autoclaw` lock
 * so it is safe against KDream / parallel agents touching shared state.
 *
 * Corruption tolerance (design "Error handling"): an unreadable or malformed
 * store is treated as EMPTY — callers get `{}` (⇒ a full extract) plus a warning,
 * never a throw.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { LogFn } from '../config';
import { acquireLock } from '../fileLock';
import { intelligencePaths, toForwardSlash } from '../paths';

/** A single incremental bookmark. */
export interface Watermark {
  /** Last-extracted session timestamp (epoch ms). */
  lastTs?: number;
  /** Opaque cursor for sources that page by something other than time. */
  offset?: string;
}

/** On-disk shape of the watermark store. */
interface WatermarkFile {
  [key: string]: Watermark;
}

/** Compose the storage key for a `(sourceId, project)` pair. */
export function watermarkKey(sourceId: string, project?: string): string {
  return `${sourceId}::${project ?? ''}`;
}

/** Absolute (forward-slash) path to the watermark store for a workspace. */
export function watermarkStorePath(workspaceRoot: string): string {
  const { root } = intelligencePaths(workspaceRoot);
  return toForwardSlash(path.join(root, 'sources', 'watermarks.json'));
}

/**
 * Lock-protected, corruption-tolerant watermark store for one workspace.
 *
 * Construct once per run and reuse; each method is independently safe and the
 * setter serializes writes through the advisory file lock.
 */
export class WatermarkStore {
  private readonly storePath: string;
  private readonly warn: LogFn;

  constructor(workspaceRoot: string, log?: LogFn) {
    this.storePath = watermarkStorePath(workspaceRoot);
    this.warn = log ?? (() => undefined);
  }

  /** Read the whole store; a missing/corrupt file yields `{}` + a warning. */
  private load(): WatermarkFile {
    let raw: string;
    try {
      if (!fs.existsSync(this.storePath)) {
        return {};
      }
      raw = fs.readFileSync(this.storePath, 'utf8');
    } catch (err) {
      this.warn(
        `watermarks: could not read ${this.storePath} (${(err as Error).message}); treating as empty (full extract)`,
      );
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as WatermarkFile;
      }
      this.warn(`watermarks: ${this.storePath} is not an object; treating as empty (full extract)`);
      return {};
    } catch (err) {
      this.warn(
        `watermarks: corrupt JSON in ${this.storePath} (${(err as Error).message}); treating as empty (full extract)`,
      );
      return {};
    }
  }

  /** Get the watermark for `(sourceId, project)`, or `{}` when none/corrupt. */
  get(sourceId: string, project?: string): Watermark {
    const all = this.load();
    const mark = all[watermarkKey(sourceId, project)];
    if (mark && typeof mark === 'object') {
      const out: Watermark = {};
      if (typeof mark.lastTs === 'number' && Number.isFinite(mark.lastTs)) {
        out.lastTs = mark.lastTs;
      }
      if (typeof mark.offset === 'string') {
        out.offset = mark.offset;
      }
      return out;
    }
    return {};
  }

  /**
   * Set the watermark for `(sourceId, project)`. Lock-protected read-modify-write
   * so concurrent setters never clobber each other's keys. Best-effort: a write
   * failure is logged, never thrown.
   */
  async set(sourceId: string, project: string | undefined, mark: Watermark): Promise<void> {
    const dir = path.dirname(this.storePath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
      this.warn(`watermarks: could not create ${dir} (${(err as Error).message})`);
      return;
    }
    const release = await acquireLock(this.storePath);
    try {
      const all = this.load();
      all[watermarkKey(sourceId, project)] = {
        ...(typeof mark.lastTs === 'number' ? { lastTs: mark.lastTs } : {}),
        ...(typeof mark.offset === 'string' ? { offset: mark.offset } : {}),
      };
      fs.writeFileSync(this.storePath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.warn(`watermarks: could not write ${this.storePath} (${(err as Error).message})`);
    } finally {
      release();
    }
  }
}

/**
 * Convenience getter (R4.1). Returns the persisted watermark for the
 * `(sourceId, project)` pair, or `{}` when absent/corrupt (⇒ full extract).
 */
export function getWatermark(
  workspaceRoot: string,
  sourceId: string,
  project?: string,
  log?: LogFn,
): Watermark {
  return new WatermarkStore(workspaceRoot, log).get(sourceId, project);
}

/** Convenience setter (R4.1). Lock-protected; best-effort. */
export async function setWatermark(
  workspaceRoot: string,
  sourceId: string,
  project: string | undefined,
  mark: Watermark,
  log?: LogFn,
): Promise<void> {
  return new WatermarkStore(workspaceRoot, log).set(sourceId, project, mark);
}
