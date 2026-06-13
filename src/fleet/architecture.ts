/**
 * architecture.ts — user-authoritative fleet architecture resolver.
 *
 * Answers "who is the orchestrator, who is a runner, who is a worker, and what
 * role is each agent playing?" with the USER in ultimate control. A project's
 * `.autoclaw/orchestrator/fleet.json` manifest (hand-editable, git-trackable)
 * overrides every auto-detected/inferred signal. See docs/FLEET_ARCHITECTURE.md.
 *
 * Pure module: no fs / vscode imports. The extension reads fleet.json + the
 * settings override + the board and passes them in; this module decides.
 */

import {
  type CanonicalRole, ROLE_META, normalizeRole, resolveAgentRole,
} from '../roles';

/** Behavioral worker types (mirrors src/fabric/agentTypes.ts AgentType). Kept
 *  as a string here so this module stays decoupled from the fabric profile. */
export type FleetAgentType =
  | 'coder' | 'runner' | 'auditor' | 'supervisor' | 'assistant' | 'governance';

const KNOWN_TYPES: ReadonlySet<string> = new Set<FleetAgentType>([
  'coder', 'runner', 'auditor', 'supervisor', 'assistant', 'governance',
]);

/** One agent's declared architecture in fleet.json. */
export interface FleetAgentDecl {
  /** Canonical role OR a custom free-form label (shown as a neutral chip). */
  role?: string;
  /** Behavioral type override. Unknown values degrade to 'coder' behavior. */
  agent_type?: string;
  /** Org-chart edge: the agent id this one reports to. */
  reports_to?: string;
}

/** `.autoclaw/orchestrator/fleet.json` document. */
export interface FleetManifest {
  schema_version?: string;
  /** The single coordinator. Authoritative over state.json governance.primary. */
  orchestrator?: string;
  agents?: Record<string, FleetAgentDecl>;
}

/** A resolved role: either a canonical role or a user-defined custom label. */
export interface ResolvedRole {
  /** The canonical role used for color/grouping; 'generalist' for custom. */
  canonical: CanonicalRole;
  /** Display label — the canonical label, or the user's custom string. */
  label: string;
  /** True when the user supplied a label outside the canonical taxonomy. */
  custom: boolean;
  /** CSS class for coloring (canonical class, or the neutral custom class). */
  cssClass: string;
}

/** Loose per-agent signal the resolver reads (everything optional). */
export interface AgentSignal {
  id: string;
  role?: string | null;
  agent_type?: string | null;
  can_orchestrate?: boolean;
}

/** Inputs to a full resolve. */
export interface ResolveInput {
  /** Parsed fleet.json (or null when absent). */
  manifest: FleetManifest | null;
  /** Per-user `autoclaw.agentRoles` override (agentId → role string). */
  settingRoles?: Record<string, string>;
  /** state.json governance.primary.agent_id, if any. */
  governancePrimary?: string | null;
  /**
   * Fallback role inferer from live activity (e.g. the board). Called only when
   * no declared/registry signal exists. Returns a CanonicalRole.
   */
  inferRole?: (agentId: string) => CanonicalRole;
}

/** True when `raw` normalizes to a known canonical role (not a custom label). */
function isCanonicalRoleString(raw: string): boolean {
  // A string is "canonical" when normalizeRole maps it to something other than
  // generalist, OR it literally is "generalist".
  const n = normalizeRole(raw);
  return n !== 'generalist' || raw.trim().toLowerCase() === 'generalist';
}

/** Build a ResolvedRole from a free-form string (canonical or custom). */
export function toResolvedRole(raw: string | null | undefined): ResolvedRole {
  const s = (raw ?? '').trim();
  if (s.length === 0) {
    const m = ROLE_META.generalist;
    return { canonical: 'generalist', label: m.label, custom: false, cssClass: m.cssClass };
  }
  if (isCanonicalRoleString(s)) {
    const canonical = normalizeRole(s);
    const m = ROLE_META[canonical];
    return { canonical, label: m.label, custom: false, cssClass: m.cssClass };
  }
  // Custom user label — keep the user's text, color it neutrally.
  return { canonical: 'generalist', label: s, custom: true, cssClass: 'role-custom' };
}

/**
 * Resolve one agent's display role with full precedence:
 *   fleet.json → settings override → registry role/agent_type/can_orchestrate
 *   → activity inference → generalist.
 * Custom (non-canonical) labels are preserved.
 */
export function resolveRole(agent: AgentSignal, input: ResolveInput): ResolvedRole {
  const decl = input.manifest?.agents?.[agent.id];
  if (decl?.role && decl.role.trim().length > 0) {
    return toResolvedRole(decl.role);
  }
  const setting = input.settingRoles?.[agent.id];
  if (setting && setting.trim().length > 0) {
    return toResolvedRole(setting);
  }
  const fromRegistry = resolveAgentRole({
    role: agent.role, agent_type: agent.agent_type, can_orchestrate: agent.can_orchestrate,
  });
  if (fromRegistry !== 'generalist') {
    return toResolvedRole(fromRegistry);
  }
  if (input.inferRole) {
    const inferred = input.inferRole(agent.id);
    if (inferred !== 'generalist') { return toResolvedRole(inferred); }
  }
  return toResolvedRole('generalist');
}

/**
 * Resolve one agent's behavioral type:
 *   fleet.json → registry agent_type → 'coder'.
 * Unknown declared types are returned verbatim (caller maps to a profile that
 * degrades to coder behavior).
 */
export function resolveType(agent: AgentSignal, manifest: FleetManifest | null): FleetAgentType {
  const declared = manifest?.agents?.[agent.id]?.agent_type;
  if (declared && declared.trim().length > 0) {
    return KNOWN_TYPES.has(declared) ? (declared as FleetAgentType) : 'coder';
  }
  if (agent.agent_type && KNOWN_TYPES.has(agent.agent_type)) {
    return agent.agent_type as FleetAgentType;
  }
  return 'coder';
}

/**
 * Designate the single fleet orchestrator:
 *   fleet.json.orchestrator → governance.primary → first can_orchestrate → null.
 * Only returns an id that is actually present in `agents` (so a stale manifest
 * entry for a departed agent doesn't crown a ghost).
 */
export function resolveOrchestrator(
  agents: readonly AgentSignal[],
  input: { manifest: FleetManifest | null; governancePrimary?: string | null },
): string | null {
  const present = new Set(agents.map(a => a.id));
  const declared = input.manifest?.orchestrator;
  if (declared && present.has(declared)) { return declared; }
  if (input.governancePrimary && present.has(input.governancePrimary)) {
    return input.governancePrimary;
  }
  const canOrch = agents.find(a => a.can_orchestrate);
  return canOrch ? canOrch.id : null;
}

/**
 * Convenience: resolve roles for the whole fleet at once. The designated
 * orchestrator is forced to the 'orchestrator' role even if it would otherwise
 * resolve lower (so the coordinator always reads as such), unless the user gave
 * it an explicit custom label in the manifest.
 */
export function resolveFleet(
  agents: readonly AgentSignal[],
  input: ResolveInput,
): { roles: Record<string, ResolvedRole>; orchestrator: string | null } {
  const orchestrator = resolveOrchestrator(agents, input);
  const roles: Record<string, ResolvedRole> = {};
  for (const a of agents) {
    let r = resolveRole(a, input);
    const hasExplicitDecl = !!input.manifest?.agents?.[a.id]?.role
      || !!input.settingRoles?.[a.id];
    if (a.id === orchestrator && !hasExplicitDecl && r.canonical !== 'orchestrator') {
      r = toResolvedRole('orchestrator');
    }
    roles[a.id] = r;
  }
  return { roles, orchestrator };
}

/** Parse a fleet.json string defensively. Returns null on any problem. */
export function parseFleetManifest(raw: string): FleetManifest | null {
  try {
    const obj = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!obj || typeof obj !== 'object') { return null; }
    const m = obj as FleetManifest;
    if (m.agents && typeof m.agents !== 'object') { return null; }
    return m;
  } catch {
    return null;
  }
}
