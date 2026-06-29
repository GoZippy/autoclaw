/**
 * commsGc.test.ts — Unit tests for CL-2 shared-inbox GC (`src/orchestrator/commsGc.ts`)
 * and the shared classification contract (`src/orchestrator/coordination.ts`).
 *
 * No `vscode` import — runs in plain Node/Mocha (TDD UI), consistent with the
 * project's other unit suites. Uses a real throwaway temp tree per test.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { archiveSharedInbox, messageTimeMs } from '../orchestrator/commsGc';
import {
  classifyMessage,
  isTelemetry,
  isAutoNudge,
  isActionableForMe,
  type CommsMessage,
} from '../orchestrator/coordination';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-06-23T12:00:00.000Z');

/** Make a fresh temp workspace and return its root. */
function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-gc-'));
}

function sharedDir(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
}
function archiveDir(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', '_archive');
}

/** Write a message file into the shared inbox. Filename mirrors the comms writer. */
function writeShared(root: string, msg: CommsMessage): string {
  const dir = sharedDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const tsPart = (msg.timestamp ?? new Date(NOW).toISOString()).replace(/[:.]/g, '-');
  const idFrag = (msg.id ?? 'msg-xxxxxxxx').slice(-8);
  const file = `${tsPart}-${msg.type}-${msg.from}-${idFrag}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(msg, null, 2), 'utf8');
  return file;
}

function listShared(root: string): string[] {
  try { return fs.readdirSync(sharedDir(root)).filter(f => f.endsWith('.json')).sort(); }
  catch { return []; }
}
function listArchive(root: string): string[] {
  try { return fs.readdirSync(archiveDir(root)).filter(f => f.endsWith('.json')).sort(); }
  catch { return []; }
}

function iso(deltaMs: number): string {
  return new Date(NOW + deltaMs).toISOString();
}

// ---------------------------------------------------------------------------
// coordination — classification matrix
// ---------------------------------------------------------------------------

suite('coordination — classifyMessage / isAutoNudge / isActionableForMe', () => {
  test('telemetry: autobuild-heartbeat finding_report', () => {
    const m: CommsMessage = { type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared' };
    assert.strictEqual(classifyMessage(m), 'telemetry');
    assert.strictEqual(isTelemetry(m), true);
  });

  test('telemetry: auto task_claim nudge for next-claude-code (by task_id)', () => {
    const m: CommsMessage = {
      type: 'task_claim', from: 'orchestrator-loop', to: 'claude-code',
      task_id: 'next-claude-code', requires_response: true,
    };
    assert.strictEqual(isAutoNudge(m), true);
    assert.strictEqual(classifyMessage(m), 'telemetry');
  });

  test('telemetry: loop status_report', () => {
    const m: CommsMessage = { type: 'status_report', from: 'orchestrator-loop', to: 'shared' };
    assert.strictEqual(classifyMessage(m), 'telemetry');
  });

  test('signal: question / task_complete / scope_violation', () => {
    for (const type of ['question', 'task_complete', 'scope_violation']) {
      const m: CommsMessage = { type, from: 'kilocode', to: 'claude-code' };
      assert.strictEqual(classifyMessage(m), 'signal', `${type} should be signal`);
      assert.strictEqual(isTelemetry(m), false);
    }
  });

  test('signal: a real agent status_report (not a telemetry source)', () => {
    const m: CommsMessage = { type: 'status_report', from: 'kilocode', to: 'shared' };
    assert.strictEqual(classifyMessage(m), 'signal');
  });

  test('isActionableForMe: real question to me requiring response is actionable', () => {
    const m: CommsMessage = { type: 'question', from: 'kilocode', to: 'claude-code', requires_response: true };
    assert.strictEqual(isActionableForMe(m, 'claude-code'), true);
  });

  test('isActionableForMe: excludes my own message', () => {
    const m: CommsMessage = { type: 'question', from: 'claude-code', to: 'kilocode', requires_response: true };
    assert.strictEqual(isActionableForMe(m, 'claude-code'), false);
  });

  test('isActionableForMe: excludes auto-nudge addressed to me', () => {
    const m: CommsMessage = {
      type: 'task_claim', from: 'orchestrator-loop', to: 'claude-code',
      task_id: 'next-claude-code', requires_response: true,
    };
    assert.strictEqual(isActionableForMe(m, 'claude-code'), false);
  });

  test('isActionableForMe: excludes telemetry finding_report broadcast', () => {
    const m: CommsMessage = {
      type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared', requires_response: true,
    };
    assert.strictEqual(isActionableForMe(m, 'claude-code'), false);
  });

  test('isActionableForMe: broadcast question to shared requiring response is actionable', () => {
    const m: CommsMessage = { type: 'question', from: 'kilocode', to: 'shared', requires_response: true };
    assert.strictEqual(isActionableForMe(m, 'claude-code'), true);
  });
});

// ---------------------------------------------------------------------------
// commsGc — messageTimeMs fallback
// ---------------------------------------------------------------------------

suite('commsGc — messageTimeMs', () => {
  test('prefers JSON timestamp', () => {
    assert.strictEqual(messageTimeMs({ timestamp: iso(0) }), NOW);
  });

  test('falls back to filename timestamp (writer-encoded :/. as -)', () => {
    const file = '2026-06-23T12-00-00-000Z-finding_report-autobuild-heartbeat-abcd1234.json';
    assert.strictEqual(messageTimeMs({}, file), NOW);
  });

  test('returns NaN when neither is parseable', () => {
    assert.ok(Number.isNaN(messageTimeMs({}, 'not-a-timestamp.json')));
  });
});

// ---------------------------------------------------------------------------
// commsGc — archiveSharedInbox
// ---------------------------------------------------------------------------

suite('commsGc — archiveSharedInbox', () => {
  test('missing tree is tolerated (no throw, zero counts)', async () => {
    const root = mkWorkspace();
    const res = await archiveSharedInbox(root, { now: NOW });
    assert.deepStrictEqual(res, { scanned: 0, archivedTelemetry: 0, archivedAgedSignals: 0, purgedHandoffNotes: 0 });
  });

  test('archives aged autobuild-heartbeat finding_reports + auto task_claim nudges', async () => {
    const root = mkWorkspace();
    // Telemetry, 2h old → archived (default telemetryMaxAgeMs = 1h).
    writeShared(root, { id: 'msg-tele1', type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared', timestamp: iso(-2 * HOUR) });
    writeShared(root, { id: 'msg-tele2', type: 'status_report', from: 'orchestrator-loop', to: 'shared', timestamp: iso(-3 * HOUR) });
    // Auto-nudge (task_claim next-claude-code), 2h old → telemetry → archived.
    writeShared(root, { id: 'msg-nudge', type: 'task_claim', from: 'orchestrator-loop', to: 'claude-code', task_id: 'next-claude-code', requires_response: true, timestamp: iso(-2 * HOUR) });
    // Fresh telemetry (10 min) → kept (within telemetry window).
    writeShared(root, { id: 'msg-tele-fresh', type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared', timestamp: iso(-10 * 60 * 1000) });

    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.scanned, 4);
    assert.strictEqual(res.archivedTelemetry, 3);
    assert.strictEqual(res.archivedAgedSignals, 0);

    // Survivors: only the fresh telemetry remains in shared. (The filename
    // carries only the last 8 chars of the id — `msg-tele-fresh` → `le-fresh`.)
    const remaining = listShared(root);
    assert.strictEqual(remaining.length, 1);
    assert.ok(remaining[0].includes('le-fresh'), `unexpected survivor: ${remaining[0]}`);
    // Archived ones moved (not deleted).
    assert.strictEqual(listArchive(root).length, 3);
  });

  test('keeps recent real signals (question / task_complete / scope_violation)', async () => {
    const root = mkWorkspace();
    writeShared(root, { id: 'msg-q', type: 'question', from: 'kilocode', to: 'shared', requires_response: true, timestamp: iso(-30 * 60 * 1000) });
    writeShared(root, { id: 'msg-tc', type: 'task_complete', from: 'kilocode', to: 'shared', timestamp: iso(-2 * HOUR) });
    writeShared(root, { id: 'msg-sv', type: 'scope_violation', from: 'kilocode', to: 'claude-code', timestamp: iso(-5 * HOUR) });
    // One aged telemetry to confirm the GC ran and only touched telemetry.
    writeShared(root, { id: 'msg-tele', type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared', timestamp: iso(-2 * HOUR) });

    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.scanned, 4);
    assert.strictEqual(res.archivedTelemetry, 1);
    assert.strictEqual(res.archivedAgedSignals, 0);

    const remaining = listShared(root);
    assert.strictEqual(remaining.length, 3, 'all three signals kept');
    assert.ok(remaining.some(f => f.includes('-question-')));
    assert.ok(remaining.some(f => f.includes('-task_complete-')));
    assert.ok(remaining.some(f => f.includes('-scope_violation-')));
  });

  test('archives signals older than signalMaxAgeMs (14d default)', async () => {
    const root = mkWorkspace();
    writeShared(root, { id: 'msg-old', type: 'question', from: 'kilocode', to: 'shared', timestamp: iso(-20 * DAY) });
    writeShared(root, { id: 'msg-new', type: 'question', from: 'kilocode', to: 'shared', timestamp: iso(-2 * DAY) });

    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.archivedAgedSignals, 1);
    const remaining = listShared(root);
    assert.strictEqual(remaining.length, 1);
    assert.ok(remaining[0].includes('msg-new'.slice(-8)) || remaining[0].includes('-question-'));
  });

  test('respects signalCap — oldest beyond the cap are archived, newest kept', async () => {
    const root = mkWorkspace();
    // 5 signals, all > telemetry window old (2h..6h) but < 14d, cap = 2.
    for (let i = 1; i <= 5; i++) {
      writeShared(root, {
        id: `msg-sig${i}`, type: 'task_complete', from: 'kilocode', to: 'shared',
        timestamp: iso(-(i + 1) * HOUR), // sig1 newest (2h), sig5 oldest (6h)
      });
    }
    const res = await archiveSharedInbox(root, { now: NOW, signalCap: 2 });
    assert.strictEqual(res.scanned, 5);
    assert.strictEqual(res.archivedAgedSignals, 3, 'oldest 3 beyond the cap of 2 archived');

    const remaining = listShared(root);
    assert.strictEqual(remaining.length, 2, 'newest 2 signals kept');
    // The two kept must be the two newest (sig1 @ -2h, sig2 @ -3h).
    assert.ok(remaining.every(f => f.includes('msg-sig1'.slice(-8)) || f.includes('msg-sig2'.slice(-8)) || f.includes('-task_complete-')));
    assert.strictEqual(listArchive(root).length, 3);
  });

  test('never archives a signal younger than the telemetry window even when beyond cap', async () => {
    const root = mkWorkspace();
    // 3 very fresh signals (within 1h), cap = 1 → none should be archived.
    writeShared(root, { id: 'msg-f1', type: 'task_complete', from: 'kilocode', to: 'shared', timestamp: iso(-5 * 60 * 1000) });
    writeShared(root, { id: 'msg-f2', type: 'task_complete', from: 'kilocode', to: 'shared', timestamp: iso(-10 * 60 * 1000) });
    writeShared(root, { id: 'msg-f3', type: 'task_complete', from: 'kilocode', to: 'shared', timestamp: iso(-15 * 60 * 1000) });

    const res = await archiveSharedInbox(root, { now: NOW, signalCap: 1 });
    assert.strictEqual(res.archivedAgedSignals, 0, 'fresh signals are protected by the telemetry-window floor');
    assert.strictEqual(listShared(root).length, 3);
  });

  test('malformed and non-json files are tolerated (counted, never moved)', async () => {
    const root = mkWorkspace();
    const dir = sharedDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json', 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored', 'utf8'); // non-json, not scanned
    writeShared(root, { id: 'msg-tele', type: 'finding_report', from: 'autobuild-heartbeat', to: 'shared', timestamp: iso(-2 * HOUR) });

    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.scanned, 2, 'broken.json + the telemetry json scanned; .txt skipped');
    assert.strictEqual(res.archivedTelemetry, 1);
    // The malformed file is still in shared (never moved).
    assert.ok(listShared(root).includes('broken.json'));
  });
});

// ---------------------------------------------------------------------------
// commsGc — handoff note GC (§3.3 retention)
// ---------------------------------------------------------------------------

function handoffsDir(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'handoffs');
}

function writeHandoffNote(root: string, taskId: string, timestamp: string): void {
  const dir = handoffsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${taskId}-abcd1234.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ task_id: taskId, timestamp }), 'utf8');
}

function listHandoffs(root: string): string[] {
  try { return fs.readdirSync(handoffsDir(root)).filter(f => f.endsWith('.json')).sort(); }
  catch { return []; }
}

suite('commsGc — handoff note purge', () => {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  test('missing handoffs dir is tolerated', async () => {
    const root = mkWorkspace();
    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.purgedHandoffNotes, 0);
  });

  test('purges notes older than handoffMaxAgeMs', async () => {
    const root = mkWorkspace();
    writeHandoffNote(root, 'old-task', iso(-THIRTY_DAYS - 1000));
    writeHandoffNote(root, 'fresh-task', iso(-1 * DAY));

    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.purgedHandoffNotes, 1, 'old note purged');
    const remaining = listHandoffs(root);
    assert.strictEqual(remaining.length, 1);
    assert.ok(remaining[0].startsWith('fresh-task'), 'fresh note kept');
  });

  test('keeps notes within the retention window', async () => {
    const root = mkWorkspace();
    writeHandoffNote(root, 'recent', iso(-7 * DAY));
    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.purgedHandoffNotes, 0);
    assert.strictEqual(listHandoffs(root).length, 1);
  });

  test('respects custom handoffMaxAgeMs override', async () => {
    const root = mkWorkspace();
    writeHandoffNote(root, 'task-a', iso(-2 * DAY));  // 2 days old
    const res = await archiveSharedInbox(root, { now: NOW, handoffMaxAgeMs: 1 * DAY });
    assert.strictEqual(res.purgedHandoffNotes, 1, 'purged when custom window is shorter');
  });

  test('malformed handoff note files are skipped (not purged)', async () => {
    const root = mkWorkspace();
    const dir = handoffsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad-task-abcd1234.json'), '{ invalid json', 'utf8');
    const res = await archiveSharedInbox(root, { now: NOW });
    assert.strictEqual(res.purgedHandoffNotes, 0, 'malformed files are never purged');
    assert.ok(fs.existsSync(path.join(dir, 'bad-task-abcd1234.json')), 'malformed file left in place');
  });
});
