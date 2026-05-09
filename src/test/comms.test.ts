import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sendMessage, readInbox, readSharedInbox,
  appendCommsLog, readCommsLog,
  writeHeartbeat, readHeartbeat,
  agentStatusFromHeartbeat, getAgentStatuses,
  writeRegistry,
  generateMessageId,
  type Message, type Heartbeat, type AgentRegistry,
} from '../comms';

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-comms-'));
  fs.mkdirSync(path.join(d, 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(d, 'inboxes', 'kiro'), { recursive: true });
  fs.mkdirSync(path.join(d, 'heartbeats'), { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

suite('Comms — messages', () => {
  test('sendMessage writes JSON to recipient inbox and appends comms-log', async () => {
    const dir = makeTmpDir();
    const msg: Message = {
      id: '', from: 'claude-code', to: 'kiro', type: 'review_request',
      timestamp: '', task_id: 'T1', payload: { foo: 'bar' }, requires_response: true,
    };
    const fp = await sendMessage(dir, msg);
    assert.ok(fs.existsSync(fp));
    const inbox = await readInbox(dir, 'kiro');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].from, 'claude-code');
    assert.strictEqual(inbox[0].task_id, 'T1');
    const log = await readCommsLog(dir);
    assert.ok(log.some(e => e.type === 'review_request'));
  });

  test('sendMessage stamps a generated id and timestamp when missing', async () => {
    const dir = makeTmpDir();
    const msg: Message = {
      id: '', from: 'kiro', to: 'claude-code', type: 'question',
      timestamp: '', payload: {}, requires_response: false,
    };
    await sendMessage(dir, msg);
    assert.match(msg.id, /^msg-/);
    assert.ok(msg.timestamp.length > 0);
  });

  test('readSharedInbox reads the shared/ directory', async () => {
    const dir = makeTmpDir();
    await sendMessage(dir, {
      id: '', from: 'orchestrator', to: 'shared', type: 'task_assignment',
      timestamp: '', payload: { sprint: 1 }, requires_response: false,
    });
    const shared = await readSharedInbox(dir);
    assert.strictEqual(shared.length, 1);
    assert.strictEqual(shared[0].to, 'shared');
  });

  test('readInbox skips a malformed JSON file without throwing', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'inboxes', 'kiro', 'broken.json'), '{not-json');
    const inbox = await readInbox(dir, 'kiro');
    assert.deepStrictEqual(inbox, []);
  });

  test('readInbox returns empty array when inbox dir does not exist', async () => {
    const dir = makeTmpDir();
    const inbox = await readInbox(dir, 'never-provisioned');
    assert.deepStrictEqual(inbox, []);
  });

  test('appendCommsLog + readCommsLog round-trip', async () => {
    const dir = makeTmpDir();
    await appendCommsLog(dir, {
      timestamp: new Date().toISOString(),
      type: 'task_complete', from: 'kiro', message: 'done',
    });
    await appendCommsLog(dir, {
      timestamp: new Date().toISOString(),
      type: 'finding_report', from: 'claude-code', message: 'fr',
    });
    const log = await readCommsLog(dir, { limit: 10 });
    assert.strictEqual(log.length, 2);
    assert.strictEqual(log[0].type, 'task_complete');
    assert.strictEqual(log[1].type, 'finding_report');
  });
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

suite('Comms — heartbeats', () => {
  test('writeHeartbeat then readHeartbeat returns the same record', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = {
      agent_id: 'kiro', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: 'orchestrate', sprint: 1,
    };
    await writeHeartbeat(dir, hb);
    const got = await readHeartbeat(dir, 'kiro');
    assert.deepStrictEqual(got, hb);
  });

  test('readHeartbeat returns null when no heartbeat exists', async () => {
    const dir = makeTmpDir();
    const got = await readHeartbeat(dir, 'never-beat');
    assert.strictEqual(got, null);
  });

  test('agentStatusFromHeartbeat: offline for null, active for fresh, stalled for old-with-sprint', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    assert.strictEqual(agentStatusFromHeartbeat(null, now), 'offline');
    assert.strictEqual(
      agentStatusFromHeartbeat(
        { agent_id: 'a', timestamp: '2026-05-09T00:00:00Z', status: 'active', current_task: null, sprint: null },
        now
      ),
      'active'
    );
    // 6 minutes ago, sprint set → stalled
    assert.strictEqual(
      agentStatusFromHeartbeat(
        { agent_id: 'a', timestamp: '2026-05-08T23:54:00Z', status: 'idle', current_task: null, sprint: 1 },
        now
      ),
      'stalled'
    );
  });

  test('agentStatusFromHeartbeat: idle window between active and stalled thresholds', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    // 3 minutes ago (between 2min and 5min) → idle
    assert.strictEqual(
      agentStatusFromHeartbeat(
        { agent_id: 'a', timestamp: '2026-05-08T23:57:00Z', status: 'active', current_task: null, sprint: null },
        now
      ),
      'idle'
    );
  });
});

// ---------------------------------------------------------------------------
// Registry & status inference
// ---------------------------------------------------------------------------

suite('Comms — registry & status inference', () => {
  test('writeRegistry then getAgentStatuses joins registry with heartbeats', async () => {
    const dir = makeTmpDir();
    const reg: AgentRegistry = {
      agents: [{
        id: 'kiro', name: 'Kiro', extension_id: null, detected: true,
        inbox_path: '.autoclaw/orchestrator/comms/inboxes/kiro/',
        hooks_supported: false, last_heartbeat: null, status: 'detected',
      }],
      ide: 'test',
      provisioned_at: new Date().toISOString(),
    };
    await writeRegistry(dir, reg);
    await writeHeartbeat(dir, {
      agent_id: 'kiro', timestamp: new Date().toISOString(),
      status: 'active', current_task: null, sprint: null,
    });
    const statuses = await getAgentStatuses(dir);
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].id, 'kiro');
    assert.strictEqual(statuses[0].live_status, 'active');
    assert.ok(statuses[0].heartbeat);
  });

  test('getAgentStatuses returns empty array when registry missing', async () => {
    const dir = makeTmpDir();
    const statuses = await getAgentStatuses(dir);
    assert.deepStrictEqual(statuses, []);
  });

  test('generateMessageId produces unique prefixed ids', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    assert.notStrictEqual(a, b);
    assert.match(a, /^msg-/);
    assert.match(b, /^msg-/);
  });
});
