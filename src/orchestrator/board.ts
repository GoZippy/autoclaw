/**
 * board.ts — The "agendaboard": a single live snapshot of what work is
 * claimable, in flight, awaiting review, or stuck.
 *
 * Pure module. Takes a snapshot of orchestrator state and produces both:
 *   - a structured {@link BoardModel} (written to `board.json`), and
 *   - a human-readable markdown rendering (written to `board.md`).
 *
 * The board has four sections:
 *   1. **Claimable** — open, dependency-satisfied tasks no agent has claimed.
 *   2. **In flight** — tasks with an active claim and a healthy owner.
 *   3. **Awaiting review** — `consensus/active/<task>.json` stubs with their
 *      reviewer tally.
 *   4. **Stuck** — claims past their TTL, owners whose heartbeat is stale,
 *      or consensus items past a soft deadline.
 *
 * No FS or vscode imports — see {@link ./boardWriter} for the IO module that
 * gathers inputs and writes the artifacts.
 */

/* -------------------------------------------------------------------------- */
/*  Input types                                                               */
/* -------------------------------------------------------------------------- */

/** Minimal task shape the board needs. Matches `OrchestratorState.agents[…].tasks`
 *  plus the manifest-task fields we surface. */
export interface BoardTask {
  id: string;
  /** Optional human-readable title from the manifest. */
  title?: string;
  /** Task ids this task depends on. Empty → no deps. */
  depends_on?: string[];
  /** Optional sprint number. */
  sprint?: number;
  /** Optional priority label. */
  priority?: 'high' | 'medium' | 'low';
  /** Status from the orchestrator state file. */
  status?: 'open' | 'claimed' | 'in_progress' | 'in_review' | 'merged' | 'done' | 'blocked';
  /** Files this task is scoped to. */
  files?: string[];
}

/** A live claim record. */
export interface BoardClaim {
  task_id: string;
  claimed_by: string;
  claimed_at: string;
  /** Optional explicit TTL; falls back to {@link CLAIM_TTL_DEFAULT_MS}. */
  ttl_ms?: number;
}

/** A live consensus/active stub. */
export interface BoardConsensus {
  task_id: string;
  author: string;
  opened_at: string;
  reviewers: string[];
  votes: Array<{ voter: string; vote: 'approve' | 'request_changes' | 'reject' }>;
  rule: 'majority' | 'unanimous';
}

/** A live heartbeat for liveness checks. */
export interface BoardHeartbeat {
  agent_id: string;
  timestamp: string;
  status?: string;
}

/* -------------------------------------------------------------------------- */
/*  Output types                                                              */
/* -------------------------------------------------------------------------- */

/** Items surfaced under the "Claimable" section. */
export interface BoardClaimableItem {
  task_id: string;
  title?: string;
  sprint?: number;
  priority?: 'high' | 'medium' | 'low';
  files: string[];
  reason: 'open_no_claim';
}

/** Items surfaced under the "In flight" section. */
export interface BoardInFlightItem {
  task_id: string;
  title?: string;
  claimed_by: string;
  claimed_at: string;
  age_ms: number;
  owner_healthy: boolean;
}

/** Items surfaced under the "Awaiting review" section. */
export interface BoardAwaitingReviewItem {
  task_id: string;
  author: string;
  opened_at: string;
  age_ms: number;
  reviewers: string[];
  votes_received: number;
  votes_required: number;
  rule: 'majority' | 'unanimous';
  approvals: number;
  request_changes: number;
}

/** Items surfaced under the "Stuck" section. */
export interface BoardStuckItem {
  task_id: string;
  reason:
    | 'claim_expired'
    | 'owner_offline'
    | 'review_overdue'
    | 'no_eligible_reviewers';
  detail: string;
  age_ms: number;
}

/**
 * Compact summary of an evidence capsule for the board (the full capsule lives
 * in the comms tree). Verdict is a plain string to keep this module decoupled
 * from the orchestrate types. Newest-first, capped — a recent-activity log.
 */
export interface BoardCapsule {
  run_id: string;
  task_id: string;
  source: string;
  verdict: string;
  /** true/false when a gate ran; undefined when none did. */
  gates_passed?: boolean;
  votes_count: number;
  evaluated_at: string;
}

/** Top-level board model written to `board.json`. */
export interface BoardModel {
  generated_at: string;
  generator: string;
  /** Total fleet size at the moment of generation. */
  fleet_size: number;
  /** Live (heartbeat-fresh) agent count. */
  live_count: number;
  claimable: BoardClaimableItem[];
  in_flight: BoardInFlightItem[];
  awaiting_review: BoardAwaitingReviewItem[];
  stuck: BoardStuckItem[];
  /** Recent review-cycle / ingested-run capsules (newest first, capped). */
  recent_capsules?: BoardCapsule[];
}

/** Max capsules surfaced on the board (it's a recent-activity strip, not a log). */
export const BOARD_CAPSULES_MAX = 10;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Default claim TTL when not specified on the claim record. */
export const CLAIM_TTL_DEFAULT_MS = 10_000;
/** Heartbeat older than this counts as "offline" for owner-health purposes. */
export const HEARTBEAT_OFFLINE_MS = 5 * 60_000;
/** Review-overdue threshold — past this and we surface the consensus as stuck. */
export const REVIEW_OVERDUE_MS = 30 * 60_000;

/* -------------------------------------------------------------------------- */
/*  Inputs container                                                          */
/* -------------------------------------------------------------------------- */

export interface BuildBoardInputs {
  tasks: BoardTask[];
  claims: BoardClaim[];
  consensus: BoardConsensus[];
  heartbeats: BoardHeartbeat[];
  /** Recent capsules (already summarized by the caller), newest-first preferred. */
  capsules?: BoardCapsule[];
  generator?: string;
  now?: number;
}

/* -------------------------------------------------------------------------- */
/*  buildBoard                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Snapshot orchestrator state into a {@link BoardModel}.
 *
 * Bucketing rules:
 *  - A task with no claim and all dependencies in `merged|done` is claimable.
 *  - A task with a fresh claim is in-flight; owner health is derived from the
 *    claimer's heartbeat.
 *  - Any task with an entry in `consensus` is awaiting review (regardless of
 *    its task status, so the board surfaces it even mid-review).
 *  - "Stuck" is layered on top: stale claim, offline owner, review overdue.
 */
export function buildBoard(inputs: BuildBoardInputs): BoardModel {
  const now = inputs.now ?? Date.now();
  const generator = inputs.generator ?? 'orchestrator-loop';

  const taskById = new Map(inputs.tasks.map(t => [t.id, t]));
  const claimByTaskId = new Map<string, BoardClaim>();
  for (const c of inputs.claims) {
    // If multiple claims exist for the same task, keep the freshest.
    const prev = claimByTaskId.get(c.task_id);
    if (!prev || new Date(c.claimed_at).getTime() > new Date(prev.claimed_at).getTime()) {
      claimByTaskId.set(c.task_id, c);
    }
  }
  const consensusByTaskId = new Map(inputs.consensus.map(c => [c.task_id, c]));

  // Heartbeat liveness lookup: keep the freshest per agent.
  const hbByAgent = new Map<string, BoardHeartbeat>();
  for (const hb of inputs.heartbeats) {
    if (!hb?.agent_id || !hb.timestamp) { continue; }
    const prev = hbByAgent.get(hb.agent_id);
    if (!prev || new Date(hb.timestamp).getTime() > new Date(prev.timestamp).getTime()) {
      hbByAgent.set(hb.agent_id, hb);
    }
  }
  const isLive = (agentId: string): boolean => {
    const hb = hbByAgent.get(agentId);
    if (!hb) { return false; }
    if (hb.status === 'halted' || hb.status === 'offline') { return false; }
    const age = now - new Date(hb.timestamp).getTime();
    return Number.isFinite(age) && age < HEARTBEAT_OFFLINE_MS;
  };

  const liveCount = Array.from(hbByAgent.keys()).filter(isLive).length;
  const isDoneStatus = (s: BoardTask['status'] | undefined): boolean =>
    s === 'merged' || s === 'done';

  // ---------- Claimable ---------------------------------------------------
  const claimable: BoardClaimableItem[] = [];
  for (const t of inputs.tasks) {
    if (claimByTaskId.has(t.id)) { continue; }
    if (consensusByTaskId.has(t.id)) { continue; }
    if (isDoneStatus(t.status)) { continue; }
    if (t.status === 'blocked') { continue; }
    const depsSatisfied = (t.depends_on ?? []).every(depId => {
      const dep = taskById.get(depId);
      return dep ? isDoneStatus(dep.status) : true; // unknown dep → assume satisfied
    });
    if (!depsSatisfied) { continue; }
    claimable.push({
      task_id: t.id,
      title: t.title,
      sprint: t.sprint,
      priority: t.priority,
      files: t.files ?? [],
      reason: 'open_no_claim',
    });
  }
  claimable.sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority)
    || a.task_id.localeCompare(b.task_id),
  );

  // ---------- In flight ---------------------------------------------------
  const inFlight: BoardInFlightItem[] = [];
  for (const [taskId, claim] of claimByTaskId) {
    if (consensusByTaskId.has(taskId)) { continue; }
    const t = taskById.get(taskId);
    const ageMs = now - new Date(claim.claimed_at).getTime();
    inFlight.push({
      task_id: taskId,
      title: t?.title,
      claimed_by: claim.claimed_by,
      claimed_at: claim.claimed_at,
      age_ms: Math.max(0, ageMs),
      owner_healthy: isLive(claim.claimed_by),
    });
  }
  inFlight.sort((a, b) => a.task_id.localeCompare(b.task_id));

  // ---------- Awaiting review --------------------------------------------
  const awaitingReview: BoardAwaitingReviewItem[] = [];
  for (const c of inputs.consensus) {
    const ageMs = now - new Date(c.opened_at).getTime();
    const approvals = c.votes.filter(v => v.vote === 'approve').length;
    const requestChanges = c.votes.filter(v => v.vote === 'request_changes').length;
    const required = c.rule === 'unanimous'
      ? c.reviewers.length
      : Math.max(1, Math.ceil((c.reviewers.length * 2) / 3));
    awaitingReview.push({
      task_id: c.task_id,
      author: c.author,
      opened_at: c.opened_at,
      age_ms: Math.max(0, ageMs),
      reviewers: [...c.reviewers],
      votes_received: c.votes.length,
      votes_required: required,
      rule: c.rule,
      approvals,
      request_changes: requestChanges,
    });
  }
  awaitingReview.sort((a, b) => b.age_ms - a.age_ms);

  // ---------- Stuck -------------------------------------------------------
  const stuck: BoardStuckItem[] = [];

  // 1. Claims past their TTL.
  for (const [taskId, claim] of claimByTaskId) {
    const ttl = claim.ttl_ms ?? CLAIM_TTL_DEFAULT_MS;
    const ageMs = now - new Date(claim.claimed_at).getTime();
    if (ageMs > ttl && !consensusByTaskId.has(taskId)) {
      stuck.push({
        task_id: taskId,
        reason: 'claim_expired',
        detail: `claim by ${claim.claimed_by} is ${Math.round(ageMs / 1000)}s old (ttl ${Math.round(ttl / 1000)}s)`,
        age_ms: ageMs,
      });
    }
  }

  // 2. In-flight tasks whose owner went offline.
  for (const item of inFlight) {
    if (!item.owner_healthy) {
      stuck.push({
        task_id: item.task_id,
        reason: 'owner_offline',
        detail: `owner ${item.claimed_by} has no fresh heartbeat`,
        age_ms: item.age_ms,
      });
    }
  }

  // 3. Reviews past the overdue threshold without enough votes.
  for (const item of awaitingReview) {
    if (item.age_ms > REVIEW_OVERDUE_MS && item.votes_received < item.votes_required) {
      stuck.push({
        task_id: item.task_id,
        reason: 'review_overdue',
        detail: `${item.votes_received}/${item.votes_required} reviews after ${Math.round(item.age_ms / 60_000)}m`,
        age_ms: item.age_ms,
      });
    }
    if (item.reviewers.length === 0) {
      stuck.push({
        task_id: item.task_id,
        reason: 'no_eligible_reviewers',
        detail: `no peers available to review ${item.task_id}`,
        age_ms: item.age_ms,
      });
    }
  }

  stuck.sort((a, b) => b.age_ms - a.age_ms);

  const recent_capsules = (inputs.capsules ?? [])
    .slice()
    .sort((a, b) => (a.evaluated_at < b.evaluated_at ? 1 : a.evaluated_at > b.evaluated_at ? -1 : 0))
    .slice(0, BOARD_CAPSULES_MAX);

  return {
    generated_at: new Date(now).toISOString(),
    generator,
    fleet_size: hbByAgent.size,
    live_count: liveCount,
    claimable,
    in_flight: inFlight,
    awaiting_review: awaitingReview,
    stuck,
    ...(recent_capsules.length > 0 ? { recent_capsules } : {}),
  };
}

function priorityRank(p: BoardTask['priority']): number {
  if (p === 'high') { return 0; }
  if (p === 'medium') { return 1; }
  if (p === 'low') { return 2; }
  return 3;
}

/* -------------------------------------------------------------------------- */
/*  renderBoardMarkdown                                                       */
/* -------------------------------------------------------------------------- */

/** Render a board as markdown. Same content as `board.json`, human-readable. */
export function renderBoardMarkdown(board: BoardModel): string {
  const out: string[] = [];
  out.push('# AutoClaw Agendaboard');
  out.push('');
  out.push(`_Generated ${board.generated_at} by ${board.generator}_`);
  out.push(`_Fleet: ${board.live_count} live / ${board.fleet_size} known_`);
  out.push('');
  out.push(`| Section | Count |`);
  out.push(`|---|---|`);
  out.push(`| Claimable | ${board.claimable.length} |`);
  out.push(`| In flight | ${board.in_flight.length} |`);
  out.push(`| Awaiting review | ${board.awaiting_review.length} |`);
  out.push(`| Stuck | ${board.stuck.length} |`);
  out.push('');

  out.push('## Claimable');
  if (board.claimable.length === 0) {
    out.push('_None — every open task has an owner or is awaiting review._');
  } else {
    out.push('| Task | Priority | Sprint | Title |');
    out.push('|---|---|---|---|');
    for (const it of board.claimable) {
      out.push(`| \`${it.task_id}\` | ${it.priority ?? '—'} | ${it.sprint ?? '—'} | ${escapeCell(it.title ?? '')} |`);
    }
  }
  out.push('');

  out.push('## In flight');
  if (board.in_flight.length === 0) {
    out.push('_No active claims._');
  } else {
    out.push('| Task | Owner | Age | Owner healthy |');
    out.push('|---|---|---|---|');
    for (const it of board.in_flight) {
      out.push(`| \`${it.task_id}\` | ${it.claimed_by} | ${formatAge(it.age_ms)} | ${it.owner_healthy ? 'yes' : '**no**'} |`);
    }
  }
  out.push('');

  out.push('## Awaiting review');
  if (board.awaiting_review.length === 0) {
    out.push('_No reviews open._');
  } else {
    out.push('| Task | Author | Rule | Votes | Reviewers | Age |');
    out.push('|---|---|---|---|---|---|');
    for (const it of board.awaiting_review) {
      const votesLabel = `${it.votes_received}/${it.votes_required}` +
        (it.approvals || it.request_changes ? ` (+${it.approvals}/−${it.request_changes})` : '');
      out.push(
        `| \`${it.task_id}\` | ${it.author} | ${it.rule} | ${votesLabel} | ${it.reviewers.join(', ')} | ${formatAge(it.age_ms)} |`,
      );
    }
  }
  out.push('');

  out.push('## Stuck');
  if (board.stuck.length === 0) {
    out.push('_Nothing stuck — fleet is healthy._');
  } else {
    out.push('| Task | Reason | Age | Detail |');
    out.push('|---|---|---|---|');
    for (const it of board.stuck) {
      out.push(`| \`${it.task_id}\` | ${it.reason} | ${formatAge(it.age_ms)} | ${escapeCell(it.detail)} |`);
    }
  }
  out.push('');

  const capsules = board.recent_capsules ?? [];
  if (capsules.length > 0) {
    out.push('## Recent evidence');
    out.push('| Task | Verdict | Gate | Votes | Source | Run |');
    out.push('|---|---|---|---|---|---|');
    for (const c of capsules) {
      const gate = c.gates_passed === undefined ? '—' : c.gates_passed ? '✓' : '✗';
      out.push(`| \`${c.task_id}\` | ${c.verdict} | ${gate} | ${c.votes_count} | ${escapeCell(c.source)} | \`${escapeCell(c.run_id)}\` |`);
    }
    out.push('');
  }

  return out.join('\n');
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) { return '—'; }
  if (ms < 60_000) { return `${Math.round(ms / 1000)}s`; }
  if (ms < 3_600_000) { return `${Math.round(ms / 60_000)}m`; }
  return `${Math.round(ms / 3_600_000)}h`;
}

function escapeCell(s: string): string {
  // Markdown table cells: pipes need escaping, newlines → space.
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
