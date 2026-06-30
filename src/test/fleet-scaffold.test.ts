/**
 * fleet-scaffold.test.ts — unit tests for src/fleet/scaffold.ts (Slice C).
 *
 * Verifies the newcomer scaffolder: idempotent dir creation, a registry row
 * added once (never duplicated), tolerance of a pre-existing comms tree /
 * registry, the keepalive profile mapping (codex → codex.md, unknown → by-id
 * convention), and that the bootstrap file is written but not clobbered.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  scaffoldAgent,
  keepaliveProfileFor,
  KEEPALIVE_PROFILES,
} from '../fleet/scaffold';
import { readRegistry, writeRegistry } from '../comms';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-scaffold-'));
}

/** The comms root the scaffolder operates on. */
function commsRootIn(base: string): string {
  return path.join(base, '.autoclaw', 'orchestrator', 'comms');
}

suite('fleet/scaffold — keepalive profile mapping', () => {
  test('codex maps to cli-headless + codex.md', () => {
    const kp = keepaliveProfileFor('codex');
    assert.strictEqual(kp.loop_mechanism, 'cli-headless');
    assert.strictEqual(kp.keepalive_template, 'templates/keepalive/codex.md');
  });

  test('hermes/openclaw/autogpt map to bridge-relayed', () => {
    for (const id of ['hermes', 'openclaw', 'autogpt']) {
      assert.strictEqual(keepaliveProfileFor(id).loop_mechanism, 'bridge-relayed', id);
    }
  });

  test('claude-code maps to slash-loop', () => {
    assert.strictEqual(keepaliveProfileFor('claude-code').loop_mechanism, 'slash-loop');
  });

  test('every shipped runner id has a profile + by-id template path', () => {
    for (const [id, kp] of Object.entries(KEEPALIVE_PROFILES)) {
      assert.ok(kp.keepalive_template.startsWith('templates/keepalive/'), id);
    }
  });

  test('unknown agent id falls back to plain-message + by-id convention', () => {
    const kp = keepaliveProfileFor('some-new-bot');
    assert.strictEqual(kp.loop_mechanism, 'plain-message');
    assert.strictEqual(kp.keepalive_template, 'templates/keepalive/some-new-bot.md');
  });
});

suite('fleet/scaffold — scaffoldAgent', () => {
  test('creates the coordination tree, inbox tree (_state + processed), and bootstrap file', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    const res = await scaffoldAgent(commsRoot, { agentId: 'codex' });

    assert.ok(fs.existsSync(path.join(commsRoot, 'inboxes', 'codex')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'inboxes', 'codex', '_state')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'inboxes', 'codex', 'processed')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'inboxes', 'shared')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'heartbeats')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'beacons')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'claims')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'consensus', 'active')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'consensus', 'closed')));
    assert.ok(fs.existsSync(path.join(commsRoot, 'invites')));
    assert.ok(fs.existsSync(res.rulesPath));
    assert.ok(fs.existsSync(res.localProtocolPath));
    assert.strictEqual(res.registryRowAdded, true);
    assert.strictEqual(res.registryCreated, true);
    assert.strictEqual(res.keepalive.loop_mechanism, 'cli-headless');
  });

  test('bootstrap file gives a fallback contract when docs are absent', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    const res = await scaffoldAgent(commsRoot, { agentId: 'codex' });
    const body = fs.readFileSync(res.rulesPath, 'utf8');

    assert.ok(body.includes('docs/AGENT_SESSION_PROTOCOL.md when present'));
    assert.ok(body.includes('pasted join'));
    assert.ok(/Do not search outside the\s+workspace/.test(body));

    const protocol = fs.readFileSync(res.localProtocolPath, 'utf8');
    assert.ok(protocol.includes('AutoClaw Agent Session Protocol'));
    assert.ok(protocol.includes('REGISTER'));
    assert.ok(protocol.includes('board.json'));
  });

  test('creates a registry row carrying loop_mechanism + keepalive_template', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    await scaffoldAgent(commsRoot, { agentId: 'codex', name: 'Codex', agentType: 'coder' });

    const reg = await readRegistry(commsRoot);
    assert.ok(reg);
    const row = reg!.agents.find(a => a.id === 'codex') as Record<string, unknown> | undefined;
    assert.ok(row, 'codex row present');
    assert.strictEqual(row!.name, 'Codex');
    assert.strictEqual(row!.detected, true);
    assert.strictEqual(row!.inbox_path, '.autoclaw/orchestrator/comms/inboxes/codex/');
    assert.strictEqual(row!.loop_mechanism, 'cli-headless');
    assert.strictEqual(row!.keepalive_template, 'templates/keepalive/codex.md');
    assert.strictEqual(row!.agent_type, 'coder');
  });

  test('is idempotent — second call does not duplicate the registry row', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    const first = await scaffoldAgent(commsRoot, { agentId: 'hermes' });
    const second = await scaffoldAgent(commsRoot, { agentId: 'hermes' });

    assert.strictEqual(first.registryRowAdded, true);
    assert.strictEqual(second.registryRowAdded, false);

    const reg = await readRegistry(commsRoot);
    const hermesRows = reg!.agents.filter(a => a.id === 'hermes');
    assert.strictEqual(hermesRows.length, 1, 'exactly one hermes row');
  });

  test('tolerates a pre-existing comms tree + registry with other agents', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    // Pre-seed a registry with two existing agents + their inboxes.
    fs.mkdirSync(path.join(commsRoot, 'inboxes', 'claude-code'), { recursive: true });
    fs.mkdirSync(path.join(commsRoot, 'inboxes', 'kilocode'), { recursive: true });
    fs.mkdirSync(path.join(commsRoot, 'heartbeats'), { recursive: true });
    await writeRegistry(commsRoot, {
      agents: [
        { id: 'claude-code', name: 'Claude Code', extension_id: 'Anthropic.claude-code', detected: true, inbox_path: '.autoclaw/orchestrator/comms/inboxes/claude-code/', hooks_supported: false, last_heartbeat: null, status: 'detected' },
        { id: 'kilocode', name: 'Kilo Code', extension_id: 'kilocode.kilo-code', detected: true, inbox_path: '.autoclaw/orchestrator/comms/inboxes/kilocode/', hooks_supported: false, last_heartbeat: null, status: 'detected' },
      ],
      ide: 'VS Code',
      provisioned_at: new Date().toISOString(),
    });

    const res = await scaffoldAgent(commsRoot, { agentId: 'codex' });
    assert.strictEqual(res.registryCreated, false);
    assert.strictEqual(res.registryRowAdded, true);

    const reg = await readRegistry(commsRoot);
    assert.strictEqual(reg!.agents.length, 3, 'codex appended to the two existing rows');
    assert.ok(reg!.agents.some(a => a.id === 'claude-code'));
    assert.ok(reg!.agents.some(a => a.id === 'kilocode'));
    assert.ok(reg!.agents.some(a => a.id === 'codex'));
  });

  test('does not overwrite a customised bootstrap file on re-scaffold', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    const res = await scaffoldAgent(commsRoot, { agentId: 'cursor' });
    fs.writeFileSync(res.rulesPath, 'CUSTOM CONTENT', 'utf8');

    await scaffoldAgent(commsRoot, { agentId: 'cursor' });
    assert.strictEqual(fs.readFileSync(res.rulesPath, 'utf8'), 'CUSTOM CONTENT');
  });

  test('refreshes keepalive fields on an existing row without duplicating', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    // Seed a stale row that lacks keepalive fields (as provisionCrossAgentComms writes).
    fs.mkdirSync(commsRoot, { recursive: true });
    await writeRegistry(commsRoot, {
      agents: [
        { id: 'codex', name: 'Codex', extension_id: null, detected: true, inbox_path: '.autoclaw/orchestrator/comms/inboxes/codex/', hooks_supported: false, last_heartbeat: null, status: 'detected' },
      ],
      ide: 'unknown',
      provisioned_at: new Date().toISOString(),
    });

    await scaffoldAgent(commsRoot, { agentId: 'codex' });
    const reg = await readRegistry(commsRoot);
    const rows = reg!.agents.filter(a => a.id === 'codex');
    assert.strictEqual(rows.length, 1);
    const row = rows[0] as unknown as Record<string, unknown>;
    assert.strictEqual(row.keepalive_template, 'templates/keepalive/codex.md');
    assert.strictEqual(row.loop_mechanism, 'cli-headless');
  });

  test('rejects an agentId containing a path separator', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    await assert.rejects(
      () => scaffoldAgent(commsRoot, { agentId: '../evil' }),
      /invalid agentId/,
    );
  });

  test('rejects an empty agentId', async () => {
    const base = makeTmpDir();
    const commsRoot = commsRootIn(base);
    await assert.rejects(
      () => scaffoldAgent(commsRoot, { agentId: '   ' }),
      /agentId is required/,
    );
  });
});
