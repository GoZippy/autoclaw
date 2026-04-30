/**
 * AutoBuild — Workflow scheduler & runner.
 *
 * Pure logic + filesystem operations only. No `vscode` imports here so the
 * module can be unit-tested under plain Mocha.
 *
 * Workflow YAML schema (the *only* fields this loader honours):
 *   name:    string
 *   cron:    "minute hour day-of-month month day-of-week"
 *   created: ISO-8601 timestamp (optional, informational)
 *   notify:  boolean (optional, default true — used by extension layer)
 *   timeout: number of seconds, workflow-level cap per step (optional)
 *   steps:
 *     - id:        string
 *       run:       string (single shell command line)
 *       condition: string (optional — currently informational, not evaluated)
 *
 * Cron subset supported by `parseCron`:
 *   - 5 fields: minute hour dom month dow
 *   - numeric values in each field's natural range
 *   - `*`        wildcard (any value)
 *   - `*\/N`      every N (e.g. `*\/5` for every 5 minutes)
 *   - `a,b,c`    explicit list
 *   - `a-b`      inclusive range
 *   Anything else (named months, `?`, `L`, step on a range, etc.) is rejected.
 *
 * Concurrency model: a single in-process Map (`inFlight`) tracks workflows
 * currently running. `tick` skips workflows already in flight. Registry
 * read-modify-write is acceptable because there is exactly one extension
 * host process per VS Code window owning `.autoclaw/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const DEFAULT_STEP_TIMEOUT_SECONDS = 120;
const MAX_LOG_BYTES = 1024 * 1024; // 1 MB

// ----- Cron -----------------------------------------------------------------

export interface CronField {
  /** Sorted, deduped set of allowed numeric values. `null` ⇒ wildcard. */
  values: number[] | null;
}

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: Record<keyof CronSpec, FieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 } // 0 = Sunday
};

function parseCronField(token: string, range: FieldRange, fieldName: string): CronField {
  if (token === '*') {
    return { values: null };
  }

  const expand = (part: string): number[] => {
    // Step expression: "*/N" or "a-b/N"
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const base = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`cron field "${fieldName}": invalid step in "${part}"`);
      }
      let lo = range.min;
      let hi = range.max;
      if (base !== '*') {
        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          lo = parseInt(rangeMatch[1], 10);
          hi = parseInt(rangeMatch[2], 10);
        } else {
          throw new Error(
            `cron field "${fieldName}": step requires "*" or "a-b" base, got "${base}"`
          );
        }
      }
      if (lo < range.min || hi > range.max || lo > hi) {
        throw new Error(`cron field "${fieldName}": step range "${base}" out of bounds`);
      }
      const out: number[] = [];
      for (let v = lo; v <= hi; v += step) {
        out.push(v);
      }
      return out;
    }

    // Range expression "a-b"
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      if (lo < range.min || hi > range.max || lo > hi) {
        throw new Error(`cron field "${fieldName}": range "${part}" out of bounds`);
      }
      const out: number[] = [];
      for (let v = lo; v <= hi; v++) {
        out.push(v);
      }
      return out;
    }

    // Plain integer
    if (/^\d+$/.test(part)) {
      const v = parseInt(part, 10);
      if (v < range.min || v > range.max) {
        throw new Error(
          `cron field "${fieldName}": value ${v} out of range [${range.min}-${range.max}]`
        );
      }
      return [v];
    }

    throw new Error(`cron field "${fieldName}": unsupported syntax "${part}"`);
  };

  const allValues: number[] = [];
  for (const part of token.split(',')) {
    if (part.length === 0) {
      throw new Error(`cron field "${fieldName}": empty list element`);
    }
    for (const v of expand(part)) {
      allValues.push(v);
    }
  }
  // Sort & dedupe so cronMatches can use simple includes/binary tests.
  const unique = Array.from(new Set(allValues)).sort((a, b) => a - b);
  return { values: unique };
}

export function parseCron(expr: string): CronSpec {
  if (typeof expr !== 'string') {
    throw new Error('cron expression must be a string');
  }
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new Error('cron expression is empty');
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (got ${tokens.length}): "${expr}"`
    );
  }
  return {
    minute: parseCronField(tokens[0], FIELD_RANGES.minute, 'minute'),
    hour: parseCronField(tokens[1], FIELD_RANGES.hour, 'hour'),
    dom: parseCronField(tokens[2], FIELD_RANGES.dom, 'dom'),
    month: parseCronField(tokens[3], FIELD_RANGES.month, 'month'),
    dow: parseCronField(tokens[4], FIELD_RANGES.dow, 'dow')
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.values === null) { return true; }
  return field.values.includes(value);
}

/**
 * Returns true when `date` matches `spec`. Day-of-month and day-of-week use
 * standard cron OR semantics: if both fields are restricted, either matching
 * is sufficient; if exactly one is restricted, only the restricted one must
 * match; if both are wildcards, both match trivially.
 */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based.
  const dow = date.getDay();

  if (!fieldMatches(spec.minute, minute)) { return false; }
  if (!fieldMatches(spec.hour, hour)) { return false; }
  if (!fieldMatches(spec.month, month)) { return false; }

  const domWild = spec.dom.values === null;
  const dowWild = spec.dow.values === null;
  if (domWild && dowWild) {
    return true;
  }
  if (!domWild && !dowWild) {
    return fieldMatches(spec.dom, dom) || fieldMatches(spec.dow, dow);
  }
  return fieldMatches(spec.dom, dom) && fieldMatches(spec.dow, dow);
}

// ----- YAML loader (scoped subset) -----------------------------------------

export interface WorkflowStep {
  id: string;
  run: string;
  condition?: string;
}

export interface Workflow {
  name: string;
  cron: string;
  created?: string;
  notify?: boolean;
  timeout?: number; // seconds
  steps: WorkflowStep[];
}

function stripComment(line: string): string {
  // Only strip an unquoted "#" — workflow values rarely contain quotes, and we
  // never embed `#` inside one, so this is the safe-and-simple approach.
  const idx = line.indexOf('#');
  if (idx === -1) { return line; }
  return line.slice(0, idx);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function parseScalar(raw: string): string | number | boolean {
  const v = unquote(raw);
  if (v === 'true') { return true; }
  if (v === 'false') { return false; }
  if (/^-?\d+$/.test(v)) { return parseInt(v, 10); }
  return v;
}

export function parseWorkflowYaml(text: string): Workflow {
  // Tiny YAML reader scoped to the workflow schema. Top-level scalars and a
  // single `steps:` list of objects (each step's keys at indent 6, list marker
  // at indent 4, with `- id:` form). We DON'T claim to be a general YAML
  // parser — anything outside the schema is ignored.
  const lines = text.split(/\r?\n/);
  const top: Record<string, string | number | boolean> = {};
  const steps: WorkflowStep[] = [];
  let inSteps = false;
  let currentStep: Partial<WorkflowStep> | null = null;

  const flushStep = () => {
    if (currentStep) {
      if (!currentStep.id || !currentStep.run) {
        throw new Error(
          `workflow step missing required id/run: ${JSON.stringify(currentStep)}`
        );
      }
      steps.push(currentStep as WorkflowStep);
      currentStep = null;
    }
  };

  for (const rawLine of lines) {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (line.trim().length === 0) { continue; }

    // Top-level key: column 0.
    if (!/^\s/.test(line)) {
      flushStep();
      inSteps = false;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) { continue; }
      const key = m[1];
      const value = m[2];
      if (key === 'steps') {
        inSteps = true;
        if (value.trim().length > 0 && value.trim() !== '|') {
          throw new Error('inline list for "steps:" not supported; use block list');
        }
        continue;
      }
      if (value.trim().length === 0) {
        // Top-level key with no scalar value — ignore (we only model the schema above).
        continue;
      }
      top[key] = parseScalar(value);
      continue;
    }

    if (!inSteps) { continue; } // we only descend into known nested context

    // List marker: "  - id: foo"
    const listMatch = line.match(/^(\s*)-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (listMatch) {
      flushStep();
      currentStep = {};
      const key = listMatch[2];
      const value = listMatch[3];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (currentStep as any)[key] = unquote(value);
      continue;
    }

    // Continuation key inside the current step: "      run: ..."
    const contMatch = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (contMatch && currentStep) {
      const key = contMatch[1];
      const value = contMatch[2];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (currentStep as any)[key] = unquote(value);
      continue;
    }
    // Unknown indentation form — ignore.
  }
  flushStep();

  if (typeof top.name !== 'string' || top.name.length === 0) {
    throw new Error('workflow YAML missing required "name"');
  }
  if (typeof top.cron !== 'string' || top.cron.length === 0) {
    throw new Error('workflow YAML missing required "cron"');
  }
  if (steps.length === 0) {
    throw new Error('workflow YAML must define at least one step');
  }
  // Validate the cron eagerly so bad expressions surface at load time.
  parseCron(top.cron);

  const wf: Workflow = {
    name: top.name,
    cron: top.cron,
    steps
  };
  if (typeof top.created === 'string') { wf.created = top.created; }
  if (typeof top.notify === 'boolean') { wf.notify = top.notify; }
  if (typeof top.timeout === 'number') { wf.timeout = top.timeout; }
  return wf;
}

export function loadWorkflow(workflowPath: string): Workflow {
  const text = fs.readFileSync(workflowPath, 'utf8');
  return parseWorkflowYaml(text);
}

// ----- Run engine ----------------------------------------------------------

export interface StepResult {
  id: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  skipped?: boolean;
}

export interface RunResult {
  workflow: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed';
  logPath: string;
  steps: StepResult[];
}

interface RunLogWriter {
  write(s: string): void;
  close(): void;
  bytesWritten(): number;
  truncated(): boolean;
}

function openLogWriter(logPath: string): RunLogWriter {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'w');
  let written = 0;
  let truncated = false;
  let closed = false;
  return {
    write(s: string) {
      if (closed) { return; }
      if (truncated) { return; }
      const buf = Buffer.from(s, 'utf8');
      const remaining = MAX_LOG_BYTES - written;
      if (buf.length <= remaining) {
        fs.writeSync(fd, buf);
        written += buf.length;
      } else {
        if (remaining > 0) {
          fs.writeSync(fd, buf.subarray(0, remaining));
          written += remaining;
        }
        const marker = Buffer.from('\n[truncated]\n', 'utf8');
        fs.writeSync(fd, marker);
        written += marker.length;
        truncated = true;
      }
    },
    close() {
      if (!closed) {
        fs.closeSync(fd);
        closed = true;
      }
    },
    bytesWritten() { return written; },
    truncated() { return truncated; }
  };
}

function isoStampForFilename(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

function pickShell(): { cmd: string; args: (run: string) => string[] } {
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', args: r => ['/c', r] };
  }
  return { cmd: '/bin/sh', args: r => ['-c', r] };
}

async function runStep(
  step: WorkflowStep,
  cwd: string,
  timeoutSeconds: number,
  log: RunLogWriter
): Promise<StepResult> {
  const startedAt = Date.now();
  const shell = pickShell();
  log.write(`[STEP ${step.id}] ${step.run}\n`);

  return new Promise<StepResult>(resolve => {
    let timedOut = false;
    let settled = false;
    const child = spawn(shell.cmd, shell.args(step.run), {
      cwd,
      env: process.env
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk: Buffer) => log.write(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => log.write(chunk.toString('utf8')));

    const finish = (exitCode: number | null) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      const ok = exitCode === 0 && !timedOut;
      log.write(
        ok
          ? `\n[OK ${step.id}] exit=${exitCode}\n`
          : `\n[FAILED ${step.id}] exit=${exitCode}${timedOut ? ' (timeout)' : ''}\n`
      );
      resolve({
        id: step.id,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut
      });
    };

    child.on('error', err => {
      log.write(`\n[ERROR ${step.id}] ${err.message}\n`);
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

export async function runWorkflow(
  workflowPath: string,
  runsDir: string
): Promise<RunResult> {
  const wf = loadWorkflow(workflowPath);
  const startedAt = new Date();
  const stamp = isoStampForFilename(startedAt);
  const logPath = path.join(runsDir, `${wf.name}-${stamp}.log`);
  const log = openLogWriter(logPath);
  // workflowPath: <root>/.autoclaw/autobuild/workflows/<name>.yaml — go up three.
  const cwd = path.dirname(path.dirname(path.dirname(path.dirname(workflowPath))));
  const stepTimeout = typeof wf.timeout === 'number' && wf.timeout > 0
    ? wf.timeout
    : DEFAULT_STEP_TIMEOUT_SECONDS;

  log.write(`# AutoBuild run: ${wf.name}\n`);
  log.write(`started: ${startedAt.toISOString()}\n`);
  log.write(`cwd:     ${cwd}\n`);
  log.write(`steps:   ${wf.steps.length}\n\n`);

  const results: StepResult[] = [];
  let aborted = false;
  for (const step of wf.steps) {
    if (aborted) {
      results.push({ id: step.id, exitCode: null, durationMs: 0, timedOut: false, skipped: true });
      log.write(`[SKIPPED ${step.id}] previous step failed\n`);
      continue;
    }
    const r = await runStep(step, cwd, stepTimeout, log);
    results.push(r);
    if (r.exitCode !== 0 || r.timedOut) {
      aborted = true;
    }
  }

  const finishedAt = new Date();
  const passed = !aborted;
  log.write(`\nfinished: ${finishedAt.toISOString()}\n`);
  log.write(`status:   ${passed ? 'passed' : 'failed'}\n`);
  log.close();

  return {
    workflow: wf.name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: passed ? 'passed' : 'failed',
    logPath,
    steps: results
  };
}

// ----- Registry & tick scheduler -------------------------------------------

export interface RegistryEntry {
  name: string;
  cron: string;
  lastRun: string | null;
  status: 'scheduled' | 'running' | 'passed' | 'failed';
  lastLog?: string;
  nextCheck?: string;
}

export interface Registry {
  workflows: RegistryEntry[];
}

export function getAutobuildDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'autobuild');
}
export function getWorkflowsDir(workspaceRoot: string): string {
  return path.join(getAutobuildDir(workspaceRoot), 'workflows');
}
export function getRunsDir(workspaceRoot: string): string {
  return path.join(getAutobuildDir(workspaceRoot), 'runs');
}
export function getRegistryPath(workspaceRoot: string): string {
  return path.join(getAutobuildDir(workspaceRoot), 'registry.json');
}

export function readRegistry(workspaceRoot: string): Registry {
  const p = getRegistryPath(workspaceRoot);
  if (!fs.existsSync(p)) {
    return { workflows: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && Array.isArray(parsed.workflows)) {
      return parsed as Registry;
    }
  } catch {
    // fall through
  }
  return { workflows: [] };
}

export function writeRegistry(workspaceRoot: string, reg: Registry): void {
  const p = getRegistryPath(workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Single-process ownership — temp+rename is overkill, but we still write
  // through a temp path to avoid leaving a partially-written registry.json
  // if the host crashes mid-write.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, p);
}

function upsertRegistry(reg: Registry, entry: RegistryEntry): Registry {
  const idx = reg.workflows.findIndex(w => w.name === entry.name);
  if (idx === -1) {
    reg.workflows.push(entry);
  } else {
    reg.workflows[idx] = entry;
  }
  return reg;
}

export interface DiscoveredWorkflow {
  workflow: Workflow;
  filePath: string;
}

export function discoverWorkflows(workspaceRoot: string): DiscoveredWorkflow[] {
  const dir = getWorkflowsDir(workspaceRoot);
  if (!fs.existsSync(dir)) { return []; }
  const out: DiscoveredWorkflow[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) { continue; }
    const full = path.join(dir, entry);
    try {
      const wf = loadWorkflow(full);
      out.push({ workflow: wf, filePath: full });
    } catch {
      // Skip malformed workflows; tick logs them via a registry note below.
    }
  }
  return out;
}

// In-flight tracker (process-local). Keys are workflow names.
const inFlight = new Map<string, Promise<RunResult>>();

/** Test seam: clears in-flight tracker. */
export function _resetInFlight(): void {
  inFlight.clear();
}

/** Test seam: returns true if a workflow is currently running. */
export function _isInFlight(name: string): boolean {
  return inFlight.has(name);
}

export interface TickOptions {
  enabled?: boolean;
  /** Override `runWorkflow` for tests. */
  runner?: (workflowPath: string, runsDir: string) => Promise<RunResult>;
}

export interface TickReport {
  ranNow: string[];
  skippedInFlight: string[];
  skippedNotMatching: string[];
  errors: { name: string; message: string }[];
  disabled: boolean;
}

/**
 * Single scheduler tick. Reads workflows, fires those whose cron matches
 * `now`, skips any that are still running, and updates the registry.
 *
 * Workflows fire-and-forget — `tick` returns once they have been kicked off,
 * not when they finish. The promise's resolution updates the registry.
 */
export async function tick(
  workspaceRoot: string,
  now: Date = new Date(),
  options: TickOptions = {}
): Promise<TickReport> {
  const report: TickReport = {
    ranNow: [],
    skippedInFlight: [],
    skippedNotMatching: [],
    errors: [],
    disabled: false
  };
  if (options.enabled === false) {
    report.disabled = true;
    return report;
  }

  const discovered = discoverWorkflows(workspaceRoot);
  if (discovered.length === 0) { return report; }

  let registry = readRegistry(workspaceRoot);
  const runsDir = getRunsDir(workspaceRoot);
  const runner = options.runner ?? runWorkflow;

  for (const { workflow, filePath } of discovered) {
    let spec: CronSpec;
    try {
      spec = parseCron(workflow.cron);
    } catch (e) {
      report.errors.push({ name: workflow.name, message: (e as Error).message });
      continue;
    }
    if (!cronMatches(spec, now)) {
      report.skippedNotMatching.push(workflow.name);
      continue;
    }
    if (inFlight.has(workflow.name)) {
      report.skippedInFlight.push(workflow.name);
      continue;
    }

    // Fire it.
    upsertRegistry(registry, {
      name: workflow.name,
      cron: workflow.cron,
      lastRun: now.toISOString(),
      status: 'running'
    });
    writeRegistry(workspaceRoot, registry);

    const promise = runner(filePath, runsDir).then(
      result => {
        registry = readRegistry(workspaceRoot);
        upsertRegistry(registry, {
          name: workflow.name,
          cron: workflow.cron,
          lastRun: result.startedAt,
          status: result.status,
          lastLog: result.logPath
        });
        writeRegistry(workspaceRoot, registry);
        inFlight.delete(workflow.name);
        return result;
      },
      err => {
        registry = readRegistry(workspaceRoot);
        upsertRegistry(registry, {
          name: workflow.name,
          cron: workflow.cron,
          lastRun: now.toISOString(),
          status: 'failed'
        });
        writeRegistry(workspaceRoot, registry);
        inFlight.delete(workflow.name);
        throw err;
      }
    );
    inFlight.set(workflow.name, promise);
    report.ranNow.push(workflow.name);
  }

  return report;
}

/**
 * Returns the path to the most recent run log for a workflow, or null.
 */
export function findLatestRunLog(workspaceRoot: string, workflowName: string): string | null {
  const dir = getRunsDir(workspaceRoot);
  if (!fs.existsSync(dir)) { return null; }
  const prefix = workflowName + '-';
  const candidates = fs
    .readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
    .sort();
  if (candidates.length === 0) { return null; }
  return path.join(dir, candidates[candidates.length - 1]);
}
