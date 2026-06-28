import * as fs from 'fs';
import * as path from 'path';

import type { FailureType } from '../diagnostics/failureTypes';
import {
  WORKFLOW_RUN_EVENT_SCHEMA,
  type WorkflowRunEvent,
  type WorkflowRunMetadata,
  type WorkflowRunStatus,
} from './types';

export const WORKFLOW_RUNS_DIR = path.join('.autoclaw', 'workflows', 'runs');
export const WORKFLOW_RUN_FILE = 'run.json';
export const WORKFLOW_EVENTS_FILE = 'events.jsonl';

export interface ReadWorkflowRunResult {
  metadata?: WorkflowRunMetadata;
  events: WorkflowRunEvent[];
  warnings: string[];
}

export interface WorkflowRunSummary {
  runId: string;
  workflowId?: string;
  status: WorkflowRunStatus | 'unknown';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  failureTypes: FailureType[];
  artifactCount: number;
  eventCount: number;
}

export function runDir(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, WORKFLOW_RUNS_DIR, runId);
}

export function runMetadataPath(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), WORKFLOW_RUN_FILE);
}

export function runEventsPath(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), WORKFLOW_EVENTS_FILE);
}

export async function writeRunMetadata(workspaceRoot: string, metadata: WorkflowRunMetadata): Promise<void> {
  const file = runMetadataPath(workspaceRoot, metadata.runId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
}

export async function appendRunEvent(workspaceRoot: string, event: WorkflowRunEvent): Promise<void> {
  const file = runEventsPath(workspaceRoot, event.runId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const record: WorkflowRunEvent = sanitizeRunEvent({
    ...event,
    schema: WORKFLOW_RUN_EVENT_SCHEMA,
  });
  await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function readRun(workspaceRoot: string, runId: string): Promise<ReadWorkflowRunResult> {
  const warnings: string[] = [];
  const metadata = await readMetadata(workspaceRoot, runId, warnings);
  const events = await readEvents(workspaceRoot, runId, warnings);
  return { metadata, events, warnings };
}

export async function listRuns(workspaceRoot: string): Promise<WorkflowRunMetadata[]> {
  const base = path.join(workspaceRoot, WORKFLOW_RUNS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: WorkflowRunMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const warnings: string[] = [];
    const metadata = await readMetadata(workspaceRoot, entry.name, warnings);
    if (metadata) {
      runs.push(metadata);
    }
  }
  return runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export async function summarizeRun(workspaceRoot: string, runId: string): Promise<WorkflowRunSummary> {
  const run = await readRun(workspaceRoot, runId);
  return summarizeRunRecords(runId, run.metadata, run.events);
}

export function summarizeRunRecords(
  runId: string,
  metadata: WorkflowRunMetadata | undefined,
  events: readonly WorkflowRunEvent[],
): WorkflowRunSummary {
  const startedAt = metadata?.startedAt ?? firstTimestamp(events);
  const completedAt = metadata?.completedAt ?? lastTerminalTimestamp(events);
  const status = metadata?.status ?? statusFromEvents(events);
  const failures = new Set<FailureType>();
  let artifactCount = 0;
  let costCents = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    if (event.failureType) {
      failures.add(event.failureType);
    }
    artifactCount += event.artifacts?.length ?? 0;
    costCents += event.tokens?.costCents ?? 0;
    inputTokens += event.tokens?.input ?? 0;
    outputTokens += event.tokens?.output ?? 0;
  }

  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = completedAt ? new Date(completedAt).getTime() : NaN;
  return {
    runId,
    workflowId: metadata?.workflowId,
    status,
    startedAt,
    completedAt,
    durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : undefined,
    costCents,
    inputTokens,
    outputTokens,
    failureTypes: [...failures].sort(),
    artifactCount,
    eventCount: events.length,
  };
}

async function readMetadata(workspaceRoot: string, runId: string, warnings: string[]): Promise<WorkflowRunMetadata | undefined> {
  try {
    const raw = await fs.promises.readFile(runMetadataPath(workspaceRoot, runId), 'utf8');
    return JSON.parse(raw) as WorkflowRunMetadata;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Failed to read run metadata for ${runId}: ${(err as Error).message}`);
    }
    return undefined;
  }
}

async function readEvents(workspaceRoot: string, runId: string, warnings: string[]): Promise<WorkflowRunEvent[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(runEventsPath(workspaceRoot, runId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Failed to read run events for ${runId}: ${(err as Error).message}`);
    }
    return [];
  }

  const events: WorkflowRunEvent[] = [];
  raw.replace(/^\uFEFF/, '').split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as WorkflowRunEvent;
      if (parsed.runId === runId && parsed.nodeId && parsed.event) {
        events.push(parsed);
      } else {
        warnings.push(`Skipped invalid event line ${index + 1} for ${runId}.`);
      }
    } catch {
      warnings.push(`Skipped corrupt event line ${index + 1} for ${runId}.`);
    }
  });
  return events;
}

function sanitizeRunEvent(event: WorkflowRunEvent): WorkflowRunEvent {
  return scrubSensitive(event) as WorkflowRunEvent;
}

function scrubSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSensitive);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (
      lowered.includes('prompt') ||
      lowered.includes('response') ||
      lowered.includes('secret') ||
      lowered.includes('apikey') ||
      lowered.includes('api_key') ||
      lowered.includes('authorization') ||
      lowered === 'token'
    ) {
      continue;
    }
    out[key] = scrubSensitive(child);
  }
  return out;
}

function firstTimestamp(events: readonly WorkflowRunEvent[]): string | undefined {
  return events[0]?.timestamp;
}

function lastTerminalTimestamp(events: readonly WorkflowRunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (['completed', 'failed', 'halted', 'human_required'].includes(events[i].event)) {
      return events[i].timestamp;
    }
  }
  return events[events.length - 1]?.timestamp;
}

function statusFromEvents(events: readonly WorkflowRunEvent[]): WorkflowRunStatus | 'unknown' {
  const last = events[events.length - 1];
  if (!last) {
    return 'unknown';
  }
  if (last.event === 'completed') {
    return 'completed';
  }
  if (last.event === 'failed') {
    return 'failed';
  }
  if (last.event === 'halted') {
    return 'halted';
  }
  if (last.event === 'human_required') {
    return 'human_required';
  }
  return 'running';
}
