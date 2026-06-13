/**
 * fleetHalt.ts — The fleet HALT kill switch (HKS-3).
 *
 * One file, one rule: while `.autoclaw/orchestrator/HALT` exists, nothing in
 * this workspace auto-dispatches — not the orchestrator loop, not trigger
 * hooks. Engaged/released by the `autoclaw.fleet.halt` / `autoclaw.fleet.resume`
 * commands (or by creating/deleting the file manually — it's just a file, so
 * it works from any shell or remote session too).
 *
 * Leaf module by design: imported by both orchestratorLoop.ts and
 * hooks/triggerHooks.ts without creating an import cycle.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

/** Relative path of the fleet kill-switch file. Presence = halted. */
export const HALT_FILE_REL = path.join('.autoclaw', 'orchestrator', 'HALT');

/** True when the fleet kill switch is engaged for this workspace. */
export function isFleetHalted(workspaceRoot: string): boolean {
  try { return fs.existsSync(path.join(workspaceRoot, HALT_FILE_REL)); } catch { return false; }
}

/**
 * Engage or release the fleet kill switch. Engaging writes a small JSON body
 * (who/when/why) so the panel and remote workers can surface the reason.
 */
export async function setFleetHalted(
  workspaceRoot: string,
  halted: boolean,
  reason?: string
): Promise<void> {
  const haltPath = path.join(workspaceRoot, HALT_FILE_REL);
  if (halted) {
    await fsPromises.mkdir(path.dirname(haltPath), { recursive: true });
    await fsPromises.writeFile(haltPath, JSON.stringify({
      halted_at: new Date().toISOString(),
      by: 'operator',
      reason: reason ?? 'manual fleet halt',
    }, null, 2), 'utf8');
  } else {
    try { await fsPromises.unlink(haltPath); } catch { /* already resumed */ }
  }
}
