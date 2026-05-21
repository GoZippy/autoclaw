/**
 * inboxState.test.ts — Unit tests for src/comms/inboxState.ts and
 * src/comms/heartbeat.ts (A4 + A5, Sprint 1 WA-3).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  markRead,
  markReplied,
  archive,
  getState,
  listUnread,
  listAwaitingMe,
} from '../comms/inboxState';
import {
  writeSessionHeartbeat,
  readSessionHeartbeats,
  checkStall,
} from '../comms/heartbeat';
import type { Heartbeat } from '../comms';
import type { InboxMessage } from '../comms/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-inbox-state-'));
}

/**
 * Create an inbox directory with one or more fixture message files.
 * Returns the inbox path.
 */
function makeFixtureInbox(
  baseDir: string,
  messages: Array<Partial<InboxMessage> & { id: string }>
): string {
  const inboxPath = path.join(baseDir, 'test-agent');
  fs.mkdirSync(inboxPath, { recursive: true });

  for (const msg of messages) {
    const full: InboxMessage = {
      from: 'orchestrator',
      to: 'test-agent',
      type: 'review_request',
      timestamp: new Date().toISOString(),
      payload: {},
      requires_response: false,
      ...msg,
    };
    fs.writeFileSync(
      path.join(inboxPath, `${msg.id}.json`),
      JSON.stringify(full, null, 2),
      'utf8'
    );
  }

  return inboxPath;
}

// ---------------------------------------------------------------------------
// A4 — Inbox state machine
// ---------------------------------------------------------------------------

suite('inboxState — markRead / markReplied / archive / getState', () => {
  test('markRead creates state file with read_at set', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-001', requires_response: true }]);
    await markRead(inboxPath, 'msg-001');
    const state = await getState(inboxPath, 'msg-001', { strict: true });
    assert.ok(state, 'state file should exist after markRead');
    assert.ok(state!.read_at, 'read_at should be set');
    assert.strictEqual(state!.replied_at, null);
    assert.strictEqual(state!.archived_at, null);
  });

  test('markRead is idempotent — second call does not change read_at', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-002' }]);
    await markRead(inboxPath, 'msg-002');
    const s1 = await getState(inboxPath, 'msg-002', { strict: true });
    const first = s1!.read_at;
    await markRead(inboxPath, 'msg-002'); // second call
    const s2 = await getState(inboxPath, 'msg-002', { strict: true });
    assert.strictEqual(s2!.read_at, first, 'read_at must not change on second markRead');
  });

  test('markReplied sets replied_at and auto-sets read_at when absent', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-003', requires_response: true }]);
    await markReplied(inboxPath, 'msg-003');
    const state = await getState(inboxPath, 'msg-003', { strict: true });
    assert.ok(state!.replied_at, 'replied_at should be set');
    assert.ok(state!.read_at, 'read_at should be auto-set by markReplied');
  });

  test('archive sets archived_at', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-004' }]);
    await archive(inboxPath, 'msg-004');
    const state = await getState(inboxPath, 'msg-004', { strict: true });
    assert.ok(state!.archived_at, 'archived_at should be set');
  });

  test('getState returns synthetic null-state when no state file exists (backwards-compat)', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-005' }]);
    const state = await getState(inboxPath, 'msg-005');
    assert.ok(state, 'should return a synthetic state object');
    assert.strictEqual(state!.read_at, null);
    assert.strictEqual(state!.replied_at, null);
    assert.strictEqual(state!.archived_at, null);
  });

  test('getState strict:true returns null when no state file exists', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-006' }]);
    const state = await getState(inboxPath, 'msg-006', { strict: true });
    assert.strictEqual(state, null);
  });

  test('_state/ directory is created automatically on first write', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [{ id: 'msg-007' }]);
    assert.ok(!fs.existsSync(path.join(inboxPath, '_state')), '_state should not exist yet');
    await markRead(inboxPath, 'msg-007');
    assert.ok(fs.existsSync(path.join(inboxPath, '_state')), '_state should be created');
  });
});

// ---------------------------------------------------------------------------
// A4 — listUnread
// ---------------------------------------------------------------------------

suite('inboxState — listUnread with fixture inbox', () => {
  test('all messages unread when no state files exist (backwards-compat)', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [
      { id: 'msg-u1' },
      { id: 'msg-u2' },
      { id: 'msg-u3' },
    ]);
    const unread = await listUnread(inboxPath);
    assert.strictEqual(unread.length, 3, 'all 3 messages should be unread');
  });

  test('read messages excluded from listUnread', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [
      { id: 'msg-r1' },
      { id: 'msg-r2' },
      { id: 'msg-r3' },
    ]);
    await markRead(inboxPath, 'msg-r1');
    await markRead(inboxPath, 'msg-r3');
    const unread = await listUnread(inboxPath);
    assert.strictEqual(unread.length, 1, 'only msg-r2 should be unread');
    assert.strictEqual(unread[0].id, 'msg-r2');
  });

  test('listUnread returns empty array for empty inbox', async () => {
    const dir = makeTmpDir();
    const inboxPath = path.join(dir, 'empty-agent');
    fs.mkdirSync(inboxPath, { recursive: true });
    const unread = await listUnread(inboxPath);
    assert.deepStrictEqual(unread, []);
  });

  test('listUnread returns empty array when inbox directory does not exist', async () => {
    const dir = makeTmpDir();
    const unread = await listUnread(path.join(dir, 'no-such-agent'));
    assert.deepStrictEqual(unread, []);
  });
});

// ---------------------------------------------------------------------------
// A4 — listAwaitingMe
// ---------------------------------------------------------------------------

suite('inboxState — listAwaitingMe filter', () => {
  test('only requires_response=true and not replied shows up', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [
      { id: 'msg-a1', requires_response: true },   // awaiting
      { id: 'msg-a2', requires_response: true },   // will reply → not awaiting
      { id: 'msg-a3', requires_response: false },  // does not require response
      { id: 'msg-a4', requires_response: true },   // awaiting
    ]);
    await markReplied(inboxPath, 'msg-a2');
    const awaiting = await listAwaitingMe(inboxPath);
    const ids = awaiting.map(m => m.id).sort();
    assert.deepStrictEqual(ids, ['msg-a1', 'msg-a4'], 'only unreplied requires_response msgs');
  });

  test('archived messages are excluded from listAwaitingMe even if requires_response', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [
      { id: 'msg-b1', requires_response: true },
      { id: 'msg-b2', requires_response: true },
    ]);
    await archive(inboxPath, 'msg-b1');
    const awaiting = await listAwaitingMe(inboxPath);
    assert.strictEqual(awaiting.length, 1, 'archived msg-b1 should be excluded');
    assert.strictEqual(awaiting[0].id, 'msg-b2');
  });

  test('backwards-compat: no state files → all requires_response msgs are awaiting', async () => {
    const dir = makeTmpDir();
    const inboxPath = makeFixtureInbox(dir, [
      { id: 'msg-c1', requires_response: true },
      { id: 'msg-c2', requires_response: false },
      { id: 'msg-c3', requires_response: true },
    ]);
    const awaiting = await listAwaitingMe(inboxPath);
    assert.strictEqual(awaiting.length, 2, 'both requires_response msgs should be awaiting');
  });
});

// ---------------------------------------------------------------------------
// A5 — Session heartbeat file written
// ---------------------------------------------------------------------------

suite('heartbeat — session-level file written', () => {
  test('writeSessionHeartbeat writes primary file', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = {
      agent_id: 'claude-code',
      timestamp: new Date().toISOString(),
      status: 'active',
      current_task: 'sprint-1-a5',
      sprint: 1,
    };
    const { primaryPath, sessionPath } = await writeSessionHeartbeat(dir, hb);
    assert.ok(fs.existsSync(primaryPath), 'primary heartbeat file should exist');
    assert.strictEqual(sessionPath, null, 'no session file when session_id absent');
    const written = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
    assert.strictEqual(written.agent_id, 'claude-code');
  });

  test('writeSessionHeartbeat writes session sidecar when session_id provided', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = {
      agent_id: 'claude-code',
      session_id: 'sess-abc123',
      timestamp: new Date().toISOString(),
      status: 'active',
      current_task: 'sprint-1-a5',
      sprint: 1,
      token_budget_remaining: 50000,
      queue_depth: 2,
      current_llm: 'claude-sonnet-4-6',
    };
    const { primaryPath, sessionPath } = await writeSessionHeartbeat(dir, hb);
    assert.ok(fs.existsSync(primaryPath), 'primary file should exist');
    assert.ok(sessionPath !== null, 'session path should be returned');
    assert.ok(fs.existsSync(sessionPath!), 'session sidecar file should exist');

    // Both files should have the same payload.
    const primary = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
    const session = JSON.parse(fs.readFileSync(sessionPath!, 'utf8'));
    assert.deepStrictEqual(primary, session, 'primary and session files should match');
    assert.strictEqual(session.session_id, 'sess-abc123');
    assert.strictEqual(session.token_budget_remaining, 50000);
  });

  test('readSessionHeartbeats returns all session files for an agent', async () => {
    const dir = makeTmpDir();
    const base: Heartbeat = {
      agent_id: 'kilo-code',
      timestamp: new Date().toISOString(),
      status: 'active',
      current_task: null,
      sprint: null,
    };
    await writeSessionHeartbeat(dir, { ...base, session_id: 'sess-1' });
    await writeSessionHeartbeat(dir, { ...base, session_id: 'sess-2' });
    // Also write one without session_id — should not appear in session list.
    await writeSessionHeartbeat(dir, { ...base });

    const sessions = await readSessionHeartbeats(dir, 'kilo-code');
    assert.strictEqual(sessions.length, 2, 'should find both session sidecar files');
    const sessionIds = sessions.map(s => s.session_id).sort();
    assert.deepStrictEqual(sessionIds, ['sess-1', 'sess-2']);
  });

  test('readSessionHeartbeats returns empty array when no session files exist', async () => {
    const dir = makeTmpDir();
    const sessions = await readSessionHeartbeats(dir, 'ghost-agent');
    assert.deepStrictEqual(sessions, []);
  });

  test('checkStall: stalled when primary is old and sprint is set', async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'heartbeats'), { recursive: true });
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const hb: Heartbeat = {
      agent_id: 'kilo-code',
      timestamp: staleTime,
      status: 'active',
      current_task: 'task-42',
      sprint: 1,
    };
    fs.writeFileSync(
      path.join(dir, 'heartbeats', 'kilo-code.json'),
      JSON.stringify(hb, null, 2),
      'utf8'
    );
    const result = await checkStall(dir, 'kilo-code');
    assert.strictEqual(result.stalled, true, 'agent should be stalled');
    assert.ok(result.primaryAge !== null && result.primaryAge > 5 * 60 * 1000);
  });

  test('checkStall: not stalled when primary is fresh', async () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'heartbeats'), { recursive: true });
    const hb: Heartbeat = {
      agent_id: 'claude-code',
      timestamp: new Date().toISOString(),
      status: 'active',
      current_task: 'task-1',
      sprint: 1,
    };
    fs.writeFileSync(
      path.join(dir, 'heartbeats', 'claude-code.json'),
      JSON.stringify(hb, null, 2),
      'utf8'
    );
    const result = await checkStall(dir, 'claude-code');
    assert.strictEqual(result.stalled, false, 'fresh agent should not be stalled');
  });
});
