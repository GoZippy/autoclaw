/**
 * trustPresets.ts — `agents/<agent>/scope.json` trust-preset model (B5).
 *
 * RFC §3 (trust presets) and §4 (scope declaration) define a per-agent
 * `scope.json` that pins a {@link TrustPreset} (`off` | `auto` | `turbo`)
 * plus allow/deny tool lists and path/branch/budget scoping. `registry.ts`
 * already owns the *translation* of a preset into host-specific flags
 * (`translateTrust` / `TRUST_PRESET_TABLE`). This module owns the layer
 * *above* that: reading, validating, normalising and persisting the
 * `scope.json` document, and resolving the effective per-dispatch trust
 * for a runner — including how the allow/deny lists interact with the
 * preset's baseline auto-approval set.
 *
 * Why a separate module: the registry stays a pure flag-translation table
 * with no filesystem surface; this module is the one place that touches
 * `agents/<agent>/scope.json` on disk, so the I/O policy (deny-by-default,
 * tolerant of a missing/corrupt file) lives in exactly one spot.
 *
 * Sprint 3 — B5 (WA-3)
 *
 * @see docs/rfc/runner-bridge-contract.md §3, §4
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ScopeDeclaration, TrustPreset } from './types';
import { translateTrust, type TrustTranslation } from './registry';

const fsPromises = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Valid trust presets, in stricter-to-looser order. */
export const TRUST_PRESETS: readonly TrustPreset[] = ['off', 'auto', 'turbo'];

/**
 * Read-only tool categories an `auto` preset auto-approves by default
 * (RFC §3 — "read-only tools auto-approved: read, grep, ls, list-sessions").
 * A `scope.json` `trustAllowList` *adds* to this baseline; a `trustDenyList`
 * *removes* from it.
 */
export const AUTO_BASELINE_TOOLS: readonly string[] = [
  'read',
  'grep',
  'search',
  'ls',
  'list-sessions',
];

/** The strictest preset — used as the conservative fallback everywhere. */
export const STRICTEST_PRESET: TrustPreset = 'off';

/* -------------------------------------------------------------------------- */
/*  scope.json model                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The on-disk `agents/<agent>/scope.json` document. A superset of
 * {@link ScopeDeclaration} with the bookkeeping fields the orchestrator
 * stamps when it writes the file.
 */
export interface AgentScopeFile extends ScopeDeclaration {
  /** The agent id this scope governs (`claude-code`, `kilocode`, …). */
  agent: string;
  /** Schema version, for forward-compatible migrations. */
  schema_version?: string;
  /** ISO timestamp the file was last written by the orchestrator. */
  updated_at?: string;
}

/** Current `scope.json` schema version. */
export const SCOPE_SCHEMA_VERSION = '1.0';

/**
 * Outcome of {@link validateScopeFile}. `value` is the normalised document
 * when `ok`; `errors` lists every problem when not.
 */
export type ScopeValidation =
  | { ok: true; value: AgentScopeFile }
  | { ok: false; errors: string[] };

/* -------------------------------------------------------------------------- */
/*  Validation & normalisation                                                */
/* -------------------------------------------------------------------------- */

/** Type guard — a value is one of the three known trust presets. */
export function isTrustPreset(v: unknown): v is TrustPreset {
  return v === 'off' || v === 'auto' || v === 'turbo';
}

/** Coerce an unknown value to a `string[]`, dropping non-strings. */
function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean);
  return out;
}

/**
 * Validate and normalise a parsed `scope.json` object.
 *
 * Deny-by-default: an absent or unparseable `trust` field is *not* silently
 * upgraded — the caller gets an error and should fall back to {@link STRICTEST_PRESET}
 * via {@link defaultScopeFile}. A bad allow/deny list is dropped (treated as
 * absent) rather than failing the whole document, since an empty list is a
 * safe interpretation.
 */
export function validateScopeFile(raw: unknown, agentHint?: string): ScopeValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['scope.json must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  const agent =
    typeof obj.agent === 'string' && obj.agent.trim()
      ? obj.agent.trim()
      : (agentHint ?? '');
  if (!agent) {
    errors.push('scope.json is missing the "agent" field');
  }

  if (!isTrustPreset(obj.trust)) {
    errors.push(
      `scope.json "trust" must be one of ${TRUST_PRESETS.join(' | ')} (got ${JSON.stringify(obj.trust)})`,
    );
  }

  // Numeric budgets, when present, must be positive finite numbers.
  for (const key of ['maxTokensPerDispatch', 'maxWallClockMs'] as const) {
    if (obj[key] !== undefined) {
      const n = obj[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        errors.push(`scope.json "${key}" must be a positive number`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: AgentScopeFile = {
    agent,
    trust: obj.trust as TrustPreset,
    schema_version:
      typeof obj.schema_version === 'string' ? obj.schema_version : SCOPE_SCHEMA_VERSION,
  };
  const allow = toStringArray(obj.trustAllowList);
  if (allow) {
    value.trustAllowList = allow;
  }
  const deny = toStringArray(obj.trustDenyList);
  if (deny) {
    value.trustDenyList = deny;
  }
  const pathScope = toStringArray(obj.pathScope);
  if (pathScope) {
    value.pathScope = pathScope;
  }
  const branchScope = toStringArray(obj.branchScope);
  if (branchScope) {
    value.branchScope = branchScope;
  }
  if (typeof obj.browserAllowed === 'boolean') {
    value.browserAllowed = obj.browserAllowed;
  }
  if (typeof obj.maxTokensPerDispatch === 'number') {
    value.maxTokensPerDispatch = obj.maxTokensPerDispatch;
  }
  if (typeof obj.maxWallClockMs === 'number') {
    value.maxWallClockMs = obj.maxWallClockMs;
  }
  if (typeof obj.updated_at === 'string') {
    value.updated_at = obj.updated_at;
  }
  return { ok: true, value };
}

/**
 * The safe default `scope.json` for an agent with no file on disk:
 * the strictest preset, no allow list, no path scope.
 */
export function defaultScopeFile(agent: string): AgentScopeFile {
  return {
    agent,
    trust: STRICTEST_PRESET,
    schema_version: SCOPE_SCHEMA_VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/*  Filesystem I/O                                                            */
/* -------------------------------------------------------------------------- */

/** Absolute path to `agents/<agent>/scope.json` under an orchestrator dir. */
export function scopeFilePath(orchestratorDir: string, agent: string): string {
  return path.join(orchestratorDir, 'agents', path.basename(agent), 'scope.json');
}

/**
 * Read `agents/<agent>/scope.json`. Returns the normalised document, or the
 * {@link defaultScopeFile} (strictest preset) when the file is missing,
 * unreadable, or fails validation — never throws. `source` tells the caller
 * which path was taken so a corrupt file can be surfaced rather than masked.
 */
export async function readScopeFile(
  orchestratorDir: string,
  agent: string,
): Promise<{ scope: AgentScopeFile; source: 'file' | 'default'; errors?: string[] }> {
  const file = scopeFilePath(orchestratorDir, agent);
  let raw: string;
  try {
    raw = await fsPromises.readFile(file, 'utf8');
  } catch {
    return { scope: defaultScopeFile(agent), source: 'default' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return {
      scope: defaultScopeFile(agent),
      source: 'default',
      errors: ['scope.json is not valid JSON'],
    };
  }
  const validation = validateScopeFile(parsed, agent);
  if (!validation.ok) {
    return { scope: defaultScopeFile(agent), source: 'default', errors: validation.errors };
  }
  return { scope: validation.value, source: 'file' };
}

/**
 * Persist `agents/<agent>/scope.json`. The document is validated first; an
 * invalid document is rejected (the orchestrator never writes a scope file
 * that would later read back as the strict default). `updated_at` and
 * `schema_version` are stamped on write.
 */
export async function writeScopeFile(
  orchestratorDir: string,
  scope: AgentScopeFile,
): Promise<{ ok: true; path: string } | { ok: false; errors: string[] }> {
  const validation = validateScopeFile(scope, scope.agent);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const doc: AgentScopeFile = {
    ...validation.value,
    schema_version: SCOPE_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  const file = scopeFilePath(orchestratorDir, scope.agent);
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { ok: true, path: file };
}

/* -------------------------------------------------------------------------- */
/*  Effective trust resolution                                                */
/* -------------------------------------------------------------------------- */

/**
 * The fully-resolved trust decision for one (agent, runner) dispatch:
 * the host-specific flag {@link TrustTranslation} plus the *materialised*
 * allow/deny tool sets after the preset baseline and the scope lists are
 * combined.
 */
export interface EffectiveTrust {
  /** The preset that was applied (from `scope.json`). */
  preset: TrustPreset;
  /** Host-specific flag translation (possibly downgraded — see RFC §3). */
  translation: TrustTranslation;
  /** Tool categories auto-approved for this dispatch. */
  autoApproved: string[];
  /** Tool categories explicitly denied; precedence over the allow set. */
  denied: string[];
  /** True when the runner could not honor the requested preset. */
  downgraded: boolean;
}

/**
 * Resolve the auto-approved tool set for a preset + scope lists.
 *
 * - `off`   — nothing is auto-approved (every call prompts).
 * - `auto`  — {@link AUTO_BASELINE_TOOLS} ∪ `trustAllowList`, minus `trustDenyList`.
 * - `turbo` — everything auto-approved; the result is the *complement* model,
 *             so we return the allow list as informational and rely on
 *             `denied` to carry the only restriction. An empty `autoApproved`
 *             with `preset === 'turbo'` means "all except denied".
 *
 * The deny list always wins over the allow list (RFC §4).
 */
export function resolveAutoApproved(scope: ScopeDeclaration): { autoApproved: string[]; denied: string[] } {
  const deny = new Set((scope.trustDenyList ?? []).map(s => s.trim()).filter(Boolean));
  const denied = [...deny];

  if (scope.trust === 'off') {
    return { autoApproved: [], denied };
  }
  if (scope.trust === 'turbo') {
    // turbo = allow-all-except-deny; autoApproved is left empty by convention.
    return { autoApproved: [], denied };
  }
  // auto: baseline ∪ allow-list, then subtract deny-list.
  const set = new Set<string>(AUTO_BASELINE_TOOLS);
  for (const t of scope.trustAllowList ?? []) {
    const trimmed = t.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  for (const d of deny) {
    set.delete(d);
  }
  return { autoApproved: [...set].sort(), denied };
}

/**
 * Resolve the effective trust for an (agent scope, runner) pair: combine the
 * registry's host-flag translation with the materialised allow/deny sets.
 *
 * This is the single call a dispatcher makes — it never needs to touch
 * `translateTrust` and `resolveAutoApproved` separately.
 */
export function resolveEffectiveTrust(
  runnerId: string,
  scope: ScopeDeclaration,
): EffectiveTrust {
  const translation = translateTrust(runnerId, scope.trust);
  const { autoApproved, denied } = resolveAutoApproved(scope);
  return {
    preset: scope.trust,
    translation,
    autoApproved,
    denied,
    downgraded: translation.downgradedFrom !== undefined,
  };
}

/**
 * Decide whether a single named tool category is auto-approved for a scope.
 *
 * - A tool on the deny list is never auto-approved (precedence rule).
 * - Under `turbo`, anything not denied is auto-approved.
 * - Under `auto`, only tools in the resolved {@link resolveAutoApproved} set.
 * - Under `off`, nothing is auto-approved.
 */
export function isToolAutoApproved(scope: ScopeDeclaration, tool: string): boolean {
  const name = tool.trim();
  if (!name) {
    return false;
  }
  const { autoApproved, denied } = resolveAutoApproved(scope);
  if (denied.includes(name)) {
    return false;
  }
  if (scope.trust === 'turbo') {
    return true;
  }
  if (scope.trust === 'off') {
    return false;
  }
  return autoApproved.includes(name);
}
