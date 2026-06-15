/**
 * routerTypes.ts — shared task-tier types for the capability-aware router.
 *
 * These mirror the tier semantics defined in `orchestrate.ts`
 * (`TaskCriticality`, `TaskPhase`) but live here so `router.ts` stays
 * decoupled from the planner module (which imports fs/path/child_process).
 * Keep the values in sync with orchestrate.ts.
 */

export type { AgentType } from './agentTypes';

/**
 * Task criticality tier controlling the consensus threshold AND the router's
 * trust gate:
 *   1 = CRITICAL — requires trust >= medium to auto-assign (unanimous review)
 *   2 = MAJOR    — default (2/3 majority)
 *   3 = ROUTINE  — simple majority
 */
export type TaskCriticality = 1 | 2 | 3;

/** Phase hint for tier-aware routing. */
export type TaskPhase = 'plan' | 'execute' | 'review' | 'grade';
