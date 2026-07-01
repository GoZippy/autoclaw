/**
 * contextIndex.ts - JSONL-backed Context Spine store.
 *
 * This is the local fallback/control-plane index. It is intentionally simple:
 * append records, collapse to latest by id on read, and skip malformed lines
 * with warnings instead of failing the caller.
 */

import * as fs from 'fs';
import * as path from 'path';

import { acquireLock } from './fileLock';
import { ensureDir, toForwardSlash } from './paths';
import {
  CoarseToFineOptions,
  CoarseToFineResult,
  ContextBlockRecord,
  ContextBlockRef,
  ContextSpineQuery,
  coarseToFineContext,
  parseContextBlockRecord,
  queryContextBlocks,
  sanitizeContextBlockRecord,
} from './contextSpine';

export const CONTEXT_SPINE_DIR = 'context-spine';
export const CONTEXT_BLOCKS_FILE = 'blocks.jsonl';

export interface ContextReadResult {
  blocks: ContextBlockRecord[];
  warnings: string[];
  missing: boolean;
}

export interface ContextQueryResult {
  blocks: ContextBlockRef[];
  degraded: boolean;
  warnings: string[];
}

export function contextSpineDir(workspaceRoot: string): string {
  return toForwardSlash(path.join(workspaceRoot, '.autoclaw', 'intelligence', CONTEXT_SPINE_DIR));
}

export function contextBlocksPath(workspaceRoot: string): string {
  return toForwardSlash(path.join(contextSpineDir(workspaceRoot), CONTEXT_BLOCKS_FILE));
}

async function appendJsonLine(filePath: string, record: ContextBlockRecord): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const release = await acquireLock(filePath);
  try {
    await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    release();
  }
}

function collapseLatest(records: ContextBlockRecord[]): ContextBlockRecord[] {
  const latest = new Map<string, ContextBlockRecord>();
  for (const record of records) {
    latest.set(record.id, record);
  }
  return Array.from(latest.values());
}

export async function appendContextBlock(
  workspaceRoot: string,
  block: ContextBlockRecord,
): Promise<ContextBlockRecord> {
  const record = sanitizeContextBlockRecord(block);
  await appendJsonLine(contextBlocksPath(workspaceRoot), record);
  return record;
}

export async function updateContextBlock(
  workspaceRoot: string,
  block: ContextBlockRecord,
): Promise<ContextBlockRecord> {
  const record = sanitizeContextBlockRecord({
    ...block,
    updatedAt: block.updatedAt || new Date().toISOString(),
  });
  await appendJsonLine(contextBlocksPath(workspaceRoot), record);
  return record;
}

export async function readContextBlocks(workspaceRoot: string): Promise<ContextReadResult> {
  const filePath = contextBlocksPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { blocks: [], warnings: [], missing: true };
    }
    return {
      blocks: [],
      warnings: [`failed to read Context Spine store ${filePath}: ${e.message}`],
      missing: false,
    };
  }

  const warnings: string[] = [];
  const records: ContextBlockRecord[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    try {
      records.push(parseContextBlockRecord(JSON.parse(line)));
    } catch (err) {
      warnings.push(`skipped malformed Context Spine record at line ${index + 1}: ${(err as Error).message}`);
    }
  });
  return { blocks: collapseLatest(records), warnings, missing: false };
}

export async function queryContextIndex(
  workspaceRoot: string,
  query: ContextSpineQuery = {},
): Promise<ContextQueryResult> {
  const read = await readContextBlocks(workspaceRoot);
  const warnings = [...read.warnings];
  if (read.missing) {
    warnings.push('Context Spine store is empty; returning no references');
  }
  return {
    blocks: queryContextBlocks(read.blocks, query),
    degraded: true,
    warnings,
  };
}

export async function coarseToFineContextIndex(
  workspaceRoot: string,
  query: ContextSpineQuery = {},
  options: CoarseToFineOptions = {},
): Promise<CoarseToFineResult> {
  const read = await readContextBlocks(workspaceRoot);
  const result = coarseToFineContext(read.blocks, query, {
    ...options,
    semanticBackendAvailable: options.semanticBackendAvailable ?? false,
  });
  const notes = [...result.notes, ...read.warnings];
  if (read.missing) {
    notes.push('Context Spine store is empty; returning no references');
  }
  return { ...result, degraded: true, notes };
}
