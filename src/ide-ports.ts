import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export type IdeId =
  | 'vscode'
  | 'cursor'
  | 'kiro'
  | 'windsurf'
  | 'antigravity'
  | 'other';

interface IdePortBlock {
  bridgeBase: number;
  kgBase: number;
}

const IDE_PORT_BLOCKS: Record<IdeId, IdePortBlock> = {
  vscode:      { bridgeBase: 9876,  kgBase: 9877 },
  cursor:      { bridgeBase: 10876, kgBase: 10877 },
  kiro:        { bridgeBase: 11876, kgBase: 11877 },
  windsurf:    { bridgeBase: 12876, kgBase: 12877 },
  antigravity: { bridgeBase: 13876, kgBase: 13877 },
  other:       { bridgeBase: 14876, kgBase: 14877 },
};

export const PER_IDE_FALLBACK_COUNT = 4;

const PORT_REGISTRY_VERSION = 1;

interface PortRegistryEntry {
  ide: IdeId;
  workspace: string;
  bridgePort: number;
  kgPort: number;
  pid: number;
  lastSeen: string;
}

interface PortRegistry {
  version: typeof PORT_REGISTRY_VERSION;
  entries: PortRegistryEntry[];
}

function registryPath(): string {
  return path.join(os.homedir(), '.autoclaw', '.port-registry.json');
}

function loadRegistry(): PortRegistry {
  try {
    const raw = fs.readFileSync(registryPath(), 'utf8');
    const parsed = JSON.parse(raw) as PortRegistry;
    if (parsed.version === PORT_REGISTRY_VERSION && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch { /* missing or corrupt — start fresh */ }
  return { version: PORT_REGISTRY_VERSION, entries: [] };
}

function saveRegistry(reg: PortRegistry): void {
  try {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2), 'utf8');
  } catch { /* registry is best-effort */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) { return; }
      settled = true;
      try { probe.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    probe.once('error', () => finish(false));
    probe.once('listening', () => { probe.close(() => finish(true)); });
    try { probe.listen(port, host); } catch { finish(false); }
  });
}

export function detectIde(appName: string): IdeId {
  const lower = appName.toLowerCase();
  if (lower.includes('cursor')) { return 'cursor'; }
  if (lower.includes('kiro')) { return 'kiro'; }
  if (lower.includes('windsurf')) { return 'windsurf'; }
  if (lower.includes('antigravity')) { return 'antigravity'; }
  if (lower.includes('code') || lower.includes('vscode')) { return 'vscode'; }
  return 'other';
}

function workspaceSalt(workspacePath: string): number {
  const h = crypto.createHash('sha1').update(workspacePath).digest();
  return h.readUInt32LE(0) % (PER_IDE_FALLBACK_COUNT + 1);
}

export function getIdePorts(ide: IdeId, workspacePath?: string): { bridgePort: number; kgPort: number } {
  const block = IDE_PORT_BLOCKS[ide];
  if (!workspacePath) {
    return { bridgePort: block.bridgeBase, kgPort: block.kgBase };
  }
  const salt = workspaceSalt(workspacePath);
  return {
    bridgePort: block.bridgeBase + salt,
    kgPort: block.kgBase + salt,
  };
}

export async function findAvailablePortInRange(
  startPort: number,
  count: number,
  host = '127.0.0.1'
): Promise<number | null> {
  for (let i = 0; i <= count; i++) {
    const candidate = startPort + i;
    if (await isPortAvailable(candidate, host)) {
      return candidate;
    }
  }
  return null;
}

export async function allocatePorts(
  ide: IdeId,
  workspacePath: string,
  preferredBridgePort?: number,
  preferredKgPort?: number
): Promise<{ bridgePort: number; kgPort: number }> {
  const block = IDE_PORT_BLOCKS[ide];
  const base = getIdePorts(ide, workspacePath);
  const startBridge = preferredBridgePort ?? base.bridgePort;
  const startKg = preferredKgPort ?? base.kgPort;

  const reg = loadRegistry();
  reg.entries = reg.entries.filter(e => {
    if (e.pid && !isPidAlive(e.pid)) { return false; }
    return true;
  });

  const usedBridgePorts = new Set(reg.entries.map(e => e.bridgePort));
  const usedKgPorts = new Set(reg.entries.map(e => e.kgPort));

  const resolvedBridge = await resolvePortInRange(block.bridgeBase, startBridge, usedBridgePorts);
  const resolvedKg = await resolvePortInRange(block.kgBase, startKg, usedKgPorts);

  const now = new Date().toISOString();
  const existingIdx = reg.entries.findIndex(e => e.ide === ide && e.workspace === workspacePath);
  const entry: PortRegistryEntry = {
    ide, workspace: workspacePath,
    bridgePort: resolvedBridge, kgPort: resolvedKg,
    pid: process.pid, lastSeen: now,
  };

  if (existingIdx >= 0) {
    reg.entries[existingIdx] = entry;
  } else {
    reg.entries.push(entry);
  }
  saveRegistry(reg);

  return { bridgePort: resolvedBridge, kgPort: resolvedKg };
}

async function resolvePortInRange(
  blockBase: number,
  preferredPort: number,
  usedPorts: Set<number>
): Promise<number> {
  if (!usedPorts.has(preferredPort) && await isPortAvailable(preferredPort)) {
    return preferredPort;
  }
  for (let i = 0; i <= PER_IDE_FALLBACK_COUNT; i++) {
    const candidate = blockBase + i;
    if (!usedPorts.has(candidate) && await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findAvailablePortInRange(blockBase, PER_IDE_FALLBACK_COUNT);
  if (fallback !== null) { return fallback; }
  throw new Error(`No available ports in block ${blockBase}-${blockBase + PER_IDE_FALLBACK_COUNT}`);
}

export function releasePorts(ide: IdeId, workspacePath: string): void {
  try {
    const reg = loadRegistry();
    reg.entries = reg.entries.filter(
      e => !(e.ide === ide && e.workspace === workspacePath)
    );
    saveRegistry(reg);
  } catch { /* ignore */ }
}

export function getPortRegistry(): PortRegistry {
  return loadRegistry();
}

export function getIDEPortBlock(ide: IdeId): IdePortBlock {
  return IDE_PORT_BLOCKS[ide];
}
