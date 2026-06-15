/**
 * metrics/effectivenessStore.ts — persistence for the tool × project
 * effectiveness matrix (see `intelligence/effectiveness.ts`).
 *
 * Unlike the run-series token store, the effectiveness matrix is a *snapshot*:
 * `/learn` recomputes it from the current session corpus and overwrites the
 * previous one. We keep the latest snapshot at
 * `.autoclaw/metrics/effectiveness.json` so the dashboard / a `/effectiveness`
 * command can render it without re-walking every transcript.
 *
 * HOST-FREE: never imports `vscode`; uses only `fs`, `paths`, `fileLock`, so the
 * whole surface is unit-testable outside the extension host (mirrors
 * `metrics/store.ts`). Corruption tolerant: a missing / unparseable / wrong-shape
 * file reads back as an empty matrix rather than throwing.
 */

import * as fs from 'fs';
import * as path from 'path';

import { acquireLock } from '../fileLock';
import { ensureDir, intelligencePaths, toForwardSlash } from '../paths';
import { EffectivenessCell, EffectivenessMatrix } from '../effectiveness';

/** Schema version of the on-disk snapshot, bumped on incompatible changes. */
export const EFFECTIVENESS_SCHEMA_VERSION = 1;

/** File name under `.autoclaw/metrics/`. */
export const EFFECTIVENESS_FILE_NAME = 'effectiveness.json';

/** On-disk shape: a schema-versioned wrapper around the matrix. */
export interface EffectivenessFile {
  version: number;
  matrix: EffectivenessMatrix;
}

// ---------------------------------------------------------------------------
// Validation / normalization (corruption tolerance)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeCell(raw: unknown): EffectivenessCell | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const tool = str(raw.tool);
  if (!tool) {
    return null;
  }
  return {
    tool,
    project: str(raw.project, '(unknown)'),
    projectLabel: str(raw.projectLabel, '(unknown)'),
    sessions: Math.max(0, Math.floor(num(raw.sessions))),
    shipped: Math.max(0, Math.floor(num(raw.shipped))),
    discarded: Math.max(0, Math.floor(num(raw.discarded))),
    keptSignals: Math.max(0, Math.floor(num(raw.keptSignals))),
    estTokens: Math.max(0, Math.floor(num(raw.estTokens))),
    shipRate: Math.min(1, Math.max(0, num(raw.shipRate))),
    keptPerSession: Math.max(0, num(raw.keptPerSession)),
    tokensPerKept: Math.max(0, num(raw.tokensPerKept)),
  };
}

function emptyMatrix(): EffectivenessMatrix {
  return { generatedAt: '', totalSessions: 0, byTool: [], byToolProject: [] };
}

function normalizeMatrix(raw: unknown): EffectivenessMatrix {
  if (!isPlainObject(raw)) {
    return emptyMatrix();
  }
  const byTool = Array.isArray(raw.byTool)
    ? raw.byTool.map(normalizeCell).filter((c): c is EffectivenessCell => c !== null)
    : [];
  const byToolProject = Array.isArray(raw.byToolProject)
    ? raw.byToolProject.map(normalizeCell).filter((c): c is EffectivenessCell => c !== null)
    : [];
  return {
    generatedAt: str(raw.generatedAt),
    totalSessions: Math.max(0, Math.floor(num(raw.totalSessions))),
    byTool,
    byToolProject,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Resolve the `.autoclaw/metrics/effectiveness.json` path for a workspace. */
export function effectivenessFilePath(workspaceRoot: string): string {
  const { metricsDir } = intelligencePaths(workspaceRoot);
  return toForwardSlash(path.join(metricsDir, EFFECTIVENESS_FILE_NAME));
}

/**
 * Read the latest snapshot. NEVER throws: a missing / unparseable / wrong-shape
 * file yields an empty matrix.
 */
export function getEffectiveness(workspaceRoot: string): EffectivenessMatrix {
  const file = effectivenessFilePath(workspaceRoot);
  let raw: string;
  try {
    if (!fs.existsSync(file)) {
      return emptyMatrix();
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyMatrix();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMatrix();
  }
  if (!isPlainObject(parsed)) {
    return emptyMatrix();
  }
  return normalizeMatrix(parsed.matrix);
}

/**
 * Persist a fresh matrix snapshot, lock-protected, overwriting the prior one.
 * Returns the snapshot as written. Best-effort callers should still wrap this in
 * try/catch — a metrics failure must never break a learn run.
 */
export async function recordEffectiveness(
  workspaceRoot: string,
  matrix: EffectivenessMatrix,
): Promise<EffectivenessMatrix> {
  const { metricsDir } = intelligencePaths(workspaceRoot);
  await ensureDir(metricsDir);
  const file = effectivenessFilePath(workspaceRoot);

  const release = await acquireLock(file);
  try {
    const payload: EffectivenessFile = {
      version: EFFECTIVENESS_SCHEMA_VERSION,
      matrix,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return matrix;
  } finally {
    release();
  }
}
