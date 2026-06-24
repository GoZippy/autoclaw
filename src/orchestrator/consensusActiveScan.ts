/**
 * consensusActiveScan.ts — classify the files in `consensus/active/` into
 * per-agent VOTES vs review STUBS.
 *
 * `consensus/active/` holds two file kinds:
 *   - a review STUB `<task>.json` (opened by the peer-review watcher when a
 *     task_complete is promoted) — has `task_id` but no top-level `vote`;
 *   - per-agent VOTES `<task>-<voter>.json` — have a string `vote` + `task_id`.
 *
 * The orchestrate review command historically mis-read this: it treated every
 * file as a vote and derived the task id via `filename.split('-')[0]`, which
 * (a) mistook stubs for votes and (b) mangled ids that contain dashes (e.g.
 * `RV-1`) — producing the perennial "No vote files in consensus/active/".
 *
 * The correct rule (matching consensusTally.ts): classify by CONTENT, and take
 * `task_id` from the file body, never the filename. Host-free + pure so it's
 * unit-tested without the extension host.
 */

/** A consensus/active file: its name + parsed JSON (or null if unparseable). */
export interface ConsensusActiveEntry {
  name: string;
  json: unknown;
}

export interface ConsensusActiveScan {
  /** task_id → per-agent vote objects (files with a string `vote`). */
  votesByTask: Map<string, Array<Record<string, unknown>>>;
  /** task_ids that have a review stub but no votes yet (sorted). */
  awaitingReview: string[];
  /** Files that couldn't be parsed / had no task_id. */
  ignored: string[];
}

/**
 * Classify consensus/active entries. A task with at least one vote is NOT listed
 * in `awaitingReview` (it's already in `votesByTask`).
 */
export function classifyConsensusActive(entries: ConsensusActiveEntry[]): ConsensusActiveScan {
  const votesByTask = new Map<string, Array<Record<string, unknown>>>();
  const stubs = new Set<string>();
  const ignored: string[] = [];

  for (const e of entries) {
    const obj = e.json;
    if (!obj || typeof obj !== 'object') { ignored.push(e.name); continue; }
    const rec = obj as Record<string, unknown>;
    const taskId = typeof rec.task_id === 'string' && rec.task_id ? rec.task_id : undefined;
    if (!taskId) { ignored.push(e.name); continue; }
    if (typeof rec.vote === 'string') {
      const list = votesByTask.get(taskId) ?? [];
      list.push(rec);
      votesByTask.set(taskId, list);
    } else {
      stubs.add(taskId); // a review stub
    }
  }

  // A task with votes is no longer merely "awaiting".
  for (const t of votesByTask.keys()) { stubs.delete(t); }

  return { votesByTask, awaitingReview: [...stubs].sort(), ignored };
}
