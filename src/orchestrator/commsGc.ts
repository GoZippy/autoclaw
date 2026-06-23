/**
 * commsGc.ts — CL-2 garbage collection / archival for the shared comms inbox.
 *
 * The shared inbox (`.autoclaw/orchestrator/comms/inboxes/shared/`) is the
 * cross-agent *conversation*. Over time the orchestrator loop floods it with
 * per-tick telemetry (`autobuild-heartbeat` `finding_report`s, auto `task_claim`
 * nudges) until the handful of real asks are unfindable — observed live at 516
 * messages, 490 of them telemetry (docs/ideas/COORDINATION-LAYER-V2.md §CL-2).
 *
 * This module restores signal by MOVING — never deleting — aged/over-cap
 * messages out of `inboxes/shared/` into `inboxes/_archive/`:
 *   - telemetry older than `telemetryMaxAgeMs` (default 1h),
 *   - any signal older than `signalMaxAgeMs` (default 14d),
 *   - the oldest signals beyond the newest `signalCap` (default 200).
 *
 * Telemetry vs signal is decided exclusively by {@link classifyMessage} in
 * `coordination.ts` — the single source of truth. Nothing here re-classifies.
 *
 * Pure-ish + vscode-free (only `node:fs`/`node:path`) so it unit-tests without
 * the Electron host. Tolerant of a missing tree and malformed files; never
 * throws.
 */

import * as fs from 'fs';
import * as path from 'path';
import { classifyMessage, type CommsMessage } from './coordination';

const fsp = fs.promises;

/** One hour, the default telemetry retention window. */
const ONE_HOUR_MS = 60 * 60 * 1000;
/** Fourteen days, the default signal retention window. */
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
/** Default count of newest signals kept in `inboxes/shared/`. */
const DEFAULT_SIGNAL_CAP = 200;

export interface ArchiveOptions {
  /** Clock injection point (epoch ms). Defaults to `Date.now()`. */
  now?: number;
  /** Telemetry older than this is archived. Default 1h. */
  telemetryMaxAgeMs?: number;
  /** Any signal older than this is archived. Default 14d. */
  signalMaxAgeMs?: number;
  /** Keep at most this many newest signals; archive the oldest beyond it. Default 200. */
  signalCap?: number;
}

export interface ArchiveResult {
  /** Total `*.json` files scanned in `inboxes/shared/`. */
  scanned: number;
  /** Telemetry files moved to `_archive/` because they aged out. */
  archivedTelemetry: number;
  /** Signal files moved to `_archive/` (aged out OR beyond the cap). */
  archivedAgedSignals: number;
}

/** A scanned shared-inbox entry, with the time we ranked/aged it by. */
interface ScannedFile {
  file: string;
  fullPath: string;
  msg: CommsMessage;
  /** Effective epoch ms for the message (JSON timestamp, else filename ts). */
  timeMs: number;
}

/**
 * Recover an epoch-ms timestamp for a message.
 *
 * Prefers the JSON `timestamp` field. Falls back to the leading timestamp the
 * comms writer encodes into the filename, where `:` and `.` are replaced by `-`
 * (e.g. `2026-06-23T10-45-12-345Z-finding_report-...json`). Returns `NaN` only
 * when neither yields a parseable date — such files are treated as "old enough"
 * for any window but never beyond a cap arbitrarily (they sort oldest).
 */
export function messageTimeMs(msg: CommsMessage, fileName?: string): number {
  const fromJson = msg?.timestamp ? Date.parse(msg.timestamp) : NaN;
  if (!Number.isNaN(fromJson)) { return fromJson; }
  if (fileName) {
    const fromName = parseFilenameTimestamp(fileName);
    if (!Number.isNaN(fromName)) { return fromName; }
  }
  return NaN;
}

/**
 * Parse the ISO-ish timestamp the comms writer prefixes onto a filename.
 * The writer does `iso.replace(/[:.]/g, '-')`, turning
 * `2026-06-23T10:45:12.345Z` into `2026-06-23T10-45-12-345Z`. We rebuild the
 * `HH:MM:SS.mmm` portion before parsing. Returns NaN when no leading date.
 */
function parseFilenameTimestamp(fileName: string): number {
  // Match: YYYY-MM-DDTHH-MM-SS(-mmm)?Z   at the start of the name.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?Z/.exec(fileName);
  if (!m) { return NaN; }
  const [, date, hh, mm, ss, ms] = m;
  const iso = `${date}T${hh}:${mm}:${ss}${ms ? '.' + ms.padEnd(3, '0') : ''}Z`;
  return Date.parse(iso);
}

/** Read + parse one shared-inbox file, tolerating a BOM and malformed JSON. */
async function readMessageFile(fullPath: string): Promise<CommsMessage | null> {
  try {
    const raw = (await fsp.readFile(fullPath, 'utf8')).replace(/^﻿/, '');
    return JSON.parse(raw) as CommsMessage;
  } catch {
    return null;
  }
}

/**
 * Move `src` into `archiveDir`, creating it on demand. Tolerant of a name
 * collision (an already-archived file with the same name) by suffixing. Never
 * throws — a failed move is reported via the returned boolean.
 */
async function moveToArchive(src: string, archiveDir: string, fileName: string): Promise<boolean> {
  try {
    await fsp.mkdir(archiveDir, { recursive: true });
    let dest = path.join(archiveDir, fileName);
    try {
      await fsp.rename(src, dest);
      return true;
    } catch {
      // Cross-device rename or destination exists — fall back to copy+unlink
      // with a uniquified name so we never clobber an existing archived file.
      dest = path.join(archiveDir, `${Date.now()}-${fileName}`);
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Archive aged telemetry and aged/over-cap signals out of the shared inbox.
 *
 * @param workspaceRoot Absolute workspace root; the comms tree lives at
 *   `<root>/.autoclaw/orchestrator/comms/inboxes/shared`.
 * @returns Counts of what was scanned and archived. On a missing tree returns
 *   `{ scanned: 0, archivedTelemetry: 0, archivedAgedSignals: 0 }`.
 */
export async function archiveSharedInbox(
  workspaceRoot: string,
  opts: ArchiveOptions = {}
): Promise<ArchiveResult> {
  const now = opts.now ?? Date.now();
  const telemetryMaxAgeMs = opts.telemetryMaxAgeMs ?? ONE_HOUR_MS;
  const signalMaxAgeMs = opts.signalMaxAgeMs ?? FOURTEEN_DAYS_MS;
  const signalCap = opts.signalCap ?? DEFAULT_SIGNAL_CAP;

  const sharedDir = path.join(
    workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared'
  );
  const archiveDir = path.join(
    workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', '_archive'
  );

  const result: ArchiveResult = { scanned: 0, archivedTelemetry: 0, archivedAgedSignals: 0 };

  let files: string[];
  try {
    files = (await fsp.readdir(sharedDir)).filter(f => f.endsWith('.json'));
  } catch {
    return result; // missing dir tolerated
  }

  // Read + classify every file. Skip (but count) unreadable ones — we never
  // move a file we couldn't parse, so nothing is lost on a transient error.
  const telemetry: ScannedFile[] = [];
  const signals: ScannedFile[] = [];
  for (const file of files) {
    result.scanned++;
    const fullPath = path.join(sharedDir, file);
    const msg = await readMessageFile(fullPath);
    if (!msg) { continue; }
    const timeMs = messageTimeMs(msg, file);
    const entry: ScannedFile = { file, fullPath, msg, timeMs };
    if (classifyMessage(msg) === 'telemetry') { telemetry.push(entry); }
    else { signals.push(entry); }
  }

  // 1) Telemetry older than the telemetry window.
  for (const t of telemetry) {
    const ageMs = Number.isNaN(t.timeMs) ? Infinity : now - t.timeMs;
    if (ageMs > telemetryMaxAgeMs) {
      if (await moveToArchive(t.fullPath, archiveDir, t.file)) { result.archivedTelemetry++; }
    }
  }

  // 2) Signals: archive if aged out OR beyond the newest-N cap. A signal younger
  //    than the telemetry window is NEVER archived (recent asks always stay),
  //    even if it would otherwise be beyond the cap.
  //    Sort newest-first so the cap keeps the freshest `signalCap` signals.
  const rankTime = (s: ScannedFile) => (Number.isNaN(s.timeMs) ? -Infinity : s.timeMs);
  const byNewest = [...signals].sort((a, b) => rankTime(b) - rankTime(a));
  for (let i = 0; i < byNewest.length; i++) {
    const s = byNewest[i];
    const ageMs = Number.isNaN(s.timeMs) ? Infinity : now - s.timeMs;
    // Floor: never touch a signal younger than the telemetry window.
    if (ageMs <= telemetryMaxAgeMs) { continue; }
    const tooOld = ageMs > signalMaxAgeMs;
    const beyondCap = i >= signalCap;
    if (tooOld || beyondCap) {
      if (await moveToArchive(s.fullPath, archiveDir, s.file)) { result.archivedAgedSignals++; }
    }
  }

  return result;
}
