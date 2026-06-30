import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createInvite, readInvite, listInvites, consumeInvite, revokeInvite,
  admitDecision, isExpired, isValidInvite, machineInviteDir,
  INVITE_TTL_MS, Invite,
} from '../fleet/invites';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'invites-test-'));
}

const T0 = Date.parse('2026-06-16T00:00:00.000Z');

function baseInput(over = {}) {
  return {
    issued_by: 'claude-code',
    project: 'autoclaw',
    workspace: '/workspace/autoclaw',
    suggested_role: 'tester',
    suggested_agent_type: 'coder',
    scope: ['src/test/**'],
    token: 'join-fixed-1',
    ...over,
  };
}

suite('Invite tokens (FF-2)', () => {

  test('createInvite persists with defaults (trust off, auto-preapproved, unconsumed)', async () => {
    const home = makeTmpHome();
    const inv = await createInvite(baseInput(), { homeDir: home, now: T0 });
    assert.strictEqual(inv.trust, 'off');
    assert.strictEqual(inv.admit_policy, 'auto-preapproved');
    assert.strictEqual(inv.consumed_by, null);
    assert.strictEqual(inv.expires, new Date(T0 + INVITE_TTL_MS).toISOString());

    // It's on disk and reads back.
    const file = path.join(machineInviteDir(home), 'join-fixed-1.json');
    assert.ok(fs.existsSync(file));
    const back = await readInvite('join-fixed-1', { homeDir: home });
    assert.ok(back && back.token === 'join-fixed-1');
  });

  test('consumeInvite is single-use — second consume rejected', async () => {
    const home = makeTmpHome();
    await createInvite(baseInput(), { homeDir: home, now: T0 });

    const first = await consumeInvite('join-fixed-1', { agent_id: 'hermes', session_id: 's1' }, { homeDir: home, now: T0 + 1000 });
    assert.strictEqual(first.ok, true);
    assert.ok(first.ok && first.invite.consumed_by?.agent_id === 'hermes');

    const second = await consumeInvite('join-fixed-1', { agent_id: 'openclaw' }, { homeDir: home, now: T0 + 2000 });
    assert.strictEqual(second.ok, false);
    assert.ok(!second.ok && second.reason === 'already_consumed');
  });

  test('consumeInvite rejects an expired token', async () => {
    const home = makeTmpHome();
    await createInvite(baseInput({ ttlMs: 1000 }), { homeDir: home, now: T0 });
    const res = await consumeInvite('join-fixed-1', { agent_id: 'hermes' }, { homeDir: home, now: T0 + 5000 });
    assert.strictEqual(res.ok, false);
    assert.ok(!res.ok && res.reason === 'expired');
  });

  test('consumeInvite rejects an unknown token', async () => {
    const home = makeTmpHome();
    const res = await consumeInvite('nope', { agent_id: 'hermes' }, { homeDir: home, now: T0 });
    assert.strictEqual(res.ok, false);
    assert.ok(!res.ok && res.reason === 'not_found');
  });

  test('revokeInvite removes the token', async () => {
    const home = makeTmpHome();
    await createInvite(baseInput(), { homeDir: home, now: T0 });
    assert.strictEqual(await revokeInvite('join-fixed-1', { homeDir: home }), true);
    assert.strictEqual(await readInvite('join-fixed-1', { homeDir: home }), null);
    // Revoking again is a no-op false.
    assert.strictEqual(await revokeInvite('join-fixed-1', { homeDir: home }), false);
  });

  test('listInvites returns all persisted invites', async () => {
    const home = makeTmpHome();
    await createInvite(baseInput({ token: 'a' }), { homeDir: home, now: T0 });
    await createInvite(baseInput({ token: 'b' }), { homeDir: home, now: T0 });
    const all = await listInvites({ homeDir: home });
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map(i => i.token).sort(), ['a', 'b']);
  });

  test('admitDecision matrix (open / auto-preapproved match+miss / manual)', () => {
    const mk = (over: Partial<Invite>): Invite => ({
      token: 't', issued_by: 'x', project: 'p', trust: 'off',
      admit_policy: 'manual', issued_at: '', expires: '', consumed_by: null,
      ...over,
    });

    assert.strictEqual(admitDecision(mk({ admit_policy: 'open' }), 'coder').admit, true);

    const pre = mk({ admit_policy: 'auto-preapproved', preapproved_types: ['tester', 'coder'] });
    assert.strictEqual(admitDecision(pre, 'coder').admit, true);
    assert.strictEqual(admitDecision(pre, 'auditor').admit, false);
    assert.strictEqual(admitDecision(pre, undefined).admit, false);

    assert.strictEqual(admitDecision(mk({ admit_policy: 'manual' }), 'coder').admit, false);
  });

  test('isExpired + isValidInvite guards', () => {
    const inv = { token: 't', project: 'p', expires: new Date(T0 + 1000).toISOString() } as Invite;
    assert.strictEqual(isValidInvite(inv), true);
    assert.strictEqual(isValidInvite({ token: 't' }), false);
    assert.strictEqual(isExpired(inv, T0), false);
    assert.strictEqual(isExpired(inv, T0 + 5000), true);
  });

  test('workspace scope writes under the comms tree', async () => {
    const home = makeTmpHome();
    const commsDir = path.join(home, 'ws', '.autoclaw', 'orchestrator', 'comms');
    await createInvite(baseInput(), { scope: 'workspace', commsDir, now: T0 });
    assert.ok(fs.existsSync(path.join(commsDir, 'invites', 'join-fixed-1.json')));
    const back = await readInvite('join-fixed-1', { scope: 'workspace', commsDir });
    assert.ok(back && back.token === 'join-fixed-1');
  });
});
