/**
 * supervisorLease.ts — single active supervisor + standby failover (SH-2).
 *
 * Only ONE supervisor may run the HEAL phase at a time, or two orchestrator
 * hosts (two IDEs with the extension) would race on recovery. This is a
 * heartbeat-renewed lease, same mutex shape as a task claim: the first holder
 * wins; while its heartbeat stays fresh it keeps the role; if it goes stale a
 * standby (the next host to tick) steals the lease and becomes supervisor —
 * self-healing the healer.
 *
 * One file: `comms/supervisor.lock.json`. fs-only (no vscode), `now` injectable.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §3.4.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

const COMMS_REL = path.join('.autoclaw', 'orchestrator', 'comms');

/** Default lease lifetime — a holder is stale once its heartbeat is older. */
export const SUPERVISOR_TTL_MS = 90_000;

/** The on-disk supervisor lease. */
export interface SupervisorLease {
  /** The holding loop-instance id. */
  holder: string;
  /** When the role was first acquired (preserved across renewals). */
  acquired_at: string;
  /** Last heartbeat — freshness is measured from this. */
  heartbeat: string;
  /** When the lease goes stale if not renewed. */
  expires: string;
}

/** Result of an acquire attempt. */
export interface AcquireResult {
  /** True ⇒ the caller is the active supervisor and should run HEAL. */
  isSupervisor: boolean;
  /** The current holder id (the caller, when isSupervisor). */
  holder: string;
  /** True when the caller stole a stale lease from a previous holder. */
  stole: boolean;
}

export function supervisorLeasePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'supervisor.lock.json');
}

async function readLease(file: string): Promise<SupervisorLease | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const o = JSON.parse(raw.replace(/^﻿/, '')) as SupervisorLease;
    return o && typeof o.holder === 'string' && typeof o.heartbeat === 'string' ? o : null;
  } catch {
    return null;
  }
}

function isStale(lease: SupervisorLease, now: number, ttlMs: number): boolean {
  const hb = Date.parse(lease.heartbeat);
  return !Number.isFinite(hb) || now - hb > ttlMs;
}

async function writeLease(file: string, lease: SupervisorLease): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(lease, null, 2) + '\n', 'utf8');
}

/**
 * Try to become (or stay) the active supervisor.
 *
 *  - No lease         → acquire it (isSupervisor true).
 *  - Held by me       → renew (bump heartbeat/expiry), isSupervisor true.
 *  - Held by another, fresh → not supervisor (stand by).
 *  - Held by another, stale → steal it (isSupervisor true, stole true).
 *
 * The non-atomic read-then-write race between two hosts is acceptable: the loser
 * simply overwrites with its own id on its next tick and the duplicate HEAL is
 * idempotent (steal_claim of an already-deleted claim is a no-op; findings are
 * advisory). The lease exists to keep the *steady state* single-supervisor.
 */
export async function acquireSupervisorRole(
  workspaceRoot: string,
  holderId: string,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<AcquireResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? SUPERVISOR_TTL_MS;
  const file = supervisorLeasePath(workspaceRoot);
  const existing = await readLease(file);

  const nowIso = new Date(now).toISOString();
  const expIso = new Date(now + ttlMs).toISOString();

  if (!existing) {
    await writeLease(file, { holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
    return { isSupervisor: true, holder: holderId, stole: false };
  }

  if (existing.holder === holderId) {
    await writeLease(file, { ...existing, heartbeat: nowIso, expires: expIso });
    return { isSupervisor: true, holder: holderId, stole: false };
  }

  if (isStale(existing, now, ttlMs)) {
    await writeLease(file, { holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
    return { isSupervisor: true, holder: holderId, stole: true };
  }

  // A fresh lease held by someone else — stand by.
  return { isSupervisor: false, holder: existing.holder, stole: false };
}

/** Release the lease iff this holder owns it (graceful shutdown). */
export async function releaseSupervisorRole(workspaceRoot: string, holderId: string): Promise<boolean> {
  const file = supervisorLeasePath(workspaceRoot);
  const existing = await readLease(file);
  if (existing && existing.holder === holderId) {
    try { await fsp.unlink(file); return true; } catch { return false; }
  }
  return false;
}

/** Read the current lease (panel / diagnostics). */
export async function readSupervisorLease(workspaceRoot: string): Promise<SupervisorLease | null> {
  return readLease(supervisorLeasePath(workspaceRoot));
}
