import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InboxMessage } from '../comms/types';

const fsPromises = fs.promises;

export interface LedgerEntry {
  received_at: string;
  responded_at: string | null;
  type: string;
}

export interface StateFile {
  project: string;
  schema_version: string;
  current_sprint: number | null;
  tasks_total: number;
  tasks_complete: number;
  agents: Record<string, { status: string; sprint: number | null; tasks: string[] }>;
  sprint_statuses: Record<string, string>;
  message_ledger: Record<string, LedgerEntry>;
  consensus_tallies: Record<string, { votes: Record<string, unknown>; result: null | 'approved' | 'rejected' }>;
  last_updated: string;
}

export class MessageLedger {
  private readonly stateFilePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stateFilePath: string) {
    this.stateFilePath = path.resolve(stateFilePath);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    const result = this.writeQueue.then(() => fn().finally(resolve));
    this.writeQueue = result.then(() => undefined, () => undefined).then(() => gate);
    return result;
  }

  record(msg: InboxMessage): Promise<boolean> {
    return this.enqueue(() => this._doRecord(msg));
  }

  private async _doRecord(msg: InboxMessage): Promise<boolean> {
    const state = await this.readState();
    if (state.message_ledger[msg.id] !== undefined) {
      return false;
    }
    state.message_ledger[msg.id] = {
      received_at: new Date().toISOString(),
      responded_at: null,
      type: msg.type,
    };
    state.last_updated = new Date().toISOString();
    await this.writeStateAtomic(state);
    return true;
  }

  async markResponded(msgId: string): Promise<void> {
    const state = await this.readState();
    if (state.message_ledger[msgId] === undefined) {
      throw new Error(`MessageLedger: unknown message id "${msgId}"`);
    }
    state.message_ledger[msgId].responded_at = new Date().toISOString();
    state.last_updated = new Date().toISOString();
    await this.writeStateAtomic(state);
  }

  async has(msgId: string): Promise<boolean> {
    const state = await this.readState();
    return state.message_ledger[msgId] !== undefined;
  }

  async getEntry(msgId: string): Promise<LedgerEntry | null> {
    const state = await this.readState();
    return state.message_ledger[msgId] ?? null;
  }

  private async readState(): Promise<StateFile> {
    try {
      const raw = await fsPromises.readFile(this.stateFilePath, 'utf8');
      return JSON.parse(raw) as StateFile;
    } catch {
      return MessageLedger.emptyState();
    }
  }

  private async writeStateAtomic(state: StateFile): Promise<void> {
    const dir = path.dirname(this.stateFilePath);
    await fsPromises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.autoclaw-state-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await fsPromises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    try {
      await fsPromises.rename(tmp, this.stateFilePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST') {
        // Windows: destination may be locked by another process during concurrent writes.
        // Fall back to copy + unlink, which is not atomic but recovers gracefully.
        try {
          await fsPromises.copyFile(tmp, this.stateFilePath);
          await fsPromises.unlink(tmp).catch(() => undefined);
        } catch {
          await fsPromises.unlink(tmp).catch(() => undefined);
          throw err;
        }
      } else {
        await fsPromises.unlink(tmp).catch(() => undefined);
        throw err;
      }
    }
  }

  static emptyState(): StateFile {
    return {
      project: '',
      schema_version: '1.0',
      current_sprint: null,
      tasks_total: 0,
      tasks_complete: 0,
      agents: {},
      sprint_statuses: {},
      message_ledger: {},
      consensus_tallies: {},
      last_updated: new Date().toISOString(),
    };
  }
}
