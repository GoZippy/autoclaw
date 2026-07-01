/**
 * contextSpine.ts - stable, prompt-safe context references for AutoClaw.
 *
 * The Context Spine is metadata-first. It points agents at project/spec/run/file/
 * symbol/span context without storing raw prompts, hidden reasoning, or complete
 * chat turns in the retrieval contract.
 */

import * as path from 'path';

import { toForwardSlash } from './paths';

export const CONTEXT_SPINE_SCHEMA = 'autoclaw.contextSpine.v1' as const;

export type ContextBlockLevel = 'project' | 'spec' | 'run' | 'file' | 'symbol' | 'span';

export interface ContextSpan {
  startLine?: number;
  endLine?: number;
}

export interface ContextBlockProvenance {
  source: 'repo' | 'spec' | 'orchestrator' | 'kg' | 'vector' | 'manual' | 'test';
  ref: string;
  capturedAt: string;
}

export interface ContextBlockIdParts {
  project: string;
  level: ContextBlockLevel;
  key: string;
  version?: string;
}

export interface ContextBlockRef {
  id: string;
  level: ContextBlockLevel;
  project: string;
  key: string;
  parentId?: string;
  path?: string;
  symbol?: string;
  span?: ContextSpan;
  updatedAt: string;
  summary?: string;
  tags?: string[];
  provenance?: ContextBlockProvenance[];
}

export interface ContextBlockRecord extends ContextBlockRef {
  schema: typeof CONTEXT_SPINE_SCHEMA;
  metadata?: Record<string, unknown>;
  /**
   * Optional, bounded retrieval payload. This is for code/spec snippets only;
   * prompt-like payloads are removed by sanitizeContextBlockRecord.
   */
  snippet?: string;
}

export interface ContextSpineQuery {
  project?: string;
  levels?: ContextBlockLevel[];
  parentId?: string;
  path?: string;
  tags?: string[];
  text?: string;
  limit?: number;
  includeSnippets?: boolean;
}

export interface CoarseToFineOptions {
  coarseLimit?: number;
  fineLimit?: number;
  semanticBackendAvailable?: boolean;
}

export interface CoarseToFineResult {
  coarse: ContextBlockRef[];
  fine: ContextBlockRef[];
  degraded: boolean;
  notes: string[];
}

const COARSE_LEVELS: ContextBlockLevel[] = ['project', 'spec', 'run', 'file'];
const FINE_LEVELS: ContextBlockLevel[] = ['symbol', 'span'];
const PROMPT_LIKE_KEYS = new Set([
  'prompt',
  'rawPrompt',
  'raw_prompt',
  'systemPrompt',
  'system_prompt',
  'userPrompt',
  'user_prompt',
  'response',
  'rawResponse',
  'raw_response',
  'messages',
  'conversation',
  'chainOfThought',
  'chain_of_thought',
  'hiddenCot',
  'hidden_cot',
]);
const MAX_SNIPPET_CHARS = 16000;

function stableSegment(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._:/-]+/g, '-').replace(/-+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'unknown';
}

function normalizePathMaybe(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return toForwardSlash(path.normalize(value));
}

function cleanTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }
  const out = Array.from(
    new Set(
      tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );
  return out.length > 0 ? out : undefined;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROMPT_LIKE_KEYS.has(key)) {
      continue;
    }
    out[key] = sanitizeMetadataValue(child);
  }
  return out;
}

function sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const out = sanitizeMetadataValue(metadata) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeProvenance(value: unknown): ContextBlockProvenance[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: ContextBlockProvenance[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Partial<ContextBlockProvenance>;
    if (typeof rec.source !== 'string' || typeof rec.ref !== 'string') {
      continue;
    }
    out.push({
      source: rec.source as ContextBlockProvenance['source'],
      ref: rec.ref,
      capturedAt: typeof rec.capturedAt === 'string' ? rec.capturedAt : new Date(0).toISOString(),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeSpan(value: unknown): ContextSpan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const span: ContextSpan = {};
  if (typeof rec.startLine === 'number' && Number.isFinite(rec.startLine)) {
    span.startLine = Math.max(1, Math.floor(rec.startLine));
  }
  if (typeof rec.endLine === 'number' && Number.isFinite(rec.endLine)) {
    span.endLine = Math.max(span.startLine ?? 1, Math.floor(rec.endLine));
  }
  return Object.keys(span).length > 0 ? span : undefined;
}

function asLevel(value: unknown): ContextBlockLevel {
  if (
    value === 'project' ||
    value === 'spec' ||
    value === 'run' ||
    value === 'file' ||
    value === 'symbol' ||
    value === 'span'
  ) {
    return value;
  }
  throw new Error(`invalid context block level: ${String(value)}`);
}

function normalizedHaystack(record: ContextBlockRecord): string {
  const bits = [
    record.id,
    record.level,
    record.project,
    record.key,
    record.path,
    record.symbol,
    record.summary,
    ...(record.tags ?? []),
  ];
  return bits.filter((v): v is string => typeof v === 'string').join('\n').toLowerCase();
}

export function contextBlockId(parts: ContextBlockIdParts): string {
  const project = stableSegment(parts.project);
  const level = stableSegment(parts.level);
  const key = stableSegment(parts.key);
  const version = parts.version ? `:${stableSegment(parts.version)}` : '';
  return `ctx:${project}:${level}:${key}${version}`;
}

export function sanitizeContextBlockRecord(input: ContextBlockRecord): ContextBlockRecord {
  const level = asLevel(input.level);
  const project = String(input.project || 'unknown').trim();
  const key = String(input.key || 'unknown').trim();
  const id = input.id || contextBlockId({ project, level, key });
  const metadata = sanitizeMetadata(input.metadata);
  const tags = cleanTags(input.tags);
  const provenance = sanitizeProvenance(input.provenance);
  const span = sanitizeSpan(input.span);
  const snippet =
    typeof input.snippet === 'string' && input.snippet.trim() !== ''
      ? input.snippet.replace(/\r\n/g, '\n').slice(0, MAX_SNIPPET_CHARS)
      : undefined;

  return {
    schema: CONTEXT_SPINE_SCHEMA,
    id,
    level,
    project,
    key,
    parentId: typeof input.parentId === 'string' && input.parentId.trim() !== '' ? input.parentId : undefined,
    path: normalizePathMaybe(input.path),
    symbol: typeof input.symbol === 'string' && input.symbol.trim() !== '' ? input.symbol.trim() : undefined,
    span,
    updatedAt:
      typeof input.updatedAt === 'string' && input.updatedAt.trim() !== ''
        ? input.updatedAt
        : new Date().toISOString(),
    summary: typeof input.summary === 'string' && input.summary.trim() !== '' ? input.summary.trim() : undefined,
    tags,
    provenance,
    metadata,
    snippet,
  };
}

export function parseContextBlockRecord(input: unknown): ContextBlockRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('context block must be an object');
  }
  const rec = input as Partial<ContextBlockRecord>;
  if (rec.schema !== CONTEXT_SPINE_SCHEMA) {
    throw new Error(`unsupported context block schema: ${String(rec.schema)}`);
  }
  return sanitizeContextBlockRecord(rec as ContextBlockRecord);
}

export function toContextBlockRef(record: ContextBlockRecord): ContextBlockRef {
  const clean = sanitizeContextBlockRecord(record);
  return {
    id: clean.id,
    level: clean.level,
    project: clean.project,
    key: clean.key,
    parentId: clean.parentId,
    path: clean.path,
    symbol: clean.symbol,
    span: clean.span,
    updatedAt: clean.updatedAt,
    summary: clean.summary,
    tags: clean.tags,
    provenance: clean.provenance,
  };
}

export function scoreContextBlock(record: ContextBlockRecord, query: ContextSpineQuery): number {
  let score = 0;
  if (query.project && stableSegment(record.project) !== stableSegment(query.project)) {
    return -1;
  }
  if (query.levels && !query.levels.includes(record.level)) {
    return -1;
  }
  if (query.parentId && record.parentId !== query.parentId) {
    return -1;
  }
  if (query.path) {
    const wanted = toForwardSlash(query.path).toLowerCase();
    const actual = (record.path ?? '').toLowerCase();
    if (!actual.includes(wanted)) {
      return -1;
    }
    score += 8;
  }
  if (query.tags && query.tags.length > 0) {
    const tags = new Set((record.tags ?? []).map((t) => t.toLowerCase()));
    const matched = query.tags.filter((t) => tags.has(t.toLowerCase())).length;
    if (matched === 0) {
      return -1;
    }
    score += matched * 5;
  }
  if (query.text && query.text.trim() !== '') {
    const terms = query.text
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const haystack = normalizedHaystack(record);
    const matched = terms.filter((t) => haystack.includes(t)).length;
    if (matched === 0) {
      return -1;
    }
    score += matched * 3;
  }
  score += COARSE_LEVELS.includes(record.level) ? 1 : 2;
  return score;
}

export function queryContextBlocks(
  records: ContextBlockRecord[],
  query: ContextSpineQuery = {},
): ContextBlockRef[] {
  const limit = Math.max(0, query.limit ?? 20);
  return records
    .map((record, index) => ({ record: sanitizeContextBlockRecord(record), index }))
    .map(({ record, index }) => ({ record, index, score: scoreContextBlock(record, query) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt) || a.index - b.index)
    .slice(0, limit)
    .map((hit) => toContextBlockRef(hit.record));
}

export function coarseToFineContext(
  records: ContextBlockRecord[],
  query: ContextSpineQuery = {},
  options: CoarseToFineOptions = {},
): CoarseToFineResult {
  const notes: string[] = [];
  const degraded = options.semanticBackendAvailable === false;
  if (degraded) {
    notes.push('semantic backends unavailable; using local Context Spine metadata only');
  }
  const baseQuery = { ...query, limit: undefined };
  const coarse = queryContextBlocks(records, {
    ...baseQuery,
    levels: query.levels?.filter((l) => COARSE_LEVELS.includes(l)) ?? COARSE_LEVELS,
    limit: options.coarseLimit ?? query.limit ?? 8,
  });
  const fine = queryContextBlocks(records, {
    ...baseQuery,
    levels: query.levels?.filter((l) => FINE_LEVELS.includes(l)) ?? FINE_LEVELS,
    limit: options.fineLimit ?? query.limit ?? 12,
  });
  return { coarse, fine, degraded, notes };
}
