/**
 * fleetViewModel.ts — View-model types for the AutoClaw Fleet dashboard.
 *
 * These are the *render-ready* shapes consumed by the webview (media/panel/
 * fleet.js).  They are intentionally decoupled from the raw on-disk shapes
 * (`Heartbeat`, `InboxMessage`, `AgentHealth`, …) so the webview never has to
 * know about file layout or comms internals.
 *
 * Pure types only — zero runtime cost, no imports of `vscode`. The pure
 * builders that produce these live in `fleetViewModelBuilders.ts` and are
 * unit-testable without a VS Code host.
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */

import type { HealthState } from '../lmd/types';

// ---------------------------------------------------------------------------
// Health grid
// ---------------------------------------------------------------------------

/** Coarse traffic-light colour derived from the LMD `HealthState`. */
export type HealthColor = 'green' | 'amber' | 'red';

/** One row of the LMD health grid (one per tracked agent). */
export interface HealthGridRow {
  agentId: string;
  /** Raw LMD health state. */
  state: HealthState;
  /** Traffic-light colour for the UI. */
  color: HealthColor;
  /** ISO timestamp of the last heartbeat seen for this agent. */
  lastSeen: string;
  /** Human-readable relative age, e.g. "12s ago", "3m ago". */
  lastSeenLabel: string;
  /** Queue depth reported on the last heartbeat (unread + claimed tasks). */
  queueDepth: number;
  /** Consecutive missed heartbeats. */
  missedHeartbeats: number;
}

// ---------------------------------------------------------------------------
// Agent identity card
// ---------------------------------------------------------------------------

/** A single recent outbound message summary shown in the expanded card. */
export interface OutboundSummary {
  id: string;
  to: string;
  type: string;
  timestamp: string;
  /** Short one-line preview derived from the payload. */
  preview: string;
}

/** Click-to-expand detail block for an agent card. */
export interface AgentCardDetail {
  /** Task IDs the agent has claimed but not completed. */
  claimedTasks: string[];
  /** Sprint assignments for this agent, "<sprint>:<role>" form. */
  sprintAssignments: string[];
  /** The agent's last 5 outbound messages, newest first. */
  lastOutbound: OutboundSummary[];
}

/** Identity card for one agent in the fleet. */
export interface AgentCard {
  agentId: string;
  /** Display name (falls back to agentId). */
  name: string;
  /** Single-glyph or short avatar token (emoji / initials). */
  avatar: string;
  /** Role string, e.g. "Fleet Panel Dashboard & UI". */
  role: string;
  /** Host machine identifier (machine_id, falls back to "local"). */
  host: string;
  /** What the agent is working on right now, or null when idle. */
  currentTask: string | null;
  /** ISO timestamp of the last heartbeat. */
  lastHeartbeat: string;
  /** Relative age label for the last heartbeat. */
  lastHeartbeatLabel: string;
  /** Coarse capability tags. */
  capabilities: string[];
  /** Health colour mirrored from the health grid. */
  color: HealthColor;
  /** Health state mirrored from the LMD. */
  state: HealthState;
  /** Parent agent id, or null for a root agent. */
  parentId: string | null;
  /** Click-to-expand detail. */
  detail: AgentCardDetail;
}

// ---------------------------------------------------------------------------
// Parent → subagent tree
// ---------------------------------------------------------------------------

/** One node in the parent→subagent tree. */
export interface AgentTreeNode {
  agentId: string;
  name: string;
  avatar: string;
  color: HealthColor;
  currentTask: string | null;
  children: AgentTreeNode[];
}

// ---------------------------------------------------------------------------
// Awaiting You
// ---------------------------------------------------------------------------

/** A message awaiting the current agent's response. */
export interface AwaitingItem {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  /** One-line preview of the message. */
  preview: string;
  /** ISO deadline, when the message carries one. */
  deadline: string | null;
  /** True when `deadline` is in the past. */
  overdue: boolean;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export type ActivityKind =
  | 'task_started'
  | 'task_complete'
  | 'finding_raised'
  | 'consensus_passed'
  | 'consensus_failed'
  | 'agent_died'
  | 'review_requested'
  | 'message';

/** One event in the real-time activity feed. */
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  /** Agent that produced the event. */
  agentId: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Relative age label. */
  timeLabel: string;
  /** Human-readable single-line description. */
  text: string;
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/** A single cost-ledger entry as written by an agent action. */
export interface CostLedgerEntry {
  agentId: string;
  /** Token count for the action. */
  tokens: number;
  /** Wall-clock milliseconds for the action. */
  wallMs: number;
  /** The `because:` rationale recorded for the action. */
  because: string;
  taskId?: string;
  sprint?: number;
  timestamp: string;
}

/** Per-agent cost rollup. */
export interface CostRollupRow {
  agentId: string;
  totalTokens: number;
  totalWallMs: number;
  /** Number of ledger entries rolled into this row. */
  actionCount: number;
}

/** Full cost-ledger rollup view. */
export interface CostLedgerView {
  perAgent: CostRollupRow[];
  totalTokens: number;
  totalWallMs: number;
  /** Most recent rationale strings (newest first), for the "because" rail. */
  recentRationales: Array<{ agentId: string; because: string; timestamp: string }>;
}

// ---------------------------------------------------------------------------
// Status-bar presence
// ---------------------------------------------------------------------------

/** Compact presence summary for the VS Code status bar. */
export interface PresenceSummary {
  /** Count of agents in a working (alive + has current task) state. */
  working: number;
  /** Count of agents with at least one message awaiting their reply. */
  needsReview: number;
  /** Count of agents that are stalled or dead. */
  down: number;
  /** Total tracked agents. */
  total: number;
  /** Pre-formatted status-bar text, e.g. "3 agents working, 1 needs review". */
  text: string;
}

// ---------------------------------------------------------------------------
// Top-level dashboard view-model
// ---------------------------------------------------------------------------

/** The complete render payload sent to the webview on each refresh. */
export interface FleetDashboardModel {
  /** ISO timestamp the model was built. */
  generatedAt: string;
  /** The agent id this panel is rendering "for" (drives Awaiting You). */
  selfAgentId: string;
  cards: AgentCard[];
  tree: AgentTreeNode[];
  awaitingYou: AwaitingItem[];
  activity: ActivityEvent[];
  healthGrid: HealthGridRow[];
  cost: CostLedgerView;
  presence: PresenceSummary;
}
