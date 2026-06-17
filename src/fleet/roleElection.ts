/**
 * roleElection.ts — self-aware role election on arrival (SA-2).
 *
 * Pure scoring + assignment functions an arriving agent uses to self-elect the
 * role the project is short on. It consumes the SA-1 needs vector (needs.ts) and
 * the joining agent's own Agent Card, scores each unmet need against the agent's
 * capabilities (`score = capability_match × idle × trust / cost` — the same
 * scorer shape the router uses), and picks the best fit. A crowd of arrivals can
 * self-distribute via {@link distributeRoles}; a looping agent can re-role via
 * {@link shouldReRole} when its lane drains and a better gap opens.
 *
 * Everything here is a pure function over plain objects: no fs, no vscode, no
 * clock, no randomness — same inputs → same output (fully unit-testable).
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §4.2 (election on arrival) and
 * §4.3 (re-election over time).
 */

import type { NeedsVector, PlannedLane } from './needs';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The joining agent's self-description (a slice of its Agent Card / résumé).
 * `idle`/`trust` are 0..1 (default 1 = fully available / fully trusted);
 * `cost` is > 0 (default 1). A cost ≤ 0 is treated as 1 to keep scores finite.
 */
export interface AgentCard {
  agent_id: string;
  /** Concrete capabilities the agent has (matched against required_capabilities). */
  skills?: string[];
  /** Roles the agent is willing/able to play (e.g. ['coder', 'tester']). */
  roles_can_play?: string[];
  /** Availability 0..1. Default 1. */
  idle?: number;
  /** Trust 0..1. Default 1. */
  trust?: number;
  /** Cost weight > 0. Default 1. */
  cost?: number;
}

/** A single need derived from the needs vector that an agent could fill. */
export interface RoleNeed {
  role: string;
  /** The open lane this need came from, if any (a bare coverage gap has none). */
  lane?: string;
  required_capabilities: string[];
}

/** The outcome of electing a role for one agent. */
export interface ElectedRole {
  role: string;
  lane?: string;
  score: number;
}

/** A {@link distributeRoles} assignment row. */
export interface RoleAssignment extends ElectedRole {
  agent_id: string;
}

// ---------------------------------------------------------------------------
// Needs → role needs
// ---------------------------------------------------------------------------

/**
 * Flatten the needs vector into the discrete role needs an arriving agent can
 * bid on. Each open lane that wants a role becomes a need carrying that lane's
 * required capabilities; each role_coverage_gap entry not already represented by
 * an open lane becomes a bare need (no lane, no required capabilities).
 *
 * Deduped by role (case-insensitive): an open-lane entry wins over a bare gap
 * entry, so a need that has a concrete lane + capabilities is preferred.
 */
export function needsToRoleNeeds(needs: NeedsVector): RoleNeed[] {
  const byRole = new Map<string, RoleNeed>();

  for (const lane of needs.open_lanes ?? []) {
    const role = (lane as PlannedLane).role;
    if (!role) { continue; }
    const key = role.toLowerCase();
    // First open-lane entry for a role wins (stable, deterministic).
    if (!byRole.has(key)) {
      byRole.set(key, {
        role,
        lane: lane.lane,
        required_capabilities: lane.required_capabilities ?? [],
      });
    }
  }

  for (const gapRole of needs.role_coverage_gap ?? []) {
    if (!gapRole) { continue; }
    const key = gapRole.toLowerCase();
    // Open-lane entry wins over a bare gap entry.
    if (!byRole.has(key)) {
      byRole.set(key, { role: gapRole, required_capabilities: [] });
    }
  }

  return [...byRole.values()];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function canPlay(card: AgentCard, role: string): boolean {
  const target = role.toLowerCase();
  return (card.roles_can_play ?? []).some(r => r.toLowerCase() === target);
}

/**
 * Capability match in [0, 1] for an agent against one need.
 *
 * - No required capabilities: 0.5 baseline if the agent can play the role,
 *   else 0.25 (it could still help, weakly).
 * - With required capabilities: fraction of required caps present in the agent's
 *   skills, plus a +0.25 can-play bonus (capped at 1).
 */
function capabilityMatch(need: RoleNeed, card: AgentCard): number {
  const playable = canPlay(card, need.role);
  const required = need.required_capabilities ?? [];

  if (required.length === 0) {
    return playable ? 0.5 : 0.25;
  }

  const skills = new Set((card.skills ?? []).map(s => s.toLowerCase()));
  const have = required.filter(c => skills.has(c.toLowerCase())).length;
  const fraction = have / required.length;
  const bonus = playable ? 0.25 : 0;
  return Math.min(1, fraction + bonus);
}

/**
 * Score how well an agent fits a need: `capability_match × idle × trust / cost`.
 * idle/trust default to 1, cost defaults to 1 (and a non-positive cost is
 * treated as 1). A need the agent cannot help with at all — zero capability
 * match and unable to play the role — scores 0.
 */
export function scoreNeed(need: RoleNeed, card: AgentCard): number {
  const match = capabilityMatch(need, card);
  // No usable capability and can't play the role → no fit at all.
  if (match <= 0 && !canPlay(card, need.role)) { return 0; }

  const idle = card.idle ?? 1;
  const trust = card.trust ?? 1;
  const rawCost = card.cost ?? 1;
  const cost = rawCost > 0 ? rawCost : 1;

  return (match * idle * trust) / cost;
}

// ---------------------------------------------------------------------------
// Election
// ---------------------------------------------------------------------------

/**
 * Elect the single best-fit unmet need for one agent: the highest positive
 * score over all role needs. Returns null when nothing fits (no positive score).
 * Deterministic tie-break: by role (ascending) among equal scores.
 */
export function electRole(needs: NeedsVector, card: AgentCard): ElectedRole | null {
  const roleNeeds = needsToRoleNeeds(needs);

  let best: ElectedRole | null = null;
  for (const need of roleNeeds) {
    const score = scoreNeed(need, card);
    if (score <= 0) { continue; }
    if (
      best === null ||
      score > best.score ||
      (score === best.score && need.role.localeCompare(best.role) < 0)
    ) {
      best = { role: need.role, ...(need.lane ? { lane: need.lane } : {}), score };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Distribution (crowd of arrivals self-distributes)
// ---------------------------------------------------------------------------

/**
 * Greedily assign roles so multiple arriving agents self-distribute across needs
 * instead of dogpiling one lane. Repeatedly picks the highest (card, need) score
 * over all still-unassigned cards and still-unclaimed needs, assigns it, removes
 * both from the pool, and continues until no positive score remains. Each agent
 * gets at most one role; each need at most one agent.
 *
 * Deterministic tie-break: by agent_id (ascending), then role (ascending).
 */
export function distributeRoles(needs: NeedsVector, cards: AgentCard[]): RoleAssignment[] {
  const roleNeeds = needsToRoleNeeds(needs);
  const remainingCards = [...cards];
  const remainingNeeds = [...roleNeeds];
  const assignments: RoleAssignment[] = [];

  // Each pass picks the single globally-best (card, need) pair.
  while (remainingCards.length > 0 && remainingNeeds.length > 0) {
    let pick: { cardIdx: number; needIdx: number; score: number; assignment: RoleAssignment } | null = null;

    for (let ci = 0; ci < remainingCards.length; ci++) {
      const card = remainingCards[ci];
      for (let ni = 0; ni < remainingNeeds.length; ni++) {
        const need = remainingNeeds[ni];
        const score = scoreNeed(need, card);
        if (score <= 0) { continue; }

        if (pick === null || isBetterPick(score, card, need, pick)) {
          pick = {
            cardIdx: ci,
            needIdx: ni,
            score,
            assignment: {
              agent_id: card.agent_id,
              role: need.role,
              ...(need.lane ? { lane: need.lane } : {}),
              score,
            },
          };
        }
      }
    }

    if (pick === null) { break; } // no positive scores remain

    assignments.push(pick.assignment);
    remainingCards.splice(pick.cardIdx, 1);
    remainingNeeds.splice(pick.needIdx, 1);
  }

  return assignments;
}

/** Tie-break helper: higher score wins; ties broken by agent_id then role. */
function isBetterPick(
  score: number,
  card: AgentCard,
  need: RoleNeed,
  current: { score: number; assignment: RoleAssignment },
): boolean {
  if (score > current.score) { return true; }
  if (score < current.score) { return false; }
  const byAgent = card.agent_id.localeCompare(current.assignment.agent_id);
  if (byAgent !== 0) { return byAgent < 0; }
  return need.role.localeCompare(current.assignment.role) < 0;
}

// ---------------------------------------------------------------------------
// Re-election (§4.3)
// ---------------------------------------------------------------------------

/**
 * Decide whether a looping agent should re-role. Only proposes a change when its
 * current lane is drained AND {@link electRole} surfaces a *different* role with
 * a positive score; otherwise returns null (stay put). This is the consent-gated
 * "release lease, propose new role" signal from §4.3 — it never re-roles the
 * agent onto the same role it already holds.
 */
export function shouldReRole(args: {
  currentRole: string;
  currentLaneDrained: boolean;
  needs: NeedsVector;
  card: AgentCard;
}): ElectedRole | null {
  if (!args.currentLaneDrained) { return null; }

  const elected = electRole(args.needs, args.card);
  if (!elected || elected.score <= 0) { return null; }
  if (elected.role.toLowerCase() === args.currentRole.toLowerCase()) { return null; }

  return elected;
}
