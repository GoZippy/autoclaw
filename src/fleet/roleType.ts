/**
 * roleType.ts — the forward `role → agent_type` derivation map.
 *
 * AutoClaw asks a joining agent for two things that sound alike but are not:
 *
 *  - `role`       (13 values, src/roles.ts) — the ORGANIZATIONAL / display facet:
 *                 the hat the agent wears on the team board, with glyph + colour,
 *                 used by the panel to group and count.
 *  - `agent_type` (6 values, src/fabric/agentTypes.ts) — the BEHAVIOURAL / policy
 *                 facet: how the orchestrator treats the agent's output, carrying
 *                 defaultTrust, consensusRule, humanInLoop, canOrchestrate.
 *
 * The two overlap heavily (a `reviewer` and a `security` analyst are two ROLES but
 * the same TYPE — `auditor`). The relationship is a near-total FUNCTION
 * role → type, so we should ask the user only for the richer `role` and DERIVE the
 * type. `roles.ts` already carries the *inverse* (ROLE_SYNONYMS maps each type word
 * back to a role); this module is the forward half, the single source of truth for
 * "given a role, what behavioural type does it default to".
 *
 * The map is intentionally MANY-TO-ONE (reviewer and security both → auditor), so
 * it is NOT invertible — do not assert a bijective round-trip against ROLE_SYNONYMS.
 *
 * Pure module: no fs / vscode imports.
 */

import type { CanonicalRole } from '../roles';
import { normalizeRole } from '../roles';
import type { AgentType } from '../fabric/agentTypes';

/**
 * The forward derivation. For each canonical role, the behavioural `agent_type`
 * it defaults to. A few roles have a legitimate ALTERNATE the user may pick in the
 * Advanced override (documented in {@link ROLE_TYPE_OVERRIDES}); this table is the
 * default the wizard pre-selects.
 *
 *   orchestrator → supervisor   (coordinates + dispatches others; canOrchestrate)
 *   architect    → coder        (designs AND edits the repo)
 *   product      → governance   (sets requirements / approves)
 *   coder        → coder
 *   reviewer     → auditor       (read-only, gates merges, unanimous)
 *   security     → auditor       (read-only, security-tier unanimous)
 *   tester       → coder        (writes + runs tests)
 *   designer     → coder        (edits UI files)
 *   creative     → assistant    (drafts copy; human-in-loop)
 *   docs         → coder        (writes doc files)
 *   researcher   → runner       (one job, returns findings, no session)
 *   ops          → runner       (runs a job, returns a result)
 *   generalist   → assistant    (safe helper default)
 */
export const ROLE_TO_AGENT_TYPE: Readonly<Record<CanonicalRole, AgentType>> = {
  orchestrator: 'supervisor',
  architect: 'coder',
  product: 'governance',
  coder: 'coder',
  reviewer: 'auditor',
  security: 'auditor',
  tester: 'coder',
  designer: 'coder',
  creative: 'assistant',
  docs: 'coder',
  researcher: 'runner',
  ops: 'runner',
  generalist: 'assistant',
};

/**
 * The legitimate alternate types for the roles whose default isn't the only
 * sensible choice. Surfaced as the "Advanced: change behavioral type" hint so a
 * divergence is a declared, explained override — never a silent contradiction.
 * Every role's default (from {@link ROLE_TO_AGENT_TYPE}) is listed first.
 */
export const ROLE_TYPE_ALTERNATES: Readonly<Partial<Record<CanonicalRole, readonly AgentType[]>>> = {
  product: ['governance', 'assistant'], // approves vs draft-only
  docs: ['coder', 'assistant'],         // commits vs draft-only
  tester: ['coder', 'runner'],          // edits tests vs result-only
  researcher: ['runner', 'assistant'],  // result-only vs conversational
  architect: ['coder', 'supervisor'],   // edits vs dispatches
};

/** Derive the behavioural agent_type for a CANONICAL role. Total — never throws. */
export function agentTypeForRole(role: CanonicalRole): AgentType {
  return ROLE_TO_AGENT_TYPE[role];
}

/**
 * Derive the behavioural agent_type for a FREE-FORM role string (e.g. an invite's
 * `suggested_role`, which may be any string). Normalises to a canonical role first,
 * then maps. Unknown / empty input → `assistant` (the safe, human-in-loop default,
 * matching generalist). This is what the renderer uses when a caller supplies a
 * role but not an explicit agent_type, so the beacon never collapses the two.
 */
export function deriveAgentType(rawRole: string | null | undefined): AgentType {
  return ROLE_TO_AGENT_TYPE[normalizeRole(rawRole)];
}
