/**
 * orchestrate.ts — Multi-agent parallel development orchestration engine.
 *
 * Core logic for:
 *   - Manifest parsing (YAML task definitions)
 *   - Dependency graph (DAG) construction
 *   - Topological sort and level assignment
 *   - Scope conflict detection (glob intersection)
 *   - Sprint planning (bin-packing with constraints)
 *   - Migration range allocation
 *   - State tracking
 *   - Template rendering
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Effort size: S = 1-2 days, M = 3-4 days, L = 5+ days */
export type EffortSize = 'S' | 'M' | 'L' | 'XL';

/**
 * Task criticality tier (inspired by clawbridge-a2a NCR/IV workflow).
 * Controls the consensus threshold required for approval:
 *   1 = CRITICAL — all voters must approve (unanimous)
 *   2 = MAJOR    — 2/3 approval threshold (default)
 *   3 = ROUTINE  — simple majority (>50%)
 */
export type TaskCriticality = 1 | 2 | 3;

export interface ManifestTask {
  id: string;
  name: string;
  depends_on: string[];
  scope: string[];
  effort: EffortSize;
  subtasks: string[];
  /**
   * Optional capability tags required to perform the task (e.g. "go",
   * "typescript", "security-review"). Used by the capability-aware
   * scorer (see `scoreAgent`) — when empty, every agent matches with
   * full capability score.
   */
  required_capabilities?: string[];
  /**
   * Criticality tier controlling the consensus threshold.
   * Defaults to 2 (MAJOR, 2/3 majority) when omitted.
   */
  criticality?: TaskCriticality;
}

/**
 * Alias for `ManifestTask` used by the capability-aware scorer.
 * Distinct name documents the scoring contract: the planner only
 * needs the subset of fields used by `scoreAgent`. Any future
 * planner-only fields (e.g. derived effort estimates) attach here
 * without polluting the manifest schema.
 */
export type PlannedTask = ManifestTask;

export interface ManifestConstraints {
  mutual_exclusion?: string[][];
  affinity?: string[][];
  max_parallelism?: number;
}

export interface Manifest {
  project: {
    name: string;
    repo?: string;
    language?: string;
    build_command?: string;
    test_command?: string;
    lint_command?: string;
  };
  tasks: ManifestTask[];
  constraints?: ManifestConstraints;
}

export interface SprintAssignment {
  agent: string;
  /** Resolved platform ID for the WA-N slot, when an agent registry was supplied. */
  platform?: string;
  /** Resolved inbox path for the platform, when an agent registry was supplied. */
  inbox?: string;
  tasks: ManifestTask[];
  scope: string[];
  branch: string;
  migration_range: { start: number; end: number } | null;
}

/** A task whose required capabilities could not be served by any local agent. */
export interface CapabilityPendingTask {
  task_id: string;
  required_capabilities: string[];
  sprint: number;
  /** Stable query ID so offers can be correlated without duplicate broadcasts. */
  query_id: string;
}

export interface Sprint {
  sprint: number;
  level: number;
  status: 'pending' | 'assigned' | 'in_progress' | 'review' | 'approved' | 'merged';
  assignments: SprintAssignment[];
  dependencies_met: boolean;
  estimated_days: number;
  /**
   * Free-form planner notes. Populated by `planSprints` when the
   * capability-aware scorer falls back (e.g. no agent matched a task's
   * required_capabilities). Optional for backwards compatibility.
   */
  notes?: string[];
  /**
   * Tasks that have `required_capabilities` but no local agent can serve them.
   * Callers should broadcast `capability_query` messages for these and re-plan
   * once `capability_offer` responses arrive.
   */
  capability_pending?: CapabilityPendingTask[];
}

export interface PlanSummary {
  project: string;
  total_tasks: number;
  total_sprints: number;
  total_agents: number;
  critical_path_length: number;
  estimated_total_days: number;
  sprints: Array<{
    number: number;
    level: number;
    tasks: number;
    agents: string[];
    status: string;
  }>;
}

export interface OrchestratorState {
  project: string;
  current_sprint: number | null;
  total_sprints: number;
  tasks_complete: number;
  tasks_total: number;
  agents: Record<string, {
    status: 'idle' | 'working' | 'review' | 'done';
    sprint: number | null;
    tasks: string[];
  }>;
  last_updated: string;
}

export interface PlannerConfig {
  work_agents: number;
  max_tasks_per_agent: number;
  max_subtasks_per_sprint: number;
  migration_range_size: number;
  branch_prefix: string;
}

// ---------------------------------------------------------------------------
// DAG — Dependency Graph
// ---------------------------------------------------------------------------

export interface DAGNode {
  task: ManifestTask;
  level: number;
  inDegree: number;
  dependents: string[];   // task IDs that depend on this node
  dependencies: string[]; // task IDs this node depends on
  criticalPathLength: number;
}

export interface DAG {
  nodes: Map<string, DAGNode>;
  levels: Map<number, string[]>;  // level -> task IDs at that level
  maxLevel: number;
  criticalPathLength: number;
}

/**
 * Build a dependency graph from a list of tasks.
 * Validates: no duplicate IDs, all depends_on references exist.
 * Throws on validation errors.
 */
export function buildDAG(tasks: ManifestTask[]): DAG {
  const nodes = new Map<string, DAGNode>();

  // Check for duplicate IDs
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task ID: "${task.id}"`);
    }
    seen.add(task.id);
  }

  // Create nodes
  for (const task of tasks) {
    nodes.set(task.id, {
      task,
      level: -1,
      inDegree: 0,
      dependents: [],
      dependencies: [...task.depends_on],
      criticalPathLength: 0,
    });
  }

  // Validate dependencies exist and build edges
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      if (!nodes.has(depId)) {
        throw new Error(
          `Task "${task.id}" depends on "${depId}" which does not exist in the manifest`
        );
      }
      nodes.get(depId)!.dependents.push(task.id);
      nodes.get(task.id)!.inDegree++;
    }
  }

  return { nodes, levels: new Map(), maxLevel: -1, criticalPathLength: 0 };
}

/**
 * Topological sort using Kahn's algorithm.
 * Assigns levels to each node. Detects cycles.
 * Returns the sorted task IDs and populates the DAG's levels map.
 */
export function topologicalSort(dag: DAG): string[] {
  const sorted: string[] = [];
  const inDegree = new Map<string, number>();

  for (const [id, node] of dag.nodes) {
    inDegree.set(id, node.inDegree);
  }

  // Level 0: nodes with no dependencies
  let currentLevel: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      currentLevel.push(id);
      dag.nodes.get(id)!.level = 0;
    }
  }

  let level = 0;
  while (currentLevel.length > 0) {
    dag.levels.set(level, [...currentLevel]);
    sorted.push(...currentLevel);

    const nextLevel: string[] = [];
    for (const id of currentLevel) {
      const node = dag.nodes.get(id)!;
      for (const depId of node.dependents) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          nextLevel.push(depId);
          dag.nodes.get(depId)!.level = level + 1;
        }
      }
    }

    currentLevel = nextLevel;
    level++;
  }

  dag.maxLevel = level - 1;

  // Cycle detection: if not all nodes were sorted, there's a cycle
  if (sorted.length !== dag.nodes.size) {
    const unsorted = [...dag.nodes.keys()].filter(id => !sorted.includes(id));
    throw new Error(
      `Cycle detected in dependency graph. Tasks involved: ${unsorted.join(', ')}`
    );
  }

  // Compute critical path lengths (longest path from each node to a leaf)
  computeCriticalPaths(dag);

  return sorted;
}

/**
 * Compute the critical path length for each node (longest chain to a leaf).
 * Must be called after topological sort.
 */
function computeCriticalPaths(dag: DAG): void {
  // Process in reverse topological order (highest level first)
  for (let level = dag.maxLevel; level >= 0; level--) {
    const taskIds = dag.levels.get(level) ?? [];
    for (const id of taskIds) {
      const node = dag.nodes.get(id)!;
      if (node.dependents.length === 0) {
        node.criticalPathLength = 1;
      } else {
        let maxChild = 0;
        for (const depId of node.dependents) {
          const child = dag.nodes.get(depId)!;
          if (child.criticalPathLength > maxChild) {
            maxChild = child.criticalPathLength;
          }
        }
        node.criticalPathLength = 1 + maxChild;
      }
    }
  }

  dag.criticalPathLength = Math.max(
    ...Array.from(dag.nodes.values()).map(n => n.criticalPathLength)
  );
}

// ---------------------------------------------------------------------------
// Scope Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Check if two glob patterns can match overlapping files.
 * Uses a simplified heuristic: patterns sharing a common non-wildcard prefix
 * or one being a prefix of the other are considered conflicting.
 */
export function globsOverlap(a: string, b: string): boolean {
  // Exact match
  if (a === b) { return true; }

  const aParts = a.replace(/\\/g, '/').split('/');
  const bParts = b.replace(/\\/g, '/').split('/');

  // Walk common prefix
  const minLen = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < minLen; i++) {
    const ap = aParts[i];
    const bp = bParts[i];

    // If either is a double-star, the rest can match anything
    if (ap === '**' || bp === '**') { return true; }

    // If either is a single-star, it matches any single segment
    if (ap === '*' || bp === '*') { continue; }

    // Literal segments must match
    if (ap !== bp) { return false; }
  }

  // If we exhausted one path and the other continues, they could overlap
  // if the shorter one ended with ** or the paths are equal length
  return true;
}

/**
 * Detect scope conflicts between tasks at the same level.
 * Returns pairs of conflicting task IDs.
 */
export function detectScopeConflicts(
  tasks: ManifestTask[]
): Array<[string, string, string[]]> {
  const conflicts: Array<[string, string, string[]]> = [];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const overlapping: string[] = [];
      for (const scopeA of tasks[i].scope) {
        for (const scopeB of tasks[j].scope) {
          if (globsOverlap(scopeA, scopeB)) {
            overlapping.push(`${scopeA} ∩ ${scopeB}`);
          }
        }
      }
      if (overlapping.length > 0) {
        conflicts.push([tasks[i].id, tasks[j].id, overlapping]);
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Sprint Planner
// ---------------------------------------------------------------------------

const EFFORT_DAYS: Record<EffortSize, number> = {
  S: 1,
  M: 3,
  L: 5,
  XL: 8,
};

/**
 * Effort size → estimated hours, used by `scoreAgent` for cost normalisation.
 * Distinct from `EFFORT_DAYS` (used for sprint estimated_days) to keep the
 * scoring formula tunable without disturbing existing sprint-duration math.
 */
const EFFORT_HOURS: Record<EffortSize, number> = {
  S: 2,
  M: 4,
  L: 8,
  XL: 16,
};

// ---------------------------------------------------------------------------
// Capability-aware Scorer (Phase 3 router)
// ---------------------------------------------------------------------------

/**
 * Minimal RegisteredAgent shape consumed by `scoreAgent`. Mirrors the
 * v2 fields on `comms.RegisteredAgent` that drive scoring; declared here
 * so `orchestrate.ts` does not depend on `comms.ts` types and existing
 * AgentRegistryEntry consumers can be passed through unchanged.
 */
export interface ScorableAgent {
  capabilities?: string[];
  trust_level?: 'untrusted' | 'low' | 'medium' | 'high';
  cost_budget?: { hourly_usd?: number; daily_usd?: number; per_task_usd?: number };
  max_parallel_tasks?: number;
  /**
   * In-flight task count for this agent in the currently-being-planned
   * sprint. Defaults to 0. Pass via the optional `context` arg of
   * `scoreAgent` rather than mutating the agent.
   */
  in_flight?: number;
  /**
   * Languages the agent can target (e.g. ["go", "typescript"]). Used to
   * boost capability_match when the task's required capabilities overlap.
   * Optional; absence weights capability_match by 0.5 (the "language
   * uncertain" default in the spec).
   */
  languages_supported?: string[];
}

/** Compute the Jaccard index between two arrays treated as sets. */
export function jaccardIndex(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) { return 1; }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) { if (setB.has(x)) { intersection++; } }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Map a TrustLevel onto a [0,1] weight; missing trust → 0.5 (neutral). */
export function trustWeight(level?: ScorableAgent['trust_level']): number {
  switch (level) {
    case 'untrusted': return 0;
    case 'low':       return 0.4;
    case 'medium':    return 0.7;
    case 'high':      return 1.0;
    default:          return 0.5;
  }
}

/**
 * Score an agent for a task per the Phase 3 fabric formula:
 *
 *   capability_match = jaccard(agent.capabilities, task.required_capabilities)
 *                      × (languages_supported overlaps task ? 1.0 : 0.5)
 *   trust_score      = trustWeight(agent.trust_level)
 *   idle_factor      = max(0, max_parallel - in_flight) / max_parallel
 *   estimated_cost   = max(0.01, effort_hours × hourly_usd)
 *   score            = capability_match × trust_score × idle_factor / estimated_cost
 *
 * Returns a non-negative number; higher = better fit. A score of 0
 * indicates the agent is either fully trust-blocked, fully busy, or
 * has no capability overlap on a task that requires capabilities.
 */
export function scoreAgent(agent: ScorableAgent, task: PlannedTask): number {
  const required = task.required_capabilities ?? [];
  const agentCaps = agent.capabilities ?? [];

  // Capability match: Jaccard, then dampened if languages_supported is
  // missing OR known to not overlap with the task's required caps.
  const jaccard = jaccardIndex(agentCaps, required);
  let langFactor = 0.5;
  if (agent.languages_supported && agent.languages_supported.length > 0) {
    if (required.length === 0) {
      // No language requirement on the task → don't penalise the agent.
      langFactor = 1.0;
    } else {
      const overlap = agent.languages_supported.some(l => required.includes(l));
      langFactor = overlap ? 1.0 : 0.5;
    }
  }
  const capabilityMatch = jaccard * langFactor;

  const trustScore = trustWeight(agent.trust_level);

  const maxParallel = agent.max_parallel_tasks ?? 1;
  const inFlight = agent.in_flight ?? 0;
  const idleFactor = maxParallel > 0
    ? Math.max(0, maxParallel - inFlight) / maxParallel
    : 0;

  const hours = EFFORT_HOURS[task.effort];
  const hourlyUsd = agent.cost_budget?.hourly_usd ?? 1.0;
  const estimatedCost = Math.max(0.01, hours * hourlyUsd);

  return (capabilityMatch * trustScore * idleFactor) / estimatedCost;
}

/**
 * Plan sprints from a DAG and constraints.
 *
 * Groups tasks by dependency level, then bin-packs each level's tasks
 * into agent slots respecting scope isolation, mutual exclusion, and
 * effort capacity.
 */
export function planSprints(
  dag: DAG,
  config: PlannerConfig,
  constraints?: ManifestConstraints,
  agents: AgentRegistryEntry[] = [],
  excludedSlots: Set<string> = new Set()
): Sprint[] {
  const sprints: Sprint[] = [];
  let sprintNumber = 1;
  let migrationCounter = 1;

  const mutualExclusion = constraints?.mutual_exclusion ?? [];
  const affinity = constraints?.affinity ?? [];
  const maxParallelism = constraints?.max_parallelism ?? config.work_agents;
  const agentCount = Math.min(config.work_agents, maxParallelism);

  // Use the capability-aware scorer when at least one registry entry
  // populates a scoring field. Otherwise fall back to the legacy
  // slot-index round-robin so existing callers/tests are unchanged.
  const useScorer = agents.some(a =>
    (a.capabilities && a.capabilities.length > 0) ||
    a.trust_level !== undefined ||
    a.cost_budget !== undefined ||
    a.max_parallel_tasks !== undefined ||
    (a.languages_supported && a.languages_supported.length > 0)
  );

  for (let level = 0; level <= dag.maxLevel; level++) {
    const taskIds = dag.levels.get(level) ?? [];
    if (taskIds.length === 0) { continue; }

    // Sort tasks by priority: critical path desc, dependents desc, effort desc
    const sortedIds = [...taskIds].sort((a, b) => {
      const nodeA = dag.nodes.get(a)!;
      const nodeB = dag.nodes.get(b)!;

      // Critical path length (longer = higher priority)
      if (nodeB.criticalPathLength !== nodeA.criticalPathLength) {
        return nodeB.criticalPathLength - nodeA.criticalPathLength;
      }
      // Downstream dependents count
      if (nodeB.dependents.length !== nodeA.dependents.length) {
        return nodeB.dependents.length - nodeA.dependents.length;
      }
      // Effort (larger first)
      return EFFORT_DAYS[nodeB.task.effort] - EFFORT_DAYS[nodeA.task.effort];
    });

    // Bin-pack tasks into agent slots for this level
    // May produce multiple sprints if tasks exceed capacity
    let remaining = [...sortedIds];

    // If every slot at this level is excluded (e.g. all mapped agents are
    // stalled), bin-packing would loop forever — bail out of this level.
    const everySlotExcluded = (() => {
      for (let i = 0; i < agentCount; i++) {
        if (!excludedSlots.has(`WA-${i + 1}`)) { return false; }
      }
      return agentCount > 0;
    })();
    if (everySlotExcluded) { continue; }

    while (remaining.length > 0) {
      const remainingBefore = remaining.length;
      const sprintNotes: string[] = [];
      const capabilityPending: CapabilityPendingTask[] = [];

      // Per-slot accumulators for THIS sprint. Indexed by agentIdx (0-based).
      interface SlotState {
        agentIdx: number;
        agentId: string;
        excluded: boolean;
        tasks: ManifestTask[];
        scopes: string[];
        subtaskCount: number;
        taskCount: number;
      }
      const slots: SlotState[] = [];
      for (let i = 0; i < agentCount; i++) {
        const agentId = `WA-${i + 1}`;
        slots.push({
          agentIdx: i,
          agentId,
          excluded: excludedSlots.has(agentId),
          tasks: [],
          scopes: [],
          subtaskCount: 0,
          taskCount: 0,
        });
      }

      const assignedThisSprint = new Set<string>();

      // Helper: can `slot` accept `task` given current accumulators?
      const slotCanAccept = (slot: SlotState, task: ManifestTask): boolean => {
        if (slot.excluded) { return false; }
        if (slot.taskCount >= config.max_tasks_per_agent) { return false; }
        if (slot.subtaskCount + task.subtasks.length > config.max_subtasks_per_sprint) {
          return false;
        }
        // Scope conflicts with any already-assigned slot in this sprint
        for (const other of slots) {
          if (other === slot) { continue; }
          if (other.scopes.length === 0) { continue; }
          if (task.scope.some(s => other.scopes.some(es => globsOverlap(s, es)))) {
            return false;
          }
        }
        // Mutual exclusion
        const violatesMutex = mutualExclusion.some(group => {
          const assigned = [...assignedThisSprint];
          return group.includes(task.id) && assigned.some(a => group.includes(a));
        });
        if (violatesMutex) { return false; }
        return true;
      };

      // Helper: commit `task` to `slot`.
      const commit = (slot: SlotState, task: ManifestTask) => {
        slot.tasks.push(task);
        slot.scopes.push(...task.scope);
        slot.subtaskCount += task.subtasks.length;
        slot.taskCount++;
        assignedThisSprint.add(task.id);
      };

      if (useScorer) {
        // ---- Capability-aware path: task-first iteration ----
        // For each remaining task in priority order, pick the highest-
        // scoring slot that can accept it. Tie-break by lower agentIdx.
        const stillRemaining: string[] = [];
        for (const taskId of remaining) {
          if (assignedThisSprint.has(taskId)) { continue; }
          const task = dag.nodes.get(taskId)!.task;

          let bestSlot: SlotState | null = null;
          let bestScore = -Infinity;
          let anyPositive = false;
          for (const slot of slots) {
            if (!slotCanAccept(slot, task)) { continue; }
            const entry = agents[slot.agentIdx];
            // entry may be undefined when the registry has fewer rows
            // than work_agents; in that case the slot is anonymous and
            // gets a default-scored ScorableAgent.
            const scorable: ScorableAgent = entry
              ? {
                  capabilities: entry.capabilities,
                  trust_level: entry.trust_level,
                  cost_budget: entry.cost_budget,
                  max_parallel_tasks: entry.max_parallel_tasks,
                  languages_supported: entry.languages_supported,
                  in_flight: slot.taskCount,
                }
              : { in_flight: slot.taskCount };
            const s = scoreAgent(scorable, task);
            if (s > 0) { anyPositive = true; }
            // Tie-break: lower agentIdx wins (slots iterated in order,
            // so strict `>` already gives that behaviour).
            if (s > bestScore) {
              bestScore = s;
              bestSlot = slot;
            }
          }

          if (bestSlot && anyPositive) {
            commit(bestSlot, task);
          } else if (bestSlot && !anyPositive) {
            // No agent had a positive score.
            const required = task.required_capabilities ?? [];
            if (required.length > 0) {
              // Task declares specific capabilities — no local agent qualifies.
              // Record as capability_pending so the caller can broadcast a
              // capability_query and re-plan once offers arrive.
              // Still fall back to round-robin so the sprint isn't blocked,
              // but flag the pending query so callers can override if a remote
              // agent responds before execution starts.
              const fallbackSlot = slots.find(s => slotCanAccept(s, task));
              if (fallbackSlot) {
                commit(fallbackSlot, task);
              }
              capabilityPending.push({
                task_id: task.id,
                required_capabilities: required,
                sprint: sprintNumber,
                query_id: `capq-${task.id}-sp${sprintNumber}`,
              });
              sprintNotes.push(
                `task ${task.id}: requires [${required.join(', ')}] but no local agent qualifies; ` +
                `capability_query broadcasted (query_id: capq-${task.id}-sp${sprintNumber})`
              );
            } else {
              // No required capabilities — generic load-balancing fallback.
              const fallbackSlot = slots.find(s => slotCanAccept(s, task));
              if (fallbackSlot) {
                commit(fallbackSlot, task);
                sprintNotes.push(
                  `task ${task.id}: no agent had positive capability score; ` +
                  `fell back to round-robin (assigned ${fallbackSlot.agentId})`
                );
              } else {
                stillRemaining.push(taskId);
              }
            }
          } else {
            stillRemaining.push(taskId);
          }
        }
        remaining = stillRemaining;
      } else {
        // ---- Legacy slot-index round-robin path (unchanged behaviour) ----
        for (const slot of slots) {
          if (slot.excluded) { continue; }
          if (remaining.length === 0) { break; }
          const stillRemaining: string[] = [];
          for (const taskId of remaining) {
            if (assignedThisSprint.has(taskId)) { continue; }
            const task = dag.nodes.get(taskId)!.task;
            if (slotCanAccept(slot, task)) {
              commit(slot, task);
            } else {
              stillRemaining.push(taskId);
            }
          }
          remaining = stillRemaining;
        }
      }

      // Materialise assignments from slots that took work.
      const assignments: SprintAssignment[] = [];
      for (const slot of slots) {
        if (slot.tasks.length === 0) { continue; }

        const needsMigrations = slot.tasks.some(t =>
          t.scope.some(s => s.includes('migrations/'))
        );
        let migRange: { start: number; end: number } | null = null;
        if (needsMigrations) {
          migRange = {
            start: migrationCounter,
            end: migrationCounter + config.migration_range_size - 1,
          };
          migrationCounter += config.migration_range_size;
        }

        const branchSlug = slot.tasks
          .map(t => t.id.replace(/[^a-z0-9-]/gi, '-'))
          .join('-')
          .substring(0, 40);

        const resolved = resolveAgentId(slot.agentId, agents);
        const platform = resolved === slot.agentId ? undefined : resolved;
        const inbox = agents[slot.agentIdx]?.inbox;
        const assignment: SprintAssignment = {
          agent: slot.agentId,
          tasks: slot.tasks,
          scope: slot.scopes,
          branch: `${config.branch_prefix}sprint-${sprintNumber}-${slot.agentId.toLowerCase()}-${branchSlug}`,
          migration_range: migRange,
        };
        if (platform) { assignment.platform = platform; }
        if (inbox) { assignment.inbox = inbox; }
        assignments.push(assignment);
      }

      if (assignments.length > 0) {
        const maxEffort = Math.max(
          ...assignments.flatMap(a =>
            a.tasks.map(t => EFFORT_DAYS[t.effort])
          )
        );

        const sprint: Sprint = {
          sprint: sprintNumber,
          level,
          status: 'pending',
          assignments,
          dependencies_met: level === 0,
          estimated_days: maxEffort,
        };
        if (sprintNotes.length > 0) {
          sprint.notes = sprintNotes;
        }
        if (capabilityPending.length > 0) {
          sprint.capability_pending = capabilityPending;
        }
        sprints.push(sprint);
        sprintNumber++;
      }

      // Defensive: if no progress was made in this iteration (e.g. every
      // available slot is excluded or every remaining task scope-conflicts
      // with itself), break to avoid an infinite loop.
      if (remaining.length >= remainingBefore) { break; }
    }
  }

  return sprints;
}

// ---------------------------------------------------------------------------
// Plan Summary
// ---------------------------------------------------------------------------

export function buildPlanSummary(
  projectName: string,
  tasks: ManifestTask[],
  sprints: Sprint[],
  agentCount: number,
  criticalPathLength: number
): PlanSummary {
  return {
    project: projectName,
    total_tasks: tasks.length,
    total_sprints: sprints.length,
    total_agents: agentCount,
    critical_path_length: criticalPathLength,
    estimated_total_days: sprints.reduce((sum, s) => sum + s.estimated_days, 0),
    sprints: sprints.map(s => ({
      number: s.sprint,
      level: s.level,
      tasks: s.assignments.reduce((sum, a) => sum + a.tasks.length, 0),
      agents: s.assignments.map(a => a.agent),
      status: s.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

export function createInitialState(
  projectName: string,
  totalSprints: number,
  totalTasks: number,
  agentCount: number
): OrchestratorState {
  const agents: OrchestratorState['agents'] = {};
  for (let i = 1; i <= agentCount; i++) {
    agents[`WA-${i}`] = { status: 'idle', sprint: null, tasks: [] };
  }

  return {
    project: projectName,
    current_sprint: null,
    total_sprints: totalSprints,
    tasks_complete: 0,
    tasks_total: totalTasks,
    agents,
    last_updated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Template Rendering
// ---------------------------------------------------------------------------

/**
 * Simple mustache-style template renderer.
 * Replaces {{key}} with values from the data object.
 * Supports {{key | "default"}} for fallback values.
 */
export function renderTemplate(
  template: string,
  data: Record<string, string | string[] | number | null | undefined>
): string {
  return template.replace(
    /\{\{(\w+)(?:\s*\|\s*"([^"]*)")?\}\}/g,
    (_match, key: string, fallback?: string) => {
      const value = data[key];
      if (value === null || value === undefined) {
        return fallback ?? '';
      }
      if (Array.isArray(value)) {
        return value.join(', ');
      }
      return String(value);
    }
  );
}

/**
 * Render a sprint assignment document from the template and sprint data.
 */
export function renderSprintAssignment(
  template: string,
  sprint: Sprint,
  assignment: SprintAssignment,
  projectName: string
): string {
  const taskList = assignment.tasks.map(t => `${t.id}: ${t.name}`).join(', ');
  const packageList = assignment.scope.join(', ');
  const scopePatterns = assignment.scope.map(s => `- \`${s}\``).join('\n');
  const primaryPackage = assignment.scope[0]
    ?.replace('internal/', '')
    .replace('/**', '')
    .replace('/*', '') ?? '';

  const depTasks = assignment.tasks.flatMap(t => t.depends_on);
  const dependencyList = depTasks.length > 0 ? depTasks.join(', ') : 'None';

  const migRange = assignment.migration_range
    ? `${assignment.migration_range.start}-${assignment.migration_range.end}`
    : 'N/A';

  return renderTemplate(template, {
    sprint_number: sprint.sprint,
    agent_id: assignment.agent,
    project_name: projectName,
    task_list: taskList,
    branch_name: assignment.branch,
    migration_start: assignment.migration_range?.start ?? null,
    migration_end: assignment.migration_range?.end ?? null,
    package_list: packageList,
    dependency_list: dependencyList,
    estimated_days: sprint.estimated_days,
    scope_patterns: scopePatterns,
    primary_package: primaryPackage,
  });
}

// ---------------------------------------------------------------------------
// YAML Serialization (minimal, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML serializer for sprint plans and summaries.
 * Handles the subset of YAML we need: scalars, arrays, nested objects.
 * For reading YAML manifests, the skill prompt instructs the AI to parse
 * YAML using the host's capabilities.
 */
export function toYAML(obj: unknown, indent: number = 0): string {
  const pad = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return 'null';
  }
  if (typeof obj === 'string') {
    // Quote strings that contain special chars
    if (/[:#{}[\],&*?|>!%@`]/.test(obj) || obj === '' || obj === 'true' || obj === 'false') {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj);
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) { return '[]'; }
    // Check if all items are simple scalars
    const allScalar = obj.every(
      item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    );
    if (allScalar) {
      return `[${obj.map(item => toYAML(item, 0)).join(', ')}]`;
    }
    return obj
      .map(item => {
        const serialized = toYAML(item, indent + 1);
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          // Object items: put first key on same line as dash
          const lines = serialized.split('\n');
          const first = lines[0].trimStart();
          const rest = lines.slice(1).join('\n');
          return `${pad}- ${first}${rest ? '\n' + rest : ''}`;
        }
        return `${pad}- ${serialized}`;
      })
      .join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) { return '{}'; }
    return entries
      .map(([key, value]) => {
        if (value === null || value === undefined) {
          return `${pad}${key}: null`;
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
          return `${pad}${key}:\n${toYAML(value, indent + 1)}`;
        }
        if (Array.isArray(value) && value.length > 0 &&
            value.some(v => typeof v === 'object' && v !== null)) {
          return `${pad}${key}:\n${toYAML(value, indent + 1)}`;
        }
        return `${pad}${key}: ${toYAML(value, indent)}`;
      })
      .join('\n');
  }
  return String(obj);
}

// ---------------------------------------------------------------------------
// File I/O Helpers
// ---------------------------------------------------------------------------

export async function ensureDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

export async function writeYAMLFile(
  filePath: string,
  data: unknown
): Promise<void> {
  const content = `# Generated by AutoClaw Orchestrator\n# ${new Date().toISOString()}\n\n${toYAML(data)}`;
  await ensureDir(path.dirname(filePath));
  await fsPromises.writeFile(filePath, content, 'utf8');
}

/**
 * Render a human-readable Markdown view of a Sprint plan.
 * The output begins with a generated-file warning header so manual edits
 * are obviously discouraged. The companion `sprint-N.yaml` remains the
 * authoritative source of truth; this Markdown is a derived artifact.
 *
 * Replaces the deprecated docs/parallel-execution-plan.md per
 * COORDINATION_IMPROVEMENTS §2.4.
 */
export function renderSprintMarkdown(sprint: Sprint, projectName: string): string {
  const lines: string[] = [];
  lines.push(`<!-- GENERATED — edit sprint-${sprint.sprint}.yaml instead. -->`);
  lines.push('');
  lines.push(`# Sprint ${sprint.sprint} — ${projectName}`);
  lines.push('');
  lines.push(`- **Status:** ${sprint.status}`);
  lines.push(`- **Level:** ${sprint.level}`);
  lines.push(`- **Dependencies met:** ${sprint.dependencies_met ? 'yes' : 'no'}`);
  lines.push(`- **Estimated days:** ${sprint.estimated_days}`);
  lines.push('');
  lines.push('## Assignments');
  lines.push('');
  if (sprint.assignments.length === 0) {
    lines.push('_(no assignments)_');
  } else {
    for (const a of sprint.assignments) {
      const platformPart = a.platform ? ` (${a.platform})` : '';
      lines.push(`### ${a.agent}${platformPart}`);
      lines.push('');
      lines.push(`- **Branch:** \`${a.branch}\``);
      if (a.inbox) {
        lines.push(`- **Inbox:** \`${a.inbox}\``);
      }
      if (a.migration_range) {
        lines.push(`- **Migration range:** ${a.migration_range.start}-${a.migration_range.end}`);
      }
      lines.push('- **Tasks:**');
      for (const t of a.tasks) {
        lines.push(`  - \`${t.id}\` — ${t.name} (${t.effort})`);
      }
      lines.push('- **Scope globs:**');
      for (const s of a.scope) {
        lines.push(`  - \`${s}\``);
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push(`_Generated ${new Date().toISOString()} by AutoClaw Orchestrator._`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write both `sprint-N.yaml` and the sibling `sprint-N.md` for a single sprint.
 * The YAML is the authoritative source of record; the Markdown is a derived
 * human-readable view (per COORDINATION_IMPROVEMENTS §2.4).
 */
export async function writeSprintArtifacts(
  sprintsDir: string,
  sprint: Sprint,
  projectName: string
): Promise<{ yamlPath: string; mdPath: string }> {
  await ensureDir(sprintsDir);
  const yamlPath = path.join(sprintsDir, `sprint-${sprint.sprint}.yaml`);
  const mdPath = path.join(sprintsDir, `sprint-${sprint.sprint}.md`);
  await writeYAMLFile(yamlPath, sprint);
  await fsPromises.writeFile(mdPath, renderSprintMarkdown(sprint, projectName), 'utf8');
  // Write JSON sidecar when capability_pending tasks exist so the reconcile
  // sweep can read them without a YAML parser.
  if (sprint.capability_pending && sprint.capability_pending.length > 0) {
    const jsonPath = path.join(sprintsDir, `sprint-${sprint.sprint}.json`);
    await fsPromises.writeFile(jsonPath, JSON.stringify(sprint, null, 2), 'utf8');
  }
  return { yamlPath, mdPath };
}

/**
 * Write all artifacts for a planner run: every `sprint-N.yaml` + sibling
 * `sprint-N.md`, plus `plan-summary.yaml`. This is the single entry point the
 * `/orchestrate plan` flow should call after `generatePlan()` so that the
 * generated Markdown view stays in lock-step with the authoritative YAML on
 * every plan regeneration. Backwards compatible — `writeSprintArtifacts` and
 * the lower-level `writeYAMLFile` continue to work for callers that prefer
 * to drive the writes themselves.
 */
export async function writePlanArtifacts(
  sprintsDir: string,
  plan: PlanResult,
  projectName: string
): Promise<{
  sprintArtifacts: Array<{ yamlPath: string; mdPath: string }>;
  summaryPath: string;
}> {
  await ensureDir(sprintsDir);
  const sprintArtifacts: Array<{ yamlPath: string; mdPath: string }> = [];
  for (const sprint of plan.sprints) {
    sprintArtifacts.push(await writeSprintArtifacts(sprintsDir, sprint, projectName));
  }
  const summaryPath = path.join(sprintsDir, 'plan-summary.yaml');
  await writeYAMLFile(summaryPath, plan.summary);
  return { sprintArtifacts, summaryPath };
}

export async function writeStateFile(
  filePath: string,
  state: OrchestratorState
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function readStateFile(
  filePath: string
): Promise<OrchestratorState | null> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(content) as OrchestratorState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full Pipeline
// ---------------------------------------------------------------------------

export interface PlanResult {
  sprints: Sprint[];
  summary: PlanSummary;
  state: OrchestratorState;
  dag: DAG;
}

/**
 * Run the full planning pipeline: parse → DAG → sort → plan → output.
 */
export function generatePlan(
  manifest: Manifest,
  config: PlannerConfig,
  agents: AgentRegistryEntry[] = [],
  excludedSlots: Set<string> = new Set()
): PlanResult {
  // Phase 1-2: Build DAG
  const dag = buildDAG(manifest.tasks);

  // Phase 3: Topological sort + level assignment
  topologicalSort(dag);

  // Phase 5-6: Sprint planning with bin-packing
  const sprints = planSprints(dag, config, manifest.constraints, agents, excludedSlots);

  // Build summary
  const summary = buildPlanSummary(
    manifest.project.name,
    manifest.tasks,
    sprints,
    config.work_agents,
    dag.criticalPathLength
  );

  // Build initial state
  const state = createInitialState(
    manifest.project.name,
    sprints.length,
    manifest.tasks.length,
    config.work_agents
  );

  return { sprints, summary, state, dag };
}

/**
 * Default planner config derived from the orchestrator config.yaml structure.
 */
export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  work_agents: 4,
  max_tasks_per_agent: 3,
  max_subtasks_per_sprint: 15,
  migration_range_size: 4,
  branch_prefix: 'feat/',
};

// ---------------------------------------------------------------------------
// Agent Registry — maps WA-N sprint IDs to platform identities
// ---------------------------------------------------------------------------

export interface AgentRegistryEntry {
  id: string;        // "WA-1", "WA-2", ...
  platform: string;  // "kiro", "kilocode", "cline", "claude-code", etc.
  inbox: string;     // relative path: ".autoclaw/orchestrator/comms/inboxes/<platform>/"
  sprint: number | null;
  assigned_at: string;

  // --- v2 scoring fields (optional) — feed `scoreAgent`. If any entry in the
  // registry sets one of these, planSprints switches from slot-index
  // round-robin to capability-aware assignment. Absence on every entry
  // preserves the legacy round-robin path used by older tests/callers.
  capabilities?: string[];
  trust_level?: 'untrusted' | 'low' | 'medium' | 'high';
  cost_budget?: { hourly_usd?: number; daily_usd?: number; per_task_usd?: number };
  max_parallel_tasks?: number;
  languages_supported?: string[];
}

export async function writeAgentRegistry(
  registryPath: string,
  entries: AgentRegistryEntry[]
): Promise<void> {
  const resolved = path.resolve(registryPath);
  await ensureDir(path.dirname(resolved));
  await fsPromises.writeFile(
    resolved,
    JSON.stringify({ agents: entries, updated: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

export async function readAgentRegistry(
  registryPath: string
): Promise<AgentRegistryEntry[]> {
  // Resolve to absolute path first so any '..' traversal is collapsed before
  // the read. Callers must only pass paths within their own workspace.
  const resolved = path.resolve(registryPath);
  try {
    const raw = await fsPromises.readFile(resolved, 'utf8');
    return (JSON.parse(raw) as { agents: AgentRegistryEntry[] }).agents ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve a WA-N sprint slot to a real agent platform ID using the registry.
 * WA-1 → agents[0].platform, WA-2 → agents[1].platform, etc.
 * Falls back to the WA-N string if no registry entry exists for that index.
 */
export function resolveAgentId(waSlot: string, agents: AgentRegistryEntry[]): string {
  const idx = parseInt(waSlot.replace('WA-', ''), 10) - 1;
  return agents[idx]?.platform ?? waSlot;
}

// ---------------------------------------------------------------------------
// Multi-Agent Consensus Validation
// ---------------------------------------------------------------------------

/**
 * Represents an agent provider (Kiro, Kilo Code, Claude Code, Cursor, etc.)
 * that can participate in cross-agent validation.
 */
export interface AgentProvider {
  id: string;           // e.g. "kiro", "kilocode", "claude-code"
  name: string;         // e.g. "Kiro (Amazon)", "Kilo Code"
  role: 'worker' | 'reviewer' | 'validator';
  status: 'active' | 'idle' | 'offline';
  capabilities: string[];  // e.g. ["go", "typescript", "review", "test"]
}

export type ValidationVerdict =
  | 'approved'
  | 'needs_changes'
  | 'blocked'
  | 'abstain';

export interface ValidationVote {
  agent_id: string;
  provider: string;
  verdict: ValidationVerdict;
  confidence: number;     // 0.0 - 1.0
  findings: ValidationFinding[];
  timestamp: string;
}

export interface ValidationFinding {
  category: 'bug' | 'security' | 'scope' | 'test_gap' | 'style' | 'architecture' | 'performance';
  severity: 'critical' | 'major' | 'minor' | 'info';
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface ConsensusResult {
  task_id: string;
  sprint: number;
  status: 'consensus_reached' | 'consensus_pending' | 'deadlocked';
  final_verdict: ValidationVerdict;
  votes: ValidationVote[];
  rounds: number;
  max_rounds: number;
  unresolved_findings: ValidationFinding[];
  resolved_findings: ValidationFinding[];
  /**
   * Findings deduplicated across voters via mergeFindings(): identical
   * file:line:category:description entries collapse into one, with severity
   * upgraded to the highest reported by any voter. Optional for backwards
   * compatibility with consumers written before Phase 0.
   */
  merged_findings?: ValidationFinding[];
  consensus_threshold: number;
  timestamp: string;
}

export interface ConsensusConfig {
  /** Minimum number of agents that must vote before consensus can be evaluated */
  min_voters: number;
  /** Fraction of approvals needed (0.0 - 1.0). Default 0.66 = 2/3 majority */
  approval_threshold: number;
  /** Maximum validation rounds before declaring deadlock */
  max_rounds: number;
  /** Whether a single 'blocked' vote vetoes consensus */
  block_is_veto: boolean;
  /** Minimum confidence score to count a vote */
  min_confidence: number;
  /** Categories that require unanimous approval (no 'needs_changes' allowed) */
  unanimous_categories: string[];
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  min_voters: 2,
  approval_threshold: 0.66,
  max_rounds: 3,
  block_is_veto: true,
  min_confidence: 0.5,
  unanimous_categories: ['security'],
};

/**
 * Map a task criticality tier to the appropriate `ConsensusConfig`.
 * When `criticality` is omitted, the default config (2/3 majority) is returned.
 *
 *   criticality 1 (CRITICAL) → unanimous: approval_threshold = 1.0
 *   criticality 2 (MAJOR)    → 2/3 majority (default)
 *   criticality 3 (ROUTINE)  → simple majority: approval_threshold = 0.501
 */
export function consensusConfigForTask(
  criticality: TaskCriticality | undefined,
  base: ConsensusConfig = DEFAULT_CONSENSUS_CONFIG
): ConsensusConfig {
  if (criticality === 1) {
    return { ...base, approval_threshold: 1.0, block_is_veto: true };
  }
  if (criticality === 3) {
    return { ...base, approval_threshold: 0.501 };
  }
  return base; // criticality 2 or undefined → default (0.66)
}

/**
 * Evaluate whether consensus has been reached from a set of validation votes.
 *
 * Rules:
 * 1. Must have at least `min_voters` votes with confidence >= `min_confidence`.
 * 2. If any vote is 'blocked' and `block_is_veto` is true, consensus fails.
 * 3. For `unanimous_categories`, ALL voters must approve (no 'needs_changes').
 * 4. Otherwise, `approval_threshold` fraction of non-abstain votes must be 'approved'.
 * 5. If threshold not met after `max_rounds`, status is 'deadlocked'.
 */
export function evaluateConsensus(
  votes: ValidationVote[],
  round: number,
  config: ConsensusConfig = DEFAULT_CONSENSUS_CONFIG
): ConsensusResult {
  const qualifiedVotes = votes.filter(v => v.confidence >= config.min_confidence);
  const nonAbstain = qualifiedVotes.filter(v => v.verdict !== 'abstain');

  // Deduplicate findings across voters (same file:line:category:description
  // collapses; severity is upgraded to the highest reported by any voter).
  const merged = mergeFindings(votes);
  const allFindings = merged.unique;
  const criticalFindings = allFindings.filter(f => f.severity === 'critical');

  // Not enough voters yet
  if (qualifiedVotes.length < config.min_voters) {
    return {
      task_id: '',
      sprint: 0,
      status: 'consensus_pending',
      final_verdict: 'abstain',
      votes,
      rounds: round,
      max_rounds: config.max_rounds,
      unresolved_findings: allFindings,
      resolved_findings: [],
      merged_findings: allFindings,
      consensus_threshold: config.approval_threshold,
      timestamp: new Date().toISOString(),
    };
  }

  // Check for veto blocks
  if (config.block_is_veto) {
    const blockers = nonAbstain.filter(v => v.verdict === 'blocked');
    if (blockers.length > 0) {
      return {
        task_id: '',
        sprint: 0,
        status: round >= config.max_rounds ? 'deadlocked' : 'consensus_pending',
        final_verdict: 'blocked',
        votes,
        rounds: round,
        max_rounds: config.max_rounds,
        unresolved_findings: allFindings,
        resolved_findings: [],
        consensus_threshold: config.approval_threshold,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // For threshold calculation, exclude blocked votes when veto is disabled
  // (blocked votes that weren't vetoed should not count against approval rate)
  const votesForThreshold = config.block_is_veto
    ? nonAbstain
    : nonAbstain.filter(v => v.verdict !== 'blocked');

  // Check unanimous categories
  for (const category of config.unanimous_categories) {
    const categoryFindings = allFindings.filter(
      f => f.category === category && (f.severity === 'critical' || f.severity === 'major')
    );
    if (categoryFindings.length > 0) {
      const allApproved = votesForThreshold.every(v => v.verdict === 'approved');
      if (!allApproved) {
        return {
          task_id: '',
          sprint: 0,
          status: round >= config.max_rounds ? 'deadlocked' : 'consensus_pending',
          final_verdict: 'needs_changes',
          votes,
          rounds: round,
          max_rounds: config.max_rounds,
          unresolved_findings: categoryFindings,
          resolved_findings: allFindings.filter(f => f.category !== category),
          merged_findings: allFindings,
          consensus_threshold: config.approval_threshold,
          timestamp: new Date().toISOString(),
        };
      }
    }
  }

  // Standard threshold check — use epsilon for floating point comparison
  const approvals = votesForThreshold.filter(v => v.verdict === 'approved').length;
  const approvalRate = votesForThreshold.length > 0 ? approvals / votesForThreshold.length : 0;
  const EPSILON = 1e-9;

  if (approvalRate >= config.approval_threshold - EPSILON) {
    return {
      task_id: '',
      sprint: 0,
      status: 'consensus_reached',
      final_verdict: 'approved',
      votes,
      rounds: round,
      max_rounds: config.max_rounds,
      unresolved_findings: criticalFindings,
      resolved_findings: allFindings.filter(f => f.severity !== 'critical'),
      merged_findings: allFindings,
      consensus_threshold: config.approval_threshold,
      timestamp: new Date().toISOString(),
    };
  }

  // Not enough approvals
  return {
    task_id: '',
    sprint: 0,
    status: round >= config.max_rounds ? 'deadlocked' : 'consensus_pending',
    final_verdict: 'needs_changes',
    votes,
    rounds: round,
    max_rounds: config.max_rounds,
    unresolved_findings: allFindings.filter(f => f.severity === 'critical' || f.severity === 'major'),
    resolved_findings: allFindings.filter(f => f.severity === 'minor' || f.severity === 'info'),
    merged_findings: allFindings,
    consensus_threshold: config.approval_threshold,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Merge findings from multiple agents, deduplicating by file+line+category.
 *
 * The caller's `votes` array is treated as immutable: every finding stored
 * in the result is a deep clone, so upgrading the severity of a duplicate
 * never mutates the caller's vote objects.
 */
export function mergeFindings(votes: ValidationVote[]): {
  unique: ValidationFinding[];
  agreements: Array<{ finding: ValidationFinding; agreedBy: string[] }>;
} {
  const cloneFinding = (f: ValidationFinding): ValidationFinding => {
    if (typeof structuredClone === 'function') { return structuredClone(f); }
    return JSON.parse(JSON.stringify(f)) as ValidationFinding;
  };

  const findingMap = new Map<string, { finding: ValidationFinding; agents: string[] }>();

  for (const vote of votes) {
    for (const finding of vote.findings) {
      const key = `${finding.file ?? ''}:${finding.line ?? 0}:${finding.category}:${finding.description}`;
      const existing = findingMap.get(key);
      if (existing) {
        existing.agents.push(vote.agent_id);
        // Upgrade severity if a later voter rates it higher. Mutates the
        // cloned copy held in findingMap, never the caller's finding.
        const severityOrder = ['info', 'minor', 'major', 'critical'];
        if (severityOrder.indexOf(finding.severity) > severityOrder.indexOf(existing.finding.severity)) {
          existing.finding.severity = finding.severity;
        }
      } else {
        findingMap.set(key, { finding: cloneFinding(finding), agents: [vote.agent_id] });
      }
    }
  }

  const unique: ValidationFinding[] = [];
  const agreements: Array<{ finding: ValidationFinding; agreedBy: string[] }> = [];

  for (const entry of findingMap.values()) {
    unique.push(entry.finding);
    if (entry.agents.length > 1) {
      agreements.push({ finding: entry.finding, agreedBy: entry.agents });
    }
  }

  return { unique, agreements };
}

// ---------------------------------------------------------------------------
// Capability Query / Offer — Phase 3 distributed capability resolution
// ---------------------------------------------------------------------------

/**
 * Payload carried in a `capability_query` message (cf. comms.ts MessageType docs).
 * Duplicated here so `orchestrate.ts` stays free of a comms.ts import.
 */
export interface CapabilityQueryPayload {
  query_id: string;
  required_capabilities: string[];
  task_id: string;
  sprint: number;
  requested_by: string;
  deadline_iso?: string;
}

/**
 * Payload carried in a `capability_offer` message.
 */
export interface CapabilityOfferPayload {
  for_query_id: string;
  agent_id: string;
  capabilities: string[];
  trust_level?: string;
  estimated_cost_usd?: number;
  available_at_iso?: string;
}

/**
 * A resolved capability offer — the best offer received for a pending task.
 */
export interface CapabilityResolution {
  task_id: string;
  query_id: string;
  sprint: number;
  winning_agent_id: string;
  offer: CapabilityOfferPayload;
}

/**
 * Broadcast `capability_query` messages for all pending tasks returned by
 * `planSprints()`. Writes to the shared inbox so every listening agent can
 * respond with a `capability_offer`.
 *
 * This is a no-op when `pendingTasks` is empty or `commsDir` is absent.
 */
export async function broadcastCapabilityQueries(
  commsDir: string,
  fromAgent: string,
  pendingTasks: CapabilityPendingTask[],
  deadlineIso?: string
): Promise<void> {
  if (!commsDir || pendingTasks.length === 0) { return; }
  const sharedInbox = path.join(commsDir, 'inboxes', 'shared');
  await ensureDir(sharedInbox);
  for (const pending of pendingTasks) {
    const payload: CapabilityQueryPayload = {
      query_id: pending.query_id,
      required_capabilities: pending.required_capabilities,
      task_id: pending.task_id,
      sprint: pending.sprint,
      requested_by: fromAgent,
      ...(deadlineIso ? { deadline_iso: deadlineIso } : {}),
    };
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-capability_query-${fromAgent}-${pending.query_id.slice(-8)}.json`;
    const msg = {
      id: `msg-capq-${pending.query_id}`,
      from: fromAgent,
      to: 'shared',
      type: 'capability_query',
      timestamp: new Date().toISOString(),
      payload,
    };
    await fsPromises.writeFile(
      path.join(sharedInbox, filename),
      JSON.stringify(msg, null, 2),
      'utf8'
    );
  }
}

/**
 * Read `capability_offer` messages from `agentId`'s inbox and return the
 * best offer for each pending query. Call this from the reconcile ticker
 * (after `broadcastCapabilityQueries`) to discover if any remote agent can
 * serve tasks that local agents couldn't.
 *
 * The winning offer is selected by highest Jaccard similarity between the
 * task's required_capabilities and the offer's capabilities, falling back to
 * lowest estimated_cost_usd as a tie-breaker.
 */
export async function resolveCapabilityOffers(
  commsDir: string,
  agentId: string,
  pendingTasks: CapabilityPendingTask[]
): Promise<CapabilityResolution[]> {
  if (!commsDir || pendingTasks.length === 0) { return []; }
  const inboxDir = path.join(commsDir, 'inboxes', agentId);
  let offerMessages: Array<{ id: string; payload: CapabilityOfferPayload }> = [];
  try {
    const files = await fsPromises.readdir(inboxDir);
    for (const file of files.filter(f => f.includes('capability_offer') && f.endsWith('.json'))) {
      try {
        const raw = await fsPromises.readFile(path.join(inboxDir, file), 'utf8');
        const msg = JSON.parse(raw.replace(/^﻿/, ''));
        if (msg.type === 'capability_offer' && msg.payload?.for_query_id) {
          offerMessages.push({ id: msg.id, payload: msg.payload as CapabilityOfferPayload });
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* inbox missing */ }

  const resolutions: CapabilityResolution[] = [];
  for (const pending of pendingTasks) {
    const offers = offerMessages.filter(o => o.payload.for_query_id === pending.query_id);
    if (offers.length === 0) { continue; }

    const required = new Set(pending.required_capabilities);
    let best: CapabilityOfferPayload | null = null;
    let bestScore = -1;

    for (const { payload } of offers) {
      const offered = new Set(payload.capabilities ?? []);
      const intersection = [...required].filter(c => offered.has(c)).length;
      // Use recall (intersection / required_size) rather than Jaccard: agents
      // with a superset of the required capabilities can still serve the task,
      // so penalising extra capabilities would incorrectly favour narrow agents.
      const recall = required.size === 0 ? 1 : intersection / required.size;
      const cost = payload.estimated_cost_usd ?? 0;
      const score = recall * 1000 - cost;
      if (score > bestScore) {
        bestScore = score;
        best = payload;
      }
    }

    if (best) {
      resolutions.push({
        task_id: pending.task_id,
        query_id: pending.query_id,
        sprint: pending.sprint,
        winning_agent_id: best.agent_id,
        offer: best,
      });
    }
  }
  return resolutions;
}
