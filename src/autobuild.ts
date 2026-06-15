/**
 * AutoBuild — Workflow scheduler & runner.
 *
 * Pure logic + filesystem operations only. No `vscode` imports here so the
 * module can be unit-tested under plain Mocha.
 *
 * (Emits an `autobuild_fail` hook event on a failed run via the leaf hookBus —
 * no heavy imports, no-op when no hooks runtime is registered.)
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
import { spawn, spawnSync } from 'child_process';
import { buildAutobuildFailEvent } from './hooks/hookEvents';
import { emitHookEvent } from './hooks/hookBus';

const DEFAULT_STEP_TIMEOUT_SECONDS = 120;
const MAX_LOG_BYTES = 1024 * 1024; // 1 MB per log
const DEFAULT_MAX_LOGS_PER_WORKFLOW = 50; // keep last N runs per workflow

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

export type StepMode = 'report' | 'fix';

export interface StepGuard {
  scope_globs: string[];
  max_files: number;
  require_clean_git: boolean;
  rollback_on: 'test_fail' | 'never';
}

export interface WorkflowStep {
  id: string;
  run: string;
  condition?: string;
  mode?: StepMode;
  guard?: StepGuard;
  verify?: string;
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
  const lines = text.split(/\r?\n/);
  const top: Record<string, string | number | boolean> = {};
  const steps: WorkflowStep[] = [];
  let inSteps = false;
  let currentStep: Partial<WorkflowStep> | null = null;
  let guardState: {
    inGuard: boolean;
    scope_globs: string[];
    max_files: number;
    require_clean_git: boolean;
    rollback_on: 'test_fail' | 'never';
  } | null = null;

  const flushGuard = () => {
    if (guardState && guardState.inGuard && currentStep) {
      currentStep.guard = {
        scope_globs: guardState.scope_globs,
        max_files: guardState.max_files,
        require_clean_git: guardState.require_clean_git,
        rollback_on: guardState.rollback_on,
      };
    }
    guardState = null;
  };

  const flushStep = () => {
    flushGuard();
    if (currentStep) {
      if (!currentStep.id || !currentStep.run) {
        throw new Error(
          `workflow step missing required id/run: ${JSON.stringify(currentStep)}`
        );
      }
      if (!currentStep.mode) currentStep.mode = 'report';
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
      if (value.trim().length === 0) { continue; }
      top[key] = parseScalar(value);
      continue;
    }

    if (!inSteps) { continue; }

    // Guard sub-key inside a step: deeper than the step keys (which sit at
    // 4 spaces), i.e. 6+ spaces, and a guard block is already open.
    if (guardState && guardState.inGuard && /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.test(line)) {
      const indent = line.length - line.trimStart().length;
      if (indent >= 6) {
        const gm = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
        if (gm) {
          const gk = gm[1];
          const gv = unquote(gm[2]);
          if (gk === 'scope_globs') {
            const raw = gv.trim();
            if (raw.startsWith('[') && raw.endsWith(']')) {
              // YAML array: ["src/**", "test/**"]
              guardState.scope_globs = raw.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
            } else {
              // Comma-separated: src/**, test/**
              guardState.scope_globs = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
            }
          } else if (gk === 'max_files') {
            guardState.max_files = parseInt(gv, 10);
            if (!Number.isFinite(guardState.max_files) || guardState.max_files <= 0) {
              throw new Error(`guard.max_files must be a positive integer, got "${gv}"`);
            }
          } else if (gk === 'require_clean_git') {
            guardState.require_clean_git = gv === 'true';
          } else if (gk === 'rollback_on') {
            if (gv !== 'test_fail' && gv !== 'never') {
              throw new Error(`guard.rollback_on must be "test_fail" or "never", got "${gv}"`);
            }
            guardState.rollback_on = gv;
          }
          continue;
        }
      }
    }

    // List marker: "  - id: foo"
    const listMatch = line.match(/^(\s*)-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (listMatch) {
      flushStep();
      currentStep = {};
      const key = listMatch[2];
      const value = listMatch[3];
      if (key === 'guard') {
        guardState = { inGuard: true, scope_globs: ['**/*'], max_files: 10, require_clean_git: true, rollback_on: 'test_fail' };
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (currentStep as any)[key] = unquote(value);
      }
      continue;
    }

    // Continuation key inside the current step
    const contMatch = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (contMatch && currentStep) {
      const key = contMatch[1];
      const value = unquote(contMatch[2]);
      if (key === 'mode') {
        if (value !== 'report' && value !== 'fix') {
          throw new Error(`step mode must be "report" or "fix", got "${value}"`);
        }
        currentStep.mode = value;
      } else if (key === 'guard') {
        guardState = { inGuard: true, scope_globs: ['**/*'], max_files: 10, require_clean_git: true, rollback_on: 'test_fail' };
      } else if (key === 'verify') {
        currentStep.verify = value;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (currentStep as any)[key] = value;
      }
      continue;
    }
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
  parseCron(top.cron);

  const wf: Workflow = {
    name: top.name,
    cron: top.cron,
    steps,
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

export type GuardVerdict = 'applied' | 'rejected_scope' | 'rejected_cap' | 'rejected_dirty' | 'rolled_back' | 'na';

export interface StepResult {
  id: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  skipped?: boolean;
  mode: StepMode;
  files_changed: string[];
  guard_verdict: GuardVerdict;
}

export interface RunResult {
  workflow: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed';
  logPath: string;
  steps: StepResult[];
  guardBlockRejected: number;
  guardRolledBack: number;
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

/**
 * Revert a guarded fix-step's changes (AB-2). Tracked modifications are
 * restored with `git checkout --`; files that were untracked BEFORE the step
 * but exist now (i.e. the step created them) are removed with `git clean -f`.
 * Reliable when the step ran against a clean tree (`require_clean_git: true`);
 * with a dirty tree it is best-effort and never touches paths the step did
 * not change. Returns true when the revert commands ran without error.
 */
function revertChanges(
  preImageUntracked: string[],
  cwd: string,
  log: RunLogWriter
): boolean {
  let ok = true;
  let reverted = 0;
  // Invoke git DIRECTLY (not through the shell) so file paths are passed as
  // discrete argv — no cmd.exe / sh quote mangling.
  const gitLines = (args: string[]): string[] => {
    const r = spawnSync('git', args, { cwd, env: process.env, timeout: 30_000 });
    return r.status === 0 && r.stdout ? r.stdout.toString().split(/\r?\n/).filter(Boolean) : [];
  };

  // Tracked files the step modified → restore to HEAD/index.
  const trackedModified = gitLines(['diff', '--name-only']);
  if (trackedModified.length > 0) {
    const co = spawnSync('git', ['checkout', '--', ...trackedModified], { cwd, env: process.env, timeout: 30_000 });
    if (co.status !== 0) { ok = false; } else { reverted += trackedModified.length; }
  }

  // Files the step newly created (untracked now, not untracked before) → remove.
  const newlyCreated = gitLines(['ls-files', '--others', '--exclude-standard'])
    .filter(f => !preImageUntracked.includes(f));
  if (newlyCreated.length > 0) {
    const cl = spawnSync('git', ['clean', '-f', '--', ...newlyCreated], { cwd, env: process.env, timeout: 30_000 });
    if (cl.status !== 0) { ok = false; } else { reverted += newlyCreated.length; }
  }

  log.write(`[ROLLBACK ${reverted} file(s)] ${ok ? 'reverted' : 'reverted with warnings'}\n`);
  return ok;
}

async function runStep(
  step: WorkflowStep,
  cwd: string,
  timeoutSeconds: number,
  log: RunLogWriter
): Promise<StepResult> {
  const startedAt = Date.now();
  const shell = pickShell();
  const mode = step.mode ?? 'report';
  const guard = step.guard;
  log.write(`[STEP ${step.id}] mode=${mode} ${step.run}\n`);

  const filesChanged: string[] = [];
  let guardVerdict: GuardVerdict = 'na';

  // ── Guard: require_clean_git ─────────────────────────────────────────
  if (mode === 'fix' && guard && guard.require_clean_git) {
    const gs = spawnSync(shell.cmd, shell.args('git status --porcelain'), { cwd, env: process.env, timeout: timeoutSeconds * 1000 });
    if (gs.status === 0 && gs.stdout && gs.stdout.toString().trim().length > 0) {
      guardVerdict = 'rejected_dirty';
      log.write(`[GUARD REJECTED ${step.id}] dirty working tree, require_clean_git\n`);
      return {
        id: step.id, exitCode: null, durationMs: Date.now() - startedAt,
        timedOut: false, mode, files_changed: [], guard_verdict: guardVerdict,
      };
    }
  }

  // ── Record pre-image for rollback ────────────────────────────────────
  // Untracked files that exist BEFORE the step runs — so a revert only deletes
  // files the step itself created, never pre-existing untracked files.
  let preImageUntracked: string[] = [];
  if (mode === 'fix' && guard) {
    const untrackedResult = spawnSync(shell.cmd, shell.args('git ls-files --others --exclude-standard'), { cwd, env: process.env, timeout: 10_000 });
    if (untrackedResult.status === 0 && untrackedResult.stdout) {
      preImageUntracked = untrackedResult.stdout.toString().split(/\r?\n/).filter(Boolean);
    }
  }

  return new Promise<StepResult>(resolve => {
    let timedOut = false;
    let settled = false;
    const child = spawn(shell.cmd, shell.args(step.run), {
      cwd,
      env: process.env,
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

      // ── Real files_changed from git diff ──────────────────────────────
      const filesChangedNow: string[] = [];
      if (mode === 'fix') {
        const diffResult = spawnSync(shell.cmd, shell.args('git diff --name-only'), { cwd, env: process.env, timeout: 10_000 });
        if (diffResult.status === 0 && diffResult.stdout) {
          filesChangedNow.push(...diffResult.stdout.toString().split(/\r?\n/).filter(Boolean));
        }
        const untrackedResult = spawnSync(shell.cmd, shell.args('git ls-files --others --exclude-standard'), { cwd, env: process.env, timeout: 10_000 });
        if (untrackedResult.status === 0 && untrackedResult.stdout) {
          filesChangedNow.push(...untrackedResult.stdout.toString().split(/\r?\n/).filter(Boolean));
        }
      }

      const done = (code: number | null, verdict: GuardVerdict) => {
        resolve({
          id: step.id, exitCode: code, durationMs: Date.now() - startedAt,
          timedOut, mode, files_changed: filesChangedNow, guard_verdict: verdict,
        });
      };

      // ── Guard: max_files cap → revert + reject ────────────────────────
      if (mode === 'fix' && guard && filesChangedNow.length > guard.max_files) {
        log.write(`[GUARD REJECTED ${step.id}] files_changed (${filesChangedNow.length}) > max_files (${guard.max_files})\n`);
        revertChanges(preImageUntracked, cwd, log);
        done(exitCode, 'rejected_cap');
        return;
      }

      // ── Guard: scope_globs → revert + reject ──────────────────────────
      if (mode === 'fix' && guard && guard.scope_globs && guard.scope_globs.length > 0) {
        const outOfScope = filesChangedNow.filter(f => {
          return !guard.scope_globs.some((pattern: string) => {
            if (pattern === '**/*' || pattern === '**') return true;
            if (pattern.includes('*')) {
              const regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
              return regex.test(f);
            }
            return f === pattern || f.startsWith(pattern.replace(/\/$/, ''));
          });
        });
        if (outOfScope.length > 0) {
          log.write(`[GUARD REJECTED ${step.id}] out-of-scope files: ${outOfScope.join(', ')}\n`);
          revertChanges(preImageUntracked, cwd, log);
          done(exitCode, 'rejected_scope');
          return;
        }
      }

      // ── Verify-gated rollback ─────────────────────────────────────────
      // Guards passed. If the step declares a verify command, run it; on
      // failure with rollback_on:'test_fail', revert the applied changes.
      if (mode === 'fix' && guard && step.verify && filesChangedNow.length > 0) {
        log.write(`[VERIFY ${step.id}] ${step.verify}\n`);
        const v = spawnSync(shell.cmd, shell.args(step.verify), { cwd, env: process.env, timeout: timeoutSeconds * 1000 });
        if (v.stdout) { log.write(v.stdout.toString()); }
        if (v.stderr) { log.write(v.stderr.toString()); }
        if (v.status !== 0) {
          if (guard.rollback_on === 'test_fail') {
            log.write(`[VERIFY FAILED ${step.id}] exit=${v.status} → rolling back\n`);
            revertChanges(preImageUntracked, cwd, log);
            done(v.status ?? 1, 'rolled_back');
            return;
          }
          // rollback_on: never — leave changes, but surface the verify failure.
          log.write(`[VERIFY FAILED ${step.id}] exit=${v.status} (rollback_on: never → changes kept)\n`);
          done(v.status ?? 1, 'applied');
          return;
        }
        log.write(`[VERIFY OK ${step.id}]\n`);
      }

      done(exitCode, mode === 'fix' && guard ? 'applied' : 'na');
    };

    child.on('error', err => {
      log.write(`\n[ERROR ${step.id}] ${err.message}\n`);
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

/**
 * Prunes old run logs for a single workflow, keeping the most recent
 * `keep` files (sorted lexicographically — log names embed an ISO stamp,
 * so this matches chronological order). Best-effort: any unlink error is
 * surfaced via the returned `errors` list but never throws.
 */
export function pruneRunLogs(
  runsDir: string,
  workflowName: string,
  keep: number = DEFAULT_MAX_LOGS_PER_WORKFLOW
): { kept: number; deleted: number; errors: string[] } {
  const result = { kept: 0, deleted: 0, errors: [] as string[] };
  if (keep <= 0 || !fs.existsSync(runsDir)) { return result; }
  const prefix = workflowName + '-';
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir).filter(f => f.startsWith(prefix) && f.endsWith('.log'));
  } catch (e) {
    result.errors.push((e as Error).message);
    return result;
  }
  entries.sort(); // ISO stamp sorts chronologically
  const toDelete = entries.length > keep ? entries.slice(0, entries.length - keep) : [];
  result.kept = entries.length - toDelete.length;
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(runsDir, f));
      result.deleted++;
    } catch (e) {
      result.errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  return result;
}

export async function runWorkflow(
  workflowPath: string,
  runsDir: string,
  options: { maxLogsPerWorkflow?: number } = {}
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
      results.push({ id: step.id, exitCode: null, durationMs: 0, timedOut: false, skipped: true, mode: step.mode ?? 'report', files_changed: [], guard_verdict: 'na' });
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

  // HKS-5: emit an autobuild_fail event for the first failed/timed-out step so
  // trigger hooks can react (notify / dispatch a fixer). Best-effort, in-process;
  // `cwd` is the workspace root. No-op when no hooks runtime is registered.
  if (!passed) {
    const failed = results.find(r => (r.exitCode !== 0 || r.timedOut) && !r.skipped);
    if (failed) {
      void emitHookEvent(buildAutobuildFailEvent(wf.name, failed.id, failed.exitCode), cwd);
    }
  }

  // Best-effort log pruning so the runs/ directory doesn't grow unbounded.
  const keep = typeof options.maxLogsPerWorkflow === 'number'
    ? options.maxLogsPerWorkflow
    : DEFAULT_MAX_LOGS_PER_WORKFLOW;
  pruneRunLogs(runsDir, wf.name, keep);

  const guardBlockRejected = results.filter(r => r.guard_verdict === 'rejected_dirty' || r.guard_verdict === 'rejected_scope' || r.guard_verdict === 'rejected_cap').length;
  const guardRolledBack = results.filter(r => r.guard_verdict === 'rolled_back').length;

  return {
    workflow: wf.name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: passed ? 'passed' : 'failed',
    logPath,
    steps: results,
    guardBlockRejected,
    guardRolledBack,
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

/**
 * Cross-process lockfile for AutoBuild registry/log writes. Multiple VS Code
 * windows opening the same workspace (e.g. on a network drive) would
 * otherwise race on `registry.json`. Lock is opportunistic: held briefly
 * while reading-modifying-writing the registry. Stale locks (PID no longer
 * alive, or lock older than `LOCK_STALE_MS`) are taken over.
 */
const LOCK_STALE_MS = 30_000;

interface LockInfo {
  pid: number;
  acquiredAt: number;
}

export function getLockPath(workspaceRoot: string): string {
  return path.join(getAutobuildDir(workspaceRoot), '.lock');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive)
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Try to acquire the AutoBuild lock. Returns true if acquired, false if
 * another live host holds it. Uses `wx` (exclusive create) so the check is
 * atomic at the filesystem level. Stale locks are removed first.
 */
export function tryAcquireLock(workspaceRoot: string): boolean {
  const lockPath = getLockPath(workspaceRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Sweep stale lock if present.
  try {
    const existingRaw = fs.readFileSync(lockPath, 'utf8');
    const existing = JSON.parse(existingRaw) as LockInfo;
    const ageMs = Date.now() - (existing.acquiredAt || 0);
    const stale = !isPidAlive(existing.pid) || ageMs > LOCK_STALE_MS;
    if (stale) {
      try { fs.unlinkSync(lockPath); } catch { /* race ok */ }
    }
  } catch {
    // No lock present, or unreadable — fall through to creation attempt.
  }

  try {
    const fd = fs.openSync(lockPath, 'wx');
    const info: LockInfo = { pid: process.pid, acquiredAt: Date.now() };
    fs.writeSync(fd, JSON.stringify(info));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') { return false; }
    // Anything else (EACCES, EROFS) — propagate so the caller can decide.
    throw e;
  }
}

export function releaseLock(workspaceRoot: string): void {
  try {
    fs.unlinkSync(getLockPath(workspaceRoot));
  } catch {
    /* lock already gone — fine */
  }
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
  lockHeldByOther?: boolean;
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

  // Cross-host lock: if another VS Code window owns it, skip this tick.
  // Local in-process `inFlight` already protects same-process races.
  const haveLock = tryAcquireLock(workspaceRoot);
  if (!haveLock) {
    report.lockHeldByOther = true;
    return report;
  }

  let registry: Registry;
  try {
    registry = readRegistry(workspaceRoot);
  } finally {
    // Hold the lock only across the registry read+upsert below; release once
    // we've spawned the runs (runs themselves don't need the lock).
  }
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

  // Release the registry lock — completion handlers update the registry via
  // an atomic temp+rename, which is safe without holding the lock.
  releaseLock(workspaceRoot);

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
