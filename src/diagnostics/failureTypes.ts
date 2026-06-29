export const WORKFLOW_FAILURE_TYPES = [
  'context_missing',
  'context_noisy',
  'query_too_broad',
  'task_needs_decomposition',
  'artifact_invalid',
  'scope_conflict',
  'tool_format_invalid',
  'tool_action_illegal',
  'compile_error',
  'test_failure',
  'mutation_survived',
  'acceptance_failure',
  'perf_regression',
  'coordination_stale_claim',
  'coordination_dead_session',
  'budget_exhausted',
  'irreducible_or_needs_human',
] as const;

export type KnownFailureType = typeof WORKFLOW_FAILURE_TYPES[number];
export type FailureType = KnownFailureType | 'unknown_external';

export interface NormalizedFailureType {
  type: FailureType;
  original?: string;
}

export interface GateResultLike {
  kind?: string;
  type?: string;
  name?: string;
  check?: string;
  passed?: boolean;
  ok?: boolean;
  failureType?: string;
  reason?: string;
  message?: string;
  exitCode?: number;
}

export interface ToolErrorLike {
  code?: string;
  kind?: string;
  name?: string;
  message?: string;
  exitCode?: number;
  stderr?: string;
}

const KNOWN = new Set<string>(WORKFLOW_FAILURE_TYPES);

const RETRYABLE_FAILURES = new Set<KnownFailureType>([
  'context_missing',
  'context_noisy',
  'query_too_broad',
  'task_needs_decomposition',
  'tool_format_invalid',
  'compile_error',
  'test_failure',
  'mutation_survived',
  'acceptance_failure',
  'perf_regression',
  'coordination_stale_claim',
]);

const ESCALATION_CANDIDATES = new Set<KnownFailureType>([
  'context_missing',
  'context_noisy',
  'task_needs_decomposition',
  'tool_format_invalid',
  'tool_action_illegal',
  'compile_error',
  'test_failure',
  'acceptance_failure',
  'perf_regression',
  'budget_exhausted',
]);

const HUMAN_REQUIRED_FAILURES = new Set<KnownFailureType>([
  'scope_conflict',
  'coordination_dead_session',
  'budget_exhausted',
  'irreducible_or_needs_human',
]);

export function normalizeFailureType(value: string | undefined | null): NormalizedFailureType {
  if (value && KNOWN.has(value)) {
    return { type: value as KnownFailureType };
  }
  return value ? { type: 'unknown_external', original: value } : { type: 'unknown_external' };
}

export function isKnownFailureType(value: string | undefined | null): value is KnownFailureType {
  return typeof value === 'string' && KNOWN.has(value);
}

export function isRetryableFailure(type: FailureType): boolean {
  return type !== 'unknown_external' && RETRYABLE_FAILURES.has(type);
}

export function isEscalationCandidate(type: FailureType): boolean {
  return type === 'unknown_external' || ESCALATION_CANDIDATES.has(type);
}

export function isHumanRequired(type: FailureType): boolean {
  return type !== 'unknown_external' && HUMAN_REQUIRED_FAILURES.has(type);
}

export function failureTypeFromGateResult(result: GateResultLike): NormalizedFailureType {
  if (result.failureType) {
    return normalizeFailureType(result.failureType);
  }

  const haystack = [
    result.kind,
    result.type,
    result.name,
    result.check,
    result.reason,
    result.message,
  ].filter(Boolean).join(' ').toLowerCase();

  if (haystack.includes('compile') || haystack.includes('typescript') || haystack.includes('tsc')) {
    return { type: 'compile_error' };
  }
  if (haystack.includes('test') || haystack.includes('spec') || haystack.includes('mocha')) {
    return { type: 'test_failure' };
  }
  if (haystack.includes('schema') || haystack.includes('json') || haystack.includes('format')) {
    return { type: 'tool_format_invalid' };
  }
  if (haystack.includes('budget') || haystack.includes('cost') || haystack.includes('timeout') || haystack.includes('time')) {
    return { type: 'budget_exhausted' };
  }
  if (haystack.includes('scope') || haystack.includes('lease') || haystack.includes('permission')) {
    return { type: 'scope_conflict' };
  }
  if (haystack.includes('context') || haystack.includes('retrieval') || haystack.includes('rag')) {
    return { type: 'context_missing' };
  }
  if (haystack.includes('mutation') || haystack.includes('mutant')) {
    return { type: 'mutation_survived' };
  }
  if (haystack.includes('acceptance') || haystack.includes('review')) {
    return { type: 'acceptance_failure' };
  }

  return { type: 'unknown_external', original: result.reason ?? result.message ?? result.kind ?? result.type };
}

export function failureTypeFromToolError(error: ToolErrorLike): NormalizedFailureType {
  const haystack = [
    error.code,
    error.kind,
    error.name,
    error.message,
    error.stderr,
  ].filter(Boolean).join(' ').toLowerCase();

  if (haystack.includes('json') || haystack.includes('schema') || haystack.includes('parse') || haystack.includes('format')) {
    return { type: 'tool_format_invalid' };
  }
  if (haystack.includes('illegal') || haystack.includes('not allowed') || haystack.includes('denied')) {
    return { type: 'tool_action_illegal' };
  }
  if (haystack.includes('compile') || haystack.includes('typescript') || haystack.includes('tsc')) {
    return { type: 'compile_error' };
  }
  if (haystack.includes('test') || haystack.includes('assert') || haystack.includes('mocha')) {
    return { type: 'test_failure' };
  }
  if (haystack.includes('scope') || haystack.includes('lease')) {
    return { type: 'scope_conflict' };
  }
  if (haystack.includes('budget') || haystack.includes('timeout') || haystack.includes('timedout') || haystack.includes('cost')) {
    return { type: 'budget_exhausted' };
  }
  if (haystack.includes('context') || haystack.includes('not found') || haystack.includes('missing')) {
    return { type: 'context_missing' };
  }

  return {
    type: 'unknown_external',
    original: error.code ?? error.kind ?? error.message ?? String(error.exitCode ?? 'unknown'),
  };
}
