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

import { LogFn } from './config';
import { resolveProjectKey } from './project';
import type { CoordinationSignals } from './coordinationSignals';
import type { KnowledgeGraph } from './kg/types';

/** Agent the orchestrator records coordination facts under. */
const COORD_AGENT = 'orchestrator';

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
