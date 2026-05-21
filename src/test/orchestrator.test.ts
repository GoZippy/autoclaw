import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SprintStatus, StateMachine } from '../orchestrator/stateMachine';
import { MessageLedger } from '../orchestrator/ledger';
import { claimMessage, generateClaimFilename } from '../orchestrator/claim';
import type { InboxMessage } from '../comms/types';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-orchestrator-'));
}

function makeMsg(id: string, type: InboxMessage['type'] = 'task_complete'): InboxMessage {
  return {
    id,
    from: 'wa-1',
    to: 'shared',
    type,
    timestamp: new Date().toISOString(),
    payload: {},
    requires_response: false,
  };
}

// ---------------------------------------------------------------------------
// StateMachine
// ---------------------------------------------------------------------------

suite('StateMachine — state transitions', () => {
  test('initial state is set via constructor and snapshot() returns it', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending, 2: SprintStatus.review });
    assert.strictEqual(sm.get(1), SprintStatus.pending);
    assert.strictEqual(sm.get(2), SprintStatus.review);
    const snap = sm.snapshot();
    assert.strictEqual(snap[1], SprintStatus.pending);
    assert.strictEqual(snap[2], SprintStatus.review);
  });

  test('transition: valid pending → assigned succeeds', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending });
    sm.transition(1, SprintStatus.assigned);
    assert.strictEqual(sm.get(1), SprintStatus.assigned);
  });

  test('transition guard: cannot skip from pending to merged directly', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending });
    assert.throws(
      () => sm.transition(1, SprintStatus.merged),
      /Invalid transition.*pending.*merged/
    );
    assert.strictEqual(sm.get(1), SprintStatus.pending);
  });

  test('transition guard: cannot skip from pending to in_progress', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending });
    assert.throws(
      () => sm.transition(1, SprintStatus.in_progress),
      /Invalid transition/
    );
  });

  test('transition guard: cannot go backwards from approved to review', () => {
    const sm = new StateMachine({ 1: SprintStatus.approved });
    assert.throws(
      () => sm.transition(1, SprintStatus.review),
      /Invalid transition/
    );
  });

  test('full valid lifecycle: pending → assigned → in_progress → review → approved → merged', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending });
    sm.transition(1, SprintStatus.assigned);
    sm.transition(1, SprintStatus.in_progress);
    sm.transition(1, SprintStatus.review);
    sm.transition(1, SprintStatus.approved);
    sm.transition(1, SprintStatus.merged);
    assert.strictEqual(sm.get(1), SprintStatus.merged);
  });

  test('transition on unregistered sprint throws', () => {
    const sm = new StateMachine({});
    assert.throws(
      () => sm.transition(99, SprintStatus.assigned),
      /Sprint 99 not registered/
    );
  });

  test('canTransition returns true/false without mutating state', () => {
    const sm = new StateMachine({ 1: SprintStatus.pending });
    assert.ok(sm.canTransition(1, SprintStatus.assigned));
    assert.ok(!sm.canTransition(1, SprintStatus.merged));
    assert.strictEqual(sm.get(1), SprintStatus.pending);
  });
});

// ---------------------------------------------------------------------------
// MessageLedger — dedup and schema
// ---------------------------------------------------------------------------

suite('MessageLedger — idempotency and schema', () => {
  test('record() returns true on first call and false on duplicate', async () => {
    const dir = makeTmpDir();
    const stateFile = path.join(dir, 'state.json');
    const ledger = new MessageLedger(stateFile);
    const msg = makeMsg('msg-abc-001');

    const first = await ledger.record(msg);
    assert.strictEqual(first, true);

    const second = await ledger.record(msg);
    assert.strictEqual(second, false);
  });

  test('ledger dedup: same msg.id from two different message objects is a no-op', async () => {
    const dir = makeTmpDir();
    const ledger = new MessageLedger(path.join(dir, 'state.json'));
    const msg1 = makeMsg('msg-dedup-1');
    const msg2 = { ...msg1, payload: { different: true } };

    await ledger.record(msg1);
    await ledger.record(msg2);

    const entry = await ledger.getEntry('msg-dedup-1');
    assert.ok(entry);
    assert.strictEqual(entry!.type, 'task_complete');
  });

  test('has() returns true after record, false for unknown id', async () => {
    const dir = makeTmpDir();
    const ledger = new MessageLedger(path.join(dir, 'state.json'));
    const msg = makeMsg('msg-has-test');

    assert.strictEqual(await ledger.has('msg-has-test'), false);
    await ledger.record(msg);
    assert.strictEqual(await ledger.has('msg-has-test'), true);
  });

  test('markResponded sets responded_at on a known entry', async () => {
    const dir = makeTmpDir();
    const ledger = new MessageLedger(path.join(dir, 'state.json'));
    const msg = makeMsg('msg-respond-1');
    await ledger.record(msg);

    await ledger.markResponded('msg-respond-1');
    const entry = await ledger.getEntry('msg-respond-1');
    assert.ok(entry!.responded_at);
  });

  test('schema: state.json has required top-level fields after first record', async () => {
    const dir = makeTmpDir();
    const stateFile = path.join(dir, 'state.json');
    const ledger = new MessageLedger(stateFile);
    await ledger.record(makeMsg('msg-schema-check'));

    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok('schema_version' in parsed, 'missing schema_version');
    assert.ok('message_ledger' in parsed, 'missing message_ledger');
    assert.ok('sprint_statuses' in parsed, 'missing sprint_statuses');
    assert.ok('consensus_tallies' in parsed, 'missing consensus_tallies');
    assert.ok('last_updated' in parsed, 'missing last_updated');
  });

  test('atomic write: state file is valid JSON after concurrent writes with different ids', async () => {
    const dir = makeTmpDir();
    const stateFile = path.join(dir, 'state.json');
    const ledger = new MessageLedger(stateFile);

    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(`msg-concurrent-${i}`));
    await Promise.all(msgs.map(m => ledger.record(m)));

    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(typeof parsed.message_ledger, 'object');
  });

  test('concurrent write safety: two record() calls for same id result in exactly one entry', async () => {
    const dir = makeTmpDir();
    const ledger = new MessageLedger(path.join(dir, 'state.json'));
    const msg = makeMsg('msg-race');

    const results = await Promise.all([
      ledger.record(msg),
      ledger.record(msg),
    ]);

    const trueCount = results.filter(r => r === true).length;
    assert.ok(trueCount <= 1, `Expected at most 1 successful record, got ${trueCount}`);

    const entry = await ledger.getEntry('msg-race');
    assert.ok(entry, 'Entry should exist after race');
  });

  test('ledger works from existing state.json that already has message_ledger entries', async () => {
    const dir = makeTmpDir();
    const stateFile = path.join(dir, 'state.json');
    const existing = {
      project: 'test', schema_version: '1.0', current_sprint: 1,
      tasks_total: 5, tasks_complete: 2, agents: {}, sprint_statuses: {},
      message_ledger: { 'existing-msg': { received_at: '2026-01-01T00:00:00Z', responded_at: null, type: 'task_assign' } },
      consensus_tallies: {}, last_updated: '2026-01-01T00:00:00Z',
    };
    fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2));

    const ledger = new MessageLedger(stateFile);
    assert.strictEqual(await ledger.has('existing-msg'), true);
    const ok = await ledger.record(makeMsg('new-msg'));
    assert.strictEqual(ok, true);
    assert.strictEqual(await ledger.has('existing-msg'), true);
    assert.strictEqual(await ledger.has('new-msg'), true);
  });
});

// ---------------------------------------------------------------------------
// claimMessage — atomic rename
// ---------------------------------------------------------------------------

suite('claimMessage — atomic rename', () => {
  function writeInboxMessage(inboxDir: string, filename: string, msg: InboxMessage): string {
    fs.mkdirSync(inboxDir, { recursive: true });
    const fp = path.join(inboxDir, filename);
    fs.writeFileSync(fp, JSON.stringify(msg, null, 2), 'utf8');
    return fp;
  }

  test('claimMessage moves file to processed/ and returns ClaimedMessage', async () => {
    const dir = makeTmpDir();
    const inboxDir = path.join(dir, 'inboxes', 'shared');
    const msg = makeMsg('msg-claim-1');
    const filename = '20260521T000000-task_complete-wa-1-claim-1.json';
    writeInboxMessage(inboxDir, filename, msg);

    const result = await claimMessage(inboxDir, filename, 'claude-code');
    assert.ok(result, 'Expected ClaimedMessage, got null');
    assert.ok(!fs.existsSync(path.join(inboxDir, filename)), 'Original file should be gone');
    assert.ok(fs.existsSync(result!.processedPath), 'Processed file should exist');
    assert.strictEqual(result!.message.id, 'msg-claim-1');
    assert.ok(result!.claimToken, 'claimToken should be set');
  });

  test('claimMessage returns null when file does not exist (already claimed)', async () => {
    const dir = makeTmpDir();
    const inboxDir = path.join(dir, 'inboxes', 'shared');
    fs.mkdirSync(inboxDir, { recursive: true });

    const result = await claimMessage(inboxDir, 'ghost-file.json', 'claude-code');
    assert.strictEqual(result, null);
  });

  test('claimMessage backs off when a fresh claim token exists', async () => {
    const dir = makeTmpDir();
    const inboxDir = path.join(dir, 'inboxes', 'shared');
    const msg = makeMsg('msg-backoff');
    const filename = 'msg-backoff-test.json';
    writeInboxMessage(inboxDir, filename, msg);

    const claimsDir = path.join(inboxDir, '..', 'agents', 'other-agent');
    fs.mkdirSync(claimsDir, { recursive: true });
    const taskId = filename.replace(/\.json$/, '');
    fs.writeFileSync(
      path.join(claimsDir, `claim-${taskId}-${Date.now()}.json`),
      JSON.stringify({ agent: 'other-agent', task_id: taskId, token: 'tok', claimed_at: new Date().toISOString(), ttl_ms: 10000 }),
      'utf8'
    );

    const result = await claimMessage(inboxDir, filename, 'claude-code');
    assert.strictEqual(result, null, 'Should back off when another agent has a fresh claim');
  });

  test('generateClaimFilename produces unique names with expected structure', () => {
    const a = generateClaimFilename();
    const b = generateClaimFilename();
    assert.notStrictEqual(a, b);
    assert.match(a, /--[0-9a-f-]{36}\.json$/);
  });
});
