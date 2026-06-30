/**
 * mcp.test.ts — Unit tests for the `autoclaw-mcp` server (BP1).
 *
 * Exercises JSON-RPC dispatch, the read-only tool suite, and the cost ledger
 * against a temp workspace. Pure file-I/O — no host, no network.
 *
 * Sprint 2 — BP1 (WA-3)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildContext,
  buildToolMap,
  dispatch,
  resolveAutoclawDir,
  CostLedger,
  hashArgs,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  activeTools,
  checkWriteGate,
  installAll,
  mergeRegistryFile,
  mergeTomlRegistryFile,
  parseTomlAutoclawEntry,
  buildServerEntry,
  serverEntriesEqual,
  type JsonRpcRequest,
  type ToolContext,
} from '../mcp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-mcp-'));
  const autoclaw = path.join(root, '.autoclaw');
  const orch = path.join(autoclaw, 'orchestrator');
  const comms = path.join(orch, 'comms');
  fs.mkdirSync(path.join(comms, 'heartbeats'), { recursive: true });
  fs.mkdirSync(path.join(comms, 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(comms, 'inboxes', 'claude-code', '_state'), { recursive: true });
  fs.mkdirSync(path.join(autoclaw, 'dream'), { recursive: true });

  fs.writeFileSync(
    path.join(orch, 'state.json'),
    JSON.stringify({
      project: 'test-proj',
      current_sprint: 2,
      tasks_total: 10,
      tasks_complete: 4,
      agents: {
        'claude-code': { status: 'assigned', sprint: 2, tasks: ['BP1'], last_heartbeat: '2026-05-21T00:00:00Z' },
      },
      sprint_statuses: { '2': 'assigned' },
    })
  );

  // Fresh heartbeat → 'working'.
  fs.writeFileSync(
    path.join(comms, 'heartbeats', 'claude-code.json'),
    JSON.stringify({
      agent_id: 'claude-code',
      timestamp: new Date().toISOString(),
      status: 'active',
      current_task: 'BP1',
      sprint: 2,
      session_id: 'sess-1',
      current_llm: 'claude',
    })
  );

  // Inbox message + unread state.
  fs.writeFileSync(
    path.join(comms, 'inboxes', 'claude-code', 'msg-1.json'),
    JSON.stringify({
      id: 'msg-1',
      from: 'kilocode',
      to: 'claude-code',
      type: 'question',
      timestamp: '2026-05-21T01:00:00Z',
      requires_response: true,
      payload: {},
    })
  );

  fs.writeFileSync(
    path.join(autoclaw, 'dream', 'MEMORY.md'),
    '# Memory\n- AutoClaw publishes to the VS Code Marketplace\n- The orchestrator uses a file-based bus\n'
  );

  return root;
}

function ctxFor(root: string): ToolContext {
  return buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace', AUTOCLAW_MCP_HOST: 'test' }, root);
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// resolveAutoclawDir / buildContext
// ---------------------------------------------------------------------------

suite('MCP — context resolution', () => {
  test('resolveAutoclawDir finds .autoclaw walking up from a subdir', () => {
    const root = makeWorkspace();
    try {
      const sub = path.join(root, 'src', 'deep');
      fs.mkdirSync(sub, { recursive: true });
      assert.strictEqual(resolveAutoclawDir(sub), path.join(root, '.autoclaw'));
    } finally {
      rmrf(root);
    }
  });

  test('buildContext: workspace scope from env, read-only by default', () => {
    const root = makeWorkspace();
    try {
      assert.strictEqual(ctxFor(root).scope, 'workspace');
      assert.strictEqual(buildContext({}, root).scope, 'global');
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

suite('MCP — JSON-RPC dispatch', () => {
  function harness(root: string) {
    const ctx = ctxFor(root);
    const ledger = new CostLedger(ctx.autoclawDir);
    return { ctx, ledger, toolMap: buildToolMap(READ_ONLY_TOOLS) };
  }

  test('initialize returns protocol version + serverInfo', async () => {
    const root = makeWorkspace();
    try {
      const { ctx, ledger, toolMap } = harness(root);
      const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'initialize' };
      const resp = await dispatch(req, ctx, toolMap, ledger);
      assert.ok(resp);
      const result = resp!.result as { serverInfo: { name: string } };
      assert.strictEqual(result.serverInfo.name, 'autoclaw-mcp');
    } finally {
      rmrf(root);
    }
  });

  test('tools/list returns all read-only tools (incl. kg.* readers + presence.fleet)', async () => {
    const root = makeWorkspace();
    try {
      const { ctx, ledger, toolMap } = harness(root);
      const resp = await dispatch(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ctx, toolMap, ledger
      );
      const result = resp!.result as { tools: Array<{ name: string }> };
      const names = result.tools.map(t => t.name).sort();
      assert.deepStrictEqual(names, [
        'doctor.run', 'fabric.route', 'fleet.brief', 'fleet.cards', 'fleet.digest', 'fleet.status',
        'inbox.read', 'intelligence.contextPack', 'intelligence.retrieve', 'kg.search', 'kg.traverse', 'presence.fleet', 'recall.query', 'todo.list',
      ]);
    } finally {
      rmrf(root);
    }
  });

  test('notification (no id) yields no response', async () => {
    const root = makeWorkspace();
    try {
      const { ctx, ledger, toolMap } = harness(root);
      const resp = await dispatch(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        ctx, toolMap, ledger
      );
      assert.strictEqual(resp, null);
    } finally {
      rmrf(root);
    }
  });

  test('unknown method returns METHOD_NOT_FOUND', async () => {
    const root = makeWorkspace();
    try {
      const { ctx, ledger, toolMap } = harness(root);
      const resp = await dispatch(
        { jsonrpc: '2.0', id: 9, method: 'bogus/method' },
        ctx, toolMap, ledger
      );
      assert.strictEqual(resp!.error?.code, -32601);
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Tools — via tools/call
// ---------------------------------------------------------------------------

suite('MCP — read-only tools', () => {
  async function callTool(root: string, name: string, args: Record<string, unknown> = {}) {
    const ctx = ctxFor(root);
    const ledger = new CostLedger(ctx.autoclawDir);
    const toolMap = buildToolMap(READ_ONLY_TOOLS);
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      ctx, toolMap, ledger
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0].text) as { ok: boolean; data?: unknown; reason?: string },
    };
  }

  test('fleet.status derives working status from a fresh heartbeat', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'fleet.status');
      assert.strictEqual(payload.ok, true);
      const rows = payload.data as Array<{ agent: string; status: string }>;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].agent, 'claude-code');
      assert.strictEqual(rows[0].status, 'working');
    } finally {
      rmrf(root);
    }
  });

  test('fleet.status program scope is not_implemented', async () => {
    const root = makeWorkspace();
    try {
      const { payload, isError } = await callTool(root, 'fleet.status', { scope: 'program' });
      assert.strictEqual(payload.ok, false);
      assert.strictEqual(payload.reason, 'not_implemented');
      assert.strictEqual(isError, true);
    } finally {
      rmrf(root);
    }
  });

  test('fleet.cards merges heartbeat + orchestrator state', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'fleet.cards');
      assert.strictEqual(payload.ok, true);
      const cards = payload.data as Array<{ agent: string; assignedTasks: string[]; sprint: number }>;
      assert.strictEqual(cards[0].agent, 'claude-code');
      assert.deepStrictEqual(cards[0].assignedTasks, ['BP1']);
      assert.strictEqual(cards[0].sprint, 2);
    } finally {
      rmrf(root);
    }
  });

  test('inbox.read returns messages with state flags', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'inbox.read', { agent: 'claude-code' });
      assert.strictEqual(payload.ok, true);
      const data = payload.data as { count: number; messages: Array<{ id: string; read: boolean }> };
      assert.strictEqual(data.count, 1);
      assert.strictEqual(data.messages[0].id, 'msg-1');
      assert.strictEqual(data.messages[0].read, false);
    } finally {
      rmrf(root);
    }
  });

  test('inbox.read awaiting_me filters to unanswered requires_response', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'inbox.read', { agent: 'claude-code', awaiting_me: true });
      const data = payload.data as { count: number };
      assert.strictEqual(data.count, 1);
    } finally {
      rmrf(root);
    }
  });

  test('inbox.read on a missing inbox returns not_found', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'inbox.read', { agent: 'nobody' });
      assert.strictEqual(payload.ok, false);
      assert.strictEqual(payload.reason, 'not_found');
    } finally {
      rmrf(root);
    }
  });

  test('recall.query scores facts from MEMORY.md by token overlap', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'recall.query', { query: 'marketplace publishes' });
      assert.strictEqual(payload.ok, true);
      const hits = payload.data as Array<{ fact: string; score: number }>;
      assert.ok(hits.length >= 1);
      assert.ok(/marketplace/i.test(hits[0].fact));
    } finally {
      rmrf(root);
    }
  });

  test('recall.query archive tier is not_implemented', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'recall.query', { query: 'x', tier: 'archive' });
      assert.strictEqual(payload.reason, 'not_implemented');
    } finally {
      rmrf(root);
    }
  });

  test('recall.query missing query is invalid_params', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'recall.query', {});
      assert.strictEqual(payload.reason, 'invalid_params');
    } finally {
      rmrf(root);
    }
  });

  test('todo.list is not_implemented until the spider index exists', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'todo.list');
      assert.strictEqual(payload.ok, false);
      assert.strictEqual(payload.reason, 'not_implemented');
    } finally {
      rmrf(root);
    }
  });

  test('doctor.run reports passing checks for a healthy workspace', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callTool(root, 'doctor.run');
      assert.strictEqual(payload.ok, true);
      const report = payload.data as { ok: boolean; checks: Array<{ name: string; status: string }> };
      assert.strictEqual(report.ok, true);
      assert.ok(report.checks.some(c => c.name === 'orchestrator-state' && c.status === 'pass'));
    } finally {
      rmrf(root);
    }
  });

  test('tools/call on an unknown tool reports isError', async () => {
    const root = makeWorkspace();
    try {
      const { payload, isError } = await callTool(root, 'nonexistent.tool');
      assert.strictEqual(isError, true);
      assert.strictEqual(payload.ok, false);
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

suite('MCP — cost ledger', () => {
  test('hashArgs is deterministic and stable-length', () => {
    const a = hashArgs({ query: 'hello' });
    const b = hashArgs({ query: 'hello' });
    assert.strictEqual(a, b);
    assert.strictEqual(a.length, 16);
    assert.notStrictEqual(a, hashArgs({ query: 'world' }));
  });

  test('tools/call appends a cost-ledger row', async () => {
    const root = makeWorkspace();
    try {
      const ctx = ctxFor(root);
      const ledger = new CostLedger(ctx.autoclawDir);
      const toolMap = buildToolMap(READ_ONLY_TOOLS);
      await dispatch(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doctor.run', arguments: {} } },
        ctx, toolMap, ledger, {}
      );
      // Ledger writes are best-effort/async — poll briefly.
      let entries: Awaited<ReturnType<CostLedger['readRecent']>> = [];
      for (let i = 0; i < 20 && entries.length === 0; i++) {
        entries = await ledger.readRecent();
        if (entries.length === 0) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].tool, 'doctor.run');
      assert.strictEqual(entries[0].ok, true);
      assert.ok(entries[0].duration_ms >= 0);
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------------------
// BP3 — write-tool authorization gate
// ---------------------------------------------------------------------------

suite('MCP — write-tool gate (BP3)', () => {
  /** Dispatch a tools/call with an explicit env so the gate is deterministic. */
  async function callWith(
    root: string,
    name: string,
    args: Record<string, unknown>,
    env: NodeJS.ProcessEnv
  ) {
    // The write-tool gate in production reads process.env, not the caller's env.
    // For testing, when AUTOCLAW_MCP_ALLOW_WRITES is set in the test env,
    // also write it to .autoclaw/mcp/config.json so the gate can read it.
    if (env.AUTOCLAW_MCP_ALLOW_WRITES) {
      const cfgDir = path.join(root, '.autoclaw', 'mcp');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, 'config.json'),
        JSON.stringify({ allowWrites: true }, null, 2),
        'utf8'
      );
    }
    const ctx = buildContext(env, root);
    const ledger = new CostLedger(ctx.autoclawDir);
    // Use activeTools so write tools are included when allowWrites is set.
    const toolMap = buildToolMap(activeTools(ctx, env));
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      ctx, toolMap, ledger, env
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0].text) as {
        ok: boolean; data?: unknown; reason?: string;
      },
    };
  }

  test('checkWriteGate denies a global-scope context', () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({}, root); // no scope ⇒ global
      const decision = checkWriteGate(ctx, {});
      assert.strictEqual(decision.allowed, false);
    } finally {
      rmrf(root);
    }
  });

  test('checkWriteGate denies workspace scope with allowWrites off', () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      assert.strictEqual(checkWriteGate(ctx, {}).allowed, false);
    } finally {
      rmrf(root);
    }
  });

  test('checkWriteGate allows workspace scope + AUTOCLAW_MCP_ALLOW_WRITES', () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      const decision = checkWriteGate(ctx, { AUTOCLAW_MCP_ALLOW_WRITES: 'true' });
      assert.strictEqual(decision.allowed, true);
    } finally {
      rmrf(root);
    }
  });

  test('checkWriteGate reads allowWrites from .autoclaw/mcp/config.json', () => {
    const root = makeWorkspace();
    try {
      const cfgDir = path.join(root, '.autoclaw', 'mcp');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ allowWrites: true }));
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      assert.strictEqual(checkWriteGate(ctx, {}).allowed, true);
    } finally {
      rmrf(root);
    }
  });

  test('activeTools hides write tools when the gate is shut', () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      assert.strictEqual(activeTools(ctx, {}).length, READ_ONLY_TOOLS.length);
    } finally {
      rmrf(root);
    }
  });

  test('activeTools exposes write tools when the gate is open', () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      const tools = activeTools(ctx, { AUTOCLAW_MCP_ALLOW_WRITES: 'true' });
      const names = tools.map(t => t.definition.name);
      assert.ok(names.includes('note.add'));
      assert.ok(names.includes('claim.task'));
      assert.ok(names.includes('llm.chat'), 'PA-5 llm.chat exposed');
      assert.ok(names.includes('invite.consume'), 'join invite consumption exposed');
      assert.ok(names.includes('presence.beacon'), 'FF-1 presence.beacon exposed');
      assert.ok(names.includes('kg.record'), 'KGC-4 kg.record exposed');
      // 6 original write tools + invite.consume/presence.beacon + 3 PA-5 llm.* tools + 2 KGC-4 kg.* write tools.
      assert.strictEqual(tools.length, READ_ONLY_TOOLS.length + 13);
    } finally {
      rmrf(root);
    }
  });

  test('tools/list omits write tools without allowWrites', async () => {
    const root = makeWorkspace();
    try {
      const ctx = buildContext({ AUTOCLAW_MCP_SCOPE: 'workspace' }, root);
      const ledger = new CostLedger(ctx.autoclawDir);
      const resp = await dispatch(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ctx, buildToolMap(READ_ONLY_TOOLS), ledger, {}
      );
      const result = resp!.result as { tools: Array<{ name: string }> };
      assert.ok(!result.tools.some(t => t.name === 'note.add'));
    } finally {
      rmrf(root);
    }
  });

  test('tools/list includes write tools with allowWrites', async () => {
    const root = makeWorkspace();
    try {
      const env = { AUTOCLAW_MCP_SCOPE: 'workspace', AUTOCLAW_MCP_ALLOW_WRITES: 'true' };
      const ctx = buildContext(env, root);
      const ledger = new CostLedger(ctx.autoclawDir);
      const resp = await dispatch(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ctx, buildToolMap(activeTools(ctx, env)), ledger, env
      );
      const result = resp!.result as { tools: Array<{ name: string }> };
      const names = result.tools.map(t => t.name);
      assert.ok(names.includes('note.add'));
      assert.ok(names.includes('consensus.vote'));
    } finally {
      rmrf(root);
    }
  });

  test('calling note.add without writes enabled reports not_found (gated out)', async () => {
    const root = makeWorkspace();
    try {
      const { payload, isError } = await callWith(
        root, 'note.add', { text: 'hello' },
        { AUTOCLAW_MCP_SCOPE: 'workspace' } // allowWrites off
      );
      // Write tools are not in the dispatch map ⇒ unknown tool.
      assert.strictEqual(isError, true);
      assert.strictEqual(payload.ok, false);
      assert.strictEqual(payload.reason, 'not_found');
    } finally {
      rmrf(root);
    }
  });

  test('note.add appends to MEMORY.md and a ledger row when enabled', async () => {
    const root = makeWorkspace();
    try {
      const { payload } = await callWith(
        root, 'note.add', { text: 'ship the MCP write tools', tags: ['bp3'] },
        { AUTOCLAW_MCP_SCOPE: 'workspace', AUTOCLAW_MCP_ALLOW_WRITES: 'true', AUTOCLAW_MCP_HOST: 'test' }
      );
      assert.strictEqual(payload.ok, true);
      const memory = fs.readFileSync(
        path.join(root, '.autoclaw', 'dream', 'MEMORY.md'), 'utf8'
      );
      assert.ok(/ship the MCP write tools/.test(memory));
      assert.ok(/## Follow-ups/.test(memory));
      // Ledger row recorded under the returned id.
      const id = (payload.data as { id: string }).id;
      const state = JSON.parse(
        fs.readFileSync(path.join(root, '.autoclaw', 'orchestrator', 'state.json'), 'utf8')
      ) as { message_ledger: Record<string, { type: string }> };
      assert.strictEqual(state.message_ledger[id].type, 'note_add');
    } finally {
      rmrf(root);
    }
  });

  test('claim.task uses create-exclusive semantics — second claim conflicts', async () => {
    const root = makeWorkspace();
    try {
      const env = {
        AUTOCLAW_MCP_SCOPE: 'workspace', AUTOCLAW_MCP_ALLOW_WRITES: 'true', AUTOCLAW_MCP_HOST: 'test',
      };
      const first = await callWith(root, 'claim.task', { task_id: 'BX1' }, env);
      assert.strictEqual(first.payload.ok, true);
      const second = await callWith(root, 'claim.task', { task_id: 'BX1' }, env);
      assert.strictEqual(second.payload.ok, false);
      assert.strictEqual(second.payload.reason, 'conflict');
    } finally {
      rmrf(root);
    }
  });

  test('inbox.send is idempotent on a repeated client_id', async () => {
    const root = makeWorkspace();
    try {
      const env = {
        AUTOCLAW_MCP_SCOPE: 'workspace', AUTOCLAW_MCP_ALLOW_WRITES: 'true', AUTOCLAW_MCP_HOST: 'test',
      };
      const a = await callWith(
        root, 'inbox.send',
        { to: 'shared', type: 'question', body: { q: 'hi' }, client_id: 'c-1' }, env
      );
      const b = await callWith(
        root, 'inbox.send',
        { to: 'shared', type: 'question', body: { q: 'hi' }, client_id: 'c-1' }, env
      );
      assert.strictEqual(a.payload.ok, true);
      assert.strictEqual(b.payload.ok, true);
      assert.strictEqual((b.payload.data as { deduped?: boolean }).deduped, true);
      assert.strictEqual(
        (a.payload.data as { id: string }).id, (b.payload.data as { id: string }).id
      );
    } finally {
      rmrf(root);
    }
  });
});

// ---------------------------------------------------------------------------
// BP2 — `autoclaw mcp install`
// ---------------------------------------------------------------------------

suite('MCP — install (BP2)', () => {
  /** A fake $HOME with selected host config dirs pre-created. */
  function fakeHome(hostDirs: string[]): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-home-'));
    for (const d of hostDirs) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    return home;
  }

  test('serverEntriesEqual: structural, order-insensitive', () => {
    const a = buildServerEntry('/x/server.js', 'workspace');
    const b = buildServerEntry('/x/server.js', 'workspace');
    assert.strictEqual(serverEntriesEqual(a, b), true);
    assert.strictEqual(serverEntriesEqual(a, buildServerEntry('/y/server.js', 'workspace')), false);
    assert.strictEqual(serverEntriesEqual(undefined, b), false);
  });

  test('mergeRegistryFile: adds, then is idempotent (unchanged)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-reg-'));
    try {
      const file = path.join(root, 'mcp.json');
      const entry = buildServerEntry('/abs/server.js', 'workspace');

      const first = await mergeRegistryFile(file, entry, { force: false });
      assert.strictEqual(first.outcome, 'added');

      const second = await mergeRegistryFile(file, entry, { force: false });
      assert.strictEqual(second.outcome, 'unchanged');

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(doc.mcpServers.autoclaw, entry);
    } finally {
      rmrf(root);
    }
  });

  test('mergeRegistryFile: preserves other servers and unknown keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-reg-'));
    try {
      const file = path.join(root, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({
        theme: 'dark',
        mcpServers: { other: { command: 'foo', args: [] } },
      }));
      const entry = buildServerEntry('/abs/server.js', 'workspace');
      await mergeRegistryFile(file, entry, { force: false });
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(doc.theme, 'dark');
      assert.ok(doc.mcpServers.other);
      assert.ok(doc.mcpServers.autoclaw);
    } finally {
      rmrf(root);
    }
  });

  test('mergeRegistryFile: differing entry needs --force', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-reg-'));
    try {
      const file = path.join(root, 'mcp.json');
      await mergeRegistryFile(file, buildServerEntry('/old/server.js', 'workspace'), { force: false });
      const newEntry = buildServerEntry('/new/server.js', 'workspace');

      const blocked = await mergeRegistryFile(file, newEntry, { force: false });
      assert.strictEqual(blocked.outcome, 'error');

      const forced = await mergeRegistryFile(file, newEntry, { force: true });
      assert.strictEqual(forced.outcome, 'updated');
    } finally {
      rmrf(root);
    }
  });

  test('installAll: detects hosts by config dir and is idempotent', async () => {
    const home = fakeHome(['.claude', '.cursor']);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ws-'));
    try {
      const opts = {
        scope: 'workspace' as const,
        home,
        workspaceRoot: ws,
        env: { PATH: '' }, // no CLIs on PATH — detection via config dirs only
        serverPath: '/abs/out/mcp/server.js',
        // Kiro CLI not present in this fake env.
        kiroAdd: async () => ({ ok: false, detail: 'kiro-cli not found' }),
      };

      const first = await installAll(opts);
      const claude = first.find(r => r.host === 'claude-code')!;
      const cursor = first.find(r => r.host === 'cursor')!;
      const windsurf = first.find(r => r.host === 'windsurf')!;
      assert.strictEqual(claude.outcome, 'added');
      assert.strictEqual(cursor.outcome, 'added');
      assert.strictEqual(windsurf.outcome, 'not-installed');

      // Re-run — every previously-added host is now `unchanged`.
      const second = await installAll(opts);
      assert.strictEqual(second.find(r => r.host === 'claude-code')!.outcome, 'unchanged');
      assert.strictEqual(second.find(r => r.host === 'cursor')!.outcome, 'unchanged');
    } finally {
      rmrf(home);
      rmrf(ws);
    }
  });

  test('installAll: Kiro goes through kiro-cli, never a file edit', async () => {
    const home = fakeHome(['.kiro']);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ws-'));
    try {
      let kiroArgs: string[] = [];
      const results = await installAll({
        scope: 'workspace',
        home,
        workspaceRoot: ws,
        env: { PATH: '' },
        serverPath: '/abs/out/mcp/server.js',
        kiroAdd: async args => { kiroArgs = args; return { ok: true, detail: 'via kiro-cli mcp add' }; },
      });
      const kiro = results.find(r => r.host === 'kiro')!;
      assert.strictEqual(kiro.outcome, 'added');
      assert.strictEqual(kiro.path, ''); // no file path — CLI-managed
      assert.ok(kiroArgs.includes('mcp') && kiroArgs.includes('add'));
      assert.ok(kiroArgs.includes('autoclaw'));
    } finally {
      rmrf(home);
      rmrf(ws);
    }
  });

  // -------------------------------------------------------------------------
  // Codex — TOML registry (~/.codex/config.toml)
  // -------------------------------------------------------------------------

  test('mergeTomlRegistryFile: adds a [mcp_servers.autoclaw] table, then idempotent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-toml-'));
    try {
      const file = path.join(root, 'config.toml');
      const entry = buildServerEntry('/abs/out/mcp/server.js', 'workspace');

      const first = await mergeTomlRegistryFile(file, entry, { force: false });
      assert.strictEqual(first.outcome, 'added');

      const text = fs.readFileSync(file, 'utf8');
      assert.ok(/\[mcp_servers\.autoclaw\]/.test(text));
      assert.ok(/command = 'node'/.test(text));
      assert.ok(/\[mcp_servers\.autoclaw\.env\]/.test(text));
      assert.ok(/AUTOCLAW_MCP_SCOPE = 'workspace'/.test(text));

      // Round-trips back to the same entry.
      assert.ok(serverEntriesEqual(parseTomlAutoclawEntry(text) ?? undefined, entry));

      const second = await mergeTomlRegistryFile(file, entry, { force: false });
      assert.strictEqual(second.outcome, 'unchanged');
    } finally {
      rmrf(root);
    }
  });

  test('mergeTomlRegistryFile: preserves other tables, keys, and comments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-toml-'));
    try {
      const file = path.join(root, 'config.toml');
      fs.writeFileSync(
        file,
        [
          '# my codex config',
          'model = "o4-mini"',
          '',
          '[mcp_servers.other]',
          "command = 'python'",
          "args = ['server.py']",
          '',
        ].join('\n'),
        'utf8'
      );
      const entry = buildServerEntry('/abs/out/mcp/server.js', 'workspace');
      const res = await mergeTomlRegistryFile(file, entry, { force: false });
      assert.strictEqual(res.outcome, 'added');

      const text = fs.readFileSync(file, 'utf8');
      assert.ok(/# my codex config/.test(text), 'comment preserved');
      assert.ok(/model = "o4-mini"/.test(text), 'top-level key preserved');
      assert.ok(/\[mcp_servers\.other\]/.test(text), 'other server preserved');
      assert.ok(/\[mcp_servers\.autoclaw\]/.test(text), 'autoclaw table added');
    } finally {
      rmrf(root);
    }
  });

  test('mergeTomlRegistryFile: Windows backslash path stays verbatim (literal string)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-toml-'));
    try {
      const file = path.join(root, 'config.toml');
      const winPath = 'K:\\Projects\\autoclaw\\out\\mcp\\server.js';
      const entry = buildServerEntry(winPath, 'workspace');
      await mergeTomlRegistryFile(file, entry, { force: false });

      const text = fs.readFileSync(file, 'utf8');
      // Literal string ⇒ no backslash doubling; parses back to the exact path.
      assert.ok(text.includes(`args = ['${winPath}']`));
      assert.deepStrictEqual(parseTomlAutoclawEntry(text)!.args, [winPath]);
    } finally {
      rmrf(root);
    }
  });

  test('mergeTomlRegistryFile: differing entry needs --force', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-toml-'));
    try {
      const file = path.join(root, 'config.toml');
      await mergeTomlRegistryFile(file, buildServerEntry('/old/server.js', 'workspace'), { force: false });
      const next = buildServerEntry('/new/server.js', 'workspace');

      const blocked = await mergeTomlRegistryFile(file, next, { force: false });
      assert.strictEqual(blocked.outcome, 'error');

      const forced = await mergeTomlRegistryFile(file, next, { force: true });
      assert.strictEqual(forced.outcome, 'updated');
      assert.ok(serverEntriesEqual(parseTomlAutoclawEntry(fs.readFileSync(file, 'utf8')) ?? undefined, next));
    } finally {
      rmrf(root);
    }
  });

  test('mergeTomlRegistryFile: refuses an unsupported inline autoclaw entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-toml-'));
    try {
      const file = path.join(root, 'config.toml');
      fs.writeFileSync(
        file,
        ['[mcp_servers]', "autoclaw = { command = 'node', args = ['x'] }", ''].join('\n'),
        'utf8'
      );
      const res = await mergeTomlRegistryFile(file, buildServerEntry('/abs/server.js', 'workspace'), {
        force: true,
      });
      assert.strictEqual(res.outcome, 'error');
      assert.ok(/inline/.test(res.detail));
    } finally {
      rmrf(root);
    }
  });

  test('installAll: detects Codex by config dir and writes its TOML registry', async () => {
    const home = fakeHome(['.codex']);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ws-'));
    try {
      const opts = {
        scope: 'workspace' as const,
        home,
        workspaceRoot: ws,
        env: { PATH: '' }, // detection via config dir only
        serverPath: '/abs/out/mcp/server.js',
        kiroAdd: async () => ({ ok: false, detail: 'kiro-cli not found' }),
      };

      const first = await installAll(opts);
      const codex = first.find(r => r.host === 'codex')!;
      assert.strictEqual(codex.outcome, 'added');
      assert.ok(codex.path.endsWith(path.join('.codex', 'config.toml')));
      assert.ok(/\[mcp_servers\.autoclaw\]/.test(fs.readFileSync(codex.path, 'utf8')));

      // Re-run is idempotent.
      const second = await installAll(opts);
      assert.strictEqual(second.find(r => r.host === 'codex')!.outcome, 'unchanged');
    } finally {
      rmrf(home);
      rmrf(ws);
    }
  });
});
