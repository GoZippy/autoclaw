/**
 * chatInjector.test.ts — generic ChatInjector (DESIGN.md Gap E).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  selectInjector,
  OutboxChatInjector,
  HostChatInjector,
  type HostChatPoster,
} from '../bridge/chatInjector';

const NOW = new Date('2026-06-14T20:00:00.000Z');

suite('ChatInjector — cli-headless (outbox)', () => {
  test('writes outbox message + ready flag', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-inject-'));
    const injector = new OutboxChatInjector({ commsRoot: root, now: () => NOW });
    const res = await injector.inject({ agentId: 'claude-code', text: 'do task-8', msgId: 'm1' });

    assert.strictEqual(res.delivered, true);
    assert.strictEqual(res.method, 'outbox');
    const outbox = path.join(root, 'outboxes', 'claude-code', 'm1.json');
    const ready = path.join(root, 'agents', 'claude-code', 'ready');
    assert.ok(fs.existsSync(outbox));
    assert.ok(fs.existsSync(ready));
    const msg = JSON.parse(fs.readFileSync(outbox, 'utf8'));
    assert.strictEqual(msg.text, 'do task-8');
    assert.strictEqual(msg.id, 'm1');
  });

  test('selectInjector returns OutboxChatInjector for cli-headless', () => {
    const inj = selectInjector('cli-headless', { commsRoot: '/tmp/x' });
    assert.strictEqual(inj.mechanism, 'cli-headless');
  });
});

suite('ChatInjector — plain-message / slash-loop (host post)', () => {
  test('posts to host chat when poster succeeds', async () => {
    const posted: string[] = [];
    const poster: HostChatPoster = { async post(t) { posted.push(t); } };
    const inj = new HostChatInjector({ mechanism: 'plain-message', poster });
    const res = await inj.inject({ agentId: 'kilocode', text: 'continue' });
    assert.strictEqual(res.delivered, true);
    assert.strictEqual(res.method, 'host-chat');
    assert.deepStrictEqual(posted, ['continue']);
  });

  test('slash-loop wraps text as /loop continuation', async () => {
    const posted: string[] = [];
    const poster: HostChatPoster = { async post(t) { posted.push(t); } };
    const inj = new HostChatInjector({ mechanism: 'slash-loop', poster });
    await inj.inject({ agentId: 'claude-code', text: 'resume' });
    assert.deepStrictEqual(posted, ['/loop resume']);
  });

  test('falls back to manual-paste with rendered prompt when poster throws', async () => {
    const poster: HostChatPoster = { async post() { throw new Error('no host'); } };
    const inj = new HostChatInjector({ mechanism: 'plain-message', poster });
    const res = await inj.inject({ agentId: 'kiro', text: 'wake up' });
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.method, 'manual-paste');
    assert.strictEqual(res.prompt, 'wake up');
  });

  test('selectInjector wires an injected poster for plain-message', async () => {
    const posted: string[] = [];
    const inj = selectInjector('plain-message', { commsRoot: '/tmp/x', poster: { async post(t) { posted.push(t); } }, agentId: 'kilocode' });
    const res = await inj.inject({ agentId: 'kilocode', text: 'hi' });
    assert.strictEqual(res.delivered, true);
    assert.deepStrictEqual(posted, ['hi']);
  });
});
