/**
 * kgRecord.ts — populate the in-process Knowledge Graph with durable, queryable
 * facts from normal work, so `kg.search` / context packs surface real history
 * instead of an empty graph.
 *
 * Today the KG is written only via the `kg.record` MCP tool, so most projects
 * have an empty `kg.db` and context packs show 0 durable facts. This records the
 * most KG-appropriate signal AutoClaw already collects: **multi-agent
 * coordination outcomes** (consensus verdicts) — agent/task-attributed decisions
 * that belong in a graph, not just the vector "learnings" blob.
 *
 * Idempotent: each outcome is recorded under a deterministic id
 * (`coord:<project>:<task>:<verdict>`); `recordThought` is a plain INSERT
 * (duplicate id throws), so a re-run simply skips already-recorded outcomes via
 * a per-record best-effort guard. Host-free (no `vscode`); the KG is lazily
 * imported and degrade-safe — never throws, never blocks the caller.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LogFn } from './config';
import { resolveProjectKey } from './project';
import type { CoordinationSignals, ReviewFinding } from './coordinationSignals';
import { workflowPatternLabel, type WorkflowPattern } from './workflows';
import type { KnowledgeGraph } from './kg/types';
import type { HandoffNote } from '../orchestrator/handoff';

/** Agent the orchestrator records coordination facts under. */
const COORD_AGENT = 'orchestrator';
/** Agent the `/learn` pipeline records distilled learnings under. */
const LEARN_AGENT = 'learn';

/** Deterministic short hash for stable dedup ids (FNV-1a, base36). */
function hashId(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/** Injectable seams (tests). */
export interface RecordCoordinationDeps {
  /** Supply the KnowledgeGraph (defaults to the in-process project KG). */
  getKg?: () => Promise<KnowledgeGraph> | KnowledgeGraph;
}

/** Result of {@link recordCoordinationToKg}. */
export interface RecordCoordinationResult {
  /** Outcomes newly recorded as KG thoughts. */
  recorded: number;
  /** Outcomes skipped (already recorded / per-record failure). */
  skipped: number;
}

function noop(): void {
  /* no-op log */
}

/** Deterministic, dedup-stable id for a coordination outcome. */
function outcomeId(project: string, taskId: string, verdict: string): string {
  return `coord:${project}:${taskId}:${verdict}`;
}

function describe(o: CoordinationSignals['outcomes'][number]): string {
  const tally = o.panelSize ? ` ${o.approvals}/${o.panelSize}` : '';
  const rule = o.rule ? ` [${o.rule}${tally}]` : '';
  return `Consensus ${o.verdict.replace(/_/g, ' ')} for ${o.taskId}${rule}.`;
}

/**
 * Record each consensus outcome in `signals` as a durable KG thought
 * (kind `decision`), project- and task-scoped, deduped by deterministic id.
 * Best-effort and degrade-safe: a missing/degraded KG records nothing and
 * returns `{ recorded: 0, skipped: <n> }` without throwing.
 */
export async function recordCoordinationToKg(
  workspaceRoot: string,
  signals: CoordinationSignals | undefined,
  opts: { log?: LogFn; deps?: RecordCoordinationDeps } = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  const outcomes = signals?.outcomes ?? [];
  if (outcomes.length === 0) {
    return { recorded: 0, skipped: 0 };
  }

  const project = resolveProjectKey(workspaceRoot);

  let kg: KnowledgeGraph;
  try {
    if (opts.deps?.getKg) {
      kg = await opts.deps.getKg();
    } else {
      const { getKnowledgeGraph } = await import('./kg/service');
      kg = getKnowledgeGraph({ workspaceRoot }).kg;
    }
  } catch (err) {
    log(`kg-record: KG unavailable — ${(err as Error).message}`);
    return { recorded: 0, skipped: outcomes.length };
  }

  let recorded = 0;
  let skipped = 0;
  for (const o of outcomes) {
    if (!o || typeof o.taskId !== 'string' || o.taskId === '') {
      skipped++;
      continue;
    }
    try {
      await kg.recordThought({
        id: outcomeId(project, o.taskId, o.verdict),
        project,
        agent: COORD_AGENT,
        task_id: o.taskId,
        kind: 'decision',
        text: describe(o),
        meta: {
          source: 'coordination',
          verdict: o.verdict,
          rule: o.rule,
          approvals: o.approvals,
          panelSize: o.panelSize,
          reviewers: o.reviewers,
          resolvedAt: o.resolvedAt,
        },
      });
      recorded++;
    } catch {
      // Duplicate deterministic id (already recorded) or a transient write
      // error — best-effort: skip, never surface.
      skipped++;
    }
  }

  log(`kg-record: recorded ${recorded} coordination fact(s), skipped ${skipped}`);
  return { recorded, skipped };
}

// ---------------------------------------------------------------------------
// Real-time orchestration events (dispatch / completion)
//
// Recorded as they happen (not only at /learn) so the KG reflects live agent
// activity. These are distinct fact types from consensus verdicts (which /learn
// harvests), so there's no duplication. Deduped by deterministic id.
// ---------------------------------------------------------------------------

/** A live orchestration event worth remembering in the graph. */
export interface OrchestrationEvent {
  type: 'dispatch' | 'completion';
  /** Unique-per-event id (e.g. dispatch sidecar basename, task_complete msg id). */
  eventId: string;
  /** Agent the fact is attributed to (assignee / author). */
  agentId: string;
  taskId?: string;
  sprint?: number;
  /** Human-readable fact text. */
  text: string;
}

async function resolveKg(
  workspaceRoot: string,
  deps: RecordCoordinationDeps | undefined,
  log: LogFn,
): Promise<KnowledgeGraph | null> {
  try {
    if (deps?.getKg) { return await deps.getKg(); }
    const { getKnowledgeGraph } = await import('./kg/service');
    return getKnowledgeGraph({ workspaceRoot }).kg;
  } catch (err) {
    log(`kg-record: KG unavailable — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Record live orchestration events (dispatch / completion) as durable KG
 * `observation` thoughts. Best-effort, degrade-safe, deduped by a deterministic
 * id (`<type>:<project>:<eventId>`). Never throws.
 */
export async function recordOrchestrationEventsToKg(
  workspaceRoot: string,
  events: OrchestrationEvent[],
  opts: { log?: LogFn; deps?: RecordCoordinationDeps } = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  const list = (events ?? []).filter(
    (e) => e && typeof e.eventId === 'string' && e.eventId !== '' && typeof e.agentId === 'string' && e.agentId !== '',
  );
  if (list.length === 0) {
    return { recorded: 0, skipped: 0 };
  }
  const project = resolveProjectKey(workspaceRoot);
  const kg = await resolveKg(workspaceRoot, opts.deps, log);
  if (!kg) {
    return { recorded: 0, skipped: list.length };
  }

  let recorded = 0;
  let skipped = 0;
  for (const e of list) {
    try {
      await kg.recordThought({
        id: `${e.type}:${project}:${e.eventId}`,
        project,
        agent: e.agentId,
        task_id: e.taskId,
        kind: 'observation',
        text: e.text,
        meta: { source: e.type, sprint: e.sprint },
      });
      recorded++;
    } catch {
      skipped++; // duplicate id (already recorded) or transient — best-effort
    }
  }
  log(`kg-record: recorded ${recorded} ${list[0].type} event(s), skipped ${skipped}`);
  return { recorded, skipped };
}

/** Facts mined by a `/learn` run that are worth promoting into the graph. */
export interface LearningFacts {
  /** Successful workflow patterns (best first). */
  workflows?: WorkflowPattern[];
  /** Review findings harvested from the comms tree. */
  findings?: ReviewFinding[];
}

/**
 * Promote a `/learn` run's mined learnings — successful workflow patterns and
 * review findings — into the KG as durable `finding` thoughts, so kg.search and
 * the viewer surface real, queryable knowledge beyond consensus decisions. This
 * is how the graph gets fed from intelligence we ALREADY compute each `/learn`.
 *
 * Same contract as {@link recordCoordinationToKg}: degrade-safe (missing/degraded
 * KG records nothing), deterministic ids (a pattern/finding already recorded in a
 * prior run is silently skipped), never throws, never blocks the caller.
 */
export async function recordLearningsToKg(
  workspaceRoot: string,
  facts: LearningFacts,
  opts: { log?: LogFn; deps?: RecordCoordinationDeps; maxWorkflows?: number; maxFindings?: number } = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  const workflows = (facts.workflows ?? []).slice(0, opts.maxWorkflows ?? 8);
  const findings = (facts.findings ?? []).slice(0, opts.maxFindings ?? 20);
  if (workflows.length === 0 && findings.length === 0) {
    return { recorded: 0, skipped: 0 };
  }

  const project = resolveProjectKey(workspaceRoot);

  let kg: KnowledgeGraph;
  try {
    if (opts.deps?.getKg) {
      kg = await opts.deps.getKg();
    } else {
      const { getKnowledgeGraph } = await import('./kg/service');
      kg = getKnowledgeGraph({ workspaceRoot }).kg;
    }
  } catch (err) {
    log(`kg-record: KG unavailable — ${(err as Error).message}`);
    return { recorded: 0, skipped: workflows.length + findings.length };
  }

  let recorded = 0;
  let skipped = 0;

  for (const w of workflows) {
    if (!w || !Array.isArray(w.sequence) || w.sequence.length === 0) { skipped++; continue; }
    try {
      await kg.recordThought({
        id: `workflow:${project}:${hashId(w.sequence.join('|'))}`,
        project,
        agent: LEARN_AGENT,
        kind: 'finding',
        text: workflowPatternLabel(w),
        meta: {
          source: 'workflow',
          shipRate: w.shipRate,
          shipped: w.shipped,
          discarded: w.discarded,
          total: w.total,
          sequence: w.sequence,
        },
      });
      recorded++;
    } catch {
      skipped++; // duplicate id (already recorded) or transient — best-effort
    }
  }

  for (const f of findings) {
    if (!f || typeof f.description !== 'string' || f.description.trim() === '') { skipped++; continue; }
    try {
      await kg.recordThought({
        id: `finding:${project}:${hashId((f.from ?? '') + '|' + f.description)}`,
        project,
        agent: f.from || LEARN_AGENT,
        kind: 'finding',
        text: f.description,
        meta: { source: 'review', from: f.from, severity: f.severity },
      });
      recorded++;
    } catch {
      skipped++;
    }
  }

  log(`kg-record: recorded ${recorded} learning fact(s), skipped ${skipped}`);
  return { recorded, skipped };
}

// ---------------------------------------------------------------------------
// Outcome edges (A — the KG half of "outcome -> { reputation row + KG edge }")
//
// A task completion is already an event (recordTaskOutcome -> reputation ledger).
// This is the KG sink of the SAME event: it materializes structural entity nodes
// (agent / task / capability) and the edges between them. EVENT-driven — called
// at the outcome site, NOT from a 30s poll. See docs/specs/kg-edge-outcome-contract.md.
//
// Schema reality: the KG `edges` PK is (from_id, kind, to_id) and traverseFrom
// joins edges -> thoughts, so edge endpoints MUST be thought ids. We therefore
// materialize lightweight entity-node thoughts and relate those.
// ---------------------------------------------------------------------------

/** The minimal outcome shape this needs. The caller maps the reputation Outcome. */
export interface OutcomeEdgeInput {
  taskId: string;
  /** The assignee/author the completion is attributed to. */
  agentId: string;
  verdict?: string;
  gatePassed?: boolean;
  resolvedAt?: string;
  /** Distinct reviewers who voted (the assignee is filtered out). */
  reviewers?: string[];
  /** Capabilities demonstrated — mirrors the per-capability reputation the router uses. */
  capabilities?: string[];
}

/** Stable thought ids for the entity nodes. */
function agentNodeId(agent: string): string { return `agent:${agent}`; }
function taskNodeId(project: string, taskId: string): string { return `task:${project}:${taskId}`; }
function capNodeId(cap: string): string { return `capability:${cap}`; }

/**
 * Materialize the outcome's entity nodes + structural edges in the KG.
 *
 * Degrade-safe (no/degraded KG -> no-op), never throws, never blocks the outcome
 * path. Nodes are idempotent by deterministic thought id (duplicate INSERT throws
 * -> swallowed); edges are idempotent by the (from, kind, to) PK (INSERT OR REPLACE
 * refreshes meta — the structural fact is singular, its verdict is its current
 * state). The returned counts reflect write attempts; dedup is enforced by the
 * store, so re-running never grows the graph.
 */
export async function recordOutcomeEdge(
  workspaceRoot: string,
  outcome: OutcomeEdgeInput,
  opts: { log?: LogFn; deps?: RecordCoordinationDeps } = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  if (!outcome || typeof outcome.taskId !== 'string' || outcome.taskId === '' ||
      typeof outcome.agentId !== 'string' || outcome.agentId === '') {
    return { recorded: 0, skipped: 0 };
  }

  const project = resolveProjectKey(workspaceRoot);

  let kg: KnowledgeGraph;
  try {
    if (opts.deps?.getKg) {
      kg = await opts.deps.getKg();
    } else {
      const { getKnowledgeGraph } = await import('./kg/service');
      kg = getKnowledgeGraph({ workspaceRoot }).kg;
    }
  } catch (err) {
    log(`kg-record: KG unavailable — ${(err as Error).message}`);
    return { recorded: 0, skipped: 1 };
  }

  let recorded = 0;
  let skipped = 0;

  // ensureNode: best-effort entity-node thought; duplicate id is a no-op (exists).
  const ensureNode = async (id: string, kind: string, text: string, meta: Record<string, unknown>): Promise<void> => {
    try {
      await kg.recordThought({ id, project, agent: 'orchestrator', kind, text, meta });
      recorded++;
    } catch {
      skipped++; // already exists (deterministic id) or transient
    }
  };
  const relate = async (from: string, kind: string, to: string, meta: Record<string, unknown>): Promise<void> => {
    try {
      await kg.recordRelation(from, kind, to, meta);
      recorded++;
    } catch {
      skipped++;
    }
  };

  const resolvedAt = outcome.resolvedAt ?? new Date().toISOString();
  const agentId = agentNodeId(outcome.agentId);
  const taskId = taskNodeId(project, outcome.taskId);

  await ensureNode(agentId, 'agent', outcome.agentId, { entity: 'agent' });
  await ensureNode(taskId, 'task', outcome.taskId, { entity: 'task', project });

  // agent --completed--> task
  await relate(agentId, 'completed', taskId, {
    verdict: outcome.verdict,
    gate_passed: outcome.gatePassed,
    resolved_at: resolvedAt,
  });

  // agent --reviewed--> task, for each distinct reviewer (not the assignee)
  for (const reviewer of outcome.reviewers ?? []) {
    if (!reviewer || reviewer === outcome.agentId) { continue; }
    const rId = agentNodeId(reviewer);
    await ensureNode(rId, 'agent', reviewer, { entity: 'agent' });
    await relate(rId, 'reviewed', taskId, { resolved_at: resolvedAt });
  }

  // agent --demonstrated--> capability, for each capability the outcome credits
  for (const cap of outcome.capabilities ?? []) {
    if (!cap) { continue; }
    const cId = capNodeId(cap);
    await ensureNode(cId, 'capability', cap, { entity: 'capability' });
    await relate(agentId, 'demonstrated', cId, { verdict: outcome.verdict, resolved_at: resolvedAt });
  }

  log(`kg-record: outcome edges for ${outcome.taskId} — recorded ${recorded}, skipped ${skipped}`);
  return { recorded, skipped };
}

// ---------------------------------------------------------------------------
// Lifecycle events (KG-P2) — per-task-lifecycle-event thought + edges.
//
// The activity-log plane that sits alongside the structural entity-node plane
// materialized by recordOutcomeEdge. Each lifecycle event (created / claimed /
// progress / review / blocked / done / spawned …) becomes ONE deterministically
// keyed `thought` plus an `activity` edge from the task node to that thought, so
// `traverseFrom(task:<p>:<id>, ['activity'])` yields the timeline and
// `thoughtsForTask(id)` reads it directly. Same degrade-safe, never-throw,
// deterministic-id-deduped contract as the writers above. See
// docs/specs/kg-board-provenance/spec.md §4.1/§4.2.
// ---------------------------------------------------------------------------

/** A caller-supplied structural edge to write alongside a lifecycle thought. */
export interface LifecycleEdge {
  from: string;
  kind: string;
  to: string;
  meta?: Record<string, unknown>;
}

/** A single task-lifecycle event to materialize in the KG. */
export interface LifecycleEvent {
  /** The board task id this event belongs to (join key). */
  taskId: string;
  /** Numeric/string sprint; stringified into the TEXT `thoughts.sprint` column. */
  sprint?: string | number;
  /** Actor the event is attributed to (agent id / `orchestrator` / …). */
  agent: string;
  /** Lifecycle kind: created | claimed | progress | review | blocked | done | spawned | … */
  kind: string;
  /** Human-readable fact text. */
  text: string;
  /**
   * Stable natural key of the underlying event (message id, claim basename,
   * handoff session_id, dispatch sidecar basename, …). Combined with
   * project/taskId/kind into the deterministic thought id so a re-processed
   * event never double-writes.
   */
  discriminator: string;
  /** Extra thought metadata (source, message_id, from/to, …). */
  meta?: Record<string, unknown>;
  /** Additional structural edges (spawned_by / derived_from / implements / blocks). */
  edges?: LifecycleEdge[];
}

/** Deterministic, dedup-stable id for a lifecycle thought. */
export function lifecycleThoughtId(
  project: string,
  taskId: string,
  kind: string,
  discriminator: string,
): string {
  return `evt:${project}:${taskId}:${kind}:${discriminator}`;
}

/**
 * Materialize a single task-lifecycle event: ensure the `task:<project>:<taskId>`
 * entity node, write the lifecycle thought under its deterministic id, then the
 * `activity` edge (task node → thought) plus any caller-supplied structural
 * edges.
 *
 * Degrade-safe (no/degraded KG → no-op), never throws, never blocks the protocol
 * step it hooks. The lifecycle thought is idempotent by deterministic id
 * (duplicate INSERT throws → swallowed → counted as skipped); edges are
 * idempotent by their (from, kind, to) PK (INSERT OR REPLACE). Re-processing the
 * same event never grows the graph. Returns write-attempt counts.
 */
export async function recordLifecycleEventToKg(
  workspaceRoot: string,
  event: LifecycleEvent,
  opts: { log?: LogFn; deps?: RecordCoordinationDeps } = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  if (
    !event ||
    typeof event.taskId !== 'string' || event.taskId === '' ||
    typeof event.agent !== 'string' || event.agent === '' ||
    typeof event.kind !== 'string' || event.kind === '' ||
    typeof event.discriminator !== 'string' || event.discriminator === ''
  ) {
    return { recorded: 0, skipped: 0 };
  }

  const project = resolveProjectKey(workspaceRoot);
  const kg = await resolveKg(workspaceRoot, opts.deps, log);
  if (!kg) {
    return { recorded: 0, skipped: 1 };
  }

  let recorded = 0;
  let skipped = 0;

  // ensureNode: best-effort entity-node thought; duplicate id is a no-op (exists).
  const ensureNode = async (id: string, kind: string, text: string, meta: Record<string, unknown>): Promise<void> => {
    try {
      await kg.recordThought({ id, project, agent: 'orchestrator', kind, text, meta });
      recorded++;
    } catch {
      skipped++; // already exists (deterministic id) or transient
    }
  };
  const relate = async (from: string, kind: string, to: string, meta?: Record<string, unknown>): Promise<void> => {
    try {
      await kg.recordRelation(from, kind, to, meta);
      recorded++;
    } catch {
      skipped++;
    }
  };

  const taskNode = taskNodeId(project, event.taskId);
  await ensureNode(taskNode, 'task', event.taskId, { entity: 'task', project });

  // The lifecycle thought itself (the activity-log row).
  const thoughtId = lifecycleThoughtId(project, event.taskId, event.kind, event.discriminator);
  let thoughtWritten = false;
  try {
    await kg.recordThought({
      id: thoughtId,
      project,
      agent: event.agent,
      sprint: event.sprint === undefined || event.sprint === null ? undefined : String(event.sprint),
      task_id: event.taskId,
      kind: event.kind,
      text: event.text,
      meta: event.meta,
    });
    recorded++;
    thoughtWritten = true;
  } catch {
    skipped++; // duplicate deterministic id (already recorded) or transient
  }

  // activity edge task node → lifecycle thought (links the timeline). Written
  // even on a duplicate thought so a graph missing the edge (e.g. from an older
  // rollout) self-heals; the edge PK makes the re-write a no-op.
  await relate(taskNode, 'activity', thoughtId, { kind: event.kind });

  // Caller-supplied structural edges (spawned_by / derived_from / implements / blocks).
  for (const e of event.edges ?? []) {
    if (!e || !e.from || !e.kind || !e.to) { continue; }
    await relate(e.from, e.kind, e.to, e.meta);
  }

  log(
    `kg-record: lifecycle ${event.kind} for ${event.taskId} — ` +
      `${thoughtWritten ? 'recorded' : 'skipped(dup)'}, edges ${1 + (event.edges?.length ?? 0)}`,
  );
  return { recorded, skipped };
}

// ---------------------------------------------------------------------------
// Backfill (KG-P4) — one-shot ingest of the provenance trail already on disk.
//
// Walks the artifacts a normal project already produces (handoff sidecars +
// the sprint/catalog task list) and maps each to a lifecycle thought via
// recordLifecycleEventToKg, so idempotency (deterministic id) and edges come for
// free. Re-running never grows the graph. Guards every parse; best-effort per
// record; bounded per source. See docs/specs/kg-board-provenance/spec.md §4.5.
// ---------------------------------------------------------------------------

/** Options for {@link backfillTaskProvenance}. */
export interface BackfillProvenanceOpts {
  log?: LogFn;
  deps?: RecordCoordinationDeps;
  /** Max records ingested per source (safety cap for a large first run). Default 500. */
  maxPerSource?: number;
}

/** Node id for a `spec:<req-id>` requirement node (implements-edge endpoint). */
function specNodeId(reqId: string): string { return `spec:${reqId}`; }

/**
 * A best-effort JSON reader that returns null on any read/parse failure — the
 * backfill skips malformed artifacts rather than aborting the whole walk.
 */
function readJsonSafe<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Extract a spec/requirement id a task references, if any. Honest: only reads an
 * EXPLICIT field (`spec` / `req` / `requirement` / `implements`) — it does not
 * fabricate a req id from the title, so the `implements` edge fires only when the
 * catalog actually carries one.
 */
function taskSpecRef(task: Record<string, unknown>): string | undefined {
  for (const key of ['spec', 'req', 'requirement', 'implements']) {
    const v = task[key];
    if (typeof v === 'string' && v.trim() !== '') { return v.trim(); }
  }
  return undefined;
}

/**
 * One-shot: populate the KG from the provenance artifacts already on disk under
 * `<workspaceRoot>/.autoclaw/orchestrator`. Sources:
 *
 *  - Handoff sidecars (`comms/handoffs/*.json`, schema {@link HandoffNote}) →
 *    a `done` lifecycle thought (discriminator = `session_id`), plus a
 *    `derived_from` edge to the `next_task_suggested` task when set.
 *  - Catalog tasks (`state.json` `tasks[]`) → a `created` lifecycle thought per
 *    task (discriminator = task id), plus an `implements` edge to a
 *    `spec:<req-id>` node when the task carries a spec/req id.
 *
 * Consensus is intentionally NOT replayed here — `recordCoordinationToKg`
 * already owns that plane. Degrade-safe, never throws; returns aggregate
 * `{ recorded, skipped }` across all sources (record-level, matching the other
 * writers).
 */
export async function backfillTaskProvenance(
  workspaceRoot: string,
  opts: BackfillProvenanceOpts = {},
): Promise<RecordCoordinationResult> {
  const log = opts.log ?? noop;
  const cap = opts.maxPerSource && opts.maxPerSource > 0 ? Math.floor(opts.maxPerSource) : 500;
  const project = resolveProjectKey(workspaceRoot);
  const orch = path.join(workspaceRoot, '.autoclaw', 'orchestrator');

  let recorded = 0;
  let skipped = 0;
  const bump = (r: RecordCoordinationResult): void => { recorded += r.recorded; skipped += r.skipped; };

  // Resolve the KG once so `spec:<req-id>` endpoint nodes can be ensured under
  // their EXACT id (the lifecycle writer builds `evt:*` ids, so it can't stamp a
  // bare `spec:*` id). Degrade-safe: a null KG just means the ensures no-op and
  // the implements edge is still stored (it simply won't hydrate in a traversal).
  const kg = await resolveKg(workspaceRoot, opts.deps, log);
  const ensureSpecNode = async (reqId: string): Promise<void> => {
    if (!kg) { return; }
    try {
      await kg.recordThought({
        id: specNodeId(reqId),
        project,
        agent: 'orchestrator',
        kind: 'spec',
        text: `Spec/requirement ${reqId}.`,
        meta: { entity: 'spec', source: 'catalog' },
      });
      recorded++;
    } catch {
      skipped++; // already exists (deterministic id) or transient
    }
  };

  // ---- Source 1: handoff sidecars → `done` thoughts (+ derived_from) --------
  const handoffsDir = path.join(orch, 'comms', 'handoffs');
  let handoffFiles: string[] = [];
  try {
    handoffFiles = fs.readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
  } catch {
    /* dir absent — nothing to backfill from handoffs */
  }
  let hCount = 0;
  for (const file of handoffFiles) {
    if (hCount >= cap) { break; }
    const note = readJsonSafe<HandoffNote>(path.join(handoffsDir, file));
    if (!note || typeof note.task_id !== 'string' || note.task_id === '') { skipped++; continue; }
    hCount++;
    const discriminator = (typeof note.session_id === 'string' && note.session_id) || file;
    const edges: LifecycleEdge[] = [];
    if (typeof note.next_task_suggested === 'string' && note.next_task_suggested.trim() !== '') {
      // task B (next) derived_from task A (this note) — endpoints are task nodes.
      edges.push({
        from: taskNodeId(project, note.next_task_suggested.trim()),
        kind: 'derived_from',
        to: taskNodeId(project, note.task_id),
        meta: { reason: 'handoff next_task_suggested' },
      });
    }
    bump(await recordLifecycleEventToKg(workspaceRoot, {
      taskId: note.task_id,
      agent: note.agent_id || 'orchestrator',
      kind: 'done',
      text: note.summary && note.summary.trim() !== '' ? note.summary : `Task ${note.task_id} completed.`,
      discriminator,
      meta: {
        source: 'handoff',
        session_id: note.session_id,
        branch: note.branch,
        files_changed: Array.isArray(note.files_changed) ? note.files_changed.length : undefined,
        next_task_suggested: note.next_task_suggested,
      },
      edges,
    }, { log, deps: opts.deps }));
  }

  // ---- Source 2: catalog tasks (state.json) → `created` thoughts -----------
  const state = readJsonSafe<{ tasks?: Array<Record<string, unknown>> }>(path.join(orch, 'state.json'));
  const tasks = Array.isArray(state?.tasks) ? state!.tasks! : [];
  let tCount = 0;
  for (const task of tasks) {
    if (tCount >= cap) { break; }
    const id = typeof task.id === 'string' ? task.id : '';
    if (id === '') { skipped++; continue; }
    tCount++;
    const title = typeof task.title === 'string' && task.title.trim() !== '' ? task.title : id;
    const sprint = typeof task.sprint === 'number' || typeof task.sprint === 'string' ? task.sprint : undefined;
    const specRef = taskSpecRef(task);
    const edges: LifecycleEdge[] = [];
    if (specRef) {
      edges.push({
        from: taskNodeId(project, id),
        kind: 'implements',
        to: specNodeId(specRef),
        meta: { source: 'catalog' },
      });
    }
    // ensureNode the spec target so the `implements` endpoint resolves in a
    // traversal (traverseFrom only hydrates edge endpoints that are thought ids).
    if (specRef) {
      await ensureSpecNode(specRef);
    }
    bump(await recordLifecycleEventToKg(workspaceRoot, {
      taskId: id,
      sprint,
      agent: 'orchestrator',
      kind: 'created',
      text: `Task ${id} created: ${title}`,
      discriminator: id,
      meta: {
        source: 'catalog',
        status: task.status,
        sprint,
        spec: specRef,
      },
      edges,
    }, { log, deps: opts.deps }));
  }

  log(`kg-record: backfillTaskProvenance — ${hCount} handoff(s), ${tCount} task(s); recorded ${recorded}, skipped ${skipped}`);
  return { recorded, skipped };
}
