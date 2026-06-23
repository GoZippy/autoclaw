import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { announceSession, sessionFrag } from '../orchestrator/announce';
import { SESSION_ANNOUNCE_TYPE } from '../orchestrator/coordination';
import type { SessionDescriptor, CommsMessage } from '../orchestrator/coordination';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'announce-test-'));
}

function commsDir(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms');
}

function sharedFiles(root: string): string[] {
  const dir = path.join(commsDir(root), 'inboxes', 'shared');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as T;
}

const SESSION = '12345678-aaaa-bbbb-cccc-dddddddddddd';

suite('Auto-announce on session start (CL-1)', () => {

  test('announce writes both the shared message and the heartbeat sidecar', async () => {
    const root = makeTmp();
    const now = Date.UTC(2026, 5, 23, 12, 0, 0);
    const res = await announceSession(root, {
      agent_id: 'claude-code',
      session_id: SESSION,
      branch: 'feat/coordination-runtime',
      current_task: 'CL-1 auto-announce',
      file_scope: ['src/orchestrator/announce.ts'],
      note: 'starting up',
    }, { now });

    assert.strictEqual(res.announced, true);
    assert.ok(res.messagePath, 'a message path was returned');

    // Heartbeat sidecar named <agent>-<frag>.json (frag = first 8 of session_id).
    const frag = sessionFrag(SESSION);
    assert.strictEqual(frag, '12345678');
    assert.strictEqual(
      path.basename(res.heartbeatPath),
      `claude-code-${frag}.json`,
      'heartbeat uses the <agent>-<frag>.json convention'
    );
    assert.ok(fs.existsSync(res.heartbeatPath), 'heartbeat sidecar exists');

    const hb = readJson<SessionDescriptor>(res.heartbeatPath);
    assert.strictEqual(hb.agent_id, 'claude-code');
    assert.strictEqual(hb.session_id, SESSION);
    assert.strictEqual(hb.status, 'active');
    assert.strictEqual(hb.current_task, 'CL-1 auto-announce');
    assert.strictEqual(hb.branch, 'feat/coordination-runtime');
    assert.deepStrictEqual(hb.file_scope, ['src/orchestrator/announce.ts']);

    // Exactly one shared announce message, carrying the descriptive payload.
    const files = sharedFiles(root);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].includes(`-${SESSION_ANNOUNCE_TYPE}-claude-code-${frag}.json`));

    const msg = readJson<CommsMessage>(res.messagePath!);
    assert.strictEqual(msg.type, SESSION_ANNOUNCE_TYPE);
    assert.strictEqual(msg.from, 'claude-code');
    assert.strictEqual(msg.to, 'shared');
    assert.strictEqual(msg.session_id, SESSION);
    assert.strictEqual(msg.requires_response, false);
    assert.strictEqual(msg.payload?.current_task, 'CL-1 auto-announce');
    assert.strictEqual(msg.payload?.branch, 'feat/coordination-runtime');
    assert.deepStrictEqual(msg.payload?.file_scope, ['src/orchestrator/announce.ts']);
    assert.strictEqual(msg.payload?.note, 'starting up');
  });

  test('re-announce within the window refreshes the heartbeat without a 2nd message', async () => {
    const root = makeTmp();
    const now = Date.UTC(2026, 5, 23, 12, 0, 0);

    const first = await announceSession(root, {
      agent_id: 'claude-code', session_id: SESSION, current_task: 'task A',
    }, { now });
    assert.strictEqual(first.announced, true);

    // 5 minutes later (inside the 10-min dedupe window), same session.
    const later = now + 5 * 60 * 1000;
    const second = await announceSession(root, {
      agent_id: 'claude-code', session_id: SESSION, current_task: 'task B',
    }, { now: later });

    assert.strictEqual(second.announced, false, 'duplicate announce suppressed');
    assert.strictEqual(second.messagePath, undefined);

    // Still exactly one announce message on the board.
    assert.strictEqual(sharedFiles(root).length, 1);

    // But the heartbeat was refreshed (new timestamp + new current_task).
    const hb = readJson<SessionDescriptor>(second.heartbeatPath);
    assert.strictEqual(hb.current_task, 'task B');
    assert.strictEqual(hb.timestamp, new Date(later).toISOString());
  });

  test('re-announce AFTER the window writes a second message', async () => {
    const root = makeTmp();
    const now = Date.UTC(2026, 5, 23, 12, 0, 0);
    await announceSession(root, { agent_id: 'claude-code', session_id: SESSION }, { now });

    // 11 minutes later — past the 10-min dedupe window.
    const later = now + 11 * 60 * 1000;
    const second = await announceSession(root, { agent_id: 'claude-code', session_id: SESSION }, { now: later });

    assert.strictEqual(second.announced, true);
    assert.strictEqual(sharedFiles(root).length, 2, 'a fresh announce landed');
  });

  test('a different session announces independently (own sidecar + message)', async () => {
    const root = makeTmp();
    const now = Date.UTC(2026, 5, 23, 12, 0, 0);
    const other = 'ffffffff-0000-1111-2222-333333333333';

    const a = await announceSession(root, { agent_id: 'claude-code', session_id: SESSION }, { now });
    const b = await announceSession(root, { agent_id: 'claude-code', session_id: other }, { now: now + 1000 });

    assert.strictEqual(a.announced, true);
    assert.strictEqual(b.announced, true);
    assert.notStrictEqual(a.heartbeatPath, b.heartbeatPath);
    assert.strictEqual(sharedFiles(root).length, 2);
  });

  test('missing comms tree is tolerated — directories are created on demand', async () => {
    const root = makeTmp(); // empty temp dir, no .autoclaw at all
    const res = await announceSession(root, {
      agent_id: 'kilocode', session_id: SESSION, current_task: 'bootstrap',
    });
    assert.strictEqual(res.announced, true);
    assert.ok(fs.existsSync(res.heartbeatPath));
    assert.strictEqual(sharedFiles(root).length, 1);
  });

  test('optional fields default safely (null task/branch, empty file_scope)', async () => {
    const root = makeTmp();
    const res = await announceSession(root, { agent_id: 'claude-code', session_id: SESSION });
    const hb = readJson<SessionDescriptor>(res.heartbeatPath);
    assert.strictEqual(hb.current_task, null);
    assert.strictEqual(hb.branch, null);
    assert.deepStrictEqual(hb.file_scope, []);
    const msg = readJson<CommsMessage>(res.messagePath!);
    assert.strictEqual(msg.payload?.note, null);
  });
});
