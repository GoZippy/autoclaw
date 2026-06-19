/**
 * pending.ts — the pending-tray + admit core (FF-3).
 *
 * A "pending" agent is one that has checked in with a fresh beacon but is NOT
 * yet declared in the user's fleet.json — i.e. it has *joined* (visible) but not
 * been *admitted* (given an authoritative role + trust). The panel renders these
 * in a tray; the user clicks Admit (write it into fleet.json) or Decline (revoke
 * its invite + drop the beacon). Under an auto-admit policy the orchestrator
 * admits matching types without a click (see invites.admitDecision).
 *
 * This module is the pure + fs core the panel/commands call. Rendering lives in
 * the webview; command wiring lives in extension.ts.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §2.2.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FleetManifest, FleetAgentDecl } from './architecture';
import type { BeaconRow } from './beacons';
import type { Invite } from './invites';

const fsp = fs.promises;

/** An agent visible via a beacon but not yet admitted to fleet.json. */
export interface PendingAgent {
  agent_id: string;
  session_id?: string;
  host?: string;
  suggested_role?: string;
  suggested_agent_type?: string;
  /** Token of the invite this agent consumed, when one matches. */
  via_invite?: string;
  /** Trust ceiling on arrival — from the invite, else 'off'. */
  trust: string;
}

/**
 * Pure: agents present as a FRESH beacon but absent from fleet.json. Suggested
 * role/type + trust come from a matching consumed invite first, then the
 * beacon's self-declared hints. Stale beacons are not pending (they're gone).
 */
export function computePendingAgents(
  beacons: BeaconRow[],
  manifest: FleetManifest | null,
  invites: Invite[] = [],
): PendingAgent[] {
  const declared = new Set(Object.keys(manifest?.agents ?? {}));
  const inviteByAgent = new Map<string, Invite>();
  for (const inv of invites) {
    if (inv.consumed_by?.agent_id) {
      inviteByAgent.set(inv.consumed_by.agent_id, inv);
    }
  }

  const out: PendingAgent[] = [];
  const seen = new Set<string>();
  for (const b of beacons) {
    if (b.stale) { continue; }
    if (declared.has(b.agent_id)) { continue; }
    if (seen.has(b.agent_id)) { continue; }
    seen.add(b.agent_id);

    const inv = inviteByAgent.get(b.agent_id);
    out.push({
      agent_id: b.agent_id,
      ...(b.session_id ? { session_id: b.session_id } : {}),
      ...(b.host ? { host: b.host } : {}),
      suggested_role: inv?.suggested_role ?? b.role,
      suggested_agent_type: inv?.suggested_agent_type ?? b.agent_type,
      ...(inv ? { via_invite: inv.token } : {}),
      trust: inv?.trust ?? 'off',
    });
  }
  return out.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

/**
 * Pure: return a new manifest with `agentId` admitted (added/updated). The
 * orchestrator and other agents are preserved.
 */
export function admitToFleet(
  manifest: FleetManifest | null,
  agentId: string,
  decl: FleetAgentDecl,
): FleetManifest {
  const base: FleetManifest = manifest ?? { schema_version: '1.0', agents: {} };
  return {
    ...base,
    agents: {
      ...(base.agents ?? {}),
      [agentId]: { ...(base.agents?.[agentId] ?? {}), ...decl },
    },
  };
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

/** Path to fleet.json under an `.autoclaw/` dir. */
export function fleetPath(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'fleet.json');
}

/** Read fleet.json. Returns null if missing or malformed. */
export async function readFleetManifest(autoclawDir: string): Promise<FleetManifest | null> {
  try {
    const raw = await fsp.readFile(fleetPath(autoclawDir), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as FleetManifest;
  } catch {
    return null;
  }
}

/** Write fleet.json. */
export async function writeFleetManifest(autoclawDir: string, manifest: FleetManifest): Promise<string> {
  const file = fleetPath(autoclawDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return file;
}

/** Read-modify-write: admit an agent into fleet.json. Returns the new manifest. */
export async function admitAgent(
  autoclawDir: string,
  agentId: string,
  decl: FleetAgentDecl,
): Promise<FleetManifest> {
  const current = await readFleetManifest(autoclawDir);
  const next = admitToFleet(current, agentId, decl);
  await writeFleetManifest(autoclawDir, next);
  return next;
}
