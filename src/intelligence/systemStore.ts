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
