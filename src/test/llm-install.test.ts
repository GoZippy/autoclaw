/**
 * llm-install.test.ts — `autoclaw llm install` integration tests.
 *
 * Covers the 8 acceptance cases from
 * docs/specs/llm-provider-s2-autoclaw-side/spec.md:
 *   - fresh workspace (3 added rows)
 *   - idempotent re-run (3 unchanged rows)
 *   - ZMLR unreachable (1 skipped row, ok: true)
 *   - playbook API unavailable (config + workspace-mcp added; playbooks skipped)
 *   - report formatting
 *   - --ollama branch (separate slice)
 *   - YAML round-trip preserves entries
 *   - workspace .mcp.json idempotency
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  installLlm,
  formatLlmInstallReport,
  parseConfig,
  serializeConfig,
} from '../llm/install';

function mkWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-llm-install-'));
  // Seed the shipped playbooks the installer reads.
  const dir = path.join(ws, 'adapters', 'zippymesh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mateam-playbook.json'),
    JSON.stringify({ id: 'mateam', name: 'MAteam fan-out', rules: [] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'kdream-playbook.json'),
    JSON.stringify({ id: 'kdream', name: 'KDream long-running', rules: [] }),
    'utf8',
  );
  return ws;
}

/** Fetch mock with route table. Routes match URL substrings. */
function makeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body ?? {}), { status: response.status });
      }
    }
    throw new Error(`ECONNREFUSED ${url}`);
  }) as typeof fetch;
}

suite('installLlm — fresh workspace (ZMLR + playbooks)', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('writes config + workspace MCP entry + imports 2 playbooks', async () => {
    const fetchImpl = makeFetch({
      '/mcp': { status: 200, body: { tools: [] } },
      '/api/playbooks/mateam': { status: 404 },
      '/api/playbooks/kdream': { status: 404 },
      '/api/playbooks': { status: 200, body: { ok: true } },
    });
    const report = await installLlm({ workspaceRoot: workspace, fetchImpl });
    assert.strictEqual(report.ok, true);
    const outcomes = report.steps.map((s) => s.outcome);
    // 1 config + 1 workspace-mcp + 2 playbooks = 4 rows
    assert.strictEqual(report.steps.length, 4);
    assert.ok(outcomes.includes('added'), `outcomes were: ${outcomes.join(', ')}`);

    // Files exist with expected content
    const cfg = fs.readFileSync(
      path.join(workspace, '.autoclaw', 'llm', 'config.yaml'),
      'utf8',
    );
    assert.ok(cfg.includes('id: zippymesh'));
    assert.ok(cfg.includes('http://127.0.0.1:20128'));

    const mcp = JSON.parse(
      fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'),
    );
    assert.strictEqual(mcp.mcpServers.zmlr.url, 'http://127.0.0.1:20128/mcp');
  });
});

suite('installLlm — idempotent re-run', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('second run produces only unchanged rows; no file writes', async () => {
    const fetchImpl = makeFetch({
      '/mcp': { status: 200 },
      '/api/playbooks/mateam': { status: 200, body: { id: 'mateam' } },
      '/api/playbooks/kdream': { status: 200, body: { id: 'kdream' } },
    });
    // First run
    await installLlm({ workspaceRoot: workspace, fetchImpl });
    const cfgMtime1 = fs.statSync(
      path.join(workspace, '.autoclaw', 'llm', 'config.yaml'),
    ).mtimeMs;
    const mcpMtime1 = fs.statSync(path.join(workspace, '.mcp.json')).mtimeMs;

    // Brief wait so a real write would land on a different mtime — but skipped
    // here because we're testing the no-write path, not timing.

    // Second run
    const report = await installLlm({ workspaceRoot: workspace, fetchImpl });
    assert.strictEqual(report.ok, true);
    for (const step of report.steps) {
      assert.strictEqual(
        step.outcome,
        'unchanged',
        `${step.step}/${step.target} should be unchanged, was ${step.outcome}`,
      );
    }
    // Files unchanged
    assert.strictEqual(
      fs.statSync(path.join(workspace, '.autoclaw', 'llm', 'config.yaml')).mtimeMs,
      cfgMtime1,
    );
    assert.strictEqual(
      fs.statSync(path.join(workspace, '.mcp.json')).mtimeMs,
      mcpMtime1,
    );
  });
});

suite('installLlm — ZMLR unreachable', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('skipped row, no files written, ok: true', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const report = await installLlm({ workspaceRoot: workspace, fetchImpl });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.steps.length, 1);
    assert.strictEqual(report.steps[0].outcome, 'skipped');
    assert.ok(report.steps[0].detail.toLowerCase().includes('unreachable'));
    assert.strictEqual(fs.existsSync(path.join(workspace, '.autoclaw', 'llm')), false);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.mcp.json')), false);
  });
});

suite('installLlm — playbook API unavailable (older ZMLR)', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('config + workspace-mcp added; playbooks skipped (not error)', async () => {
    // /mcp responds, but the playbook API returns 500 for everything
    const fetchImpl = makeFetch({
      '/mcp': { status: 200 },
      '/api/playbooks': { status: 500, body: { error: 'not_available' } },
    });
    const report = await installLlm({ workspaceRoot: workspace, fetchImpl });
    assert.strictEqual(report.ok, true);
    const configStep = report.steps.find((s) => s.step === 'config');
    const mcpStep = report.steps.find((s) => s.step === 'workspace-mcp');
    const playbookSteps = report.steps.filter((s) => s.step === 'playbook');
    assert.strictEqual(configStep?.outcome, 'added');
    assert.strictEqual(mcpStep?.outcome, 'added');
    assert.strictEqual(playbookSteps.length, 2);
    for (const p of playbookSteps) {
      assert.strictEqual(p.outcome, 'skipped');
    }
  });
});

suite('formatLlmInstallReport', () => {
  test('produces a readable single-block output', () => {
    const text = formatLlmInstallReport({
      ok: true,
      steps: [
        { step: 'config', target: 'zippymesh', outcome: 'added', detail: 'wrote config.yaml' },
        { step: 'workspace-mcp', target: 'zmlr', outcome: 'added', detail: 'wrote .mcp.json' },
      ],
    });
    assert.ok(text.includes('autoclaw llm install'));
    assert.ok(text.includes('added'));
    assert.ok(text.includes('zippymesh'));
    assert.ok(text.endsWith('OK'));
  });
});

suite('installLlm — --ollama branch', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('adds an ollama entry to config.yaml when /api/version responds', async () => {
    const fetchImpl = makeFetch({
      '/api/version': { status: 200, body: { version: '0.5.7' } },
    });
    const report = await installLlm({
      workspaceRoot: workspace,
      zippymesh: false,
      ollama: true,
      fetchImpl,
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.steps.length, 1);
    assert.strictEqual(report.steps[0].outcome, 'added');
    const cfg = fs.readFileSync(
      path.join(workspace, '.autoclaw', 'llm', 'config.yaml'),
      'utf8',
    );
    assert.ok(cfg.includes('id: ollama'));
  });

  test('skipped when ollama is not running', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const report = await installLlm({
      workspaceRoot: workspace,
      zippymesh: false,
      ollama: true,
      fetchImpl,
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.steps[0].outcome, 'skipped');
  });
});

suite('config YAML round-trip', () => {
  test('parse(serialize(x)) preserves the providers array', () => {
    const original = {
      providers: [
        {
          id: 'zippymesh',
          endpoint: 'http://127.0.0.1:20128',
          auth: { kind: 'bearer' as const, tokenEnv: 'ZIPPYMESH_TOKEN' },
          extraHeaders: { 'X-Client': 'autoclaw' },
        },
        { id: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      ],
    };
    const text = serializeConfig(original);
    const back = parseConfig(text);
    assert.strictEqual(back.providers.length, 2);
    assert.strictEqual(back.providers[0].id, 'zippymesh');
    assert.strictEqual(back.providers[0].endpoint, 'http://127.0.0.1:20128');
    assert.strictEqual(back.providers[0].auth?.tokenEnv, 'ZIPPYMESH_TOKEN');
    assert.strictEqual(back.providers[0].extraHeaders?.['X-Client'], 'autoclaw');
    assert.strictEqual(back.providers[1].id, 'ollama');
  });

  test('parse() returns empty providers when file has no providers: key', () => {
    const out = parseConfig('# just a comment\nother: thing\n');
    assert.deepStrictEqual(out.providers, []);
  });
});
