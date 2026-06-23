/**
 * coordination.ts — shared contracts for Coordination Layer v2 (CL-1/CL-2/CL-5).
 *
 * One place that defines, for the file-based comms tree:
 *   - what counts as TELEMETRY vs a real SIGNAL (CL-2 routing/GC, CL-5 brief),
 *   - which messages are actionable for a given session ("awaiting me"),
 *   - the session-announce message + the heartbeat fields a session self-describes
 *     with (CL-1 writes them; CL-5 reads them).
 *
 * Pure + dependency-free so every layer agrees on the same definitions and it all
 * unit-tests without a filesystem.
 */

/** A comms message as it appears on disk (only the fields we classify on). */
export interface CommsMessage {
  id?: string;
  from?: string;
  to?: string;
  type?: string;
  timestamp?: string;
  requires_response?: boolean;
  session_id?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
}

export type MessageClass = 'telemetry' | 'signal';

/** The `type` of an auto-generated session announcement (CL-1). */
export const SESSION_ANNOUNCE_TYPE = 'session_announce';

/**
 * Heartbeat fields a session self-describes with (CL-1 stamps these; CL-5 +
 * the panel read them). Extends the base heartbeat additively.
 */
export interface SessionDescriptor {
  agent_id: string;
  session_id: string;
  timestamp: string;
  status?: string;
  /** What this session is currently doing (one line). */
  current_task?: string | null;
  /** The git branch this session is working on. */
  branch?: string | null;
  /** File globs this session has declared it is editing (mirrors CL-4 leases). */
  file_scope?: string[];
}

/** Sources whose messages are loop/automation telemetry, not conversation. */
const TELEMETRY_SOURCES = /(^|[-_])(autobuild|orchestrator-loop|loop|heartbeat|watchdog|supervisor-loop)([-_]|$)/i;

/**
 * Is this message an automated nudge rather than a real ask? The orchestrator
 * loop re-broadcasts `task_claim` for `next-<agent>` every few minutes with
 * `requires_response:true`; those must not count as "awaiting you".
 */
export function isAutoNudge(msg: CommsMessage): boolean {
  if (!msg) { return false; }
  const from = String(msg.from ?? '');
  if (msg.type === 'task_claim' && TELEMETRY_SOURCES.test(from)) { return true; }
  // `next-<agent>` is the loop's synthetic "claim your next task" task id.
  if (msg.type === 'task_claim' && typeof msg.task_id === 'string' && msg.task_id.startsWith('next-')) { return true; }
  return false;
}

/**
 * Classify a message as telemetry (loop/automation chatter) or signal
 * (cross-agent conversation a human/peer should see). Telemetry = per-tick
 * heartbeat/loop `finding_report`s and `status_report`s from automation sources,
 * plus auto `task_claim` nudges. Everything else — questions, answers, task_*,
 * reviews, votes, scope_violation, real findings, session_announce — is signal.
 */
export function classifyMessage(msg: CommsMessage): MessageClass {
  if (!msg || !msg.type) { return 'signal'; }
  if (isAutoNudge(msg)) { return 'telemetry'; }
  const from = String(msg.from ?? '');
  if ((msg.type === 'finding_report' || msg.type === 'status_report') && TELEMETRY_SOURCES.test(from)) {
    return 'telemetry';
  }
  return 'signal';
}

export function isTelemetry(msg: CommsMessage): boolean {
  return classifyMessage(msg) === 'telemetry';
}

/**
 * Is this message actionable for the given session right now? True when it is a
 * SIGNAL (not telemetry/auto-nudge), is not from me, and is addressed to me —
 * either directly (`to` === my agent id) or broadcast to `shared` while
 * `requires_response`. This is the correct basis for "awaiting you".
 */
export function isActionableForMe(msg: CommsMessage, agentId: string, sessionId?: string): boolean {
  if (!msg || classifyMessage(msg) === 'telemetry') { return false; }
  const from = String(msg.from ?? '');
  if (from === agentId) {
    // A message I sent is not awaiting me — unless a different session of mine sent it.
    if (!sessionId || msg.session_id === sessionId || !msg.session_id) { return false; }
  }
  const to = String(msg.to ?? '');
  if (to === agentId) { return true; }
  if (to === 'shared' && msg.requires_response === true) { return true; }
  return false;
}
