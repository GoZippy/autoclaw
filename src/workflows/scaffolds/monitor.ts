import type { AntiHackingSeverity, AntiHackingViolation, AntiHackingViolationKind } from './types';

export interface ScaffoldMonitorAccess {
  path: string;
  kind?: 'read' | 'write';
}

export interface ScaffoldMonitorInput {
  agentId?: string;
  taskId?: string;
  scaffoldId?: string;
  reads?: ScaffoldMonitorAccess[];
  writes?: ScaffoldMonitorAccess[];
  allowedWriteGlobs?: string[];
  scopeGlobs?: string[];
  verifierGlobs?: string[];
  hiddenTestGlobs?: string[];
  runLedgerGlobs?: string[];
  scoreLedgerGlobs?: string[];
  policyGlobs?: string[];
  now?: string;
}

export interface ScaffoldMonitorFindingPayload {
  finding: string;
  severity: AntiHackingSeverity;
  task_id?: string;
  scaffold_id?: string;
  agent?: string;
  violation: AntiHackingViolation;
}

export interface ScaffoldMonitorResult {
  allowed: boolean;
  violations: AntiHackingViolation[];
  findings: ScaffoldMonitorFindingPayload[];
  /** Existing scorer maps any violation to negative reward; fatal uses -1. */
  rewardOverride?: number;
}

const DEFAULT_VERIFIER_GLOBS = [
  '.autoclaw/verifiers/**',
  '**/.autoclaw/verifiers/**',
  'verifiers/hidden/**',
  '**/verifiers/hidden/**',
  '**/__verifier__/**',
  '**/.hidden-verifier/**',
];

const DEFAULT_HIDDEN_TEST_GLOBS = [
  '__hidden_tests__/**',
  '**/__hidden_tests__/**',
  'hidden-tests/**',
  '**/hidden-tests/**',
  '**/.hidden-tests/**',
  '**/*.hidden.test.ts',
  '**/*.hidden.spec.ts',
];

const DEFAULT_RUN_LEDGER_GLOBS = [
  '.autoclaw/workflows/runs/**',
  '**/.autoclaw/workflows/runs/**',
  '**/run-ledger*.jsonl',
];

const DEFAULT_SCORE_LEDGER_GLOBS = [
  '.autoclaw/workflows/scaffolds/scores.jsonl',
  '**/.autoclaw/workflows/scaffolds/scores.jsonl',
  '**/scaffold-score*.jsonl',
];

const DEFAULT_POLICY_GLOBS = [
  '.autoclaw/policies/**',
  '**/.autoclaw/policies/**',
  'docs/policies/**',
  '**/policy*.yaml',
  '**/policy*.json',
];

export function evaluateScaffoldMonitor(input: ScaffoldMonitorInput): ScaffoldMonitorResult {
  const now = input.now ?? new Date().toISOString();
  const violations: AntiHackingViolation[] = [];
  const add = (
    kind: AntiHackingViolationKind,
    summary: string,
    severity: AntiHackingSeverity,
    path?: string,
  ): void => {
    violations.push({ kind, summary, severity, path, detectedAt: now });
  };

  for (const access of input.reads ?? []) {
    const p = normalizePath(access.path);
    if (matchesAny(p, input.verifierGlobs ?? DEFAULT_VERIFIER_GLOBS)) {
      add('hidden_verifier_read', `Read of hidden verifier path "${p}" is blocked.`, 'fatal', p);
    }
  }

  for (const access of input.writes ?? []) {
    const p = normalizePath(access.path);
    const allowedByException = matchesAny(p, input.allowedWriteGlobs ?? []);
    if (!allowedByException && input.scopeGlobs?.length && !matchesAny(p, input.scopeGlobs)) {
      add('scope_violation', `Write to "${p}" is outside declared scaffold scope.`, 'fatal', p);
      continue;
    }
    if (allowedByException) {
      continue;
    }
    if (matchesAny(p, input.verifierGlobs ?? DEFAULT_VERIFIER_GLOBS)) {
      add('verifier_modified', `Write to verifier path "${p}" is blocked.`, 'fatal', p);
    } else if (matchesAny(p, input.hiddenTestGlobs ?? DEFAULT_HIDDEN_TEST_GLOBS)) {
      add('hidden_test_modified', `Write to hidden test path "${p}" is blocked.`, 'fatal', p);
    } else if (matchesAny(p, input.scoreLedgerGlobs ?? DEFAULT_SCORE_LEDGER_GLOBS)) {
      add('score_ledger_modified', `Write to scaffold score ledger "${p}" is blocked.`, 'fatal', p);
    } else if (matchesAny(p, input.runLedgerGlobs ?? DEFAULT_RUN_LEDGER_GLOBS)) {
      add('run_ledger_modified', `Write to workflow run ledger "${p}" is blocked.`, 'fatal', p);
    } else if (matchesAny(p, input.policyGlobs ?? DEFAULT_POLICY_GLOBS)) {
      add('policy_modified', `Write to policy path "${p}" is blocked.`, 'fatal', p);
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    findings: violations.map((violation) => toFindingPayload(violation, input)),
    rewardOverride: violations.length > 0 ? -1 : undefined,
  };
}

function toFindingPayload(
  violation: AntiHackingViolation,
  input: ScaffoldMonitorInput,
): ScaffoldMonitorFindingPayload {
  return {
    finding: violation.summary,
    severity: violation.severity,
    task_id: input.taskId,
    scaffold_id: input.scaffoldId,
    agent: input.agentId,
    violation,
  };
}

function matchesAny(pathValue: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globMatches(glob, pathValue));
}

function globMatches(glob: string, target: string): boolean {
  const normalizedGlob = normalizePath(glob);
  const normalizedTarget = normalizePath(target);
  if (!normalizedGlob || !normalizedTarget) {
    return false;
  }
  if (normalizedGlob === normalizedTarget) {
    return true;
  }
  if (normalizedGlob.startsWith('**/') && globMatches(normalizedGlob.slice(3), normalizedTarget)) {
    return true;
  }
  const escaped = normalizedGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`).test(normalizedTarget);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}
