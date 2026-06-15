/**
 * dependencies.ts — Cross-project API dependency registry (MP-3 / DR-1).
 *
 * Manages `~/.autoclaw/programs/<program_id>/dependencies.json` — the single
 * machine-global, repo-agnostic registry of consumer→producer API edges across
 * every project in a program. It answers the one question the per-task claim
 * conventions cannot: "I am about to change <these paths> in producer P — which
 * consumers in *other* repos pin a contract surface that just moved?"
 *
 * Design (mirrors src/program-plane.ts): vscode-free and pure Node, so the whole
 * module is unit-testable with plain mocha. The caller passes `homeDir` +
 * `programId`; this module does only FS I/O + pure data transforms. No
 * module-level Date.now()/Math.random() — timestamps are injected.
 *
 * Schema follows MULTI_PROJECT_ORCHESTRATION_REVIEW.md §5/§8 (and the CIF
 * proposal §5.1 / §8 / Appendix B). Platform-independence (§8) is load-bearing:
 * the `api` field on every edge is an ABSTRACT capability name ("payments-api"),
 * never a concrete vendor. The concrete implementation lives ONLY in `backends`,
 * so a vendor can be swapped without touching a single consumer edge.
 */

import * as fs from 'fs';
import * as path from 'path';
import { programDir } from '../program-plane';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Schema types (review doc §5/§8)
// ---------------------------------------------------------------------------

/**
 * One consumer→producer dependency edge.
 *
 * `api` is an ABSTRACT capability (e.g. "payments-api"), NOT a vendor — the
 * concrete implementation is recorded only in {@link DependenciesDoc.backends}.
 * `consumed_via` is the consumer's contract surface as glob patterns: the files
 * in the *consumer* repo that import/exercise this producer API. When the
 * *producer*'s changed paths intersect this surface, the consumer must be told.
 */
export interface DependencyEdge {
  consumer: string;
  producer: string;
  /** Abstract capability name (vendor-neutral) — never a concrete vendor. */
  api: string;
  /** Contract version the consumer currently pins (e.g. "v2"). */
  version: string;
  /** Glob patterns naming the consumer's contract surface. */
  consumed_via: string[];
  /** Agent/PO ids notified on an api_change affecting this edge. */
  notify: string[];
}

/** Per-project metadata: who owns it and which capabilities it provides. */
export interface ProjectInfo {
  owner?: string;
  /** Abstract capabilities this project provides (producer side). */
  provides?: string[];
}

/**
 * Vendor-swap record for one abstract capability (§8). The capability is the
 * key in {@link DependenciesDoc.backends}; this records which concrete
 * implementation currently satisfies it and which ones are interchangeable.
 */
export interface BackendInfo {
  /** The concrete implementation currently satisfying the capability. */
  current: string;
  /** Other implementations that satisfy the same contract. */
  interchangeable: string[];
  /** Pointer to the contract spec, e.g. "openapi:guru-connect/payments-api/v3.yaml". */
  contract?: string;
}

export interface DependenciesDoc {
  schema_version: '1.0';
  updated_at: string;
  projects: Record<string, ProjectInfo>;
  dependencies: DependencyEdge[];
  /** Map abstract capability → its current/interchangeable concrete backends. */
  backends?: Record<string, BackendInfo>;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/** `~/.autoclaw/programs/<program_id>/dependencies.json`. */
export function dependenciesPath(homeDir: string, programId: string): string {
  return path.join(programDir(homeDir, programId), 'dependencies.json');
}

/** A fresh, well-formed empty registry. Caller stamps `updated_at` on write. */
export function emptyDependenciesDoc(): DependenciesDoc {
  return {
    schema_version: '1.0',
    updated_at: '',
    projects: {},
    dependencies: [],
  };
}

// ---------------------------------------------------------------------------
// Reads / writes
// ---------------------------------------------------------------------------

/**
 * Read the registry. Tolerates a missing file by returning a well-formed empty
 * doc (the program may simply have no declared dependencies yet).
 */
export async function readDependencies(homeDir: string, programId: string): Promise<DependenciesDoc> {
  try {
    const raw = await fsp.readFile(dependenciesPath(homeDir, programId), 'utf8');
    const doc = JSON.parse(raw.replace(/^﻿/, '')) as DependenciesDoc;
    // Defensive normalisation — a hand-edited file may omit array/object fields.
    if (!doc.projects) { doc.projects = {}; }
    if (!Array.isArray(doc.dependencies)) { doc.dependencies = []; }
    return doc;
  } catch {
    return emptyDependenciesDoc();
  }
}

/**
 * Atomically write the registry (tmp file + rename) and stamp `updated_at`.
 * `now` is injectable so tests are deterministic and there is no module-level
 * Date.now().
 */
export async function writeDependencies(
  homeDir: string,
  programId: string,
  doc: DependenciesDoc,
  now: Date = new Date(),
): Promise<void> {
  const dir = programDir(homeDir, programId);
  await fsp.mkdir(dir, { recursive: true });
  doc.updated_at = now.toISOString();
  const finalPath = dependenciesPath(homeDir, programId);
  const tmpPath = `${finalPath}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(doc, null, 2), 'utf8');
  await fsp.rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// Glob matching (conservative; minimatch is NOT a project dependency)
// ---------------------------------------------------------------------------

/**
 * Conservative glob matcher. `minimatch` is not in package.json, so we compile
 * a small, well-understood subset of glob syntax to a RegExp rather than pull a
 * new dependency for one call site. Supported tokens:
 *
 *   `**`  — matches any number of path segments (including zero), greedily;
 *   `*`   — matches anything except a path separator;
 *   `?`   — matches a single non-separator character;
 *   everything else is treated literally (regex-escaped).
 *
 * Both `/` and `\` are accepted as separators on the input side (Windows repos
 * report backslash paths) by normalising to `/` before matching. This is
 * intentionally a *conservative* matcher: it is used only to decide whether a
 * changed path falls within a declared contract surface, where over-notifying a
 * consumer is far safer than silently missing a breaking change.
 */
export function globMatch(glob: string, candidate: string): boolean {
  const normGlob = glob.replace(/\\/g, '/');
  const normCand = candidate.replace(/\\/g, '/');

  let re = '';
  for (let i = 0; i < normGlob.length; i++) {
    const c = normGlob[i];
    if (c === '*') {
      if (normGlob[i + 1] === '*') {
        // `**` — any chars including separators (zero or more segments).
        i++; // consume the second '*'
        // Swallow a trailing slash after `**` so "**/foo" matches "foo".
        if (normGlob[i + 1] === '/') { i++; }
        // If this `**` was preceded by a separator we already emitted ("/.*"),
        // make that separator optional so "src/**" also matches bare "src".
        if (re.endsWith('/')) {
          re = `${re.slice(0, -1)}(?:/.*)?`;
        } else {
          re += '.*';
        }
      } else {
        // single `*` — any chars except a separator.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      // Escape any regex-significant literal.
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(normCand);
}

/** True if ANY of `globs` matches ANY of `paths`. */
function globsIntersectPaths(globs: string[], paths: string[]): boolean {
  for (const g of globs) {
    for (const p of paths) {
      if (globMatch(g, p)) { return true; }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Return every dependency edge whose `producer` matches AND whose
 * `consumed_via` globs intersect any of `changedPaths` (the producer's contract
 * surface that just changed). This is the core of the §5.2 change-notification
 * flow: feed it a producer id + the paths a commit/edit touched, and it yields
 * exactly the consumer edges that need an `api_change` notification.
 */
export function consumersOf(doc: DependenciesDoc, producer: string, changedPaths: string[]): DependencyEdge[] {
  return doc.dependencies.filter(
    edge => edge.producer === producer && globsIntersectPaths(edge.consumed_via, changedPaths),
  );
}

/**
 * Add (or update) a dependency edge. Idempotent on the (consumer, producer, api)
 * triple: a second call with the same triple updates `version`, `consumed_via`,
 * and `notify` in place rather than appending a duplicate. Mutates and returns
 * `doc` for chaining.
 */
export function addDependency(doc: DependenciesDoc, edge: DependencyEdge): DependenciesDoc {
  const existing = doc.dependencies.find(
    e => e.consumer === edge.consumer && e.producer === edge.producer && e.api === edge.api,
  );
  if (existing) {
    existing.version = edge.version;
    existing.consumed_via = edge.consumed_via;
    existing.notify = edge.notify;
  } else {
    doc.dependencies.push(edge);
  }
  return doc;
}

/**
 * Look up the backend (vendor-swap) record for an abstract capability name.
 * Returns undefined when no backend is recorded for that capability.
 */
export function backendFor(doc: DependenciesDoc, api: string): BackendInfo | undefined {
  return doc.backends?.[api];
}

// ---------------------------------------------------------------------------
// Seed data (Appendix B) — convenience for tests / bootstrapping
// ---------------------------------------------------------------------------

/**
 * A registry pre-populated with the real workspace edges from the CIF proposal
 * Appendix B: `guru-connect` is the highest-fan-out producer, providing the
 * abstract `payments-api` capability to BOTH `checkitfixit` and `zippyhealth`.
 *
 * Vendor-neutral by construction: edges name the abstract capability
 * ("payments-api") only; the concrete implementation ("guru-connect-internal",
 * swappable for "stripe-adapter" / "zippycoin-ledger") lives only in `backends`.
 */
export function seedZippyStack(): DependenciesDoc {
  return {
    schema_version: '1.0',
    updated_at: '',
    projects: {
      'guru-connect': { owner: 'po-guru-connect', provides: ['payments-api', 'tenant-api', 'zippycoin-api'] },
      'checkitfixit': { owner: 'po-checkitfixit' },
      'zippyhealth': { owner: 'po-zippyhealth' },
    },
    dependencies: [
      {
        consumer: 'checkitfixit',
        producer: 'guru-connect',
        api: 'payments-api',
        version: 'v2',
        consumed_via: ['supabase/functions/**', 'src/services/payments/**'],
        notify: ['po-checkitfixit', 'claude-code'],
      },
      {
        consumer: 'zippyhealth',
        producer: 'guru-connect',
        api: 'payments-api',
        version: 'v2',
        consumed_via: ['apps/main-app/src/billing/**'],
        notify: ['po-zippyhealth'],
      },
    ],
    backends: {
      'payments-api': {
        current: 'guru-connect-internal',
        interchangeable: ['stripe-adapter', 'zippycoin-ledger'],
        contract: 'openapi:guru-connect/payments-api/v3.yaml',
      },
    },
  };
}
