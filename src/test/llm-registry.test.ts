/**
 * llm-registry.test.ts — LlmRegistry getPreferred() algorithm tests.
 *
 * Covers the three algorithm branches:
 *   1. explicit  — caller named a provider.
 *   2. zmlr-recommend — ZMLR healthy → recommendModel pin (S1: always null stopgap).
 *   3. oracle — fall-through ladder.
 * Plus the ZMLR-rate-limited skip-to-oracle branch.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LlmRegistry } from '../llm/registry';
import { ZippyMeshProvider } from '../llm/zippymesh';
import { OllamaProvider } from '../llm/ollama';
import { LmStudioProvider } from '../llm/lmstudio';
import { Oracle } from '../llm/oracle';

interface CapturedFetchCall {
  url: string;
  body?: unknown;
}

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-registry-'));
}

function makeFetch(
  routes: Record<string, { status: number; body: unknown }>,
  capture?: CapturedFetchCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (capture) {
      capture.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    }
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), { status: response.status });
      }
    }
    throw new Error(`ECONNREFUSED ${url}`);
  }) as typeof fetch;
}

suite('LlmRegistry — explicit branch', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('getPreferred({ explicitProviderId: "ollama" }) returns Ollama directly', async () => {
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [
        new ZippyMeshProvider({ fetchImpl: (async () => new Response()) as typeof fetch }),
        new OllamaProvider({ fetchImpl: (async () => new Response()) as typeof fetch }),
      ],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true }),
    });
    const pick = await registry.getPreferred({ explicitProviderId: 'ollama' });
    assert.ok(pick);
    assert.strictEqual(pick!.provider.id, 'ollama');
    assert.strictEqual(pick!.via, 'explicit');
  });
});

suite('LlmRegistry — oracle fallback branch (ZMLR unreachable)', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('getPreferred() falls through to oracle when ZMLR is down + Ollama is up', async () => {
    const routes = {
      '127.0.0.1:11434/api/version': { status: 200, body: { version: '0.5.7' } },
      '127.0.0.1:11434/api/tags': {
        status: 200,
        body: {
          models: [{ name: 'llama3.1:8b', details: { family: 'llama', parameter_size: '8B' } }],
        },
      },
    };
    const fetchImpl = makeFetch(routes);
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [
        new ZippyMeshProvider({ fetchImpl }), // ZMLR /v1/models will throw → unreachable
        new OllamaProvider({ fetchImpl }),
      ],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true, fetchImpl }),
    });
    const pick = await registry.getPreferred({ hints: { intent: 'chat' } });
    assert.ok(pick, 'pick should not be null');
    assert.strictEqual(pick!.provider.id, 'ollama');
    assert.strictEqual(pick!.via, 'oracle');
    assert.strictEqual(pick!.failsafe, false);
  });

  test('getPreferred() returns null when nothing is online', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [
        new ZippyMeshProvider({ fetchImpl }),
        new OllamaProvider({ fetchImpl }),
      ],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true, fetchImpl }),
    });
    const pick = await registry.getPreferred({ hints: { intent: 'chat' } });
    assert.strictEqual(pick, null);
  });

  test('getPreferred() can return LM Studio when it is the only local endpoint online', async () => {
    const fetchImpl = makeFetch({
      '127.0.0.1:1234/v1/models': {
        status: 200,
        body: { data: [{ id: 'qwen2.5-coder-7b-instruct' }] },
      },
    });
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [
        new ZippyMeshProvider({ fetchImpl }),
        new OllamaProvider({ fetchImpl }),
        new LmStudioProvider({ fetchImpl }),
      ],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true, fetchImpl }),
    });
    const pick = await registry.getPreferred({ hints: { intent: 'code' } });
    assert.ok(pick, 'pick should not be null');
    assert.strictEqual(pick!.provider.id, 'lmstudio');
    assert.strictEqual(pick!.via, 'oracle');
    assert.strictEqual(pick!.model, 'qwen2.5-coder-7b-instruct');
  });
});

suite('LlmRegistry — ZMLR scaffold-aware recommendation branch', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('getPreferred() forwards scaffold constraints and preserves harnessId', async () => {
    const capture: CapturedFetchCall[] = [];
    const fetchImpl = makeFetch(
      {
        '127.0.0.1:20128/v1/models': {
          status: 200,
          body: { data: [{ id: 'auto' }] },
        },
        '127.0.0.1:20128/mcp': {
          status: 200,
          body: {
            success: true,
            recommendations: [
              { model: 'ollama/qwen3:14b', harnessId: 'qwen-xml-tools' },
            ],
            fallbackChain: ['ollama/qwen3:7b'],
          },
        },
      },
      capture,
    );
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [new ZippyMeshProvider({ fetchImpl })],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true, fetchImpl }),
    });

    const pick = await registry.getPreferred({
      hints: { intent: 'code' },
      zmlrConstraints: {
        failureType: 'acceptance_failure',
        promptHarnessId: 'qwen-xml-tools',
        allowedHarnesses: ['qwen-xml-tools', 'openai-tools'],
        scaffoldScoreHints: [{ scaffoldId: 'scaffold-qwen-review', reward: 0.75 }],
      },
    });

    assert.ok(pick);
    assert.strictEqual(pick!.provider.id, 'zippymesh');
    assert.strictEqual(pick!.model, 'ollama/qwen3:14b');
    assert.strictEqual(pick!.via, 'zmlr-recommend');
    assert.strictEqual(pick!.harnessId, 'qwen-xml-tools');

    const mcpCall = capture.find((call) => call.url.endsWith('/mcp'));
    assert.ok(mcpCall);
    const input = (mcpCall!.body as { input: { constraints: Record<string, unknown> } }).input;
    assert.strictEqual(input.constraints.failure_type, 'acceptance_failure');
    assert.strictEqual(input.constraints.prompt_harness_id, 'qwen-xml-tools');
    assert.deepStrictEqual(input.constraints.allowed_harnesses, ['qwen-xml-tools', 'openai-tools']);
    assert.deepStrictEqual(input.constraints.scaffold_score_hints, [
      { scaffold_id: 'scaffold-qwen-review', reward: 0.75 },
    ]);
  });
});

suite('LlmRegistry — default providers', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('default registry includes ZippyMesh, Ollama, and LM Studio', () => {
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true }),
    });
    assert.deepStrictEqual(registry.list().map(p => p.id), ['zippymesh', 'ollama', 'lmstudio']);
  });
});

suite('LlmRegistry — failsafe branch', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('getPreferred() returns ollama pinned to failsafe model when only :11435 is up', async () => {
    const fetchImpl = makeFetch({
      '127.0.0.1:11435/api/version': { status: 200, body: { version: '0.5.7' } },
      '127.0.0.1:11435/api/tags': {
        status: 200,
        body: { models: [{ name: 'qwen3:0.6b', details: { family: 'qwen', parameter_size: '0.6B' } }] },
      },
    });
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [
        new ZippyMeshProvider({ fetchImpl }),
        new OllamaProvider({ fetchImpl }),
      ],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true, fetchImpl }),
    });
    const pick = await registry.getPreferred({ hints: { intent: 'chat' } });
    assert.ok(pick);
    assert.strictEqual(pick!.failsafe, true);
    assert.strictEqual(pick!.model, 'qwen3:0.6b');
    assert.strictEqual(pick!.provider.id, 'ollama');
  });
});

suite('LlmRegistry — resolve()', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('resolve("ollama:llama3.1:70b") returns Ollama + model', () => {
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [new OllamaProvider({ fetchImpl: (async () => new Response()) as typeof fetch })],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true }),
    });
    const r = registry.resolve('ollama:llama3.1:70b');
    assert.ok(r);
    assert.strictEqual(r!.provider.id, 'ollama');
    assert.strictEqual(r!.model, 'llama3.1:70b');
  });

  test('resolve("unknown-provider") returns undefined', () => {
    const registry = new LlmRegistry({
      workspaceRoot: workspace,
      providers: [],
      oracle: new Oracle({ workspaceRoot: workspace, ephemeral: true }),
    });
    assert.strictEqual(registry.resolve('unknown-provider'), undefined);
  });
});
