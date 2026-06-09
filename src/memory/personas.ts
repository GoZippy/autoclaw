/**
 * personas.ts — Per-persona memory engine (PA-1, integrate-automate-v3.2).
 *
 * Each persona keeps a sharded, bi-temporal memory:
 *
 *   .autoclaw/memory/personas/<id>/
 *     scratch/lessons.jsonl   ← freshly learned, this-session
 *     recall/lessons.jsonl    ← promoted after surviving a few sessions
 *     archive/lessons.jsonl   ← long-tail, demoted out of recall
 *     lessons.md              ← human digest (last-N, newest first)
 *
 * and a cross-project mirror at `~/.autoclaw/personas/<id>/` that ONLY ever
 * receives privacy-cleared entries (survey §4 don't-do #4): `project` entries
 * never leave the workspace, and even a `global`/`global-candidate` entry is
 * blocked if a secret-scan trips. The whole module is `vscode`-free and
 * operates on explicit roots so it unit-tests in plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PersonaId, PersonaMemoryEntry, PersonaPrivacy } from '../personas/types';

const fsp = fs.promises;

/** Persona-local memory tiers (distinct from the workspace `MemoryTier`). */
export type PersonaMemoryTier = 'scratch' | 'recall' | 'archive';
export const PERSONA_TIERS: readonly PersonaMemoryTier[] = ['scratch', 'recall', 'archive'];

/** Resolved on-disk locations for one persona's memory. */
export interface PersonaMemoryPaths {
  root: string;
  scratch: string;
  recall: string;
  archive: string;
  digest: string;
}

/** Project-scoped memory root for a persona under a workspace `.autoclaw/`. */
export function personaMemoryRoot(autoclawDir: string, id: PersonaId): string {
  return path.join(autoclawDir, 'memory', 'personas', id);
}

/** Global (cross-project) memory root, e.g. `~/.autoclaw/personas/<id>/`. */
export function personaGlobalRoot(homeAutoclawDir: string, id: PersonaId): string {
  return path.join(homeAutoclawDir, 'personas', id);
}

/** Resolve the JSONL tier files + digest path for a persona root. */
export function personaMemoryPaths(root: string): PersonaMemoryPaths {
  return {
    root,
    scratch: path.join(root, 'scratch', 'lessons.jsonl'),
    recall: path.join(root, 'recall', 'lessons.jsonl'),
    archive: path.join(root, 'archive', 'lessons.jsonl'),
    digest: path.join(root, 'lessons.md'),
  };
}

// ---------------------------------------------------------------------------
// Secret scan — a privacy entry is blocked from global memory if it trips this
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_]{8,}/, // token prefixes
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b[A-Za-z0-9._-]*(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/,          // internal host:port
  /\bhttps?:\/\/[^\s/]*(internal|localhost|127\.0\.0\.1|10\.|192\.168\.)/i, // private endpoints
];

/** True when `content` looks like it contains a secret / private locator. */
export function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(re => re.test(content));
}

/**
 * Decide whether an entry may be mirrored to GLOBAL memory:
 *  - `project`           → never.
 *  - `global`            → yes, unless the secret-scan trips.
 *  - `global-candidate`  → yes, unless the secret-scan trips.
 * A tripped secret-scan forces the answer to false regardless of label.
 */
export function isPromotableToGlobal(entry: PersonaMemoryEntry): boolean {
  if (entry.privacy === 'project') { return false; }
  if (containsSecret(entry.content)) { return false; }
  return entry.privacy === 'global' || entry.privacy === 'global-candidate';
}

// ---------------------------------------------------------------------------
// JSONL tier IO
// ---------------------------------------------------------------------------

async function readJsonl(file: string): Promise<PersonaMemoryEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: PersonaMemoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { continue; }
    try { out.push(JSON.parse(t) as PersonaMemoryEntry); } catch { /* skip malformed line */ }
  }
  return out;
}

async function writeJsonl(file: string, entries: readonly PersonaMemoryEntry[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
}

/** Append a freshly-learned lesson to a persona's scratch tier. */
export async function appendLesson(root: string, entry: PersonaMemoryEntry): Promise<void> {
  const { scratch } = personaMemoryPaths(root);
  await fsp.mkdir(path.dirname(scratch), { recursive: true });
  await fsp.appendFile(scratch, JSON.stringify(entry) + '\n', 'utf8');
}

/** Read all entries across all three tiers (scratch first → archive). */
export async function readAllLessons(root: string): Promise<PersonaMemoryEntry[]> {
  const p = personaMemoryPaths(root);
  return [
    ...(await readJsonl(p.scratch)),
    ...(await readJsonl(p.recall)),
    ...(await readJsonl(p.archive)),
  ];
}

// ---------------------------------------------------------------------------
// Promotion: scratch → recall → archive
// ---------------------------------------------------------------------------

export interface PersonaPromotionConfig {
  /** Sessions a lesson stays in scratch before promotion to recall. */
  promoteAfterSessions: number;
  /** Sessions a lesson stays in recall before demotion to archive. */
  archiveAfterSessions: number;
  /** The current session counter (monotonic). */
  currentSession: number;
}

export function defaultPersonaPromotionConfig(currentSession: number): PersonaPromotionConfig {
  return { promoteAfterSessions: 2, archiveAfterSessions: 8, currentSession };
}

/** Age of an entry in sessions, derived from a `session` field if present. */
function entrySession(e: PersonaMemoryEntry): number {
  const s = (e as unknown as { session?: number }).session;
  return typeof s === 'number' ? s : 0;
}

/**
 * Run one promotion cycle for a persona, in place on disk:
 *  - scratch entries older than `promoteAfterSessions` → recall
 *  - recall entries older than `archiveAfterSessions` → archive
 * Superseded entries are dropped from the live tiers (kept only in archive).
 * Returns the count moved at each hop. Pure w.r.t. inputs beyond the disk IO.
 */
export async function promoteLessons(
  root: string,
  config: PersonaPromotionConfig,
): Promise<{ promoted: number; archived: number }> {
  const p = personaMemoryPaths(root);
  const scratch = await readJsonl(p.scratch);
  const recall = await readJsonl(p.recall);
  const archive = await readJsonl(p.archive);

  const toRecall: PersonaMemoryEntry[] = [];
  const keepScratch: PersonaMemoryEntry[] = [];
  for (const e of scratch) {
    if (config.currentSession - entrySession(e) >= config.promoteAfterSessions) {
      toRecall.push(e);
    } else {
      keepScratch.push(e);
    }
  }

  const mergedRecall = [...recall, ...toRecall];
  const toArchive: PersonaMemoryEntry[] = [];
  const keepRecall: PersonaMemoryEntry[] = [];
  for (const e of mergedRecall) {
    if (e.superseded_by || config.currentSession - entrySession(e) >= config.archiveAfterSessions) {
      toArchive.push(e);
    } else {
      keepRecall.push(e);
    }
  }

  await writeJsonl(p.scratch, keepScratch);
  await writeJsonl(p.recall, keepRecall);
  await writeJsonl(p.archive, [...archive, ...toArchive]);

  return { promoted: toRecall.length, archived: toArchive.length };
}

// ---------------------------------------------------------------------------
// Global mirror (privacy-gated)
// ---------------------------------------------------------------------------

/**
 * Mirror a persona's privacy-cleared lessons to its GLOBAL root. Only entries
 * that pass {@link isPromotableToGlobal} are written; `project` and
 * secret-tripping entries are silently skipped. Idempotent: a global entry is
 * keyed by `subject` so re-runs don't duplicate. Returns the count mirrored
 * and the count blocked.
 */
export async function mirrorToGlobal(
  projectRoot: string,
  globalRoot: string,
): Promise<{ mirrored: number; blocked: number }> {
  const all = await readAllLessons(projectRoot);
  const eligible = all.filter(isPromotableToGlobal);
  const blocked = all.length - eligible.length;

  const globalFile = path.join(globalRoot, 'recall', 'lessons.jsonl');
  const existing = await readJsonl(globalFile);
  const bySubject = new Map<string, PersonaMemoryEntry>();
  for (const e of existing) { bySubject.set(e.subject, e); }
  for (const e of eligible) {
    // Mark as fully `global` once mirrored.
    bySubject.set(e.subject, { ...e, privacy: 'global' as PersonaPrivacy });
  }
  await writeJsonl(globalFile, [...bySubject.values()]);
  return { mirrored: eligible.length, blocked };
}

// ---------------------------------------------------------------------------
// Human digest (lessons.md)
// ---------------------------------------------------------------------------

/** Rewrite a persona's `lessons.md` digest: the last `limit` lessons, newest first. */
export async function writeDigest(root: string, persona: PersonaId, limit = 5): Promise<void> {
  const all = await readAllLessons(root);
  const recent = [...all]
    .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime())
    .slice(0, limit);
  const lines = [
    `# ${persona} — lessons (last ${recent.length})`,
    '',
    ...recent.map(e => `- ${e.content} _(${e.recorded_at}${e.privacy === 'project' ? ', project-only' : ''})_`),
    '',
  ];
  const { digest } = personaMemoryPaths(root);
  await fsp.mkdir(path.dirname(digest), { recursive: true });
  await fsp.writeFile(digest, lines.join('\n'), 'utf8');
}
