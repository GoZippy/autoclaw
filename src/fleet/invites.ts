/**
 * invites.ts — Join tokens for inviting an outside agent onto a project (FF-2).
 *
 * An invite is a single-use, scoped, TTL'd token a human (or an orchestrator)
 * issues so a specific outside agent — from OpenClaw, Hermes, another chat
 * session, or another IDE — can JOIN this project bounded by construction. The
 * token carries the path scope it's allowed (a lease seed), a trust ceiling
 * (default off — the agent arrives non-acting), and the admit policy that
 * governs whether consuming it auto-admits the agent or drops it in the
 * pending tray for a human.
 *
 * This module is pure of vscode and touches fs only for the invite files. It
 * mirrors beacons.ts: two homes (machine-global + workspace), `now` injectable
 * for tests, deny-by-default on anything malformed.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §2 (invite) + §8 (admit policy).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsp = fs.promises;

/**
 * How an agent that consumes an invite is admitted to the fleet:
 * - `manual`           — every join waits for a human click in the pending tray.
 * - `auto-preapproved` — an autonomous orchestrator may admit a consuming agent
 *                        whose *type* is in `preapproved_types`; others wait. (default)
 * - `open`             — admit any valid invite (a trusted LAN / program).
 */
export type AdmitPolicy = 'manual' | 'auto-preapproved' | 'open';

/** The trust ceiling an invited agent arrives with. */
export type InviteTrust = 'off' | 'auto' | 'turbo';

/** Stamp recorded when an invite is consumed (single-use). */
export interface InviteConsumption {
  agent_id: string;
  session_id?: string;
  at: string;
}

/** An on-disk invite token. */
export interface Invite {
  token: string;
  issued_by: string;
  project: string;
  workspace?: string;
  /** Optional sprint this invite is scoped to (per-sprint admit control). */
  sprint?: string;
  /** Role hint shown in the tray; the user's fleet.json still wins. */
  suggested_role?: string;
  suggested_agent_type?: string;
  /** Path globs the invited agent may touch — seeds a scope-lease. */
  scope?: string[];
  /** Lanes the invited agent is expected to speak: fs|mcp|http|relay. */
  transports?: string[];
  /** Trust ceiling on arrival (default 'off' — visible but non-acting). */
  trust: InviteTrust;
  /** How consuming this invite admits the agent (default 'auto-preapproved'). */
  admit_policy: AdmitPolicy;
  /** Agent types auto-admitted under 'auto-preapproved'. */
  preapproved_types?: string[];
  issued_at: string;
  expires: string;
  /** Null until consumed; single-use thereafter. */
  consumed_by?: InviteConsumption | null;
}

/** Default invite lifetime — 24 hours. */
export const INVITE_TTL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Path helpers (mirror beacons.ts)
// ---------------------------------------------------------------------------

/** The machine-global invite directory (`~/.autoclaw/invites`). */
export function machineInviteDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.autoclaw', 'invites');
}

/** A workspace's invite directory (under the comms tree). */
export function workspaceInviteDir(commsDir: string): string {
  return path.join(commsDir, 'invites');
}

/** Resolve the directory an op should target, mirroring writeBeacon's opts. */
function resolveDir(opts: InviteOpts): string {
  return opts.scope === 'workspace' && opts.commsDir
    ? workspaceInviteDir(opts.commsDir)
    : machineInviteDir(opts.homeDir);
}

/** Sanitize a token for use as a filename. */
function safeToken(t: string): string {
  return t.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Common options: which home + an injectable `now`. */
export interface InviteOpts {
  scope?: 'machine' | 'workspace';
  commsDir?: string;
  homeDir?: string;
  now?: number;
}

// ---------------------------------------------------------------------------
// Validate / normalize
// ---------------------------------------------------------------------------

/** True if `v` has the minimum fields to be a usable invite. */
export function isValidInvite(v: unknown): v is Invite {
  if (!v || typeof v !== 'object') { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.token === 'string' && o.token.length > 0
    && typeof o.project === 'string'
    && typeof o.expires === 'string' && o.expires.length > 0;
}

/** True if `inv` is past its TTL relative to `now`. */
export function isExpired(inv: Invite, now: number): boolean {
  const t = new Date(inv.expires).getTime();
  return !Number.isFinite(t) || now > t;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  issued_by: string;
  project: string;
  workspace?: string;
  sprint?: string;
  suggested_role?: string;
  suggested_agent_type?: string;
  scope?: string[];
  transports?: string[];
  trust?: InviteTrust;
  admit_policy?: AdmitPolicy;
  preapproved_types?: string[];
  /** Override the generated token (tests). */
  token?: string;
  /** Override the TTL in ms (default INVITE_TTL_MS). */
  ttlMs?: number;
}

/**
 * Create + persist a new invite. Returns the written Invite. The token is
 * random unless `input.token` is supplied (tests). `now` is injectable.
 */
export async function createInvite(input: CreateInviteInput, opts: InviteOpts = {}): Promise<Invite> {
  const now = opts.now ?? Date.now();
  const ttl = input.ttlMs ?? INVITE_TTL_MS;
  const token = input.token ?? `join-${crypto.randomBytes(9).toString('hex')}`;
  const invite: Invite = {
    token,
    issued_by: input.issued_by,
    project: input.project,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.sprint ? { sprint: input.sprint } : {}),
    ...(input.suggested_role ? { suggested_role: input.suggested_role } : {}),
    ...(input.suggested_agent_type ? { suggested_agent_type: input.suggested_agent_type } : {}),
    ...(input.scope && input.scope.length ? { scope: input.scope } : {}),
    ...(input.transports && input.transports.length ? { transports: input.transports } : {}),
    trust: input.trust ?? 'off',
    admit_policy: input.admit_policy ?? 'auto-preapproved',
    ...(input.preapproved_types && input.preapproved_types.length
      ? { preapproved_types: input.preapproved_types }
      : {}),
    issued_at: new Date(now).toISOString(),
    expires: new Date(now + ttl).toISOString(),
    consumed_by: null,
  };

  const dir = resolveDir(opts);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${safeToken(token)}.json`),
    JSON.stringify(invite, null, 2) + '\n',
    'utf8',
  );
  return invite;
}

// ---------------------------------------------------------------------------
// Read / list
// ---------------------------------------------------------------------------

/** Read one invite by token. Returns null if missing or malformed. */
export async function readInvite(token: string, opts: InviteOpts = {}): Promise<Invite | null> {
  const dir = resolveDir(opts);
  try {
    const raw = await fsp.readFile(path.join(dir, `${safeToken(token)}.json`), 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    return isValidInvite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** List every invite in the resolved directory. Malformed files are skipped. */
export async function listInvites(opts: InviteOpts = {}): Promise<Invite[]> {
  const dir = resolveDir(opts);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: Invite[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
      if (isValidInvite(parsed)) { out.push(parsed); }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Consume (single-use) / revoke
// ---------------------------------------------------------------------------

export type ConsumeResult =
  | { ok: true; invite: Invite }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_consumed' };

/**
 * Consume an invite for a joining agent. Single-use: stamps `consumed_by` and
 * writes it back. Fails if the token is unknown, expired, or already consumed.
 * `now` is injectable.
 */
export async function consumeInvite(
  token: string,
  consumer: { agent_id: string; session_id?: string },
  opts: InviteOpts = {},
): Promise<ConsumeResult> {
  const now = opts.now ?? Date.now();
  const inv = await readInvite(token, opts);
  if (!inv) { return { ok: false, reason: 'not_found' }; }
  if (inv.consumed_by) { return { ok: false, reason: 'already_consumed' }; }
  if (isExpired(inv, now)) { return { ok: false, reason: 'expired' }; }

  inv.consumed_by = {
    agent_id: consumer.agent_id,
    ...(consumer.session_id ? { session_id: consumer.session_id } : {}),
    at: new Date(now).toISOString(),
  };
  const dir = resolveDir(opts);
  await fsp.writeFile(
    path.join(dir, `${safeToken(token)}.json`),
    JSON.stringify(inv, null, 2) + '\n',
    'utf8',
  );
  return { ok: true, invite: inv };
}

/** Revoke (delete) an invite. Returns true if a file was removed. */
export async function revokeInvite(token: string, opts: InviteOpts = {}): Promise<boolean> {
  const dir = resolveDir(opts);
  try {
    await fsp.unlink(path.join(dir, `${safeToken(token)}.json`));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Admit policy resolution
// ---------------------------------------------------------------------------

export interface AdmitDecision {
  /** True ⇒ admit without a human; false ⇒ park in the pending tray. */
  admit: boolean;
  reason: string;
}

/**
 * Decide whether an agent consuming `invite` is auto-admitted. Pure — the panel
 * / orchestrator calls this after a successful consume. `consumerType` is the
 * joining agent's declared `agent_type` (matched against `preapproved_types`).
 *
 *   open             → admit
 *   auto-preapproved → admit iff consumerType ∈ preapproved_types
 *   manual           → never auto (human decides in the tray)
 */
export function admitDecision(invite: Invite, consumerType?: string): AdmitDecision {
  switch (invite.admit_policy) {
    case 'open':
      return { admit: true, reason: 'admit policy is open' };
    case 'auto-preapproved': {
      const list = invite.preapproved_types ?? [];
      if (consumerType && list.includes(consumerType)) {
        return { admit: true, reason: `type "${consumerType}" is pre-approved` };
      }
      return {
        admit: false,
        reason: consumerType
          ? `type "${consumerType}" not pre-approved — awaiting admit`
          : 'no agent_type declared — awaiting admit',
      };
    }
    case 'manual':
    default:
      return { admit: false, reason: 'admit policy is manual — awaiting human' };
  }
}
