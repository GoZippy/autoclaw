import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sendMessage, readInbox, readSharedInbox,
  appendCommsLog, readCommsLog,
  writeHeartbeat, readHeartbeat,
  agentStatusFromHeartbeat, getAgentStatuses,
  writeRegistry, readRegistry,
  generateMessageId,
  redactErrorMessage,
  readMessageState, markMessageRead, markMessageReplied, markMessageArchived,
  getInboxSummary,
  type Message, type Heartbeat, type AgentRegistry, type RegisteredAgent,
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

// ---------------------------------------------------------------------------
// v2 schemas — RegisteredAgent + Heartbeat extensions
// ---------------------------------------------------------------------------

suite('Comms — v2 schemas', () => {
  test('v1 RegisteredAgent JSON parses; new fields are undefined', async () => {
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
    const got = await readRegistry(dir);
    assert.ok(got);
    assert.strictEqual(got!.agents.length, 1);
    assert.strictEqual(got!.agents[0].capabilities, undefined);
    assert.strictEqual(got!.agents[0].trust_level, undefined);
    assert.strictEqual(got!.agents[0].machine_id, undefined);
    assert.strictEqual(got!.schema_version, undefined);
  });

  test('v2 RegisteredAgent with all new fields populated round-trips', async () => {
    const dir = makeTmpDir();
    const agent: RegisteredAgent = {
      id: 'claude-code', name: 'Claude Code', extension_id: 'anthropic.claude-code',
      detected: true, inbox_path: '.autoclaw/orchestrator/comms/inboxes/claude-code/',
      hooks_supported: true, last_heartbeat: null, status: 'detected',
      rules_path: '.claude/rules/cross-agent-protocol.md',
      machine_id: 'abc123hex',
      machine_ip: '10.0.0.42',
      capabilities: ['typescript', 'react'],
      llms_available: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      context_window: 1000000,
      tools_supported: ['bash', 'edit'],
      trust_level: 'high',
      cost_budget: { daily_usd: 100, hourly_usd: 10 },
      max_parallel_tasks: 3,
      skills_loaded: ['kdream', 'autobuild'],
      human_in_loop_required: false,
      agent_card_path: '~/.autoclaw/agent-card.json',
      spiffe_id: undefined,
      last_detected_at: '2026-05-09T12:00:00Z',
    };
    const reg: AgentRegistry = {
      agents: [agent],
      ide: 'vscode',
      provisioned_at: new Date().toISOString(),
      schema_version: '2',
    };
    await writeRegistry(dir, reg);
    const got = await readRegistry(dir);
    assert.ok(got);
    assert.strictEqual(got!.schema_version, '2');
    const a = got!.agents[0];
    assert.strictEqual(a.trust_level, 'high');
    assert.deepStrictEqual(a.capabilities, ['typescript', 'react']);
    assert.deepStrictEqual(a.llms_available, ['claude-opus-4-7', 'claude-sonnet-4-6']);
    assert.strictEqual(a.context_window, 1000000);
    assert.deepStrictEqual(a.cost_budget, { daily_usd: 100, hourly_usd: 10 });
    assert.strictEqual(a.max_parallel_tasks, 3);
    assert.strictEqual(a.machine_id, 'abc123hex');
    assert.strictEqual(a.machine_ip, '10.0.0.42');
    assert.strictEqual(a.last_detected_at, '2026-05-09T12:00:00Z');
  });

  test('v1 Heartbeat round-trips (no new fields present)', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = {
      agent_id: 'kiro', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: null, sprint: null,
    };
    await writeHeartbeat(dir, hb);
    const got = await readHeartbeat(dir, 'kiro');
    assert.deepStrictEqual(got, hb);
    assert.strictEqual(got!.session_id, undefined);
    assert.strictEqual(got!.queue_depth, undefined);
  });

  test('writeHeartbeat: two successive writes with different session_ids both round-trip (latest wins)', async () => {
    const dir = makeTmpDir();
    const hb1: Heartbeat = {
      agent_id: 'kiro', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: null, sprint: null,
      session_id: 'session-aaa',
    };
    await writeHeartbeat(dir, hb1);
    const got1 = await readHeartbeat(dir, 'kiro');
    assert.strictEqual(got1!.session_id, 'session-aaa');

    const hb2: Heartbeat = { ...hb1, timestamp: '2026-05-09T00:00:30Z', session_id: 'session-bbb' };
    await writeHeartbeat(dir, hb2);
    const got2 = await readHeartbeat(dir, 'kiro');
    assert.strictEqual(got2!.session_id, 'session-bbb');
  });

  test('v2 Heartbeat with all new fields round-trips', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = {
      agent_id: 'claude-code', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: 'task-7', sprint: 1,
      session_id: '550e8400-e29b-41d4-a716-446655440000',
      token_budget_remaining: 42000,
      queue_depth: 3,
      current_llm: 'claude-opus-4-7',
      last_error: { timestamp: '2026-05-09T00:00:00Z', code: 'rate_limit', message: 'too many requests' },
      network_latency_ms: 25,
      error_rate_1m: 0.01,
      schema_version: '2',
    };
    await writeHeartbeat(dir, hb);
    const got = await readHeartbeat(dir, 'claude-code');
    assert.deepStrictEqual(got, hb);
  });

  test('agentStatusFromHeartbeat returns "overloaded" when queue_depth high', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    const status = agentStatusFromHeartbeat(
      {
        agent_id: 'a', timestamp: '2026-05-09T00:00:00Z',
        status: 'active', current_task: null, sprint: null,
        queue_depth: 12,
      },
      now
    );
    assert.strictEqual(status, 'overloaded');
  });

  test('agentStatusFromHeartbeat returns "overloaded" when error_rate_1m high', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    const status = agentStatusFromHeartbeat(
      {
        agent_id: 'a', timestamp: '2026-05-09T00:00:00Z',
        status: 'active', current_task: null, sprint: null,
        error_rate_1m: 0.6,
      },
      now
    );
    assert.strictEqual(status, 'overloaded');
  });

  test('agentStatusFromHeartbeat: stalled wins over overloaded', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    // 6 minutes ago, sprint set, queue_depth high → stalled (Stage A wins).
    const status = agentStatusFromHeartbeat(
      {
        agent_id: 'a', timestamp: '2026-05-08T23:54:00Z',
        status: 'idle', current_task: null, sprint: 1,
        queue_depth: 99, error_rate_1m: 0.99,
      },
      now
    );
    assert.strictEqual(status, 'stalled');
  });

  test('redactErrorMessage: truncates over-500-char input', () => {
    const huge = 'x'.repeat(800);
    const out = redactErrorMessage(huge);
    assert.strictEqual(out.length, 500);
  });

  test('redactErrorMessage: strips ANSI escape sequences', () => {
    const ansi = '\x1b[31mERROR\x1b[0m: thing failed';
    const out = redactErrorMessage(ansi);
    assert.strictEqual(out, 'ERROR: thing failed');
  });

  test('redactErrorMessage: replaces $HOME path', () => {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) { return; } // Skip on hosts without home.
    const msg = `failed to open ${home}/secret.txt`;
    const out = redactErrorMessage(msg);
    assert.ok(out.includes('$HOME/secret.txt'), `expected $HOME substitution, got: ${out}`);
    assert.ok(!out.includes(home), `home path leaked: ${out}`);
  });

  test('redactErrorMessage: redacts token-looking strings', () => {
    const msg = 'auth failed for sk-AbCdEf1234567890ZZZ and ghp_qwertyABCDEFGH123';
    const out = redactErrorMessage(msg);
    assert.ok(out.includes('<redacted>'), out);
    assert.ok(!/sk-[A-Za-z0-9]+/.test(out), `sk- token leaked: ${out}`);
    assert.ok(!/ghp_[A-Za-z0-9]+/.test(out), `ghp_ token leaked: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// Inbox state machine
// ---------------------------------------------------------------------------

suite('Comms — inbox state machine', () => {
  async function sendAndReturn(dir: string, to: string, requiresResponse = false): Promise<Message> {
    const msg: Message = {
      id: '', from: 'orchestrator', to, type: 'review_request',
      timestamp: '', payload: {}, requires_response: requiresResponse,
    };
    await sendMessage(dir, msg);
    return msg;
  }

  test('readMessageState returns null when no state file exists', async () => {
    const dir = makeTmpDir();
    const got = await readMessageState(dir, 'kiro', 'msg-nope');
    assert.strictEqual(got, null);
  });

  test('markMessageRead creates state file with read_at; idempotent', async () => {
    const dir = makeTmpDir();
    const msg = await sendAndReturn(dir, 'kiro', true);
    await markMessageRead(dir, 'kiro', msg.id);
    const s1 = await readMessageState(dir, 'kiro', msg.id);
    assert.ok(s1);
    assert.ok(s1!.read_at);
    const firstReadAt = s1!.read_at;
    // Re-mark; should be a no-op (read_at unchanged).
    await markMessageRead(dir, 'kiro', msg.id);
    const s2 = await readMessageState(dir, 'kiro', msg.id);
    assert.strictEqual(s2!.read_at, firstReadAt);
  });

  test('markMessageReplied sets replied_at and read_at if missing', async () => {
    const dir = makeTmpDir();
    const msg = await sendAndReturn(dir, 'kiro', true);
    await markMessageReplied(dir, 'kiro', msg.id);
    const s = await readMessageState(dir, 'kiro', msg.id);
    assert.ok(s!.replied_at);
    assert.ok(s!.read_at);
  });

  test('markMessageArchived sets archived_at', async () => {
    const dir = makeTmpDir();
    const msg = await sendAndReturn(dir, 'kiro', false);
    await markMessageArchived(dir, 'kiro', msg.id);
    const s = await readMessageState(dir, 'kiro', msg.id);
    assert.ok(s!.archived_at);
  });

  test('getInboxSummary: backwards compatible — no _state/ → all unread, all awaiting if requires_response', async () => {
    const dir = makeTmpDir();
    await sendAndReturn(dir, 'kiro', true);
    await sendAndReturn(dir, 'kiro', false);
    await sendAndReturn(dir, 'kiro', true);
    const sum = await getInboxSummary(dir, 'kiro');
    assert.strictEqual(sum.total, 3);
    assert.strictEqual(sum.unread, 3);
    assert.strictEqual(sum.awaiting_response, 2);
    assert.strictEqual(sum.archived, 0);
  });

  test('getInboxSummary: read+replied+archived counted correctly', async () => {
    const dir = makeTmpDir();
    const m1 = await sendAndReturn(dir, 'kiro', true);
    const m2 = await sendAndReturn(dir, 'kiro', true);
    const m3 = await sendAndReturn(dir, 'kiro', false);
    await markMessageRead(dir, 'kiro', m1.id);
    await markMessageReplied(dir, 'kiro', m2.id);
    await markMessageArchived(dir, 'kiro', m3.id);
    const sum = await getInboxSummary(dir, 'kiro');
    assert.strictEqual(sum.total, 3);
    // m2 is read (via replied) and m1 is read; m3 has no read_at → unread = 1
    assert.strictEqual(sum.unread, 1);
    // m1 requires_response and not replied → 1 awaiting; m2 requires + replied → not awaiting
    assert.strictEqual(sum.awaiting_response, 1);
    assert.strictEqual(sum.archived, 1);
  });
});
