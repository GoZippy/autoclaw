import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ClaimedMessage, InboxMessage } from '../comms/types';

const fsPromises = fs.promises;

const CLAIM_TTL_MS = 10_000;

export function generateClaimFilename(): string {
  return `${Date.now()}${process.hrtime.bigint()}--${crypto.randomUUID()}.json`;
}

export async function claimMessage(
  inboxPath: string,
  filename: string,
  agentId: string
): Promise<ClaimedMessage | null> {
  const agentsDir = path.join(inboxPath, '..', 'agents');
  const claimsDir = path.join(agentsDir, agentId);
  const taskId = filename.replace(/\.json$/, '');
  const claimFilename = `claim-${taskId}-${Date.now()}.json`;
  const claimFilePath = path.join(claimsDir, claimFilename);

  await fsPromises.mkdir(claimsDir, { recursive: true });

  // Check all agents' claim dirs — back off if any agent has a fresh claim on this task.
  const existingClaims = await listAllClaimFiles(agentsDir, taskId);
  for (const cf of existingClaims) {
    const stat = await fsPromises.stat(cf).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < CLAIM_TTL_MS) {
      return null;
    }
  }

  const claimToken = crypto.randomUUID();
  await fsPromises.writeFile(
    claimFilePath,
    JSON.stringify({ agent: agentId, task_id: taskId, token: claimToken, claimed_at: new Date().toISOString(), ttl_ms: CLAIM_TTL_MS }, null, 2),
    'utf8'
  );

  const processedDir = path.join(inboxPath, 'processed');
  await fsPromises.mkdir(processedDir, { recursive: true });

  const originalPath = path.join(inboxPath, filename);
  const processedPath = path.join(processedDir, filename);

  try {
    await fsPromises.rename(originalPath, processedPath);
  } catch (err: unknown) {
    await fsPromises.unlink(claimFilePath).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    if (code === 'EXDEV') {
      return claimCrossVolume(originalPath, processedPath, claimFilePath, agentId, claimToken);
    }
    throw err;
  }

  const raw = await fsPromises.readFile(processedPath, 'utf8').catch(() => null);
  if (!raw) { return null; }

  let message: InboxMessage;
  try {
    message = JSON.parse(raw.replace(/^﻿/, '')) as InboxMessage;
  } catch {
    return null;
  }

  return {
    message,
    originalPath,
    processedPath,
    claimedAt: new Date().toISOString(),
    claimToken,
  };
}

async function claimCrossVolume(
  src: string,
  dst: string,
  claimFilePath: string,
  _agentId: string,
  claimToken: string
): Promise<ClaimedMessage | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fsPromises.open(dst, 'wx');
  } catch (err: unknown) {
    await fsPromises.unlink(claimFilePath).catch(() => undefined);
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return null;
    }
    throw err;
  }

  try {
    const raw = await fsPromises.readFile(src, 'utf8');
    await fd.writeFile(raw, 'utf8');
  } finally {
    await fd.close();
  }

  await fsPromises.unlink(src).catch(() => undefined);

  const raw = await fsPromises.readFile(dst, 'utf8').catch(() => null);
  if (!raw) { return null; }

  let message: InboxMessage;
  try {
    message = JSON.parse(raw.replace(/^﻿/, '')) as InboxMessage;
  } catch {
    return null;
  }

  return {
    message,
    originalPath: src,
    processedPath: dst,
    claimedAt: new Date().toISOString(),
    claimToken,
  };
}

async function listAllClaimFiles(agentsDir: string, taskId: string): Promise<string[]> {
  const all: string[] = [];
  try {
    const agentEntries = await fsPromises.readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (!entry.isDirectory()) { continue; }
      const agentDir = path.join(agentsDir, entry.name);
      try {
        const files = await fsPromises.readdir(agentDir);
        for (const f of files) {
          if (f.startsWith(`claim-${taskId}-`) && f.endsWith('.json')) {
            all.push(path.join(agentDir, f));
          }
        }
      } catch { /* agent dir unreadable — skip */ }
    }
  } catch { /* agentsDir missing — return empty */ }
  return all;
}

async function listClaimFiles(claimsDir: string, taskId: string): Promise<string[]> {
  try {
    const files = await fsPromises.readdir(claimsDir);
    return files
      .filter(f => f.startsWith(`claim-${taskId}-`))
      .map(f => path.join(claimsDir, f));
  } catch {
    return [];
  }
}
