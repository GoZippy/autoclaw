/**
 * discovery.ts — find out-of-tree connectors WITHOUT loading their code (acp/1).
 *
 * Scans the plugin directories for `connector.json` manifests and validates each
 * fail-closed. This is the read-only half of Phase 3: it answers "what connectors
 * are installed, and would each load?" for `autoclaw doctor` + the fleet panel.
 * It deliberately does NOT import or execute any connector module — code loading
 * (the dangerous part: arbitrary process spawn / repo edits) is gated behind
 * signing + conformance + worktree-jail in later phases.
 *
 * Scanned, in precedence order:
 *   1. workspace plugins:  <workspaceRoot>/.autoclaw/connectors/<id>/connector.json
 *   2. user plugins:       <homeDir>/.autoclaw/connectors/<id>/connector.json
 * (npm-scope discovery — @autoclaw/connector-* — is a later increment.)
 */

import * as fs from 'fs';
import * as path from 'path';

import { parseConnectorManifest, type ManifestValidation } from './manifest';

const fsp = fs.promises;

/** One discovered connector dir + its validation outcome (code NOT loaded). */
export interface DiscoveredConnector {
  /** The connector id (from the manifest, or the dir name when unparseable). */
  id: string;
  /** Absolute path of the connector dir. */
  dir: string;
  /** 'workspace' | 'user' — which plugin root it came from (precedence). */
  origin: 'workspace' | 'user';
  validation: ManifestValidation;
}

export interface DiscoverOptions {
  workspaceRoot?: string;
  /** Home dir (~). Injectable for tests. */
  homeDir?: string;
}

function connectorsRoot(base: string): string {
  return path.join(base, '.autoclaw', 'connectors');
}

async function scanRoot(root: string, origin: 'workspace' | 'user'): Promise<DiscoveredConnector[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return []; // missing root → nothing to discover
  }
  const out: DiscoveredConnector[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) { continue; }
    const dirName = path.basename(ent.name); // confine — no traversal
    if (dirName !== ent.name || dirName.startsWith('.')) { continue; }
    const dir = path.join(root, dirName);
    const manifestPath = path.join(dir, 'connector.json');
    let validation: ManifestValidation;
    try {
      validation = parseConnectorManifest(await fsp.readFile(manifestPath, 'utf8'));
    } catch {
      validation = {
        ok: false, status: 'disabled', unverified: true,
        reasons: ['no readable connector.json in connector dir'],
      };
    }
    out.push({ id: validation.manifest?.id ?? dirName, dir, origin, validation });
  }
  return out;
}

/**
 * Discover all installed connector manifests (read-only). Workspace plugins take
 * precedence over user plugins on id collision (workspace wins, user shadowed).
 * Never throws; a missing/unreadable root contributes nothing.
 */
export async function discoverConnectorManifests(opts: DiscoverOptions = {}): Promise<DiscoveredConnector[]> {
  const found: DiscoveredConnector[] = [];
  if (opts.workspaceRoot) {
    found.push(...await scanRoot(connectorsRoot(opts.workspaceRoot), 'workspace'));
  }
  if (opts.homeDir) {
    found.push(...await scanRoot(connectorsRoot(opts.homeDir), 'user'));
  }
  // De-dupe by id, workspace-wins (it is pushed first).
  const seen = new Set<string>();
  const result: DiscoveredConnector[] = [];
  for (const c of found) {
    if (seen.has(c.id)) { continue; }
    seen.add(c.id);
    result.push(c);
  }
  return result;
}
