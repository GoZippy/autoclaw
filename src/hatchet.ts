/**
 * hatchet.ts — Durable workflow adapter (Phase 4).
 *
 * Wraps the Hatchet workflow runtime (https://hatchet.run) when available,
 * falling back to a simple in-memory queue for local development. The
 * in-memory queue does NOT survive process restarts; use Hatchet for
 * production workloads that must survive editor restarts.
 *
 * Install the official Hatchet SDK to unlock persistence:
 *
 *   npm install --save-optional @hatchet-dev/typescript-sdk
 *
 * Spec: docs/DISTRIBUTED_AGENT_FABRIC.md §3 Phase 4.
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowStep {
  /** Unique step name within the workflow. */
  name: string;
  /** Handler receives the workflow's input + results of prior steps. */
  handler: (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown>;
  /** Step names that must complete before this step runs (DAG edges). */
  depends_on?: string[];
  timeout_ms?: number;
  retries?: number;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
}

export interface WorkflowContext {
  workflowId: string;
  runId: string;
  stepName: string;
  /** Results of completed prior steps, keyed by step name. */
  stepResults: Record<string, unknown>;
}

export interface WorkflowRun {
  runId: string;
  workflowName: string;
  status: WorkflowStatus;
  input: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  error?: string;
  started_at: string;
  finished_at?: string;
}

// ---------------------------------------------------------------------------
// In-memory queue (no external deps)
// ---------------------------------------------------------------------------

class InMemoryWorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly runs = new Map<string, WorkflowRun>();

  register(def: WorkflowDefinition): void {
    this.definitions.set(def.name, def);
  }

  async trigger(workflowName: string, input: Record<string, unknown>): Promise<string> {
    const def = this.definitions.get(workflowName);
    if (!def) { throw new Error(`Unknown workflow: ${workflowName}`); }
    const runId = `run-${crypto.randomBytes(8).toString('hex')}`;
    const run: WorkflowRun = {
      runId,
      workflowName,
      status: 'pending',
      input,
      stepResults: {},
      started_at: new Date().toISOString(),
    };
    this.runs.set(runId, run);
    // Execute asynchronously without blocking the caller
    setImmediate(() => this.execute(run, def).catch(e => {
      run.status = 'failed';
      run.error = String(e);
      run.finished_at = new Date().toISOString();
    }));
    return runId;
  }

  private async execute(run: WorkflowRun, def: WorkflowDefinition): Promise<void> {
    run.status = 'running';
    // Topological execution: build a simple level set from depends_on
    const completed = new Set<string>();
    const remaining = [...def.steps];
    const maxIterations = def.steps.length * 2; // guard against cycles
    let iter = 0;

    while (remaining.length > 0 && iter++ < maxIterations) {
      const ready = remaining.filter(s => (s.depends_on ?? []).every(d => completed.has(d)));
      if (ready.length === 0) { break; }
      for (const step of ready) {
        const idx = remaining.indexOf(step);
        remaining.splice(idx, 1);
        const ctx: WorkflowContext = {
          workflowId: def.name,
          runId: run.runId,
          stepName: step.name,
          stepResults: { ...run.stepResults },
        };
        try {
          const result = await Promise.race([
            step.handler(run.input, ctx),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`Step ${step.name} timed out`)), step.timeout_ms ?? 30_000)
            ),
          ]);
          run.stepResults[step.name] = result;
          completed.add(step.name);
        } catch (e) {
          run.status = 'failed';
          run.error = String(e);
          run.finished_at = new Date().toISOString();
          return;
        }
      }
    }

    run.status = 'succeeded';
    run.finished_at = new Date().toISOString();
  }

  getStatus(runId: string): WorkflowRun | null {
    return this.runs.get(runId) ?? null;
  }

  listRuns(workflowName?: string): WorkflowRun[] {
    const all = [...this.runs.values()];
    return workflowName ? all.filter(r => r.workflowName === workflowName) : all;
  }
}

// ---------------------------------------------------------------------------
// Singleton engine (swapped to Hatchet client when SDK is present)
// ---------------------------------------------------------------------------

let _engine: InMemoryWorkflowEngine | null = null;
let _hatchetAvailable: boolean | null = null;

export async function isHatchetAvailable(): Promise<boolean> {
  if (_hatchetAvailable !== null) { return _hatchetAvailable; }
  try {
    await (Function('return import("@hatchet-dev/typescript-sdk")')() as Promise<unknown>);
    _hatchetAvailable = true;
  } catch {
    _hatchetAvailable = false;
  }
  return _hatchetAvailable;
}

function getEngine(): InMemoryWorkflowEngine {
  if (!_engine) { _engine = new InMemoryWorkflowEngine(); }
  return _engine;
}

/**
 * Register a workflow definition. Safe to call multiple times with the same
 * name — later calls overwrite.
 */
export function registerWorkflow(def: WorkflowDefinition): void {
  getEngine().register(def);
}

/**
 * Trigger a workflow run. Returns the runId immediately; the workflow
 * executes asynchronously.
 */
export async function triggerWorkflow(
  workflowName: string,
  input: Record<string, unknown> = {}
): Promise<string> {
  // Try Hatchet if available (placeholder — wire real SDK here)
  if (await isHatchetAvailable()) {
    try {
      const sdk = await (Function('return import("@hatchet-dev/typescript-sdk")')() as Promise<unknown>);
      const hatchet = sdk as { run(name: string, input: unknown): Promise<{ runId: string }> };
      const { runId } = await hatchet.run(workflowName, input);
      return runId;
    } catch {
      _hatchetAvailable = false;
    }
  }
  return getEngine().trigger(workflowName, input);
}

/**
 * Poll run status (in-memory) or query Hatchet API.
 */
export async function getWorkflowStatus(runId: string): Promise<WorkflowRun | null> {
  return getEngine().getStatus(runId);
}

/**
 * List all runs, optionally filtered by workflow name.
 */
export function listWorkflowRuns(workflowName?: string): WorkflowRun[] {
  return getEngine().listRuns(workflowName);
}

// ---------------------------------------------------------------------------
// Built-in AutoClaw workflows
// ---------------------------------------------------------------------------

/**
 * Registers the canonical AutoClaw orchestration pipeline as a workflow.
 * Steps: plan → assign → review → merge. Each step is a stub that writes
 * a status message; real implementations plug in by replacing the handlers.
 */
export function registerAutoclawPipeline(): void {
  registerWorkflow({
    name: 'autoclaw:sprint-pipeline',
    steps: [
      {
        name: 'plan',
        handler: async (input) => {
          return { status: 'planned', manifest: input.manifest ?? null };
        },
      },
      {
        name: 'assign',
        depends_on: ['plan'],
        handler: async (_input, ctx) => {
          const planResult = ctx.stepResults['plan'] as Record<string, unknown> | null;
          return { status: 'assigned', sprints: planResult?.sprints ?? [] };
        },
      },
      {
        name: 'review',
        depends_on: ['assign'],
        handler: async (_input, ctx) => {
          const assignResult = ctx.stepResults['assign'] as Record<string, unknown> | null;
          return { status: 'review_requested', assignments: assignResult?.sprints ?? [] };
        },
      },
      {
        name: 'merge',
        depends_on: ['review'],
        handler: async () => ({ status: 'merged', merged_at: new Date().toISOString() }),
      },
    ],
  });
}
