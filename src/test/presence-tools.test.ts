import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext } from '../mcp/types';
import { RAW_WRITE_TOOLS } from '../mcp/writeTools';
import { READ_ONLY_TOOLS } from '../mcp/tools';
import { createInvite, readInvite, writeInvite } from '../fleet/invites';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return root;
}

function ctxFor(root: string): ToolContext {
  return {
    workspaceRoot: root,
    autoclawDir: path.join(root, '.autoclaw'),
    scope: 'workspace',
    host: 'test-agent',
    sessionId: 'sess-x',
  };
}

const beaconTool = RAW_WRITE_TOOLS.find(t => t.definition.name === 'presence.beacon')!;
const fleetTool = READ_ONLY_TOOLS.find(t => t.definition.name === 'presence.fleet')!;

suite('presence.beacon + presence.fleet (FF-1)', () => {

  test('the two tools exist and are registered', () => {
    assert.ok(beaconTool, 'presence.beacon should be a write tool');
    assert.ok(fleetTool, 'presence.fleet should be a read tool');
  });

  test('presence.beacon writes a workspace beacon that presence.fleet reads back', async () => {
    const root = makeWorkspace();
    try {
      const ctx = ctxFor(root);
      const write = await beaconTool.run(ctx, {
        role: 'tester',
        agent_type: 'coder',
        current_task: 'joining the project',
        transports: ['mcp', 'fs'],
        card_url: 'http://localhost:42777/.well-known/agent.json',
        scope: 'workspace',
      });
      assert.strictEqual(write.ok, true);

      // The beacon file landed under the workspace comms tree.
      const beaconDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'beacons');
      const files = fs.readdirSync(beaconDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 1);

      // presence.fleet surfaces our beacon (find by agent_id, not by count —
      // the machine beacon dir may hold unrelated rows on a dev box).
      const read = await fleetTool.run(ctx, {});
      assert.strictEqual(read.ok, true);
      const rows = (read as { ok: true; data: Array<Record<string, unknown>> }).data;
      const mine = rows.find(r => r.agent_id === 'test-agent');
      assert.ok(mine, 'our beacon should appear in the fleet');
      assert.strictEqual(mine!.role, 'tester');
      assert.strictEqual(mine!.session_id, 'sess-x');
      assert.deepStrictEqual(mine!.transports, ['mcp', 'fs']);
      assert.strictEqual(mine!.origin, 'beacon');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('presence.beacon can consume an invite token while checking in', async () => {
    const root = makeWorkspace();
    try {
      const ctx = ctxFor(root);
      const commsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms');
      const inv = await createInvite({
        issued_by: 'host',
        project: 'demo',
        workspace: root,
        suggested_role: 'coder',
        suggested_agent_type: 'coder',
        token: 'join-presence-1',
      }, { homeDir: root });
      await writeInvite(inv, { scope: 'workspace', commsDir, homeDir: root });

      const write = await beaconTool.run(ctx, {
        agent_id: 'codex',
        role: 'coder',
        agent_type: 'coder',
        invite_token: 'join-presence-1',
        scope: 'workspace',
      });
      assert.strictEqual(write.ok, true);

      const workspace = await readInvite('join-presence-1', { scope: 'workspace', commsDir });
      assert.strictEqual(workspace?.consumed_by?.agent_id, 'codex');
      assert.strictEqual(workspace?.consumed_by?.session_id, 'sess-x');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the host stamps host + session_id (caller cannot spoof identity)', async () => {
    const root = makeWorkspace();
    try {
      const ctx = ctxFor(root);
      // Caller tries to claim a different agent_id; host still stamps host=ctx.host.
      const write = await beaconTool.run(ctx, { agent_id: 'pretend-other', scope: 'workspace' });
      assert.strictEqual(write.ok, true);
      const rows = (await fleetTool.run(ctx, {}) as { ok: true; data: Array<Record<string, unknown>> }).data;
      const mine = rows.find(r => r.agent_id === 'pretend-other');
      assert.ok(mine);
      // host is the trusted caller host, not anything the caller supplied.
      assert.strictEqual(mine!.host, 'test-agent');
      assert.strictEqual(mine!.session_id, 'sess-x');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
