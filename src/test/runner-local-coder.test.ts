/**
 * runner-local-coder.test.ts — LocalCoderRunner integration tests.
 *
 * Covers the four S3 spec acceptance criteria for the runner:
 *   - plan preamble injected (happy path)
 *   - no provider → no preamble (base behavior)
 *   - plan failure → no preamble (non-fatal)
 *   - provider field round-trip on the base adapter
 */

import * as assert from 'assert';

import { LocalCoderRunner } from '../runners/local-coder';
import { LoopServiceAdapter } from '../runners/loop-service-adapter';
import type {
  ChatOptions,
  ChatResult,
  DetectionResult,
  HealthReport,
  LlmProvider,
  ModelInfo,
  ProviderCapabilities,
} from '../llm/types';

/** A minimal in-memory LlmProvider for tests. */
class StubProvider implements LlmProvider {
  readonly id = 'stub';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolUse: false,
    jsonMode: false,
    embeddings: false,
    locality: 'local',
    reportsCost: false,
    modelFamilies: [],
  };
  readonly defaultModel = 'stub-model';
  lastChat?: ChatOptions;
  constructor(private readonly behavior: (opts: ChatOptions) => Promise<ChatResult> | ChatResult) {}
  async detect(): Promise<DetectionResult> {
    return { found: true, version: 'stub', endpoint: 'mem://stub' };
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.lastChat = opts;
    return this.behavior(opts);
  }
  async models(): Promise<ModelInfo[]> {
    return [{ id: 'stub-model', local: true }];
  }
  async health(): Promise<HealthReport> {
    return { ok: true, reachable: true, authPresent: true, modelCount: 1, recentErrors: [] };
  }
}

/** Capture the dispatch body the runner would have POSTed. */
async function captureBodyVia(
  runner: LocalCoderRunner | LoopServiceAdapter,
  prompt: string,
): Promise<Record<string, unknown>> {
  // composeDispatchBody is protected; cast to access via the standard
  // type-only escape hatch used elsewhere in the test suite.
  const hook = (runner as unknown as {
    composeDispatchBody(opts: { prompt: string; trust: string; workingDir: string; sessionId: string }): Promise<Record<string, unknown>>;
  }).composeDispatchBody.bind(runner);
  return hook({ prompt, trust: 'auto', workingDir: process.cwd(), sessionId: 's-1' });
}

suite('LocalCoderRunner — plan preamble injection', () => {
  test('inserts the provider plan as `preamble` on the dispatch body', async () => {
    const provider = new StubProvider(async (opts) => ({
      ok: true,
      response: '1. Read the file\n2. Find the bug\n3. Fix it',
      model: 'stub-model',
      servedBy: 'stub',
      durationMs: 5,
      tokens: { input: opts.prompt?.length ?? 0, output: 30 },
    }));
    const runner = new LocalCoderRunner({
      id: 'local-coder',
      endpoint: 'http://example.invalid',
      provider,
    });
    const body = await captureBodyVia(runner, 'count to 3');
    assert.strictEqual(body.preamble, '1. Read the file\n2. Find the bug\n3. Fix it');
    assert.strictEqual(body.prompt, 'count to 3'); // base body fields preserved

    // Verify the chat call carried plan intent + local locality.
    assert.strictEqual(provider.lastChat?.hints?.intent, 'plan');
    assert.strictEqual(provider.lastChat?.hints?.requireLocality, 'local');
  });

  test('with no provider, dispatch body has no `preamble` (base behavior)', async () => {
    const runner = new LocalCoderRunner({
      id: 'local-coder-no-provider',
      endpoint: 'http://example.invalid',
    });
    const body = await captureBodyVia(runner, 'no plan');
    assert.strictEqual(body.preamble, undefined);
    assert.strictEqual(body.prompt, 'no plan');
  });

  test('plan failure is non-fatal — body has no `preamble`, dispatch is not blocked', async () => {
    const provider = new StubProvider(() => {
      throw new Error('synthetic plan failure');
    });
    const runner = new LocalCoderRunner({
      id: 'local-coder-bad-provider',
      endpoint: 'http://example.invalid',
      provider,
    });
    const body = await captureBodyVia(runner, 'whatever');
    assert.strictEqual(body.preamble, undefined);
    assert.strictEqual(body.prompt, 'whatever');
  });

  test('provider returns ok:false → no preamble', async () => {
    const provider = new StubProvider(async () => ({
      ok: false,
      model: 'stub-model',
      servedBy: 'stub',
      durationMs: 1,
      errorClass: 'internal',
      errorMessage: 'mock failure',
    }));
    const runner = new LocalCoderRunner({
      id: 'local-coder-error-provider',
      endpoint: 'http://example.invalid',
      provider,
    });
    const body = await captureBodyVia(runner, 'x');
    assert.strictEqual(body.preamble, undefined);
  });

  test('provider returns empty response → no preamble', async () => {
    const provider = new StubProvider(async () => ({
      ok: true,
      response: '',
      model: 'stub-model',
      servedBy: 'stub',
      durationMs: 1,
    }));
    const runner = new LocalCoderRunner({
      id: 'local-coder-empty-provider',
      endpoint: 'http://example.invalid',
      provider,
    });
    const body = await captureBodyVia(runner, 'x');
    assert.strictEqual(body.preamble, undefined);
  });

  test('planEnabled: false disables preamble even when a provider is set', async () => {
    const provider = new StubProvider(async () => ({
      ok: true,
      response: 'plan',
      model: 'stub-model',
      servedBy: 'stub',
      durationMs: 1,
    }));
    const runner = new LocalCoderRunner({
      id: 'local-coder-disabled',
      endpoint: 'http://example.invalid',
      provider,
      planEnabled: false,
    });
    const body = await captureBodyVia(runner, 'x');
    assert.strictEqual(body.preamble, undefined);
  });
});

suite('LoopServiceAdapter — optional provider round-trip', () => {
  test('providerForTest() returns the same instance passed via config', () => {
    const provider = new StubProvider(async () => ({
      ok: true,
      response: '',
      model: 'stub-model',
      servedBy: 'stub',
      durationMs: 0,
    }));
    const adapter = new LoopServiceAdapter({
      id: 'with-provider',
      endpoint: 'http://example.invalid',
      provider,
    });
    assert.strictEqual(adapter.providerForTest(), provider);
  });

  test('providerForTest() returns undefined when none is configured', () => {
    const adapter = new LoopServiceAdapter({
      id: 'without-provider',
      endpoint: 'http://example.invalid',
    });
    assert.strictEqual(adapter.providerForTest(), undefined);
  });

  test('composeDispatchBody returns the same body as buildDispatchBody when no augmentation', async () => {
    const adapter = new LoopServiceAdapter({
      id: 'no-augment',
      endpoint: 'http://example.invalid',
    });
    const body = await captureBodyVia(adapter, 'hello');
    assert.strictEqual(body.prompt, 'hello');
    assert.strictEqual(body.preamble, undefined);
  });
});
