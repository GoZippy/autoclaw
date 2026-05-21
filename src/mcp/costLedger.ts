/**
 * costLedger.ts — Per-tool-invocation telemetry for the `autoclaw-mcp` server.
 *
 * Every `tools/call` appends one JSONL row to
 *   `.autoclaw/mcp/cost-ledger.jsonl`
 * recording tool name, an args hash (never the raw args — they may contain
 * query text), wall-clock duration, result size, and the calling host/session.
 *
 * Design constraints (RFC §7, §8):
 *  - Multiple host subprocesses run concurrently. JSONL append is the only
 *    cross-process-safe write pattern here: each `fs.appendFile` writes a
 *    single newline-terminated record; interleaving at line granularity is
 *    acceptable and no record is ever partially overwritten.
 *  - The ledger is best-effort. A logging failure must never fail a tool
 *    call, so every write is wrapped and swallowed.
 *  - Rotation at 1 MB keeps the file bounded (RFC §7.5 mentions log rotation;
 *    we apply the same 1 MB cap to the cost ledger).
 *
 * Sprint 2 — BP1 (WA-3)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CostLedgerEntry } from './types';

const fsPromises = fs.promises;

/** Rotate the ledger once it grows past this many bytes. */
const ROTATE_BYTES = 1024 * 1024;

/** Ledger filename relative to `.autoclaw/mcp/`. */
const LEDGER_FILENAME = 'cost-ledger.jsonl';

/**
 * Hash tool arguments for the ledger. Raw args are intentionally NOT logged —
 * `recall.query` arguments can contain sensitive query text. A short hex
 * digest is enough to correlate repeated identical calls (cache analysis).
 */
export function hashArgs(args: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(args ?? null);
  } catch {
    serialised = '<unserialisable>';
  }
  return crypto.createHash('sha256').update(serialised).digest('hex').slice(0, 16);
}

/**
 * Per-process cost ledger writer.
 *
 * One instance per server process. Holds no cross-process locks — concurrency
 * safety comes from append-only JSONL semantics, not from this object.
 */
export class CostLedger {
  private readonly ledgerPath: string;

  /**
   * @param autoclawDir Absolute path to the workspace `.autoclaw/` directory.
   */
  constructor(autoclawDir: string) {
    this.ledgerPath = path.join(autoclawDir, 'mcp', LEDGER_FILENAME);
  }

  /** Absolute path to the ledger file (exposed for tests / `fleet.cards`). */
  get path(): string {
    return this.ledgerPath;
  }

  /**
   * Append one invocation record. Best-effort: never throws. Failures are
   * swallowed so telemetry can never break a tool call.
   */
  async record(entry: CostLedgerEntry): Promise<void> {
    try {
      await fsPromises.mkdir(path.dirname(this.ledgerPath), { recursive: true });
      await this.rotateIfNeeded();
      await fsPromises.appendFile(this.ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Telemetry is best-effort — swallow.
    }
  }

  /**
   * Read recent ledger entries (newest last). Used by `fleet.cards` to roll up
   * per-host hit counts. Tolerates a missing file and skips malformed lines.
   *
   * @param limit Maximum number of trailing entries to return.
   */
  async readRecent(limit = 500): Promise<CostLedgerEntry[]> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.ledgerPath, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const out: CostLedgerEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as CostLedgerEntry);
      } catch {
        // Skip a torn/interleaved line — append-only JSONL makes this rare.
      }
    }
    return out;
  }

  /**
   * Rotate the ledger to `<name>.1` when it exceeds {@link ROTATE_BYTES}.
   * Single generation kept; the previous `.1` is overwritten. Best-effort.
   */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fsPromises.stat(this.ledgerPath);
      if (stat.size < ROTATE_BYTES) {
        return;
      }
      const rotated = this.ledgerPath + '.1';
      // rename is atomic on the same volume; tolerate concurrent rotation.
      await fsPromises.rename(this.ledgerPath, rotated).catch(() => undefined);
    } catch {
      // Missing file or stat error — nothing to rotate.
    }
  }
}
