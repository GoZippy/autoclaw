/**
 * programRegistry.test.ts — Unit tests for the workspace-local program-scope
 * registry (`src/program/registry.ts`) and the browser-capability resolver
 * (`src/program/browserCapability.ts`).
 *
 * No `vscode` import — plain Node/Mocha. The VS Code command is exercised via
 * a structural stub injected as `VsCodeAddRepoDeps`.
 *
 * Sprint 4 — C14 + C5_statusbar (C.13), WA-1.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  programRegistryPath,
  readProgramRegistry,
  ensureProgramRegistry,
  addRepoToProgram,
  removeRepoFromProgram,
  tailCrossRepoComms,
  buildProgramAgentsTable,
  programAgentStatus,
  addRepoToProgramCommand,
  type VsCodeAddRepoDeps,
} from '../program/registry';
import {
  needsBrowser,
  hasNativeBrowser,
  resolveBrowserProvision,
  applyBrowserProvisionToMcp,
  PLAYWRIGHT_MCP_KEY,
  PLAYWRIGHT_MCP_SERVER,
} from '../program/browserCapability';

function makeTmpDir(prefix = 'prog-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a comms-log.jsonl + registry.json + heartbeat for a fake repo. */
function seedRepo(
  repo: string,
  opts: {
    agents?: Array<{ id: string; name?: string; role?: string }>;
    heartbeats?: Record<string, { timestamp: string; current_task?: string }>;
    commsLines?: Array<Record<string, unknown>>;
  } = {},
): void {
  const comms = path.join(repo, '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(path.join(comms, 'heartbeats'), { recursive: true });
  if (opts.agents) {
    fs.writeFileSync(
      path.join(comms, 'registry.json'),
      JSON.stringify({ agents: opts.agents }),
      'utf8',
    );
  }
  for (const [agentId, hb] of Object.entries(opts.heartbeats ?? {})) {
    fs.writeFileSync(
      path.join(comms, 'heartbeats', `${agentId}.json`),
      JSON.stringify({ agent_id: agentId, ...hb }),
      'utf8',
    );
  }
  if (opts.commsLines) {
    fs.writeFileSync(
      path.join(comms, 'comms-log.jsonl'),
      opts.commsLines.map(l => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );
  }
}

suite('Program Registry — read / write / ensure', () => {
  test('ensureProgramRegistry seeds the host workspace as the first repo', async () => {
    const ws = makeTmpDir();
    const reg = await ensureProgramRegistry(ws);
    assert.strictEqual(reg.schema_version, '1.0');
    assert.strictEqual(reg.repos.length, 1);
    assert.strictEqual(reg.repos[0].path, path.resolve(ws));
    assert.ok(fs.existsSync(programRegistryPath(ws)));
  });

  test('readProgramRegistry returns null when no registry exists', async () => {
    const ws = makeTmpDir();
    assert.strictEqual(await readProgramRegistry(ws), null);
  });

  test('ensureProgramRegistry is idempotent (does not overwrite)', async () => {
    const ws = makeTmpDir();
    const first = await ensureProgramRegistry(ws, 'My Program');
    const second = await ensureProgramRegistry(ws, 'Different Name');
    assert.strictEqual(second.program_name, first.program_name);
    assert.strictEqual(second.program_name, 'My Program');
  });
});

suite('Program Registry — addRepoToProgram', () => {
  test('adds a new repo and reports added=true', async () => {
    const ws = makeTmpDir();
    const other = makeTmpDir();
    const result = await addRepoToProgram(ws, other, 'Other Repo');
    assert.strictEqual(result.added, true);
    assert.strictEqual(result.registry.repos.length, 2);
    const added = result.registry.repos.find(r => r.path === path.resolve(other));
    assert.ok(added);
    assert.strictEqual(added!.label, 'Other Repo');
  });

  test('adding the same repo twice is idempotent (added=false)', async () => {
    const ws = makeTmpDir();
    const other = makeTmpDir();
    await addRepoToProgram(ws, other);
    const second = await addRepoToProgram(ws, other);
    assert.strictEqual(second.added, false);
    assert.strictEqual(second.registry.repos.length, 2);
  });

  test('removeRepoFromProgram removes a repo', async () => {
    const ws = makeTmpDir();
    const other = makeTmpDir();
    await addRepoToProgram(ws, other);
    const removed = await removeRepoFromProgram(ws, other);
    assert.strictEqual(removed, true);
    const reg = await readProgramRegistry(ws);
    assert.strictEqual(reg!.repos.length, 1);
  });

  test('removeRepoFromProgram returns false for an unknown repo', async () => {
    const ws = makeTmpDir();
    await ensureProgramRegistry(ws);
    assert.strictEqual(await removeRepoFromProgram(ws, makeTmpDir()), false);
  });
});

suite('Program Registry — cross-repo comms tail', () => {
  test('merges and sorts comms entries across repos', async () => {
    const ws = makeTmpDir();
    const repoB = makeTmpDir();
    seedRepo(ws, {
      commsLines: [
        { timestamp: '2026-05-21T10:00:00Z', type: 'task_claim', from: 'a', message: 'first' },
        { timestamp: '2026-05-21T10:30:00Z', type: 'task_complete', from: 'a', message: 'third' },
      ],
    });
    seedRepo(repoB, {
      commsLines: [
        { timestamp: '2026-05-21T10:15:00Z', type: 'question', from: 'b', message: 'second' },
      ],
    });
    await addRepoToProgram(ws, repoB, 'Repo B');

    const tail = await tailCrossRepoComms(ws);
    assert.strictEqual(tail.length, 3);
    assert.deepStrictEqual(tail.map(e => e.message), ['first', 'second', 'third']);
    assert.strictEqual(tail[1].repoLabel, 'Repo B');
  });

  test('limit returns the newest N entries across the program', async () => {
    const ws = makeTmpDir();
    seedRepo(ws, {
      commsLines: [
        { timestamp: '2026-05-21T01:00:00Z', type: 't', from: 'a', message: 'old' },
        { timestamp: '2026-05-21T02:00:00Z', type: 't', from: 'a', message: 'mid' },
        { timestamp: '2026-05-21T03:00:00Z', type: 't', from: 'a', message: 'new' },
      ],
    });
    await ensureProgramRegistry(ws);
    const tail = await tailCrossRepoComms(ws, { limit: 2 });
    assert.deepStrictEqual(tail.map(e => e.message), ['mid', 'new']);
  });

  test('returns empty array when no registry exists', async () => {
    const ws = makeTmpDir();
    assert.deepStrictEqual(await tailCrossRepoComms(ws), []);
  });

  test('skips disabled repos', async () => {
    const ws = makeTmpDir();
    const repoB = makeTmpDir();
    seedRepo(ws, { commsLines: [{ timestamp: '2026-05-21T10:00:00Z', type: 't', from: 'a', message: 'host' }] });
    seedRepo(repoB, { commsLines: [{ timestamp: '2026-05-21T11:00:00Z', type: 't', from: 'b', message: 'parked' }] });
    await addRepoToProgram(ws, repoB);
    const reg = await readProgramRegistry(ws);
    reg!.repos.find(r => r.path === path.resolve(repoB))!.enabled = false;
    fs.writeFileSync(programRegistryPath(ws), JSON.stringify(reg), 'utf8');

    const tail = await tailCrossRepoComms(ws);
    assert.deepStrictEqual(tail.map(e => e.message), ['host']);
  });
});

suite('Program Registry — cross-repo Agents table', () => {
  test('builds a single table with a repo column across repos', async () => {
    const now = Date.parse('2026-05-21T12:00:00Z');
    const ws = makeTmpDir();
    const repoB = makeTmpDir();
    seedRepo(ws, {
      agents: [{ id: 'claude-code', name: 'Claude', role: 'WA-1' }],
      heartbeats: {
        'claude-code': { timestamp: '2026-05-21T11:59:30Z', current_task: 'C14' },
      },
    });
    seedRepo(repoB, {
      agents: [{ id: 'kilocode', role: 'WA-2' }],
      heartbeats: {
        'kilocode': { timestamp: '2026-05-21T11:00:00Z' },
      },
    });
    await addRepoToProgram(ws, repoB, 'Repo B');

    const rows = await buildProgramAgentsTable(ws, { now });
    assert.strictEqual(rows.length, 2);
    const claude = rows.find(r => r.agentId === 'claude-code')!;
    assert.strictEqual(claude.status, 'active');
    assert.strictEqual(claude.currentTask, 'C14');
    assert.ok(claude.repoLabel.length > 0);
    const kilo = rows.find(r => r.agentId === 'kilocode')!;
    assert.strictEqual(kilo.repoLabel, 'Repo B');
    assert.strictEqual(kilo.status, 'stalled'); // 60 min stale
  });

  test('repos with no registry contribute zero rows', async () => {
    const ws = makeTmpDir();
    await ensureProgramRegistry(ws);
    const rows = await buildProgramAgentsTable(ws);
    assert.deepStrictEqual(rows, []);
  });

  test('programAgentStatus derives status from heartbeat age', () => {
    const now = Date.parse('2026-05-21T12:00:00Z');
    assert.strictEqual(programAgentStatus('2026-05-21T11:59:00Z', now), 'active');
    assert.strictEqual(programAgentStatus('2026-05-21T11:56:00Z', now), 'idle');
    assert.strictEqual(programAgentStatus('2026-05-21T11:00:00Z', now), 'stalled');
    assert.strictEqual(programAgentStatus('2026-05-20T00:00:00Z', now), 'offline');
    assert.strictEqual(programAgentStatus(null, now), 'offline');
  });
});

suite('Program Registry — addRepoToProgramCommand (VS Code)', () => {
  /** Build a stub VsCodeAddRepoDeps; records every toast it shows. */
  function stubVscode(pickedPath: string | null): {
    deps: VsCodeAddRepoDeps;
    toasts: string[];
  } {
    const toasts: string[] = [];
    const deps: VsCodeAddRepoDeps = {
      window: {
        showOpenDialog: () =>
          Promise.resolve(pickedPath ? [{ fsPath: pickedPath }] : undefined),
        showInformationMessage: (m: string) => { toasts.push(`info:${m}`); return Promise.resolve(undefined); },
        showWarningMessage: (m: string) => { toasts.push(`warn:${m}`); return Promise.resolve(undefined); },
        showErrorMessage: (m: string) => { toasts.push(`error:${m}`); return Promise.resolve(undefined); },
      },
    };
    return { deps, toasts };
  }

  test('returns null and shows nothing when the user cancels', async () => {
    const ws = makeTmpDir();
    const { deps, toasts } = stubVscode(null);
    const result = await addRepoToProgramCommand(deps, ws);
    assert.strictEqual(result, null);
    assert.deepStrictEqual(toasts, []);
  });

  test('adds a picked folder and shows an info toast', async () => {
    const ws = makeTmpDir();
    const other = makeTmpDir();
    const { deps, toasts } = stubVscode(other);
    const result = await addRepoToProgramCommand(deps, ws);
    assert.ok(result);
    assert.strictEqual(result!.added, true);
    assert.ok(toasts.some(t => t.startsWith('info:')));
  });

  test('shows a warning when the repo is already in the program', async () => {
    const ws = makeTmpDir();
    const other = makeTmpDir();
    await addRepoToProgram(ws, other);
    const { deps, toasts } = stubVscode(other);
    const result = await addRepoToProgramCommand(deps, ws);
    assert.strictEqual(result!.added, false);
    assert.ok(toasts.some(t => t.startsWith('warn:')));
  });

  test('shows an error when the picked path is not a folder', async () => {
    const ws = makeTmpDir();
    const file = path.join(makeTmpDir(), 'a-file.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    const { deps, toasts } = stubVscode(file);
    const result = await addRepoToProgramCommand(deps, ws);
    assert.strictEqual(result, null);
    assert.ok(toasts.some(t => t.startsWith('error:')));
  });
});

suite('Browser Capability — needs_browser flag + Playwright fallback', () => {
  test('needsBrowser is a strict-true guard', () => {
    assert.strictEqual(needsBrowser({ needs_browser: true }), true);
    assert.strictEqual(needsBrowser({ needs_browser: false }), false);
    assert.strictEqual(needsBrowser({}), false);
    assert.strictEqual(needsBrowser(null), false);
    assert.strictEqual(needsBrowser(undefined), false);
  });

  test('hasNativeBrowser is true only for gemini-cli', () => {
    assert.strictEqual(hasNativeBrowser('gemini-cli'), true);
    assert.strictEqual(hasNativeBrowser('claude-code'), false);
    assert.strictEqual(hasNativeBrowser('cursor'), false);
    assert.strictEqual(hasNativeBrowser('kiro'), false);
  });

  test('resolveBrowserProvision returns not-required when no browser is needed', () => {
    const p = resolveBrowserProvision('claude-code', { needs_browser: false });
    assert.strictEqual(p.mode, 'not-required');
  });

  test('resolveBrowserProvision passes through for the Gemini runner', () => {
    const p = resolveBrowserProvision('gemini-cli', { needs_browser: true });
    assert.strictEqual(p.mode, 'native');
  });

  test('resolveBrowserProvision backs non-Gemini runners with Playwright MCP', () => {
    const p = resolveBrowserProvision('claude-code', { needs_browser: true });
    assert.strictEqual(p.mode, 'playwright-mcp');
    if (p.mode === 'playwright-mcp') {
      assert.strictEqual(p.mcpKey, PLAYWRIGHT_MCP_KEY);
      assert.deepStrictEqual(p.mcpServer, PLAYWRIGHT_MCP_SERVER);
    }
  });

  test('applyBrowserProvisionToMcp adds the Playwright entry idempotently', () => {
    const p = resolveBrowserProvision('cursor', { needs_browser: true });
    const first = applyBrowserProvisionToMcp(p, {});
    assert.ok(first[PLAYWRIGHT_MCP_KEY]);
    const second = applyBrowserProvisionToMcp(p, first);
    assert.deepStrictEqual(second, first);
  });

  test('applyBrowserProvisionToMcp leaves the map unchanged for native/not-required', () => {
    const native = resolveBrowserProvision('gemini-cli', { needs_browser: true });
    assert.deepStrictEqual(applyBrowserProvisionToMcp(native, { foo: PLAYWRIGHT_MCP_SERVER }), {
      foo: PLAYWRIGHT_MCP_SERVER,
    });
  });
});
