/**
 * systemStore.ts — the cross-project ("system") intelligence tier.
 *
 * The LOCAL tier is per-project (`<workspace>/.autoclaw`). This SYSTEM tier lives
 * at a user-chosen dir (`autoclaw.intelligence.systemDir`, any drive — never
 * silently C:) and holds knowledge that's useful across MANY projects: tool/CLI
 * usage, environment/OS facts, conventions, preferences. It also keeps a
 * project↔store **registry** (`projects.json`) so projects can cross-reference
 * ("which project knows about X / has a tool for Z").
 *
 * Host-free: no `vscode` import. Best-effort I/O; never throws on a missing or
 * malformed store. The command layer reads the configured dir and passes it in.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { toForwardSlash } from './paths';
import { SystemPaths } from './storage';

/** One project's row in the system registry. */
export interface ProjectRegistryEntry {
  /** Workspace root (forward-slash), the stable key. */
  path: string;
  /** Display name (basename). */
  name: string;
  lastIndexedAt?: string;
  lastLearnedAt?: string;
  indexChunks?: number;
  learnSessions?: number;
  /** Optional free-text topic hints for cross-referencing. */
  topics?: string[];
}

export interface ProjectRegistry {
  version: number;
  projects: ProjectRegistryEntry[];
}

const REGISTRY_VERSION = 1;

/** Create the system-tier directory structure (idempotent). */
export function ensureSystemStore(sys: SystemPaths): void {
  for (const dir of [sys.root, sys.vectorDir, sys.learningsDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort */
    }
  }
}

/** Read the project registry; returns an empty registry when absent/malformed. */
export function readRegistry(registryPath: string): ProjectRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as ProjectRegistry).projects)
    ) {
      const reg = parsed as ProjectRegistry;
      return {
        version: typeof reg.version === 'number' ? reg.version : REGISTRY_VERSION,
        projects: reg.projects.filter(
          (p) => p && typeof p.path === 'string' && p.path.trim() !== '',
        ),
      };
    }
  } catch {
    /* absent / malformed → empty */
  }
  return { version: REGISTRY_VERSION, projects: [] };
}

function sameProject(a: string, b: string): boolean {
  return toForwardSlash(a).replace(/\/+$/, '').toLowerCase() ===
    toForwardSlash(b).replace(/\/+$/, '').toLowerCase();
}

/**
 * Upsert a project into the registry (merge by path; later fields win, arrays
 * union). Writes atomically (tmp → rename) and returns the updated registry.
 */
export function upsertProject(
  registryPath: string,
  entry: Partial<ProjectRegistryEntry> & { path: string },
): ProjectRegistry {
  const reg = readRegistry(registryPath);
  const key = toForwardSlash(entry.path);
  const name = entry.name ?? path.basename(key.replace(/\/+$/, '')) ?? key;
  const idx = reg.projects.findIndex((p) => sameProject(p.path, key));
  const prev = idx >= 0 ? reg.projects[idx] : undefined;
  const merged: ProjectRegistryEntry = {
    ...prev,
    ...entry,
    path: key,
    name,
    topics: unionTopics(prev?.topics, entry.topics),
  };
  if (idx >= 0) {
    reg.projects[idx] = merged;
  } else {
    reg.projects.push(merged);
  }
  writeRegistry(registryPath, reg);
  return reg;
}

function unionTopics(a?: string[], b?: string[]): string[] | undefined {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])].filter((t) => t && t.trim() !== ''));
  return set.size > 0 ? Array.from(set) : undefined;
}

function writeRegistry(registryPath: string, reg: ProjectRegistry): void {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const tmp = `${registryPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    fs.renameSync(tmp, registryPath);
  } catch {
    /* best effort — registry is an optimization, never load-bearing */
  }
}

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

export type Tier = 'project' | 'system';

/**
 * Patterns that mark a learning as broadly useful (system-wide) rather than
 * project-specific. First-pass heuristic — intentionally conservative and easy
 * to extend; tune as real usage accrues. (R: "note things useful for many
 * projects → system store".)
 */
const SYSTEM_PATTERNS: readonly RegExp[] = [
  // generic tools / CLIs / build systems
  /\b(git|npm|pnpm|yarn|nvm|node|deno|bun|docker|podman|kubectl|helm|terraform|ansible|aws|gcloud|az|pip|poetry|cargo|rustup|go|make|cmake|gradle|maven|brew|apt|dnf|pacman|choco|winget|scoop|powershell|pwsh|bash|zsh|fish|ssh|curl|jq|sed|awk|grep|rg|fzf)\b/i,
  // environment / OS / runtime facts
  /\b(environment variable|env var|\$?PATH\b|operating system|windows|linux|macos|wsl|electron|node:sqlite|abi mismatch|globalStorage|registry key|symlink|junction)\b/i,
  // cross-project conventions / preferences
  /\b(always|never|prefer|convention|across projects|system-wide|systemwide|in general|every project|globally|my setup|machine-wide)\b/i,
];

/**
 * Classify a piece of learned text as `system` (cross-project) or `project`.
 * `system` when it reads as generic tool/environment/convention knowledge.
 */
export function classifyTier(text: string): Tier {
  if (!text || text.trim() === '') {
    return 'project';
  }
  return SYSTEM_PATTERNS.some((re) => re.test(text)) ? 'system' : 'project';
}

// ---------------------------------------------------------------------------
// System learnings store (the queryable cross-project knowledge — v2)
// ---------------------------------------------------------------------------

/** A distilled learning promoted to the cross-project system store. */
export interface SystemLearning {
  /** Stable content hash (dedup key). */
  id: string;
  /** The learning text. */
  text: string;
  /** Which distilled section it came from. */
  kind: 'pattern' | 'avoid' | 'tool';
  /** classifyTier label (metadata; all distilled patterns are cross-project). */
  tier: Tier;
  /** Project that contributed it (forward-slash). */
  project: string;
  /** ISO timestamp the caller stamps (kept out of this module for determinism). */
  capturedAt?: string;
}

/** The JSONL holding promoted system learnings. */
export function systemLearningsPath(sys: SystemPaths): string {
  return toForwardSlash(path.join(sys.learningsDir, 'system-learnings.jsonl'));
}

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Parse a learn `insight-*.md` into the distilled-pattern bullets worth keeping
 * cross-project: the "Successful Patterns", "Patterns to Avoid", and "Preferred
 * Tools" sections. The top metadata block + "Reflection" prose are skipped.
 */
export function parseInsightItems(markdown: string): Array<{ text: string; kind: SystemLearning['kind'] }> {
  const sectionKind: Record<string, SystemLearning['kind']> = {
    'successful patterns': 'pattern',
    'patterns to avoid': 'avoid',
    'preferred tools': 'tool',
  };
  const out: Array<{ text: string; kind: SystemLearning['kind'] }> = [];
  let current: SystemLearning['kind'] | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      const name = h[1].toLowerCase().replace(/\(.*?\)/g, '').trim();
      current = sectionKind[name];
      continue;
    }
    if (!current) {
      continue;
    }
    const b = line.match(/^[-*]\s+(.+)$/);
    if (b && b[1].trim().length >= 3) {
      out.push({ text: b[1].trim(), kind: current });
    }
  }
  return out;
}

/** Read all promoted system learnings (corruption-tolerant). */
export function readSystemLearnings(sys: SystemPaths): SystemLearning[] {
  const out: SystemLearning[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(systemLearningsPath(sys), 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const o = JSON.parse(line) as SystemLearning;
      if (o && typeof o.text === 'string' && typeof o.id === 'string') {
        out.push(o);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export interface PromoteResult {
  scanned: number;
  promoted: number;
}

/**
 * Promote the distilled pattern bullets of a learn insight into the system store,
 * deduped by content hash across projects/runs. Appends new ones to the JSONL.
 * Best-effort; returns counts. `capturedAt` is stamped by the caller for testability.
 */
export function promoteInsight(
  sys: SystemPaths,
  args: { project: string; insightMarkdown: string; capturedAt?: string },
): PromoteResult {
  const items = parseInsightItems(args.insightMarkdown);
  if (items.length === 0) {
    return { scanned: 0, promoted: 0 };
  }
  ensureSystemStore(sys);
  const existing = new Set(readSystemLearnings(sys).map((l) => l.id));
  const project = toForwardSlash(args.project);
  const fresh: SystemLearning[] = [];
  for (const it of items) {
    const id = hashText(it.text);
    if (existing.has(id)) {
      continue;
    }
    existing.add(id);
    fresh.push({
      id,
      text: it.text,
      kind: it.kind,
      tier: classifyTier(it.text),
      project,
      capturedAt: args.capturedAt,
    });
  }
  if (fresh.length > 0) {
    try {
      fs.appendFileSync(
        systemLearningsPath(sys),
        fresh.map((l) => JSON.stringify(l)).join('\n') + '\n',
        'utf8',
      );
    } catch {
      return { scanned: items.length, promoted: 0 };
    }
  }
  return { scanned: items.length, promoted: fresh.length };
}

export interface SystemSearchHit extends SystemLearning {
  /** Number of query tokens matched (ranking). */
  score: number;
}

/**
 * Search the system learnings by case-insensitive token overlap. Returns the
 * top `limit` hits, best first. A cross-project recall surface for retrieval.
 */
export function searchSystemLearnings(
  sys: SystemPaths,
  query: string,
  limit = 10,
): SystemSearchHit[] {
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return [];
  }
  const hits: SystemSearchHit[] = [];
  for (const l of readSystemLearnings(sys)) {
    const hay = l.text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) {
        score++;
      }
    }
    if (score > 0) {
      hits.push({ ...l, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, limit));
}
