import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AGENT_REGISTRY_VERSION = 1;

export interface RegisteredWorker {
  id: string;
  ide: string;
  workspace: string;
  bridgeHost: string;
  bridgePort: number;
  bridgeUrl: string;
  pid: number;
  status: 'online' | 'busy' | 'offline';
  capabilities: string[];
  registeredAt: string;
  lastHeartbeat: string;
  assignedTasks: string[];
}

interface AgentRegistry {
  version: typeof AGENT_REGISTRY_VERSION;
  machineId: string;
  workers: RegisteredWorker[];
}

function agentRegistryPath(): string {
  return path.join(os.homedir(), '.autoclaw', '.agent-registry.json');
}

function loadRegistry(): AgentRegistry {
  try {
    const raw = fs.readFileSync(agentRegistryPath(), 'utf8');
    const parsed = JSON.parse(raw) as AgentRegistry;
    if (parsed.version === AGENT_REGISTRY_VERSION && Array.isArray(parsed.workers)) {
      return parsed;
    }
  } catch { /* missing or corrupt */ }
  return { version: AGENT_REGISTRY_VERSION, machineId: '', workers: [] };
}

function saveRegistry(reg: AgentRegistry): void {
  try {
    fs.mkdirSync(path.dirname(agentRegistryPath()), { recursive: true });
    fs.writeFileSync(agentRegistryPath(), JSON.stringify(reg, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerWorker(entry: Omit<RegisteredWorker, 'registeredAt'>): void {
  const reg = loadRegistry();
  reg.workers = reg.workers.filter(w => w.pid === entry.pid ? isPidAlive(w.pid) : true);
  const now = new Date().toISOString();
  const existingIdx = reg.workers.findIndex(w => w.pid === entry.pid && w.ide === entry.ide);
  const full: RegisteredWorker = { ...entry, registeredAt: now };
  if (existingIdx >= 0) {
    full.registeredAt = reg.workers[existingIdx].registeredAt;
    reg.workers[existingIdx] = full;
  } else {
    reg.workers.push(full);
  }
  saveRegistry(reg);
}

export function unregisterWorker(pid: number, ide: string): void {
  try {
    const reg = loadRegistry();
    reg.workers = reg.workers.filter(w => !(w.pid === pid && w.ide === ide));
    saveRegistry(reg);
  } catch { /* ignore */ }
}

export function heartbeatWorker(pid: number, ide: string, status: RegisteredWorker['status']): void {
  try {
    const reg = loadRegistry();
    const w = reg.workers.find(w => w.pid === pid && w.ide === ide);
    if (w) {
      w.lastHeartbeat = new Date().toISOString();
      w.status = status;
      saveRegistry(reg);
    }
  } catch { /* ignore */ }
}

export function getAvailableWorkers(): RegisteredWorker[] {
  const reg = loadRegistry();
  const staleThreshold = Date.now() - 5 * 60 * 1000;
  reg.workers = reg.workers.filter(w => {
    if (!isPidAlive(w.pid)) { return false; }
    return new Date(w.lastHeartbeat).getTime() > staleThreshold;
  });
  saveRegistry(reg);
  return reg.workers.filter(w => w.status === 'online');
}

export function getAllWorkers(): RegisteredWorker[] {
  const reg = loadRegistry();
  const staleThreshold = Date.now() - 5 * 60 * 1000;
  return reg.workers.filter(w => {
    if (!isPidAlive(w.pid)) { return false; }
    return new Date(w.lastHeartbeat).getTime() > staleThreshold;
  });
}

export function getWorkerCount(): number {
  return getAvailableWorkers().length;
}
