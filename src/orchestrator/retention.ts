/**
 * retention.ts — shared-inbox retention sweep.
 *
 * The orchestrator loop broadcasts a `task_claim` ("next-<vendor>") to the
 * shared inbox every tick. Nothing prunes them, so a long-running loop piles
 * up thousands of tiny JSON files (observed: 779 in one workspace). The
 * durable audit trail is `comms-log.jsonl` — the individual shared-inbox
 * messages are transient, so they are safe to sweep once they age out.
 *
 * This module deletes aged messages from the shared inbox (default: only the
 * orchestrator-loop's `task_claim` heartbeats, older than a cutoff). It is
 * conservative by default:
 *   - never touches `comms-log.jsonl`, `_state/`, or non-`.json` files,
 *   - only sweeps message types in `types` (default `['task_claim']`),
 *   - keeps the newest `keepRecent` matching files regardless of age,
 *   - dry-run unless `apply: true`.
 *
 * Pure logic + injected clock; real fs via Node. `vscode`-free → unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

/** A swept-file decision (for dry-run reporting and tests). */
export interface SweepCandidate {
  file: string;
  type?: string;
  from?: string;
  timestamp?: string;
  ageMs: number;
  deleted: boolean;
  reason: string;
}

export interface SweepOptions {
  /** Absolute path to the comms dir (…/orchestrator/comms). */
  commsDir: string;
  /** Delete matching messages older than this many hours. Default 24. */
  maxAgeHours?: number;
  /** Message types eligible for sweeping. Default `['task_claim']`. */
  types?: string[];
  /** Always keep this many newest matching files. Default 20. */
  keepRecent?: number;
  /** Actually delete. Default false (dry-run). */
  apply?: boolean;
  /** Clock seam for tests. */
  now?: () => Date;
}

export interface SweepReport {
  scanned: number;
  matched: number;
  deleted: number;
  keptRecent: number;
  keptYoung: number;
  applied: boolean;
  candidates: SweepCandidate[];
}

interface MinimalMessage {
  type?: string;
  from?: string;
  timestamp?: string;
}

function parseJsonSafe<T>(raw: string): T | null {
  try { return JSON.parse(raw.replace(/^/, '')) as T; } catch { return null; }
}

/**
 * Sweep the shared inbox. Returns a report; only deletes when `apply` is true.
 *
 * Selection: a file is a *candidate* when its parsed `type` is in `types`.
 * Among candidates, the newest `keepRecent` are always kept; of the rest, only
 * those older than `maxAgeHours` are deleted. Unparseable files and files whose
 * type is not in `types` are left untouched.
 */
export async function sweepSharedInbox(opts: SweepOptions): Promise<SweepReport> {
  const now = (opts.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const maxAgeMs = (opts.maxAgeHours ?? 24) * 3_600_000;
  const types = new Set(opts.types ?? ['task_claim']);
  const keepRecent = Math.max(0, opts.keepRecent ?? 20);
  const apply = opts.apply === true;

  const sharedDir = path.join(opts.commsDir, 'inboxes', 'shared');

  let files: string[];
  try {
    files = (await fsPromises.readdir(sharedDir)).filter(f => f.endsWith('.json'));
  } catch {
    return { scanned: 0, matched: 0, deleted: 0, keptRecent: 0, keptYoung: 0, applied: apply, candidates: [] };
  }

  // Read + classify.
  interface Entry { file: string; msg: MinimalMessage | null; ts: number; }
  const entries: Entry[] = [];
  for (const file of files) {
    const full = path.join(sharedDir, file);
    let msg: MinimalMessage | null = null;
    try { msg = parseJsonSafe<MinimalMessage>(await fsPromises.readFile(full, 'utf8')); } catch { msg = null; }
    // Fall back to the timestamp embedded in the filename when the body is
    // unreadable (filename format: <ts>-<type>-<from>-<id8>.json).
    const tsStr = msg?.timestamp ?? file.slice(0, 24).replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
    const ts = new Date(tsStr).getTime();
    entries.push({ file, msg, ts: Number.isFinite(ts) ? ts : 0 });
  }

  const candidates = entries.filter(e => e.msg && e.msg.type && types.has(e.msg.type));
  // Newest first so the first `keepRecent` are the ones we always keep.
  candidates.sort((a, b) => b.ts - a.ts);

  const report: SweepReport = {
    scanned: files.length,
    matched: candidates.length,
    deleted: 0,
    keptRecent: 0,
    keptYoung: 0,
    applied: apply,
    candidates: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    const ageMs = nowMs - e.ts;
    let deleted = false;
    let reason: string;
    if (i < keepRecent) {
      reason = 'kept (within keepRecent newest)';
      report.keptRecent++;
    } else if (ageMs < maxAgeMs) {
      reason = 'kept (younger than maxAge)';
      report.keptYoung++;
    } else {
      reason = apply ? 'deleted' : 'would delete (dry-run)';
      if (apply) {
        try { await fsPromises.unlink(path.join(sharedDir, e.file)); deleted = true; report.deleted++; }
        catch { reason = 'delete failed'; }
      }
    }
    report.candidates.push({
      file: e.file,
      type: e.msg?.type,
      from: e.msg?.from,
      timestamp: e.msg?.timestamp,
      ageMs,
      deleted,
      reason,
    });
  }

  return report;
}
