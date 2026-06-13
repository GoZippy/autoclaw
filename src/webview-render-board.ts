/**
 * webview-render-board.ts — pure HTML renderers for the panel's task board
 * and per-task message threads.
 *
 * The board is a four-lane kanban built from `board.json` (see
 * src/orchestrator/board.ts):
 *   Backlog (claimable) → In progress (in_flight) → Review (awaiting_review) → Blocked (stuck)
 *
 * Each card shows the task, its assignee (with role color + model), age, and
 * a count of the messages exchanged about that task. Clicking a card's thread
 * toggle reveals the conversation between the agents working it — exactly the
 * "who is talking to whom about this task" view the fleet needs.
 *
 * Split into TypeScript so it is unit-testable without the Electron host
 * (see src/test/board-rendering.test.ts). Every interpolated value passes
 * through {@link esc}. No fs / vscode imports.
 */
import { esc, formatAge, shortModel } from './webview-render';
import { type CanonicalRole, ROLE_META, resolveAgentRole } from './roles';
export { type CanonicalRole };

// ---------------------------------------------------------------------------
// Input shapes — mirror board.json (read from disk by the extension)
// ---------------------------------------------------------------------------

export interface BoardClaimableItem {
  task_id: string;
  title?: string;
  sprint?: number;
  priority?: 'high' | 'medium' | 'low';
  files?: string[];
}
export interface BoardInFlightItem {
  task_id: string;
  title?: string;
  claimed_by: string;
  claimed_at?: string;
  age_ms?: number | null;
  owner_healthy?: boolean;
}
export interface BoardReviewItem {
  task_id: string;
  author: string;
  opened_at?: string;
  reviewers?: string[];
  votes_received?: number;
  votes_required?: number;
  rule?: 'majority' | 'unanimous';
  approvals?: number;
  request_changes?: number;
}
export interface BoardStuckItem {
  task_id: string;
  reason?: string;
  detail?: string;
  age_ms?: number | null;
}
export interface BoardCapsuleItem {
  run_id: string;
  task_id: string;
  source?: string;
  verdict?: string;
  gates_passed?: boolean;
  votes_count?: number;
  evaluated_at?: string;
}
export interface BoardSnapshot {
  fleet_size?: number;
  live_count?: number;
  claimable?: BoardClaimableItem[];
  in_flight?: BoardInFlightItem[];
  awaiting_review?: BoardReviewItem[];
  stuck?: BoardStuckItem[];
  recent_capsules?: BoardCapsuleItem[];
}

/** A single message in a per-task thread (a flattened comms-log entry). */
export interface ThreadMessage {
  timestamp: string;
  type: string;
  from: string;
  to?: string;
  task_id?: string;
  message?: string;
}

/** Lookups the renderer needs to color/label participants. */
export interface BoardRenderContext {
  /** agentId → canonical role (so cards & threads carry role color). */
  roleOf?: Record<string, CanonicalRole>;
  /** agentId → display name. Falls back to the id. */
  nameOf?: Record<string, string>;
  /** agentId → current model id (shown on in-flight cards). */
  modelOf?: Record<string, string>;
  /** task_id → messages exchanged about it, oldest first. */
  threads?: Record<string, ThreadMessage[]>;
  now?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roleClass(ctx: BoardRenderContext, agentId: string): string {
  const role = ctx.roleOf?.[agentId];
  return role ? ROLE_META[role].cssClass : 'role-generalist';
}
function roleGlyph(ctx: BoardRenderContext, agentId: string): string {
  const role = ctx.roleOf?.[agentId];
  return role ? ROLE_META[role].glyph : ROLE_META.generalist.glyph;
}
function displayName(ctx: BoardRenderContext, agentId: string): string {
  return ctx.nameOf?.[agentId] || agentId;
}

/** A small colored avatar + name for a fleet participant. */
function participant(ctx: BoardRenderContext, agentId: string): string {
  return `<span class="who ${roleClass(ctx, agentId)}" title="${esc(displayName(ctx, agentId))}">` +
    `<span class="who-glyph" aria-hidden="true">${roleGlyph(ctx, agentId)}</span>` +
    `<span class="who-name">${esc(displayName(ctx, agentId))}</span></span>`;
}

/** Count messages for a task (0 when none / no thread map). */
function threadCount(ctx: BoardRenderContext, taskId: string): number {
  return ctx.threads?.[taskId]?.length ?? 0;
}

function priorityTag(p?: string): string {
  if (!p) { return ''; }
  return `<span class="prio prio-${esc(p)}" title="${esc(p)} priority">${esc(p)}</span>`;
}

/** Render the collapsible message thread for one task. */
function renderThread(ctx: BoardRenderContext, taskId: string): string {
  const msgs = ctx.threads?.[taskId];
  if (!msgs || msgs.length === 0) { return ''; }
  const now = ctx.now ?? Date.now();
  let h = `<div class="task-thread" hidden>`;
  for (const m of msgs) {
    h += '<div class="thread-msg">';
    h += `<span class="thread-time">${esc(formatAge(m.timestamp, now))}</span>`;
    h += participant(ctx, m.from);
    if (m.to && m.to !== 'shared') { h += `<span class="thread-arrow" aria-hidden="true">→</span>${participant(ctx, m.to)}`; }
    else if (m.to === 'shared') { h += `<span class="thread-arrow" aria-hidden="true">→</span><span class="who who-shared">all</span>`; }
    h += `<span class="thread-type type-${esc(m.type)}">${esc(m.type)}</span>`;
    if (m.message) { h += `<span class="thread-text">${esc(m.message)}</span>`; }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

/** The shared card chrome: task id/title, a thread toggle, and the body. */
function card(opts: {
  ctx: BoardRenderContext;
  taskId: string;
  title?: string;
  meta: string;     // pre-rendered meta line (assignee, age, votes…)
  extraClass?: string;
}): string {
  const { ctx, taskId, title, meta } = opts;
  const count = threadCount(ctx, taskId);
  let h = `<div class="board-card ${opts.extraClass ?? ''}" data-task-id="${esc(taskId)}">`;
  h += '<div class="board-card-top">';
  h += `<span class="task-id">${esc(taskId)}</span>`;
  if (count > 0) {
    h += `<button type="button" class="thread-toggle" data-task-id="${esc(taskId)}" ` +
      `aria-expanded="false" title="${count} message${count === 1 ? '' : 's'} about this task">` +
      `<span class="thread-icon" aria-hidden="true">💬</span>${count}</button>`;
  }
  h += '</div>';
  if (title) { h += `<div class="task-title">${esc(title)}</div>`; }
  h += `<div class="board-card-meta">${meta}</div>`;
  h += renderThread(ctx, taskId);
  h += '</div>';
  return h;
}

/** Max cards rendered per lane; the rest collapse into a "+N more" footer so
 *  a 100-task board stays usable in a narrow sidebar. */
export const MAX_CARDS_PER_COLUMN = 30;

function renderColumn(opts: {
  key: string; label: string; glyph: string; cards: string[]; emptyHint: string;
}): string {
  const total = opts.cards.length;
  const shown = opts.cards.slice(0, MAX_CARDS_PER_COLUMN);
  const hidden = total - shown.length;
  let h = `<div class="board-col board-col-${opts.key}">`;
  h += `<div class="board-col-head"><span class="col-glyph" aria-hidden="true">${opts.glyph}</span>` +
    `<span class="col-label">${esc(opts.label)}</span><span class="col-count">${total}</span></div>`;
  h += `<div class="board-col-body">`;
  h += total > 0 ? shown.join('') : `<p class="board-empty">${esc(opts.emptyHint)}</p>`;
  if (hidden > 0) { h += `<p class="board-more">+${hidden} more</p>`; }
  h += '</div></div>';
  return h;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the four-lane task board. Returns a string the webview sets as
 * innerHTML. Empty board → a friendly hint (no kanban shell).
 */
export function renderBoard(board: BoardSnapshot | null, ctx: BoardRenderContext = {}): string {
  if (!board) {
    return '<p class="empty">No board yet. Run /orchestrate to plan sprints, ' +
      'or wait for the orchestrator to publish board.json.</p>';
  }
  const now = ctx.now ?? Date.now();
  const claimable = board.claimable ?? [];
  const inFlight = board.in_flight ?? [];
  const review = board.awaiting_review ?? [];
  const stuck = board.stuck ?? [];

  // Backlog
  const claimableCards = claimable.map(t => card({
    ctx, taskId: t.task_id, title: t.title,
    meta: [
      priorityTag(t.priority),
      typeof t.sprint === 'number' ? `<span class="meta-sprint">sprint ${esc(t.sprint)}</span>` : '',
      (t.files && t.files.length) ? `<span class="meta-files" title="${esc(t.files.join(', '))}">${t.files.length} file${t.files.length === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join(''),
    extraClass: 'is-claimable',
  }));

  // In progress
  const inFlightCards = inFlight.map(t => {
    const model = ctx.modelOf?.[t.claimed_by];
    const meta =
      participant(ctx, t.claimed_by) +
      (model ? `<span class="meta-model" title="${esc(model)}">${esc(shortModel(model))}</span>` : '') +
      (typeof t.age_ms === 'number' ? `<span class="meta-age">${esc(formatAge(new Date(now - t.age_ms).toISOString(), now))}</span>` : '') +
      (t.owner_healthy === false ? `<span class="meta-warn" title="owner heartbeat is stale">owner stalled</span>` : '');
    return card({ ctx, taskId: t.task_id, title: t.title, meta, extraClass: 'is-inflight' });
  });

  // Review
  const reviewCards = review.map(t => {
    const received = t.votes_received ?? 0;
    const required = t.votes_required ?? 0;
    const reviewers = (t.reviewers ?? []).map(r => participant(ctx, r)).join('');
    const meta =
      `<span class="meta-author">by ${participant(ctx, t.author)}</span>` +
      (reviewers ? `<span class="meta-reviewers"><span class="meta-label">reviewers</span>${reviewers}</span>` : '') +
      `<span class="meta-votes" title="${esc(t.rule ?? 'majority')}">✓${t.approvals ?? 0} ✎${t.request_changes ?? 0} · ${received}/${required}</span>`;
    return card({ ctx, taskId: t.task_id, meta, extraClass: 'is-review' });
  });

  // Blocked
  const stuckCards = stuck.map(t => card({
    ctx, taskId: t.task_id,
    meta:
      `<span class="meta-stuck" title="${esc(t.detail ?? '')}">${esc((t.reason ?? 'blocked').replace(/_/g, ' '))}</span>` +
      (typeof t.age_ms === 'number' ? `<span class="meta-age">${esc(formatAge(new Date(now - t.age_ms).toISOString(), now))}</span>` : ''),
    extraClass: 'is-stuck',
  }));

  let h = '<div class="board-kanban" aria-label="Task board">';
  h += renderColumn({ key: 'backlog', label: 'Backlog', glyph: '○', cards: claimableCards, emptyHint: 'Nothing claimable.' });
  h += renderColumn({ key: 'inflight', label: 'In progress', glyph: '◐', cards: inFlightCards, emptyHint: 'No active work.' });
  h += renderColumn({ key: 'review', label: 'Review', glyph: '◔', cards: reviewCards, emptyHint: 'Nothing in review.' });
  h += renderColumn({ key: 'blocked', label: 'Blocked', glyph: '✕', cards: stuckCards, emptyHint: 'Nothing stuck.' });
  h += '</div>';
  h += renderRecentEvidence(board.recent_capsules ?? []);
  return h;
}

/**
 * Recent-evidence strip below the kanban: a compact, read-only log of the latest
 * review-cycle / ingested-run capsules (verdict + gate state). Each row carries
 * the run handle so an operator can fetch or replay the capsule. Empty ⇒ nothing.
 */
function renderRecentEvidence(capsules: BoardCapsuleItem[]): string {
  if (capsules.length === 0) { return ''; }
  const rows = capsules.map(c => {
    const gate = c.gates_passed === undefined
      ? '<span class="ev-gate ev-gate-none" title="no acceptance gate ran">—</span>'
      : c.gates_passed
        ? '<span class="ev-gate ev-gate-pass" title="acceptance gate passed">✓</span>'
        : '<span class="ev-gate ev-gate-fail" title="acceptance gate failed">✗</span>';
    const verdictClass = c.verdict === 'approved' ? 'ev-ok' : (c.verdict === 'blocked' || c.verdict === 'needs_changes') ? 'ev-bad' : '';
    return '<tr>' +
      `<td class="ev-task">${esc(c.task_id)}</td>` +
      `<td class="ev-verdict ${verdictClass}">${esc(c.verdict ?? '—')}</td>` +
      `<td class="ev-gatecell">${gate}</td>` +
      `<td class="ev-votes">${esc(c.votes_count ?? 0)}</td>` +
      `<td class="ev-source">${esc(c.source ?? '—')}</td>` +
      `<td class="ev-run" title="${esc(c.run_id)}">${esc(c.run_id)}</td>` +
      '</tr>';
  }).join('');
  return '<div class="board-evidence" aria-label="Recent evidence">' +
    '<div class="board-evidence-title">Recent evidence</div>' +
    '<table class="board-evidence-table"><thead><tr>' +
    '<th>Task</th><th>Verdict</th><th>Gate</th><th>Votes</th><th>Source</th><th>Run</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/**
 * Infer the role an agent is *playing right now* from live board activity,
 * for fleets where no agent declares an explicit role. Grounded in real
 * orchestrator state (claims, authorship, reviews) — never guessed from text:
 *
 *   - actively holds an in-flight claim, or authored work now in review → coder
 *   - is a named reviewer on an open review (and not building)            → reviewer
 *   - otherwise                                                            → generalist
 *
 * Caller applies this only as a fallback BELOW explicit registry role /
 * agent_type / can_orchestrate.
 */
export function inferRoleFromActivity(agentId: string, board: BoardSnapshot | null): CanonicalRole {
  if (!board) { return 'generalist'; }
  const claiming = (board.in_flight ?? []).some(t => t.claimed_by === agentId);
  if (claiming) { return 'coder'; }
  const authoring = (board.awaiting_review ?? []).some(t => t.author === agentId);
  if (authoring) { return 'coder'; }
  const reviewing = (board.awaiting_review ?? []).some(t => (t.reviewers ?? []).includes(agentId));
  if (reviewing) { return 'reviewer'; }
  return 'generalist';
}

/**
 * Resolve the single role to display for an agent, applying the full
 * precedence chain in one place so the panel, board, and tests agree:
 *
 *   1. declared    — user override from `autoclaw.agentRoles` (already normalized)
 *   2. registry    — explicit `role` / fabric `agent_type` / `can_orchestrate`
 *   3. activity     — what the agent is doing on the live board right now
 *   4. generalist  — nothing known
 */
export function resolveDisplayRole(input: {
  declared?: CanonicalRole;
  role?: string | null;
  agent_type?: string | null;
  can_orchestrate?: boolean;
  agentId: string;
  board: BoardSnapshot | null;
}): CanonicalRole {
  if (input.declared && input.declared !== 'generalist') { return input.declared; }
  const registry = resolveAgentRole({
    role: input.role, agent_type: input.agent_type, can_orchestrate: input.can_orchestrate,
  });
  if (registry !== 'generalist') { return registry; }
  return inferRoleFromActivity(input.agentId, input.board);
}

/** Count of all tasks on the board — used for the section badge. */
export function boardTaskCount(board: BoardSnapshot | null): number {
  if (!board) { return 0; }
  return (board.claimable?.length ?? 0) + (board.in_flight?.length ?? 0) +
    (board.awaiting_review?.length ?? 0) + (board.stuck?.length ?? 0);
}

/**
 * Render the flat message feed (newest first) with role-colored participants
 * and task/sprint tags, so message traffic between agents is legible at a
 * glance. Replaces the old plain-text feed.
 */
export function renderMessageFeed(entries: readonly ThreadMessage[], ctx: BoardRenderContext = {}): string {
  if (!entries || entries.length === 0) {
    return '<p class="empty">No messages yet.</p>';
  }
  const now = ctx.now ?? Date.now();
  let h = '<div class="msg-feed">';
  for (const e of [...entries].reverse()) {
    h += '<div class="msg-entry">';
    h += `<span class="msg-time">${esc(formatAge(e.timestamp, now))}</span>`;
    h += participant(ctx, e.from);
    if (e.to && e.to !== 'shared') { h += `<span class="thread-arrow" aria-hidden="true">→</span>${participant(ctx, e.to)}`; }
    else if (e.to === 'shared') { h += `<span class="thread-arrow" aria-hidden="true">→</span><span class="who who-shared">all</span>`; }
    h += `<span class="msg-type type-${esc(e.type)}">${esc(e.type)}</span>`;
    if (e.task_id) { h += `<span class="msg-task">${esc(e.task_id)}</span>`; }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

/**
 * Group comms-log entries by task id into oldest-first threads, keeping only
 * entries that carry a task_id. Used to feed {@link BoardRenderContext.threads}.
 */
export function buildThreads(entries: readonly ThreadMessage[]): Record<string, ThreadMessage[]> {
  const out: Record<string, ThreadMessage[]> = {};
  for (const e of entries) {
    if (!e.task_id) { continue; }
    (out[e.task_id] ??= []).push(e);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  return out;
}
