/**
 * webview-render.ts — pure HTML-generating helpers for the AutoClaw panel.
 *
 * These functions produce strings of HTML that the webview JS injects directly
 * into the DOM via innerHTML. They MUST be safe against untrusted input —
 * every interpolated value passes through {@link esc}.
 *
 * They are split out from the webview JS into TypeScript so they can be
 * unit-tested without booting the Electron host (see
 * `src/test/webview-rendering.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  RegisteredAgent, Heartbeat, AgentStatus, Message,
} from './comms';
import {
  type CanonicalRole, ROLE_META, resolveAgentRole, summarizeRoles,
} from './roles';

/** Where an agent's presence reached this panel from (CF-2, integrate-automate-v3.2).
 *  Mirrors the `FleetOrigin` in views/fleetViewModel.ts; kept inline so the
 *  pure render module has no cross-module import. */
export type AgentOrigin = 'local' | 'relay' | 'beacon';

/** RegisteredAgent + the live runtime fields that getAgentStatuses() injects. */
export interface AgentWithLive extends RegisteredAgent {
  live_status?: AgentStatus;
  heartbeat?: Heartbeat | null;
  /** CF-2: 'relay' for a remote-host agent forwarded by the cloud relay,
   *  'local' (or absent) for an agent on this machine. */
  origin?: AgentOrigin;
  /** CF-2: the host the agent runs on. Falls back to machine_id, then 'local'. */
  host?: string;
  /** Optional explicit role string (registry rows in the wild carry one). */
  role?: string;
  /** All known session heartbeats for this agent (sidecar files). */
  sessions?: Heartbeat[];
}

/** Resolve an agent's display host (CF-2): explicit host → machine_id → 'local'. */
export function agentHost(agent: AgentWithLive): string {
  return agent.host || agent.machine_id || 'local';
}

/** True when the agent reached this panel from off this workspace — either a
 *  relay-forwarded remote-host agent (CF-2) or a beacon check-in from another
 *  IDE / runner on this machine (fleet beacons). Both render grouped by host. */
export function isRemoteAgent(agent: AgentWithLive): boolean {
  return agent.origin === 'relay' || agent.origin === 'beacon';
}

/** Inbox summary tuple posted from extension.ts. */
export interface InboxSummary {
  total: number;
  unread: number;
  awaiting_response: number;
  archived: number;
}

/** Resolved context for a `review_request` — the work actually under review.
 *  Built by resolving the request's `source_task_complete_id` against the
 *  shared inbox. Lets the reviewer see *what* they are approving. */
export interface ReviewContext {
  /** False when the source `task_complete` could not be located. */
  found: boolean;
  /** id of the source `task_complete` message. */
  sourceId?: string;
  author?: string;
  taskId?: string;
  sprint?: number;
  /** Human-readable summary of the completed work. */
  summary?: string;
  /** Branch the work landed on (`task_complete` `payload.branch`). */
  branch?: string;
  /** Files the author listed as touched, if any. */
  files?: string[];
}

/** Live consensus state for a `review_request`, powering the decision UI. */
export interface ConsensusTally {
  approvals: number;
  requestChanges: number;
  rejects: number;
  /** Distinct voters seen so far. */
  votesReceived: number;
  /** Votes needed to resolve under `rule`. */
  votesRequired: number;
  rule: 'majority' | 'unanimous';
  reviewers: string[];
  /** This reviewer's existing vote, if they already voted. */
  myVote?: 'approve' | 'request_changes' | 'reject' | null;
  /** True when the gate has already resolved. */
  decided?: boolean;
  /** ISO deadline from the request, if set. */
  deadlineIso?: string;
}

/** Message + the agent perspective the webview is showing. */
export interface AwaitingYouRow {
  message: Message;
  /** Excerpt of payload (up to ~140 chars). */
  excerpt: string;
  /** Resolved source-work context (review_request only). */
  context?: ReviewContext;
  /** Live consensus tally (review_request only). */
  tally?: ConsensusTally;
}

/** Health snapshot for the panel header badges. */
export interface FabricHealth {
  /** Bridge transport in use. `poll` is the default until SSE/WS appear. */
  bridge: 'poll' | 'sse' | 'ws' | 'off';
  /** kg-daemon process state. */
  kg: 'off' | 'running' | 'unreachable';
  /** Optional raw `/api/v1/health` payload for tooltip / a11y context. */
  bridge_port?: number;
  sse_clients?: number;
  ws_clients?: number;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** HTML-escape a value. Mirrors the runtime helper in kdream-dashboard.js. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Format a token-count like 1000000 → "1M". Returns empty string for falsy. */
export function formatContextWindow(n?: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) { return ''; }
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + 'M';
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + 'K';
  }
  return String(n);
}

/** "2 min ago" / "5h ago" / "never" for an ISO timestamp. */
export function formatAge(iso?: string | null, now: number = Date.now()): string {
  if (!iso) { return 'never'; }
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) { return 'never'; }
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) { return s + 's ago'; }
  if (s < 3600) { return Math.floor(s / 60) + ' min ago'; }
  if (s < 86400) { return Math.floor(s / 3600) + 'h ago'; }
  return Math.floor(s / 86400) + 'd ago';
}

/** Short form of a session id — first 8 chars, ellipsis if truncated. */
export function shortSessionId(s?: string | null): string {
  if (!s) { return ''; }
  return s.length > 8 ? s.slice(0, 8) + '…' : s;
}

/** Short display form of a model id: drops vendor path prefixes
 *  ("us.anthropic.claude-…" → "claude-…") and trailing date stamps
 *  ("claude-haiku-4-5-20251001" → "claude-haiku-4-5"). */
export function shortModel(s?: string | null): string {
  if (!s) { return ''; }
  let m = String(s);
  const slash = m.lastIndexOf('/');
  if (slash >= 0) { m = m.slice(slash + 1); }
  // vendor-prefixed bedrock-style ids: us.anthropic.claude-x → claude-x
  m = m.replace(/^[a-z]{2}\.[a-z0-9]+\./, '');
  m = m.replace(/-20\d{6}(-v\d+(:\d+)?)?$/, '');
  return m;
}

// ---------------------------------------------------------------------------
// Roles & team summary
// ---------------------------------------------------------------------------

/** Render one colored role chip. `compact` uses the 2–3 letter abbreviation. */
export function renderRoleChip(role: CanonicalRole, compact = false): string {
  const meta = ROLE_META[role];
  const text = compact ? meta.abbrev : meta.label;
  return `<span class="role-chip ${meta.cssClass}" title="${esc(meta.label)}">` +
    `<span class="role-glyph" aria-hidden="true">${meta.glyph}</span>${esc(text)}</span>`;
}

/** Resolve the canonical role for a panel agent row. */
export function agentRole(agent: AgentWithLive): CanonicalRole {
  return resolveAgentRole({
    role: agent.role,
    agent_type: agent.agent_type,
    can_orchestrate: agent.can_orchestrate,
  });
}

/**
 * Render the team-summary strip shown above the agent list: live/total
 * counts, session count, and the role distribution as colored chips.
 * Designed to stay readable from 2 agents up to 50.
 */
export function renderTeamSummary(agents: readonly AgentWithLive[], now: number = Date.now()): string {
  if (!agents || agents.length === 0) { return ''; }
  const live = agents.filter(a => {
    const s = a.live_status || a.status;
    return s === 'active' || s === 'idle' || s === 'overloaded';
  }).length;
  const sessionCount = agents.reduce((n, a) => n + (a.sessions?.length ?? 0), 0);
  const roles = summarizeRoles(agents.map(agentRole));

  let h = '<div class="team-summary" role="status" aria-label="Team summary">';
  h += `<span class="team-count" title="agents with a fresh heartbeat / total registered">` +
    `<span class="team-live">${live}</span>/${agents.length} live</span>`;
  if (sessionCount > 0) {
    h += `<span class="team-sessions" title="known sessions across all agents">${sessionCount} session${sessionCount === 1 ? '' : 's'}</span>`;
  }
  h += '<span class="team-roles">';
  for (const { role, count } of roles) {
    const meta = ROLE_META[role];
    h += `<span class="role-chip ${meta.cssClass}" title="${count} × ${esc(meta.label)}">` +
      `<span class="role-glyph" aria-hidden="true">${meta.glyph}</span>${esc(meta.label)}` +
      (count > 1 ? `<span class="role-count">${count}</span>` : '') + '</span>';
  }
  h += '</span></div>';
  return h;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Sort sessions newest-first; the primary heartbeat's session (if any) is
 *  not special-cased — every session renders the same way. */
function sortSessions(sessions: readonly Heartbeat[]): Heartbeat[] {
  return [...sessions].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * Render the per-agent session list (expanded card body). One row per
 * session heartbeat: short id, status, model, current task, last-seen.
 */
export function renderSessionList(sessions: readonly Heartbeat[] | undefined, now: number = Date.now()): string {
  if (!sessions || sessions.length === 0) { return ''; }
  let h = '<div class="session-list" aria-label="Sessions">';
  h += `<div class="session-list-label">Sessions<span class="session-list-count">${sessions.length}</span></div>`;
  for (const s of sortSessions(sessions)) {
    const stale = now - new Date(s.timestamp).getTime() > 10 * 60_000;
    h += `<div class="session-row${stale ? ' stale' : ''}">`;
    h += `<span class="session-dot ${stale ? 'status-offline' : 'status-' + esc(s.status || 'idle')}" aria-hidden="true"></span>`;
    h += `<span class="session-id" title="${esc(s.session_id ?? '')}">${esc(shortSessionId(s.session_id) || '(no id)')}</span>`;
    if (s.current_llm) { h += `<span class="session-model" title="${esc(s.current_llm)}">${esc(shortModel(s.current_llm))}</span>`; }
    if (s.current_task) { h += `<span class="session-task" title="${esc(s.current_task)}">${esc(s.current_task)}</span>`; }
    h += `<span class="session-seen">${esc(formatAge(s.timestamp, now))}</span>`;
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

/** CSS modifier suffix for an agent status badge. */
export function statusBadgeClass(status?: AgentStatus | string | null): string {
  switch (status) {
    case 'active': return 'status-active';
    case 'idle': return 'status-idle';
    case 'overloaded': return 'status-overloaded';
    case 'stalled': return 'status-stalled';
    case 'offline': return 'status-offline';
    case 'detected': return 'status-detected';
    default: return 'status-detected';
  }
}

/** CSS modifier for a trust-level badge. */
export function trustBadgeClass(t?: string | null): string {
  switch (t) {
    case 'high': return 'trust-high';
    case 'medium': return 'trust-medium';
    case 'low': return 'trust-low';
    case 'untrusted': return 'trust-untrusted';
    default: return 'trust-unknown';
  }
}

/** Render a row of pill-shaped chips. Accepts arbitrary string tags. */
export function renderChips(label: string, values: readonly string[] | undefined): string {
  if (!values || values.length === 0) { return ''; }
  const chips = values.map(v => `<span class="chip">${esc(v)}</span>`).join('');
  return `<div class="agent-detail-row"><span class="detail-label">${esc(label)}</span><span class="chip-row">${chips}</span></div>`;
}

/** Render a single key/value detail row. Hidden when value is empty. */
export function renderDetailRow(label: string, value: string | undefined | null): string {
  if (value == null || value === '') { return ''; }
  return `<div class="agent-detail-row"><span class="detail-label">${esc(label)}</span><span class="detail-value">${esc(value)}</span></div>`;
}

/**
 * Render one agent card. The summary row is always rendered; the expanded
 * body is rendered as a sibling div the JS can toggle by adding/removing
 * the .open class on the surrounding .agent-card element.
 */
export function renderAgentCard(
  agent: AgentWithLive,
  summary: InboxSummary | null = null,
  now: number = Date.now(),
  selfId?: string
): string {
  const live = agent.live_status || agent.status || 'detected';
  const hb = agent.heartbeat ?? null;
  const lastBeat = hb?.timestamp || agent.last_heartbeat || null;
  const cardId = `agent-card-${esc(agent.id)}`;
  const isSelf = !!selfId && agent.id === selfId;

  // ── Summary line (always visible) ────────────────────────────────────────
  let head = '<div class="agent-card-head" role="button" tabindex="0" aria-expanded="false" ';
  head += `aria-controls="${cardId}-body" data-agent-id="${esc(agent.id)}">`;
  head += '<span class="card-chevron"></span>';
  head += `<span class="status-pill ${statusBadgeClass(live)}" title="${esc(live)}">${esc(live)}</span>`;
  head += `<span class="agent-name">${esc(agent.name || agent.id)}</span>`;
  // "you" pill — marks the agent running in THIS window, so the user can tell
  // why the self-scoped "Awaiting You" section attaches to this agent and not
  // another. Only one card per window carries it.
  if (isSelf) {
    head += '<span class="you-pill" title="This is you — the agent running in this window">you</span>';
  }
  // Role chip — the single most useful "what is this agent doing on the team"
  // signal, so it sits right after the name on the always-visible summary line.
  head += renderRoleChip(agentRole(agent), true);
  head += `<span class="agent-id">${esc(agent.id)}</span>`;
  if (agent.extension_id) {
    head += `<span class="agent-platform">${esc(extractPlatform(agent.extension_id))}</span>`;
  }
  // Model the agent is running right now — abbreviated to stay on one line.
  const headModel = hb?.current_llm
    || (agent.llms_available && agent.llms_available.length === 1 ? agent.llms_available[0] : undefined);
  if (headModel) {
    head += `<span class="agent-model" title="${esc(headModel)}">${esc(shortModel(headModel))}</span>`;
  }
  // CF-2: origin/host badge — only for relay-forwarded remote-host agents, so
  // the single-machine view is unchanged (no badge when origin is local/absent).
  if (isRemoteAgent(agent)) {
    const host = agentHost(agent);
    const isBeacon = agent.origin === 'beacon';
    const title = isBeacon
      ? `External agent on ${esc(host)} (beacon check-in)`
      : `Remote agent on ${esc(host)} (via cloud relay)`;
    head += `<span class="origin-badge origin-${isBeacon ? 'beacon' : 'remote'}" title="${title}">⌂ ${esc(host)}</span>`;
  }
  if (summary && summary.awaiting_response > 0) {
    head += `<span class="awaiting-pip" title="${summary.awaiting_response} awaiting your response">${summary.awaiting_response}</span>`;
  }
  head += '</div>';

  // ── Expanded body ────────────────────────────────────────────────────────
  let body = `<div class="agent-card-body" id="${cardId}-body" hidden>`;
  // Role first, with the colored pill so the body restates the head chip.
  body += `<div class="agent-detail-row"><span class="detail-label">Role</span>`;
  body += `<span class="detail-value">${renderRoleChip(agentRole(agent), false)}</span></div>`;
  body += renderChips('Capabilities', agent.capabilities);
  body += renderChips('LLMs', agent.llms_available);
  if (typeof agent.context_window === 'number' && agent.context_window > 0) {
    body += renderDetailRow('Context Window', formatContextWindow(agent.context_window));
  }
  if (agent.trust_level) {
    body += `<div class="agent-detail-row"><span class="detail-label">Trust</span>`;
    body += `<span class="trust-pill ${trustBadgeClass(agent.trust_level)}">${esc(agent.trust_level)}</span></div>`;
  }
  if (agent.cost_budget) {
    const parts: string[] = [];
    if (typeof agent.cost_budget.daily_usd === 'number') { parts.push(`$${agent.cost_budget.daily_usd}/day`); }
    if (typeof agent.cost_budget.hourly_usd === 'number') { parts.push(`$${agent.cost_budget.hourly_usd}/hr`); }
    if (parts.length) { body += renderDetailRow('Budget', parts.join(' · ')); }
  }
  // CF-2: surface host + origin so a remote agent is unambiguous in the body.
  if (isRemoteAgent(agent)) {
    const suffix = agent.origin === 'beacon' ? ' (external · beacon)' : ' (remote · via relay)';
    body += renderDetailRow('Host', `${agentHost(agent)}${suffix}`);
  }
  // v2 identity + routing fields
  if (agent.machine_id) { body += renderDetailRow('Machine', agent.machine_id); }
  if (agent.machine_ip) { body += renderDetailRow('Machine IP', agent.machine_ip); }
  if (typeof agent.max_parallel_tasks === 'number') {
    body += renderDetailRow('Max Parallel', String(agent.max_parallel_tasks));
  }
  if (agent.human_in_loop_required) {
    body += renderDetailRow('Human-in-Loop', 'required');
  }
  body += renderChips('Tools', agent.tools_supported);
  body += renderChips('Skills', agent.skills_loaded);

  body += renderDetailRow('Last Heartbeat', formatAge(lastBeat, now));
  if (hb?.current_llm) { body += renderDetailRow('Current LLM', hb.current_llm); }
  if (typeof hb?.queue_depth === 'number') {
    const warn = hb.queue_depth >= 10 ? ' warn' : '';
    body += `<div class="agent-detail-row"><span class="detail-label">Queue Depth</span>`;
    body += `<span class="queue-bar${warn}" role="progressbar" aria-valuemin="0" aria-valuemax="20" aria-valuenow="${hb.queue_depth}">`;
    body += `<span class="queue-fill" style="width:${Math.min(100, hb.queue_depth * 5)}%"></span>`;
    body += `<span class="queue-num">${hb.queue_depth}</span></span></div>`;
  }
  if (typeof hb?.token_budget_remaining === 'number') {
    body += renderDetailRow('Tokens Remaining', String(hb.token_budget_remaining));
  }
  if (typeof hb?.error_rate_1m === 'number') {
    const pct = Math.round(hb.error_rate_1m * 1000) / 10;
    body += renderDetailRow('Error Rate (1m)', pct + '%');
  }
  if (hb?.last_error?.message) {
    body += `<div class="agent-detail-row last-error"><span class="detail-label">Last Error</span>`;
    body += `<pre class="error-box">${esc(hb.last_error.message)}</pre></div>`;
  }
  // Per-session breakdown — when sidecar session heartbeats exist, show one
  // row each (a single agent process can host several chat sessions). Falls
  // back to the single primary session id when no sidecars were collected.
  if (agent.sessions && agent.sessions.length > 0) {
    body += renderSessionList(agent.sessions, now);
  } else if (hb?.session_id) {
    body += renderDetailRow('Session', shortSessionId(hb.session_id));
  }

  // Inbox summary counters (per agent)
  if (summary) {
    body += '<div class="inbox-summary" aria-label="Inbox counters">';
    body += `<div class="ic"><span class="ic-num">${summary.total}</span><span class="ic-label">Total</span></div>`;
    body += `<div class="ic"><span class="ic-num">${summary.unread}</span><span class="ic-label">Unread</span></div>`;
    body += `<div class="ic ic-awaiting"><span class="ic-num">${summary.awaiting_response}</span><span class="ic-label">Awaiting You</span></div>`;
    body += `<div class="ic"><span class="ic-num">${summary.archived}</span><span class="ic-label">Archived</span></div>`;
    body += '</div>';
  }

  body += '</div>';

  const selfClass = isSelf ? ' is-self' : '';
  return `<div class="agent-card${selfClass}" data-agent-id="${esc(agent.id)}"${isSelf ? ' data-self="true"' : ''}>${head}${body}</div>`;
}

/** Render the persistent "you are X" identity banner for the Team view.
 *
 * The same logical mailbox renders under a different card in each IDE because
 * the self-scoped "Awaiting You" section follows whichever agent is running
 * the window. Without telling the user who "you" are, that looks arbitrary —
 * this banner makes it legible. Returns '' when the host identity is unknown.
 */
export function renderSelfIdentity(
  agents: readonly AgentWithLive[],
  selfId?: string
): string {
  if (!selfId) { return ''; }
  const self = agents.find(a => a.id === selfId);
  const name = self?.name || selfId;
  const known = !!self;
  const note = known
    ? 'The "Awaiting You" section and your inbox counts are scoped to this agent.'
    : 'This window’s agent is not registered on the team yet.';
  return (
    `<div class="self-identity${known ? '' : ' unknown'}" title="${esc(note)}">` +
    '<span class="self-identity-label">You are</span>' +
    `<span class="self-identity-name">${esc(name)}</span>` +
    `<span class="agent-id">${esc(selfId)}</span>` +
    '</div>'
  );
}

/** Render the entire agent list. Returns a string the JS sets as innerHTML.
 *
 * CF-2: when any agent is relay-forwarded (cross-machine fleet), cards are
 * grouped under a per-host header — this machine's local agents first, then
 * remote hosts alphabetically. With no relay data the list is flat, exactly
 * as before (single-machine view unchanged). */
export function renderAgentList(
  agents: readonly AgentWithLive[],
  summaries: Record<string, InboxSummary> = {},
  now: number = Date.now(),
  selfId?: string
): string {
  if (!agents || agents.length === 0) {
    return '<p class="empty">No agents detected.</p>';
  }

  const hasRelay = agents.some(isRemoteAgent);
  const card = (a: AgentWithLive) => renderAgentCard(a, summaries[a.id] ?? null, now, selfId);
  const summary = renderSelfIdentity(agents, selfId) + renderTeamSummary(agents, now);

  if (!hasRelay) {
    return summary + agents.map(card).join('');
  }

  // Partition into this machine's local agents and remote agents grouped by
  // host. Local agents render first under "This machine"; each remote host is
  // its own group, hosts alphabetical.
  const localAgents: AgentWithLive[] = [];
  const remoteByHost = new Map<string, AgentWithLive[]>();
  for (const a of agents) {
    if (isRemoteAgent(a)) {
      const host = agentHost(a);
      const list = remoteByHost.get(host) ?? [];
      list.push(a);
      remoteByHost.set(host, list);
    } else {
      localAgents.push(a);
    }
  }

  const groupHeader = (cls: string, glyph: string, label: string, count: number): string =>
    `<div class="host-group-header ${cls}"><span class="host-glyph">${glyph}</span>` +
    `<span class="host-label">${esc(label)}</span>` +
    `<span class="host-count">${count}</span></div>`;

  let out = summary;
  if (localAgents.length > 0) {
    out += groupHeader('local', '⚑', 'This machine', localAgents.length);
    out += localAgents.map(card).join('');
  }
  for (const host of Array.from(remoteByHost.keys()).sort((a, b) => a.localeCompare(b))) {
    const list = remoteByHost.get(host)!;
    out += groupHeader('remote', '⌂', host, list.length);
    out += list.map(card).join('');
  }
  return out;
}

/** Heuristic: derive a short platform tag from extension_id. */
export function extractPlatform(extensionId: string): string {
  const id = extensionId.toLowerCase();
  if (id.includes('claude')) { return 'claude-code'; }
  if (id.includes('kilocode')) { return 'kilocode'; }
  if (id.includes('kiro')) { return 'kiro'; }
  if (id.includes('roo')) { return 'roo'; }
  if (id.includes('cursor')) { return 'cursor'; }
  if (id.includes('continue')) { return 'continue'; }
  if (id.includes('windsurf')) { return 'windsurf'; }
  if (id.includes('copilot')) { return 'copilot'; }
  return extensionId.split('.').pop() || extensionId;
}

// ---------------------------------------------------------------------------
// Awaiting You section
// ---------------------------------------------------------------------------

/** Truncate body text for the awaiting-you list excerpt. */
export function payloadExcerpt(payload: Record<string, unknown> | undefined, max = 140): string {
  if (!payload) { return ''; }
  // Prefer human-readable fields if present.
  for (const k of ['summary', 'description', 'message', 'body', 'question']) {
    const v = (payload as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > max ? v.slice(0, max) + '…' : v;
    }
  }
  // Auto-promoted review_requests carry no human text — they point at the
  // work via `source_task_complete_id`. Describe them instead of dumping JSON.
  if (typeof (payload as Record<string, unknown>).source_task_complete_id === 'string') {
    const author = typeof (payload as Record<string, unknown>).author === 'string'
      ? ` by ${(payload as Record<string, unknown>).author}` : '';
    return `Peer review requested${author} — expand to see the completed work.`;
  }
  try {
    const s = JSON.stringify(payload);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    return '';
  }
}

/** Filter messages to those that need a response from `me`. */
export function filterAwaitingYou(
  messages: readonly Message[],
  me: string,
  states: Record<string, { replied_at: string | null }> = {}
): Message[] {
  return messages.filter(m =>
    m.to === me &&
    m.requires_response === true &&
    !states[m.id]?.replied_at
  );
}

/** Render one Approve / Request changes / Reject button. */
function voteButton(
  vote: 'approve' | 'request_changes' | 'reject',
  label: string,
  taskId: string,
  m: Message,
  myVote: string | null,
): string {
  const isCast = myVote === vote;
  return '<button class="vote-btn vote-' + vote + (isCast ? ' cast' : '') + '" type="button"'
    + ' data-task-id="' + esc(taskId) + '"'
    + ' data-message-id="' + esc(m.id) + '"'
    + ' data-from="' + esc(m.from) + '"'
    + ' data-vote="' + vote + '"'
    + (isCast ? ' aria-pressed="true"' : '')
    + '>' + esc(label) + (isCast ? ' ✓' : '') + '</button>';
}

/** Render the consensus tally line — counts, threshold, and a plain-English
 *  hint that tells the reviewer whether their decision is still needed. */
function renderTally(t: ConsensusTally): string {
  const need = t.rule === 'unanimous' ? 'unanimous' : 'majority';
  let cls = 'awaiting-tally';
  let hint: string;
  if (t.decided) {
    hint = 'Decision reached — your vote is optional.';
  } else if (t.myVote) {
    hint = 'You voted ' + t.myVote.replace('_', ' ') + ' — you can change it below.';
  } else {
    cls += ' needs-you';
    hint = 'Your decision is needed.';
  }
  let h = '<div class="' + cls + '">';
  h += '<span class="tally-counts">';
  h += '<span class="t-approve" title="approvals">✓ ' + t.approvals + '</span> ';
  h += '<span class="t-changes" title="change requests">✎ ' + t.requestChanges + '</span> ';
  h += '<span class="t-reject" title="rejections">✗ ' + t.rejects + '</span>';
  h += '</span>';
  h += '<span class="tally-rule">' + t.votesReceived + '/' + t.votesRequired + ' votes · ' + need + '</span>';
  h += '<span class="tally-hint">' + esc(hint) + '</span>';
  if (typeof t.deadlineIso === 'string' && t.deadlineIso.length >= 16) {
    h += '<span class="tally-deadline">due ' + esc(t.deadlineIso.slice(0, 16).replace('T', ' ')) + '</span>';
  }
  h += '</div>';
  return h;
}

/** One key/value line in the review detail grid. */
function detailKV(label: string, value: string): string {
  return '<div class="detail-kv"><span class="detail-label">' + esc(label)
    + '</span><span class="detail-val">' + esc(value) + '</span></div>';
}

/** Render the collapsed drill-down panel showing the work under review. */
function renderReviewDetail(ctx?: ReviewContext): string {
  let h = '<div class="awaiting-detail" hidden>';
  if (!ctx || !ctx.found) {
    h += '<p class="detail-missing">The original completion report wasn\'t found in the '
      + 'shared inbox — it may have been archived. Decide from the task history, or ask '
      + 'the author for a recap before voting.</p>';
    if (ctx?.sourceId) { h += '<p class="detail-src">source: ' + esc(ctx.sourceId) + '</p>'; }
    return h + '</div>';
  }
  h += '<div class="detail-grid">';
  if (ctx.author) { h += detailKV('Author', ctx.author); }
  if (typeof ctx.sprint === 'number') { h += detailKV('Sprint', String(ctx.sprint)); }
  if (ctx.branch) { h += detailKV('Branch', ctx.branch); }
  h += '</div>';
  if (ctx.summary) { h += '<div class="detail-summary">' + esc(ctx.summary) + '</div>'; }
  if (ctx.files && ctx.files.length > 0) {
    h += '<div class="detail-files"><span class="detail-label">Files changed</span><ul>';
    for (const f of ctx.files.slice(0, 20)) {
      h += '<li><button class="file-link" type="button" data-file="' + esc(f) + '">' + esc(f) + '</button></li>';
    }
    if (ctx.files.length > 20) { h += '<li class="more">+' + (ctx.files.length - 20) + ' more</li>'; }
    h += '</ul></div>';
  }
  h += '<p class="detail-decide">You\'re deciding whether this work is approved. '
    + 'Approve it, request changes, or reject below.</p>';
  return h + '</div>';
}

/** Render the Awaiting You section body. */
export function renderAwaitingYou(rows: readonly AwaitingYouRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty">Nothing awaiting your response.</p>';
  }
  let h = '<div class="awaiting-list" aria-live="polite">';
  for (const r of rows) {
    const m = r.message;
    const isReview = m.type === 'review_request';
    const taskId = r.context?.taskId || m.task_id || '';
    h += '<div class="awaiting-row" data-message-id="' + esc(m.id) + '">';

    // Header — clickable to expand the drill-down detail panel.
    h += '<div class="awaiting-head awaiting-meta" data-action="toggle-detail" role="button" tabindex="0" aria-expanded="false">';
    h += '<span class="awaiting-caret" aria-hidden="true">▸</span>';
    h += '<span class="awaiting-from">' + esc(m.from) + '</span>';
    h += '<span class="awaiting-type">' + esc(m.type) + '</span>';
    if (typeof m.sprint === 'number') { h += '<span class="awaiting-sprint">sprint ' + esc(m.sprint) + '</span>'; }
    if (taskId) { h += '<span class="awaiting-task">' + esc(taskId) + '</span>'; }
    h += '</div>';

    // One-line summary, always visible.
    h += '<div class="awaiting-body awaiting-preview">' + esc(r.excerpt) + '</div>';

    // Consensus tally + drill-down (review_request only).
    if (isReview && r.tally) { h += renderTally(r.tally); }
    if (isReview) { h += renderReviewDetail(r.context); }

    // Actions: a real decision for reviews, free-text reply otherwise.
    h += '<div class="awaiting-actions">';
    if (isReview && taskId) {
      const my = r.tally?.myVote ?? null;
      h += '<input class="vote-comment" type="text" placeholder="Optional note for the author…" aria-label="Review comment" />';
      h += '<div class="vote-btns">';
      h += voteButton('approve', 'Approve', taskId, m, my);
      h += voteButton('request_changes', 'Request changes', taskId, m, my);
      h += voteButton('reject', 'Reject', taskId, m, my);
      h += '</div>';
    } else {
      h += '<button class="reply-btn" type="button" data-message-id="' + esc(m.id) + '" data-from="' + esc(m.from) + '" data-type="' + esc(m.type) + '">Reply</button>';
    }
    h += '</div>';

    h += '</div>';
  }
  return h + '</div>';
}

// ---------------------------------------------------------------------------
// Fabric health badges
// ---------------------------------------------------------------------------

/** Plain-English explanation of each bridge state, used in tooltips. */
export function bridgeTooltip(state: FabricHealth['bridge'], h?: FabricHealth | null): string {
  const base = (() => {
    switch (state) {
      case 'poll': return 'Bridge transport: filesystem polling (default — no daemon required).';
      case 'sse':  return 'Bridge transport: Server-Sent Events stream.';
      case 'ws':   return 'Bridge transport: WebSocket stream.';
      case 'off':  return 'Bridge transport: disabled. Inter-agent messages will not be relayed.';
    }
  })();
  const clients = h ? ` Connected clients: SSE=${h.sse_clients ?? 0} WS=${h.ws_clients ?? 0}.` : '';
  const port = h?.bridge_port ? ` Port ${h.bridge_port}.` : '';
  return `${base}${clients}${port} Click to open the bridge docs.`;
}

/** Plain-English explanation of each kg-daemon state, used in tooltips. */
export function kgTooltip(state: FabricHealth['kg']): string {
  switch (state) {
    case 'off':         return 'Knowledge Graph daemon: not running. Memory recall + bi-temporal facts disabled. Click to start.';
    case 'running':     return 'Knowledge Graph daemon: running. Memory recall + bi-temporal facts active. Click to open dashboard.';
    case 'unreachable': return 'Knowledge Graph daemon: process running but not responding. Click to restart.';
  }
}

/** Webview command emitted when a fabric chip is clicked. */
type FabricChipCommand = 'openBridgeDoc' | 'startKgDaemon' | 'openKgDashboard' | 'restartKgDaemon';

/** Which command a click on a kg chip should dispatch, given the state. */
export function kgClickCommand(state: FabricHealth['kg']): FabricChipCommand {
  switch (state) {
    case 'off':         return 'startKgDaemon';
    case 'running':     return 'openKgDashboard';
    case 'unreachable': return 'restartKgDaemon';
  }
}

export function renderFabricHealth(h: FabricHealth | null): string {
  const bridgeState: FabricHealth['bridge'] = h?.bridge ?? 'poll';
  const kgState: FabricHealth['kg'] = h?.kg ?? 'off';
  const bridgeCls = `bridge-${bridgeState}`;
  const kgCls = `kg-${kgState}`;
  const bridgeLabel = `bridge: ${bridgeState}`;
  const kgLabel = `kg: ${kgState}`;
  const bridgeTip = bridgeTooltip(bridgeState, h);
  const kgTip = kgTooltip(kgState);
  const kgCmd = kgClickCommand(kgState);
  return (
    `<button type="button" class="health-badge ${esc(bridgeCls)}" ` +
      `data-fabric-action="openBridgeDoc" ` +
      `title="${esc(bridgeTip)}" aria-label="${esc(bridgeTip)}">${esc(bridgeLabel)}</button>` +
    `<button type="button" class="health-badge ${esc(kgCls)}" ` +
      `data-fabric-action="${esc(kgCmd)}" ` +
      `title="${esc(kgTip)}" aria-label="${esc(kgTip)}">${esc(kgLabel)}</button>`
  );
}

// ---------------------------------------------------------------------------
// UI-3: Status-dot legend popover
// ---------------------------------------------------------------------------

/** Plain-English explanation of each agent status, used in the legend popover. */
export const STATUS_LEGEND: ReadonlyArray<{ status: string; label: string; meaning: string }> = [
  { status: 'active',     label: 'Active',     meaning: 'Working a claim right now.' },
  { status: 'idle',       label: 'Idle',       meaning: 'Heartbeat fresh; no claim in progress.' },
  { status: 'overloaded', label: 'Overloaded', meaning: 'Queue depth ≥ 10 or token budget low.' },
  { status: 'stalled',    label: 'Stalled',    meaning: 'No heartbeat for ≥5 cycles.' },
  { status: 'offline',    label: 'Offline',    meaning: 'Heartbeat dead; excluded from quorum.' },
  { status: 'detected',   label: 'Detected',   meaning: 'Registered but never checked in.' },
];

/**
 * Render the (?) legend chip + collapsible popover that explains every status
 * dot color. Click toggles `.open` on the wrapper; tests assert markup only.
 */
export function renderStatusLegend(): string {
  const rows = STATUS_LEGEND.map(s =>
    `<li class="legend-row"><span class="status-dot ${esc(statusBadgeClass(s.status))}" aria-hidden="true"></span>` +
    `<span class="legend-label">${esc(s.label)}</span>` +
    `<span class="legend-meaning">${esc(s.meaning)}</span></li>`
  ).join('');
  return (
    `<span class="status-legend" role="group" aria-label="Status legend">` +
      `<button type="button" class="legend-chip" aria-expanded="false" aria-controls="status-legend-popover" ` +
        `title="Show status-dot legend">?</button>` +
      `<div id="status-legend-popover" class="legend-popover" role="region" aria-label="Agent status meanings" hidden>` +
        `<ul class="legend-list">${rows}</ul>` +
      `</div>` +
    `</span>`
  );
}

// ---------------------------------------------------------------------------
// UI-2: Panel version footer
// ---------------------------------------------------------------------------

/** Read extension version from package.json. Null if missing/malformed. */
export function readExtensionVersionFromDisk(extensionFsPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(extensionFsPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Read current git branch from .git/HEAD. Null on detached HEAD / no repo. */
export function readGitBranchFromDisk(workspaceRoot: string): string | null {
  try {
    const head = fs.readFileSync(path.join(workspaceRoot, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Render the panel footer. Missing pieces are omitted, not filled. */
export function renderPanelFooter(version: string | null, branch: string | null): string {
  const verLabel = version ? `v${esc(version)}` : 'v?';
  const parts = [`AutoClaw ${verLabel}`];
  if (branch) { parts.push(`branch: ${esc(branch)}`); }
  return `<footer class="panel-footer" role="contentinfo" aria-label="AutoClaw version">${parts.join(' · ')}</footer>`;
}
