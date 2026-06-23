/**
 * manifest.ts — fail-closed validation of a connector.json (acp/1).
 *
 * Deny-by-default, mirroring validateScopeFile: a malformed/absent manifest, an
 * unparseable permissions block, or an unrecognized tier yields a DISABLED
 * connector with a surfaced hint — never a wildcard. A connector targeting a
 * protocol/ABI major the host does not speak is SHELVED (hint), not crashed.
 * Unknown future fields are preserved on round-trip.
 *
 * Signature verification + provenance/SBOM checks are Phase 5 — here an unsigned
 * manifest is merely flagged `unverified` (loadable only as tier-3-unverified by
 * the caller's policy), not rejected.
 */

import {
  ACP_VERSION, HOST_ABI,
  type ConnectorManifest, type ConnectorFace, type ConnectorTier,
} from './types';

const FACES: readonly ConnectorFace[] = ['runner', 'source', 'presence'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Outcome of validating one manifest. */
export interface ManifestValidation {
  /** True iff the connector may be registered (possibly as unverified). */
  ok: boolean;
  /** 'ok' = loadable; 'shelved' = wrong acp/abi major; 'disabled' = malformed/unsafe. */
  status: 'ok' | 'shelved' | 'disabled';
  /** The normalized manifest (tier defaulted, runner→tier≥2 applied), when parseable. */
  manifest?: ConnectorManifest;
  /** Unsigned (or signature not yet verified) — caller gates as tier-3-unverified. */
  unverified: boolean;
  /** Human-readable reasons / hints (always present; the audit trail). */
  reasons: string[];
}

/** Parse a "major.minor" string into [major, minor]; NaNs on failure. */
function parseMM(v: string): [number, number] {
  const m = /^(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
}
function cmpMM(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) { return a[0] - b[0]; }
  return a[1] - b[1];
}

/**
 * Does `hostAbi` (major.minor) satisfy an abiRange like ">=2.0 <3.0"? Supported
 * comparators: >= > <= < = (and a bare "X.Y" meaning exact). Empty/absent range
 * is permissive (true). A token that can't be parsed makes the range fail-closed
 * (false) so a mis-declared range shelves rather than silently loads.
 */
export function satisfiesAbiRange(range: string | undefined, hostAbi: string = HOST_ABI): boolean {
  if (!range || !range.trim()) { return true; }
  const host = parseMM(hostAbi);
  if (Number.isNaN(host[0])) { return false; }
  for (const tok of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?\s*(\d+\.\d+)$/.exec(tok);
    if (!m) { return false; } // unparseable token → fail-closed
    const op = m[1] ?? '=';
    const bound = parseMM(m[2]);
    const c = cmpMM(host, bound);
    const ok =
      op === '>=' ? c >= 0 :
      op === '<=' ? c <= 0 :
      op === '>' ? c > 0 :
      op === '<' ? c < 0 :
      c === 0;
    if (!ok) { return false; }
  }
  return true;
}

function acpMajor(tag: string): number {
  const m = /^acp\/(\d+)/.exec(String(tag).trim());
  return m ? Number(m[1]) : NaN;
}

/**
 * Validate a parsed manifest object (fail-closed). Returns a structured outcome;
 * never throws. The returned `manifest` preserves unknown fields.
 */
export function validateConnectorManifest(raw: unknown): ManifestValidation {
  const reasons: string[] = [];
  const disabled = (reason: string): ManifestValidation => {
    reasons.push(reason);
    return { ok: false, status: 'disabled', unverified: true, reasons };
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return disabled('manifest is not a JSON object');
  }
  const m = raw as Record<string, unknown>;

  // acp tag — shelve a major the host does not speak (never crash).
  const acp = typeof m.acp === 'string' ? m.acp : '';
  const hostMajor = acpMajor(ACP_VERSION);
  const cMajor = acpMajor(acp);
  if (Number.isNaN(cMajor)) { return disabled(`missing/invalid "acp" tag (got ${JSON.stringify(m.acp)})`); }
  if (cMajor !== hostMajor) {
    reasons.push(`connector targets ${acp}; host speaks ${ACP_VERSION} — shelved`);
    return { ok: false, status: 'shelved', unverified: true, reasons };
  }

  // id — THE shared identity; must be a safe, separator-free token.
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!id || !ID_RE.test(id)) { return disabled(`missing/invalid "id" (got ${JSON.stringify(m.id)})`); }

  // provides — non-empty subset of the known faces.
  if (!Array.isArray(m.provides) || m.provides.length === 0) {
    return disabled('"provides" must be a non-empty array of faces');
  }
  const provides = m.provides.filter((f): f is ConnectorFace => FACES.includes(f as ConnectorFace));
  if (provides.length !== m.provides.length) {
    return disabled(`"provides" has unknown face(s): ${JSON.stringify(m.provides)}`);
  }

  // permissions — if present, must be an object (malformed → fail-closed).
  if (m.permissions !== undefined && (typeof m.permissions !== 'object' || m.permissions === null || Array.isArray(m.permissions))) {
    return disabled('"permissions" is present but not an object');
  }

  // tier — default 3 (most-restricted); a runner forces tier ≥ 2.
  let tier: ConnectorTier;
  if (m.tier === undefined) { tier = 3; }
  else if (m.tier === 1 || m.tier === 2 || m.tier === 3) { tier = m.tier; }
  else { return disabled(`unrecognized "tier" ${JSON.stringify(m.tier)} (expected 1|2|3)`); }
  if (provides.includes('runner') && tier > 2) {
    reasons.push('connector provides a runner → tier forced from 3 to 2 (runners may not be tier 3)');
    tier = 2;
  }

  // abiRange — refuse to load outside the declared range (shelve).
  if (m.abiRange !== undefined && typeof m.abiRange !== 'string') {
    return disabled('"abiRange" must be a string');
  }
  if (!satisfiesAbiRange(typeof m.abiRange === 'string' ? m.abiRange : undefined)) {
    reasons.push(`host ABI ${HOST_ABI} is outside connector abiRange "${String(m.abiRange)}" — shelved`);
    return { ok: false, status: 'shelved', unverified: true, reasons };
  }

  const unverified = typeof m.signature !== 'string' || m.signature.trim().length === 0;
  if (unverified) { reasons.push('manifest is unsigned — loadable only as tier-3 unverified'); }

  const manifest: ConnectorManifest = {
    ...(m as ConnectorManifest), // preserve unknown/forward fields
    acp,
    id,
    tier,
    provides,
  };
  if (reasons.length === 0) { reasons.push('ok'); }
  return { ok: true, status: 'ok', manifest, unverified, reasons };
}

/** Parse raw JSON text into a manifest validation (tolerant of bad JSON). */
export function parseConnectorManifest(text: string): ManifestValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, status: 'disabled', unverified: true, reasons: [`manifest is not valid JSON: ${(e as Error).message}`] };
  }
  return validateConnectorManifest(raw);
}
