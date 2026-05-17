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
import type {
  RegisteredAgent, Heartbeat, AgentStatus, Message,
} from './comms';

/** RegisteredAgent + the live runtime fields that getAgentStatuses() injects. */
export interface AgentWithLive extends RegisteredAgent {
  live_status?: AgentStatus;
  heartbeat?: Heartbeat | null;
}

/** Inbox summary tuple posted from extension.ts. */
export interface InboxSummary {
  total: number;
  unread: number;
  awaiting_response: number;
  archived: number;
}

/** Message + the agent perspective the webview is showing. */
export interface AwaitingYouRow {
  message: Message;
  /** Excerpt of payload (up to ~140 chars). */
  excerpt: string;
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
  now: number = Date.now()
): string {
  const live = agent.live_status || agent.status || 'detected';
  const hb = agent.heartbeat ?? null;
  const lastBeat = hb?.timestamp || agent.last_heartbeat || null;
  const cardId = `agent-card-${esc(agent.id)}`;

  // ── Summary line (always visible) ────────────────────────────────────────
  let head = '<div class="agent-card-head" role="button" tabindex="0" aria-expanded="false" ';
  head += `aria-controls="${cardId}-body" data-agent-id="${esc(agent.id)}">`;
  head += '<span class="card-chevron"></span>';
  head += `<span class="status-pill ${statusBadgeClass(live)}" title="${esc(live)}">${esc(live)}</span>`;
  head += `<span class="agent-name">${esc(agent.name || agent.id)}</span>`;
  head += `<span class="agent-id">${esc(agent.id)}</span>`;
  if (agent.extension_id) {
    head += `<span class="agent-platform">${esc(extractPlatform(agent.extension_id))}</span>`;
  }
  if (summary && summary.awaiting_response > 0) {
    head += `<span class="awaiting-pip" title="${summary.awaiting_response} awaiting your response">${summary.awaiting_response}</span>`;
  }
  head += '</div>';

  // ── Expanded body ────────────────────────────────────────────────────────
  let body = `<div class="agent-card-body" id="${cardId}-body" hidden>`;
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
  if (hb?.session_id) {
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

  return `<div class="agent-card" data-agent-id="${esc(agent.id)}">${head}${body}</div>`;
}

/** Render the entire agent list. Returns a string the JS sets as innerHTML. */
export function renderAgentList(
  agents: readonly AgentWithLive[],
  summaries: Record<string, InboxSummary> = {},
  now: number = Date.now()
): string {
  if (!agents || agents.length === 0) {
    return '<p class="empty">No agents detected.</p>';
  }
  return agents
    .map(a => renderAgentCard(a, summaries[a.id] ?? null, now))
    .join('');
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

/** Render the Awaiting You section body. */
export function renderAwaitingYou(rows: readonly AwaitingYouRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty">Nothing awaiting your response.</p>';
  }
  let h = '<div class="awaiting-list" aria-live="polite">';
  for (const r of rows) {
    const m = r.message;
    h += '<div class="awaiting-row" data-message-id="' + esc(m.id) + '">';
    h += '<div class="awaiting-meta">';
    h += '<span class="awaiting-from">' + esc(m.from) + '</span>';
    h += '<span class="awaiting-type">' + esc(m.type) + '</span>';
    if (typeof m.sprint === 'number') { h += '<span class="awaiting-sprint">sprint ' + esc(m.sprint) + '</span>'; }
    if (m.task_id) { h += '<span class="awaiting-task">' + esc(m.task_id) + '</span>'; }
    h += '</div>';
    h += '<div class="awaiting-body">' + esc(r.excerpt) + '</div>';
    h += '<div class="awaiting-actions">';
    h += '<button class="reply-btn" type="button" data-message-id="' + esc(m.id) + '" data-from="' + esc(m.from) + '" data-type="' + esc(m.type) + '">Reply</button>';
    h += '</div>';
    h += '</div>';
  }
  return h + '</div>';
}

// ---------------------------------------------------------------------------
// Fabric health badges
// ---------------------------------------------------------------------------

export function renderFabricHealth(h: FabricHealth | null): string {
  if (!h) {
    return '<span class="health-badge bridge-poll">bridge: poll</span><span class="health-badge kg-off">kg: off</span>';
  }
  const bridgeCls = `bridge-${h.bridge}`;
  const kgCls = `kg-${h.kg}`;
  const bridgeLabel = `bridge: ${h.bridge}`;
  const kgLabel = `kg: ${h.kg}`;
  return (
    `<span class="health-badge ${esc(bridgeCls)}" title="${esc(`SSE=${h.sse_clients ?? 0} WS=${h.ws_clients ?? 0}`)}">${esc(bridgeLabel)}</span>` +
    `<span class="health-badge ${esc(kgCls)}">${esc(kgLabel)}</span>`
  );
}
