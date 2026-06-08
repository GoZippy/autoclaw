/**
 * fleetViewModelBuilders.ts — Pure render-data builders for the Fleet panel.
 *
 * Every function here is a *pure* transform: raw on-disk shapes in, render-ready
 * view-models out.  No file I/O, no `vscode`, no clock side-effects beyond an
 * injectable `now`.  This makes the whole module unit-testable in plain Node
 * (see `src/test/fleet-panel.test.ts`).
 *
 * The I/O layer that feeds these builders lives in `src/panel/fleetData.ts`.
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */

import type { HealthState, AgentHealth } from '../lmd/types';
import type {
  FleetOrigin,
  HealthColor,
  HealthGridRow,
  AgentCard,
  AgentCardDetail,
  AgentTreeNode,
  AwaitingItem,
  ActivityEvent,
  ActivityKind,
  OutboundSummary,
  CostLedgerEntry,
  CostLedgerView,
  CostRollupRow,
  PresenceSummary,
  FleetDashboardModel,
} from './fleetViewModel';

// ---------------------------------------------------------------------------
// Raw input shapes (subset of comms types — kept local to avoid a hard
// dependency on the comms module's evolving surface).
// ---------------------------------------------------------------------------

/** Minimal heartbeat shape this module reads. */
export interface RawHeartbeat {
  agent_id: string;
  timestamp: string;
  status?: string;
  current_task?: string | null;
  sprint?: number | null;
  session_id?: string;
  queue_depth?: number;
  /**
   * CF-1: the host the heartbeat originated on. Local heartbeats may omit
   * this (resolved to the local-host label); relay-forwarded heartbeats carry
   * the remote machine id so the same agent_id on two machines stays distinct.
   */
  host?: string;
  /** CF-1: `local` for file-bus heartbeats, `relay` for relay-forwarded ones. */
  origin?: FleetOrigin;
}

/** Minimal registered-agent shape this module reads. */
export interface RawAgentProfile {
  id: string;
  name?: string;
  role?: string;
  machine_id?: string;
  capabilities?: string[];
  /** Parent agent id when this is a spawned sub-agent. */
  parent_id?: string | null;
}

/** Minimal inbox message shape this module reads. */
export interface RawMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  timestamp: string;
  sprint?: number;
  task_id?: string;
  payload?: Record<string, unknown>;
  requires_response?: boolean;
  response_deadline?: string;
}

/** Per-message inbox state (subset of `InboxStateEntry`). */
export interface RawInboxState {
  msg_id: string;
  read_at: string | null;
  replied_at: string | null;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a short relative-age label.
 * Returns "now" for sub-5s ages and "—" for an unparseable input.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) { return '—'; }
  const deltaMs = now - t;
  if (deltaMs < 0) { return 'now'; }
  const s = Math.floor(deltaMs / 1000);
  if (s < 5) { return 'now'; }
  if (s < 60) { return `${s}s ago`; }
  const m = Math.floor(s / 60);
  if (m < 60) { return `${m}m ago`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return `${h}h ago`; }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// Cross-machine fleet (CF-1)
// ---------------------------------------------------------------------------

/** Default label for the machine this extension is running on. */
export const LOCAL_HOST = 'local';

/**
 * A heartbeat after origin/host resolution — every field present, ready to
 * key by (agent, host). Produced by `mergeFleetHeartbeats`.
 */
export interface ResolvedHeartbeat extends RawHeartbeat {
  host: string;
  origin: FleetOrigin;
}

/** Composite key that keeps the same agent_id on two machines distinct. */
export function fleetKey(agentId: string, host: string): string {
  return `${agentId}::${host}`;
}

export interface MergeFleetHeartbeatsOptions {
  /** Label applied to local heartbeats that don't carry their own host. */
  localHost?: string;
  /** Clock, for stale-relay age-out. */
  now?: number;
  /**
   * Relay agents whose last heartbeat is older than this age out of the
   * merged fleet — the same liveness window applied to local agents. `0`
   * (default) disables age-out (keep everything).
   */
  relayStaleMs?: number;
}

/**
 * Merge this machine's local heartbeats with relay-forwarded heartbeats from
 * other machines into a single de-duplicated fleet.
 *
 * Rules:
 *  - Local heartbeats are tagged `origin:'local'`, `host: localHost` (unless
 *    they already carry a host).
 *  - Relay heartbeats are tagged `origin:'relay'`, `host: hb.host ?? 'unknown'`.
 *  - De-dupe is by **(agent_id, host)** — the same agent on two machines is two
 *    rows; two heartbeats for the same agent+host collapse to the freshest.
 *  - When a local and a relay heartbeat collide on the same (agent, host),
 *    local wins on a tie and relay only wins if strictly fresher — the local
 *    file bus is the source of truth for this machine.
 *  - Relay rows older than `relayStaleMs` are dropped (stale remote agents age
 *    out just like local ones); local rows are never aged out here (the LMD
 *    health layer governs local liveness).
 *
 * Pure + deterministic given `now`. Result is sorted by agent_id then host.
 */
export function mergeFleetHeartbeats(
  local: RawHeartbeat[],
  relay: RawHeartbeat[],
  opts: MergeFleetHeartbeatsOptions = {}
): ResolvedHeartbeat[] {
  const localHost = opts.localHost ?? LOCAL_HOST;
  const now = opts.now ?? Date.now();
  const staleMs = opts.relayStaleMs ?? 0;

  const resolved: ResolvedHeartbeat[] = [];
  for (const hb of local) {
    resolved.push({ ...hb, origin: 'local', host: hb.host ?? localHost });
  }
  for (const hb of relay) {
    const host = hb.host ?? 'unknown';
    if (staleMs > 0) {
      const age = now - new Date(hb.timestamp).getTime();
      // Drop stale or unparseable-timestamp relay rows.
      if (!(age >= 0) || age > staleMs) { continue; }
    }
    resolved.push({ ...hb, origin: 'relay', host });
  }

  const byKey = new Map<string, ResolvedHeartbeat>();
  for (const hb of resolved) {
    const key = fleetKey(hb.agent_id, hb.host);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, hb); continue; }
    const prevT = new Date(prev.timestamp).getTime();
    const curT = new Date(hb.timestamp).getTime();
    // Freshest wins; on a tie, prefer a local origin over a relay one.
    if (curT > prevT || (curT === prevT && prev.origin === 'relay' && hb.origin === 'local')) {
      byKey.set(key, hb);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) => a.agent_id.localeCompare(b.agent_id) || a.host.localeCompare(b.host)
  );
}

// ---------------------------------------------------------------------------
// Health grid
// ---------------------------------------------------------------------------

/** Map an LMD `HealthState` to a traffic-light colour. */
export function healthColor(state: HealthState): HealthColor {
  switch (state) {
    case 'alive':    return 'green';
    case 'degraded': return 'amber';
    case 'stalled':  return 'red';
    case 'dead':     return 'red';
    default:         return 'amber';
  }
}

/**
 * Build the LMD health grid rows from `AgentHealth` snapshots.
 * Rows are sorted worst-health-first so problems surface at the top.
 */
export function buildHealthGrid(
  health: AgentHealth[],
  now: number = Date.now()
): HealthGridRow[] {
  const severity: Record<HealthState, number> = {
    dead: 0, stalled: 1, degraded: 2, alive: 3,
  };
  return health
    .map((h): HealthGridRow => ({
      agentId: h.agentId,
      state: h.state,
      color: healthColor(h.state),
      lastSeen: h.lastHeartbeatAt,
      lastSeenLabel: relativeAge(h.lastHeartbeatAt, now),
      queueDepth: h.queueDepth ?? 0,
      missedHeartbeats: h.missedHeartbeats,
    }))
    .sort((a, b) =>
      severity[a.state] - severity[b.state] || a.agentId.localeCompare(b.agentId)
    );
}

// ---------------------------------------------------------------------------
// Outbound message summaries
// ---------------------------------------------------------------------------

/** Derive a short one-line preview from a message payload. */
export function messagePreview(msg: RawMessage): string {
  const p = msg.payload ?? {};
  const candidate =
    (typeof p.message === 'string' && p.message) ||
    (typeof p.summary === 'string' && p.summary) ||
    (typeof p.text === 'string' && p.text) ||
    (typeof p.question === 'string' && p.question) ||
    (typeof p.title === 'string' && p.title) ||
    '';
  const flat = candidate.replace(/\s+/g, ' ').trim();
  if (flat) { return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat; }
  return `${msg.type} → ${msg.to}`;
}

/**
 * Build the last-N outbound message summaries for an agent, newest first.
 */
export function buildOutboundSummaries(
  messages: RawMessage[],
  agentId: string,
  limit = 5
): OutboundSummary[] {
  return messages
    .filter(m => m.from === agentId)
    .sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, limit)
    .map((m): OutboundSummary => ({
      id: m.id,
      to: m.to,
      type: m.type,
      timestamp: m.timestamp,
      preview: messagePreview(m),
    }));
}

// ---------------------------------------------------------------------------
// Agent identity cards
// ---------------------------------------------------------------------------

/** Derive a short avatar token from an agent id / name. */
export function avatarFor(agentId: string, name?: string): string {
  const source = (name ?? agentId).trim();
  if (!source) { return '?'; }
  const words = source.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** Inputs needed to build the full set of agent cards. */
export interface AgentCardInputs {
  /** All known agent profiles. */
  profiles: RawAgentProfile[];
  /** Latest heartbeat per agent id. */
  heartbeats: Map<string, RawHeartbeat>;
  /** Latest LMD health per agent id. */
  health: Map<string, AgentHealth>;
  /** All outbound messages observed (used for last-5 + claimed tasks). */
  messages: RawMessage[];
  /** Sprint assignments keyed by agent id ("<sprint>:<role>" strings). */
  sprintAssignments: Map<string, string[]>;
  /** Claimed-but-incomplete task ids keyed by agent id. */
  claimedTasks: Map<string, string[]>;
}

/** Build the click-to-expand detail block for one agent. */
export function buildAgentCardDetail(
  agentId: string,
  inputs: AgentCardInputs
): AgentCardDetail {
  return {
    claimedTasks: inputs.claimedTasks.get(agentId) ?? [],
    sprintAssignments: inputs.sprintAssignments.get(agentId) ?? [],
    lastOutbound: buildOutboundSummaries(inputs.messages, agentId, 5),
  };
}

/**
 * Build all agent identity cards.  Agents are sorted by health severity then
 * id so unhealthy agents surface first.
 */
export function buildAgentCards(
  inputs: AgentCardInputs,
  now: number = Date.now()
): AgentCard[] {
  const severity: Record<HealthState, number> = {
    dead: 0, stalled: 1, degraded: 2, alive: 3,
  };
  return inputs.profiles
    .map((p): AgentCard => {
      const hb = inputs.heartbeats.get(p.id);
      const h = inputs.health.get(p.id);
      const state: HealthState = h?.state ?? 'alive';
      const lastHb = hb?.timestamp ?? h?.lastHeartbeatAt ?? '';
      // CF-1: a relay-forwarded heartbeat carries its own host + origin; those
      // win over the profile's machine_id. Absent a relay heartbeat the card
      // is a local one (origin 'local'), preserving the single-host path.
      const origin: FleetOrigin = hb?.origin ?? 'local';
      const host = hb?.host ?? p.machine_id ?? LOCAL_HOST;
      return {
        agentId: p.id,
        name: p.name ?? p.id,
        avatar: avatarFor(p.id, p.name),
        role: p.role ?? '',
        host,
        origin,
        isRemote: origin === 'relay',
        currentTask: (hb?.current_task ?? null) || null,
        lastHeartbeat: lastHb,
        lastHeartbeatLabel: lastHb ? relativeAge(lastHb, now) : '—',
        capabilities: p.capabilities ?? [],
        color: healthColor(state),
        state,
        parentId: p.parent_id ?? null,
        detail: buildAgentCardDetail(p.id, inputs),
      };
    })
    .sort((a, b) =>
      severity[a.state] - severity[b.state] || a.agentId.localeCompare(b.agentId)
    );
}

// ---------------------------------------------------------------------------
// Parent → subagent tree
// ---------------------------------------------------------------------------

/**
 * Build the parent→subagent forest from a flat list of cards.
 *
 * Roots are cards with no `parentId` (or whose parent is unknown — orphans are
 * promoted to roots so nothing is silently dropped). Cycles are broken by
 * tracking visited ids.
 */
export function buildAgentTree(cards: AgentCard[]): AgentTreeNode[] {
  const byId = new Map<string, AgentCard>();
  for (const c of cards) { byId.set(c.agentId, c); }

  const childrenOf = new Map<string, AgentCard[]>();
  const roots: AgentCard[] = [];
  for (const c of cards) {
    if (c.parentId && byId.has(c.parentId) && c.parentId !== c.agentId) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c);
      childrenOf.set(c.parentId, list);
    } else {
      roots.push(c);
    }
  }

  const toNode = (c: AgentCard, visited: Set<string>): AgentTreeNode => {
    visited.add(c.agentId);
    const kids = (childrenOf.get(c.agentId) ?? [])
      .filter(k => !visited.has(k.agentId))
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map(k => toNode(k, visited));
    return {
      agentId: c.agentId,
      name: c.name,
      avatar: c.avatar,
      color: c.color,
      currentTask: c.currentTask,
      children: kids,
    };
  };

  const visited = new Set<string>();
  return roots
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map(r => toNode(r, visited));
}

// ---------------------------------------------------------------------------
// Awaiting You
// ---------------------------------------------------------------------------

/**
 * Build the "Awaiting You" list:  messages where
 * `to == selfAgentId ∧ requires_response ∧ replied_at == null` and not archived.
 *
 * `states` maps `msg.id` → its inbox state; a missing entry means unread /
 * unreplied (backwards-compatible with the inbox state machine).
 */
export function buildAwaitingYou(
  messages: RawMessage[],
  selfAgentId: string,
  states: Map<string, RawInboxState>,
  now: number = Date.now()
): AwaitingItem[] {
  return messages
    .filter(m => {
      if (m.to !== selfAgentId) { return false; }
      if (!m.requires_response) { return false; }
      const st = states.get(m.id);
      if (st?.archived_at) { return false; }
      if (st?.replied_at) { return false; }
      return true;
    })
    .map((m): AwaitingItem => {
      const deadline = m.response_deadline ?? null;
      const overdue =
        deadline !== null && new Date(deadline).getTime() < now;
      return {
        id: m.id,
        from: m.from,
        type: m.type,
        timestamp: m.timestamp,
        preview: messagePreview(m),
        deadline,
        overdue,
      };
    })
    .sort((a, b) => {
      // Overdue first, then oldest first.
      if (a.overdue !== b.overdue) { return a.overdue ? -1 : 1; }
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

/** Map a comms message type to an activity-feed kind. */
export function activityKindForMessage(type: string): ActivityKind {
  switch (type) {
    case 'task_claim':       return 'task_started';
    case 'task_assignment':  return 'task_started';
    case 'task_complete':    return 'task_complete';
    case 'finding_report':   return 'finding_raised';
    case 'consensus_result': return 'consensus_passed';
    case 'review_request':   return 'review_requested';
    default:                 return 'message';
  }
}

/** Human-readable description for an activity event. */
function activityText(msg: RawMessage, kind: ActivityKind): string {
  const task = msg.task_id ? ` ${msg.task_id}` : '';
  switch (kind) {
    case 'task_started':
      return `${msg.from} started task${task}`;
    case 'task_complete':
      return `${msg.from} completed task${task}`;
    case 'finding_raised':
      return `${msg.from} raised a finding: ${messagePreview(msg)}`;
    case 'consensus_passed': {
      const passed = (msg.payload?.result ?? msg.payload?.outcome) === 'passed';
      return `Consensus ${passed ? 'passed' : 'resolved'}${task} (${msg.from})`;
    }
    case 'review_requested':
      return `${msg.from} requested review${task}`;
    default:
      return `${msg.from} → ${msg.to}: ${messagePreview(msg)}`;
  }
}

/**
 * Build the activity feed from observed messages plus optional synthetic
 * health events (e.g. agent died). Newest first, capped at `limit`.
 */
export function buildActivityFeed(
  messages: RawMessage[],
  healthEvents: Array<{ agentId: string; kind: ActivityKind; timestamp: string; text: string }> = [],
  now: number = Date.now(),
  limit = 50
): ActivityEvent[] {
  const fromMessages: ActivityEvent[] = messages.map(m => {
    const kind = activityKindForMessage(m.type);
    return {
      id: m.id,
      kind,
      agentId: m.from,
      timestamp: m.timestamp,
      timeLabel: relativeAge(m.timestamp, now),
      text: activityText(m, kind),
    };
  });

  const fromHealth: ActivityEvent[] = healthEvents.map((e, i) => ({
    id: `health-${e.agentId}-${e.timestamp}-${i}`,
    kind: e.kind,
    agentId: e.agentId,
    timestamp: e.timestamp,
    timeLabel: relativeAge(e.timestamp, now),
    text: e.text,
  }));

  return [...fromMessages, ...fromHealth]
    .sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/**
 * Roll up cost-ledger entries into per-agent totals plus a recent-rationale
 * rail.  Per-agent rows are sorted by total tokens descending.
 */
export function buildCostLedger(
  entries: CostLedgerEntry[],
  rationaleLimit = 8
): CostLedgerView {
  const byAgent = new Map<string, CostRollupRow>();
  let totalTokens = 0;
  let totalWallMs = 0;

  for (const e of entries) {
    totalTokens += e.tokens;
    totalWallMs += e.wallMs;
    const row = byAgent.get(e.agentId) ?? {
      agentId: e.agentId,
      totalTokens: 0,
      totalWallMs: 0,
      actionCount: 0,
    };
    row.totalTokens += e.tokens;
    row.totalWallMs += e.wallMs;
    row.actionCount += 1;
    byAgent.set(e.agentId, row);
  }

  const recentRationales = [...entries]
    .filter(e => e.because && e.because.trim().length > 0)
    .sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, rationaleLimit)
    .map(e => ({
      agentId: e.agentId,
      because: e.because.trim(),
      timestamp: e.timestamp,
    }));

  return {
    perAgent: Array.from(byAgent.values()).sort(
      (a, b) => b.totalTokens - a.totalTokens
    ),
    totalTokens,
    totalWallMs,
    recentRationales,
  };
}

// ---------------------------------------------------------------------------
// Status-bar presence
// ---------------------------------------------------------------------------

/**
 * Build the compact presence summary shown in the VS Code status bar.
 *
 * - `working`     = agents that are `alive` AND have a non-null current task.
 * - `needsReview` = distinct agents that have ≥1 message awaiting their reply.
 * - `down`        = agents that are `stalled` or `dead`.
 */
export function buildPresence(
  cards: AgentCard[],
  awaitingByAgent: Map<string, AwaitingItem[]>
): PresenceSummary {
  let working = 0;
  let down = 0;
  for (const c of cards) {
    if (c.state === 'stalled' || c.state === 'dead') {
      down += 1;
    } else if (c.state === 'alive' && c.currentTask) {
      working += 1;
    }
  }
  let needsReview = 0;
  for (const list of awaitingByAgent.values()) {
    if (list.length > 0) { needsReview += 1; }
  }

  const parts: string[] = [];
  parts.push(`${working} agent${working === 1 ? '' : 's'} working`);
  if (needsReview > 0) {
    parts.push(`${needsReview} need${needsReview === 1 ? 's' : ''} review`);
  }
  if (down > 0) {
    parts.push(`${down} down`);
  }

  return {
    working,
    needsReview,
    down,
    total: cards.length,
    text: parts.join(', '),
  };
}

// ---------------------------------------------------------------------------
// Top-level assembly
// ---------------------------------------------------------------------------

/** Everything `buildFleetDashboard` needs, gathered by the I/O layer. */
export interface FleetDashboardInputs {
  selfAgentId: string;
  cardInputs: AgentCardInputs;
  /** All messages observed (inbox + outbox + processed). */
  allMessages: RawMessage[];
  /** Inbox states for the *self* agent, keyed by msg id. */
  selfInboxStates: Map<string, RawInboxState>;
  /** Inbox states grouped per agent, for the presence "needs review" count. */
  inboxStatesByAgent: Map<string, Map<string, RawInboxState>>;
  /** Messages addressed to each agent, for per-agent awaiting computation. */
  messagesByRecipient: Map<string, RawMessage[]>;
  health: AgentHealth[];
  cost: CostLedgerEntry[];
  /** Synthetic health-derived activity events (agent died, recovered, …). */
  healthEvents?: Array<{ agentId: string; kind: ActivityKind; timestamp: string; text: string }>;
}

/**
 * Assemble the complete `FleetDashboardModel` from gathered inputs.
 *
 * This is the single pure entry point the panel calls after `fleetData.ts`
 * has done all the file reading.  Fully deterministic given `now`.
 */
export function buildFleetDashboard(
  inputs: FleetDashboardInputs,
  now: number = Date.now()
): FleetDashboardModel {
  const cards = buildAgentCards(inputs.cardInputs, now);
  const tree = buildAgentTree(cards);

  const awaitingYou = buildAwaitingYou(
    inputs.messagesByRecipient.get(inputs.selfAgentId) ?? inputs.allMessages,
    inputs.selfAgentId,
    inputs.selfInboxStates,
    now
  );

  // Per-agent awaiting counts for the presence summary.
  const awaitingByAgent = new Map<string, AwaitingItem[]>();
  for (const card of cards) {
    const msgs = inputs.messagesByRecipient.get(card.agentId) ?? [];
    const states = inputs.inboxStatesByAgent.get(card.agentId) ?? new Map();
    awaitingByAgent.set(
      card.agentId,
      buildAwaitingYou(msgs, card.agentId, states, now)
    );
  }

  return {
    generatedAt: new Date(now).toISOString(),
    selfAgentId: inputs.selfAgentId,
    cards,
    tree,
    awaitingYou,
    activity: buildActivityFeed(inputs.allMessages, inputs.healthEvents ?? [], now),
    healthGrid: buildHealthGrid(inputs.health, now),
    cost: buildCostLedger(inputs.cost),
    presence: buildPresence(cards, awaitingByAgent),
  };
}
