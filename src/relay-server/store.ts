/**
 * store.ts — file-based store for the AutoClaw relay server (AF-10).
 *
 * Self-host-friendly: messages + heartbeats live on disk under a data dir,
 * namespaced by ACCOUNT (a token maps to an account; all of a user's machines
 * share one account). The server NEVER decrypts inbox payloads — it stores the
 * `encrypted` envelope as-is and serves it back; only the receiving client can
 * read it. `vscode`-free + pure-ish so it unit-tests in plain node.
 *
 * Layout:
 *   <dataDir>/accounts/<account>/inbox/<recipient>/<id>.json   ← stored message
 *   <dataDir>/accounts/<account>/heartbeats/<agent>.json       ← latest heartbeat
 *
 * Delivery model (MVP): GET drains — messages are returned AND deleted
 * (at-most-once). The client applies them idempotently. Production can add
 * ack-based at-least-once; documented in docs/relay-server.md.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

/** A message as stored + served (the body stays encrypted end-to-end). */
export interface StoredMessage {
  id: string;
  to: string;
  from: string;
  type: string;
  timestamp: string;
  /** AES-256-GCM envelope produced by the sending client. Opaque to the server. */
  encrypted: unknown;
}

/** A heartbeat as stored (low-sensitivity; sent in clear by the client). */
export interface StoredHeartbeat {
  agent_id: string;
  timestamp: string;
  status: string;
  current_task: string | null;
  sprint: number | null;
  current_llm?: string;
  installation_id: string;
  received_at: string;
}

function safeSeg(s: string): string {
  // Keep path segments to a safe charset so a hostile `to`/account can't escape.
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || '_';
}

export class RelayStore {
  constructor(private readonly dataDir: string) {}

  private accountDir(account: string): string {
    return path.join(this.dataDir, 'accounts', safeSeg(account));
  }
  private inboxDir(account: string, recipient: string): string {
    return path.join(this.accountDir(account), 'inbox', safeSeg(recipient));
  }
  private heartbeatsDir(account: string): string {
    return path.join(this.accountDir(account), 'heartbeats');
  }

  /** Store inbox messages for an account, routed by each message's `to`. Returns the count stored. */
  async putMessages(account: string, messages: readonly StoredMessage[]): Promise<number> {
    let n = 0;
    for (const m of messages) {
      if (!m?.id || !m?.to) { continue; }
      const dir = this.inboxDir(account, m.to);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${safeSeg(m.id)}.json`), JSON.stringify(m), 'utf8');
      n++;
    }
    return n;
  }

  /**
   * Return AND delete the stored messages for the given recipients (or every
   * recipient in the account when `recipients` is empty/undefined). Oldest
   * first by timestamp.
   */
  async drainMessages(account: string, recipients?: readonly string[]): Promise<StoredMessage[]> {
    const inboxRoot = path.join(this.accountDir(account), 'inbox');
    let targets: string[];
    if (recipients && recipients.length > 0) {
      targets = recipients.map(safeSeg);
    } else {
      try {
        targets = (await fsp.readdir(inboxRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
      } catch {
        return [];
      }
    }
    const out: StoredMessage[] = [];
    for (const recip of targets) {
      const dir = path.join(inboxRoot, recip);
      let files: string[];
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const fn of files) {
        if (!fn.endsWith('.json')) { continue; }
        const fp = path.join(dir, fn);
        try {
          const m = JSON.parse(await fsp.readFile(fp, 'utf8')) as StoredMessage;
          out.push(m);
          await fsp.unlink(fp).catch(() => undefined); // drain: delete on read
        } catch { /* skip malformed */ }
      }
    }
    return out.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /** Upsert heartbeats (latest-per-agent) for an account. Returns the count stored. */
  async putHeartbeats(
    account: string,
    installationId: string,
    heartbeats: ReadonlyArray<Omit<StoredHeartbeat, 'installation_id' | 'received_at'>>,
  ): Promise<number> {
    const dir = this.heartbeatsDir(account);
    await fsp.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    let n = 0;
    for (const hb of heartbeats) {
      if (!hb?.agent_id) { continue; }
      const row: StoredHeartbeat = { ...hb, installation_id: installationId, received_at: now };
      await fsp.writeFile(path.join(dir, `${safeSeg(hb.agent_id)}.json`), JSON.stringify(row), 'utf8');
      n++;
    }
    return n;
  }

  /** All current heartbeats for an account (for a cross-machine fleet view). */
  async getHeartbeats(account: string): Promise<StoredHeartbeat[]> {
    const dir = this.heartbeatsDir(account);
    let files: string[];
    try { files = await fsp.readdir(dir); } catch { return []; }
    const out: StoredHeartbeat[] = [];
    for (const fn of files) {
      if (!fn.endsWith('.json')) { continue; }
      try { out.push(JSON.parse(await fsp.readFile(path.join(dir, fn), 'utf8')) as StoredHeartbeat); } catch { /* skip */ }
    }
    return out;
  }
}
