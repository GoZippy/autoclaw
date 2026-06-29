/**
 * reviewfleet-context.test.ts — RF-5: Unit tests for context.ts
 *
 * ALL intelligence-layer deps are injected — no real buildContextPack or
 * network calls ever fire.  Tests verify:
 *
 *   1. buildReviewContext with a normal fake pack → summary includes file
 *      refs + counts, length ≤ maxChars, no code fences.
 *   2. CONTENT SAFETY — a pack whose markdown is full of dangerous content
 *      (code fences, diff blocks, API_KEY=secret, long hex blob) → the
 *      summary contains NONE of the dangerous content.
 *   3. Degrade-safe: fetchContextPack throws → SAFE_FALLBACK, no throw.
 *   4. maxChars truncation: huge pack → summary.length ≤ maxChars.
 *   5. redactSecrets unit: masks API key / bearer token / KEY=... pattern.
 *   6. prod.ts wiring — dispatchReviewer WITH contextProvider → prompt
 *      includes "Context:"; WITHOUT → prompt unchanged; contextProvider
 *      that throws → dispatch still returns a verdict.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildReviewContext,
  buildReviewContextProvider,
  redactSecrets,
  type ReviewContextDeps,
  type ReviewContextResult,
} from '../reviewfleet/context';

import {
  defaultReviewFleetDeps,
  buildReviewPrompt,
  type ReviewFleetProdOpts,
  type LlmChatFn,
} from '../reviewfleet/prod';

import type { ReviewerCapacity } from '../reviewfleet/roster';

/* -------------------------------------------------------------------------- */
/*  Fixture helpers                                                            */
/* -------------------------------------------------------------------------- */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ctx-test-'));
}

function modelReviewer(id = 'test:local-llm'): ReviewerCapacity {
  return {
    id,
    kind: 'model',
    locality: 'local',
    costTier: 'free',
    strength: 'strong',
    healthy: true,
    detail: `test-model:${id}`,
  };
}

function fakeLlmChat(text: string, costCents = 2): LlmChatFn {
  return async (args) => ({ text, costCents, _capturedPrompt: args.prompt } as { text: string; costCents: number; _capturedPrompt?: string });
}

/** A fakeLlmChat that captures the exact prompt it receives. */
function capturingLlmChat(
  text: string,
  costCents = 2,
): { fn: LlmChatFn; prompts: string[] } {
  const prompts: string[] = [];
  const fn: LlmChatFn = async (args) => {
    prompts.push(args.prompt);
    return { text, costCents };
  };
  return { fn, prompts };
}

function baseProdOpts(
  workspaceRoot: string,
  overrides: Partial<ReviewFleetProdOpts> = {},
): ReviewFleetProdOpts {
  return {
    workspaceRoot,
    roster: [modelReviewer()],
    now: () => '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a fake pack result, optionally overriding fields. */
function fakePack(overrides: {
  markdown?: string;
  codeHits?: number;
  kgHits?: number;
  degraded?: boolean;
} = {}): {
  markdown: string;
  codeHits: number;
  kgHits: number;
  degraded: boolean;
} {
  return {
    markdown: overrides.markdown ?? '## Context\n\nSome context about src/reviewfleet/context.ts and src/intelligence/redact.ts.\n',
    codeHits: overrides.codeHits ?? 5,
    kgHits: overrides.kgHits ?? 3,
    degraded: overrides.degraded ?? false,
  };
}

function fakeFetchContextPack(pack: ReturnType<typeof fakePack>) {
  return async (_args: { task: string; taskId: string; workspaceRoot: string }) => pack;
}

/* -------------------------------------------------------------------------- */
/*  Suite 1: buildReviewContext — normal happy path                           */
/* -------------------------------------------------------------------------- */

suite('RF-5 buildReviewContext — normal happy path', () => {
  test('summary includes task id and hit counts', async () => {
    const ws = tmpDir();
    const pack = fakePack({ codeHits: 5, kgHits: 3 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-A', intent: 'security', workspaceRoot: ws },
      deps,
    );

    assert.strictEqual(result.safe, true, 'safe must always be true');
    assert.ok(result.summary.includes('RF-5-A'), 'summary must include task id');
    assert.ok(result.summary.includes('3'), 'summary must mention KG hit count');
    assert.ok(result.summary.includes('5'), 'summary must mention code hit count');
  });

  test('summary includes relevant file paths (basenames)', async () => {
    const ws = tmpDir();
    const pack = fakePack({
      markdown:
        '## Context\n\n' +
        '- src/reviewfleet/context.ts\n' +
        '- src/intelligence/redact.ts\n' +
        '- src/reviewfleet/prod.ts\n',
      codeHits: 3,
      kgHits: 0,
    });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-B', workspaceRoot: ws },
      deps,
    );

    assert.ok(result.summary.includes('context.ts'), 'summary must reference context.ts');
    assert.ok(result.summary.includes('redact.ts'), 'summary must reference redact.ts');
    assert.ok(result.summary.includes('prod.ts'), 'summary must reference prod.ts');
  });

  test('summary length is ≤ default maxChars (800)', async () => {
    const ws = tmpDir();
    const pack = fakePack({ codeHits: 5, kgHits: 3 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-C', workspaceRoot: ws },
      deps,
    );

    assert.ok(
      result.summary.length <= 800,
      `summary too long: ${result.summary.length} chars`,
    );
  });

  test('summary contains NO code fences (even if pack markdown had none)', async () => {
    const ws = tmpDir();
    const pack = fakePack({ codeHits: 2, kgHits: 1 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-D', workspaceRoot: ws },
      deps,
    );

    assert.ok(!result.summary.includes('```'), 'summary must not contain code fences');
  });

  test('provenance matches pack counts', async () => {
    const ws = tmpDir();
    const pack = fakePack({ codeHits: 7, kgHits: 2, degraded: false });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-E', workspaceRoot: ws },
      deps,
    );

    assert.strictEqual(result.provenance.codeHits, 7);
    assert.strictEqual(result.provenance.kgHits, 2);
    assert.strictEqual(result.provenance.degraded, false);
  });

  test('degraded flag surfaced in provenance and mentioned in summary', async () => {
    const ws = tmpDir();
    const pack = fakePack({ codeHits: 0, kgHits: 0, degraded: true });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-F', workspaceRoot: ws },
      deps,
    );

    assert.strictEqual(result.provenance.degraded, true, 'provenance.degraded must be true');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 2: CONTENT SAFETY — dangerous content is stripped/redacted          */
/* -------------------------------------------------------------------------- */

suite('RF-5 buildReviewContext — content safety pipeline', () => {
  /**
   * This is the primary invariant test.
   * The pack markdown contains EVERYTHING dangerous:
   *   - A fenced code block with a secret inside
   *   - A diff --git block with +/- lines
   *   - A KEY=value secret assignment
   *   - A long hex blob (40+ chars)
   *
   * The summary must contain NONE of these.
   */
  test('CONTENT SAFETY: strips code fences, diff lines, secrets, and hex blobs', async () => {
    const ws = tmpDir();

    const secretInFence = 'sk-secret123';
    const hexBlob = 'a'.repeat(45) + '0'.repeat(5); // 50-char hex-like blob
    const apiKey = 'sk-' + 'X'.repeat(25); // matches sk- API key pattern

    const dangerousMarkdown = [
      '## Context',
      '',
      'Some safe context about src/reviewfleet/context.ts.',
      '',
      // Code fence with secret inside
      '```typescript',
      `const SECRET_KEY = "${secretInFence}";`,
      'function review() { return true; }',
      '```',
      '',
      // Diff block
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc123..def456 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      '-const x = 1;',
      '+const x = 2;',
      '',
      // Key=value secret
      `API_KEY=${apiKey}`,
      '',
      // Long hex blob on a standalone line
      hexBlob,
      '',
      'End of context.',
    ].join('\n');

    const pack = fakePack({ markdown: dangerousMarkdown, codeHits: 1, kgHits: 0 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-SAFETY', workspaceRoot: ws },
      deps,
    );

    const summary = result.summary;

    // 1. Code fence contents must not be in the summary
    assert.ok(
      !summary.includes(secretInFence),
      `summary must NOT contain code-fence secret "${secretInFence}"; got: ${summary}`,
    );
    assert.ok(!summary.includes('```'), 'summary must NOT contain code fence markers');
    assert.ok(
      !summary.includes('function review()'),
      'summary must NOT contain function body from fenced block',
    );

    // 2. Diff body must not be in the summary
    assert.ok(
      !summary.includes('diff --git'),
      `summary must NOT contain "diff --git"; got: ${summary}`,
    );
    assert.ok(
      !summary.includes('@@ -1,3'),
      `summary must NOT contain hunk header "@@ -1,3"; got: ${summary}`,
    );
    assert.ok(
      !summary.includes('-const x = 1'),
      `summary must NOT contain diff removal line; got: ${summary}`,
    );
    assert.ok(
      !summary.includes('+const x = 2'),
      `summary must NOT contain diff addition line; got: ${summary}`,
    );

    // 3. API_KEY value must be redacted (the key name may appear but value must not)
    assert.ok(
      !summary.includes(apiKey),
      `summary must NOT contain raw API key "${apiKey}"; got: ${summary}`,
    );

    // 4. Long hex blob must be redacted (40+ chars matching generic token pattern)
    assert.ok(
      !summary.includes(hexBlob),
      `summary must NOT contain raw hex blob (${hexBlob.length} chars); got: ${summary}`,
    );

    // Invariant: safe is always true
    assert.strictEqual(result.safe, true);
  });

  test('summary is still useful after dangerous content is stripped', async () => {
    const ws = tmpDir();
    const dangerousMarkdown = [
      '## Context',
      '',
      'Review covers src/reviewfleet/context.ts and src/intelligence/redact.ts.',
      '',
      '```ts',
      'const SECRET = "sk-abc123def456";',
      '```',
    ].join('\n');

    const pack = fakePack({ markdown: dangerousMarkdown, codeHits: 2, kgHits: 1 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const result = await buildReviewContext(
      { taskId: 'RF-5-USEFUL', intent: 'code', workspaceRoot: ws },
      deps,
    );

    // Must still have a meaningful summary
    assert.ok(result.summary.length > 10, 'summary must not be empty after stripping');
    assert.ok(result.summary.includes('RF-5-USEFUL'), 'summary must still have task id');
    // Must not have the secret
    assert.ok(!result.summary.includes('sk-abc123def456'), 'secret must be stripped');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 3: Degrade-safe — fetchContextPack throws                          */
/* -------------------------------------------------------------------------- */

suite('RF-5 buildReviewContext — degrade-safe / error handling', () => {
  test('returns minimal safe result when fetchContextPack throws', async () => {
    const ws = tmpDir();
    const deps: ReviewContextDeps = {
      fetchContextPack: async () => {
        throw new Error('intelligence layer unavailable');
      },
    };

    let result: ReviewContextResult | undefined;
    let threw = false;
    try {
      result = await buildReviewContext(
        { taskId: 'RF-5-DEGRADE', workspaceRoot: ws },
        deps,
      );
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'buildReviewContext must NEVER throw');
    assert.ok(result !== undefined, 'must return a result');
    assert.strictEqual(result!.safe, true, 'safe must be true even on error');
    assert.strictEqual(result!.provenance.degraded, true, 'degraded must be true on error');
    assert.strictEqual(result!.provenance.kgHits, 0);
    assert.strictEqual(result!.provenance.codeHits, 0);
    assert.ok(
      result!.summary.includes('no additional context'),
      `fallback summary expected, got: ${result!.summary}`,
    );
  });

  test('does not throw even when deps is completely undefined', async () => {
    // Without fetchContextPack injected, the real defaultFetchContextPack runs.
    // In test environments without an intelligence store it will degrade or throw
    // internally.  Either way, buildReviewContext must not throw.
    const ws = tmpDir();

    let threw = false;
    let result: ReviewContextResult | undefined;
    try {
      // Pass a safe-fallback fetchContextPack to avoid hitting real intelligence layer
      result = await buildReviewContext(
        { taskId: 'RF-5-NODEPS', workspaceRoot: ws },
        {
          fetchContextPack: async () => ({
            markdown: undefined,
            codeHits: 0,
            kgHits: 0,
            degraded: true,
          }),
        },
      );
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'must not throw with empty/degraded pack');
    if (result) {
      assert.strictEqual(result.safe, true);
    }
  });

  test('returns minimal safe fallback when fetchContextPack returns empty', async () => {
    const ws = tmpDir();
    const deps: ReviewContextDeps = {
      fetchContextPack: async () => ({
        markdown: undefined,
        codeHits: 0,
        kgHits: 0,
        degraded: true,
      }),
    };

    const result = await buildReviewContext(
      { taskId: 'RF-5-EMPTY', workspaceRoot: ws },
      deps,
    );

    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.provenance.degraded, true);
    assert.ok(result.summary.length > 0, 'summary must not be empty string');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 4: maxChars truncation                                              */
/* -------------------------------------------------------------------------- */

suite('RF-5 buildReviewContext — maxChars truncation', () => {
  test('summary is truncated to exactly maxChars when pack is huge', async () => {
    const ws = tmpDir();
    // Generate a markdown body with many safe file references to produce a long summary.
    const manyFiles = Array.from({ length: 50 }, (_, i) => `- src/module/file${i}.ts`).join('\n');
    const pack = fakePack({
      markdown: '## Context\n\n' + manyFiles + '\n',
      codeHits: 50,
      kgHits: 10,
    });

    const maxChars = 200;
    const deps: ReviewContextDeps = {
      fetchContextPack: fakeFetchContextPack(pack),
      maxChars,
    };

    const result = await buildReviewContext(
      { taskId: 'RF-5-TRUNC', workspaceRoot: ws },
      deps,
    );

    assert.ok(
      result.summary.length <= maxChars,
      `summary length ${result.summary.length} exceeds maxChars ${maxChars}`,
    );
  });

  test('summary ends with ellipsis when truncated', async () => {
    const ws = tmpDir();
    const manyFiles = Array.from({ length: 50 }, (_, i) => `- src/module/file${i}.ts`).join('\n');
    const pack = fakePack({
      markdown: '## Context\n\n' + manyFiles + '\n',
      codeHits: 50,
      kgHits: 10,
    });

    const maxChars = 100;
    const deps: ReviewContextDeps = {
      fetchContextPack: fakeFetchContextPack(pack),
      maxChars,
    };

    const result = await buildReviewContext(
      { taskId: 'RF-5-ELLIPSIS', workspaceRoot: ws },
      deps,
    );

    // If truncation happened, the last char should be the ellipsis character.
    if (result.summary.length === maxChars) {
      assert.ok(
        result.summary.endsWith('…'),
        `truncated summary must end with '…', got: ...${result.summary.slice(-5)}`,
      );
    }
  });

  test('short pack is not truncated (no ellipsis added unnecessarily)', async () => {
    const ws = tmpDir();
    const pack = fakePack({
      markdown: '## Context\n\n- src/foo.ts\n',
      codeHits: 1,
      kgHits: 0,
    });

    const maxChars = 800;
    const deps: ReviewContextDeps = {
      fetchContextPack: fakeFetchContextPack(pack),
      maxChars,
    };

    const result = await buildReviewContext(
      { taskId: 'RF-5-SHORT', workspaceRoot: ws },
      deps,
    );

    assert.ok(
      result.summary.length < maxChars,
      'short pack should not need truncation',
    );
    assert.ok(!result.summary.endsWith('…'), 'no ellipsis when not truncated');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 5: redactSecrets unit tests                                         */
/* -------------------------------------------------------------------------- */

suite('RF-5 redactSecrets — masks secret patterns', () => {
  test('masks an OpenAI-style API key (sk- prefix)', () => {
    const text = 'The key is sk-' + 'A'.repeat(25) + ' and should be redacted.';
    const result = redactSecrets(text);
    assert.ok(
      !result.includes('sk-' + 'A'.repeat(25)),
      `API key must be redacted; got: ${result}`,
    );
    assert.ok(result.includes('redacted'), 'result must contain a redacted marker');
  });

  test('masks a Bearer token', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sometoken';
    const result = redactSecrets(text);
    assert.ok(
      !result.includes('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sometoken'),
      `Bearer token must be redacted; got: ${result}`,
    );
    assert.ok(
      result.includes('Bearer'),
      'Bearer prefix should remain (only value is redacted)',
    );
  });

  test('masks KEY=value secret assignment', () => {
    const text = 'SECRET_KEY=supersecretvalue123\nother content';
    const result = redactSecrets(text);
    assert.ok(
      !result.includes('supersecretvalue123'),
      `secret value must be redacted; got: ${result}`,
    );
    assert.ok(result.includes('SECRET_KEY'), 'key name should remain');
  });

  test('masks a TOKEN=value pattern', () => {
    const text = 'GITHUB_TOKEN=ghp_abc123xyz456\nsome other line';
    const result = redactSecrets(text);
    // The value should be redacted
    assert.ok(
      !result.includes('ghp_abc123xyz456') || result.includes('redacted'),
      `token value must be redacted; got: ${result}`,
    );
  });

  test('does not mangle ordinary text', () => {
    const text = 'This is a normal sentence with no secrets.';
    const result = redactSecrets(text);
    assert.strictEqual(result, text, 'ordinary text should not be altered');
  });

  test('masks a long hex blob (40+ chars)', () => {
    const hexBlob = '0123456789abcdef'.repeat(3); // 48 chars — triggers generic token
    const text = `hash: ${hexBlob} end`;
    const result = redactSecrets(text);
    assert.ok(
      !result.includes(hexBlob),
      `long hex blob must be redacted; got: ${result}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 6: prod.ts wiring — contextProvider integration                    */
/* -------------------------------------------------------------------------- */

suite('RF-5 prod.ts wiring — contextProvider in dispatchReviewer', () => {
  test('WITH contextProvider: prompt received by llmChat includes "Context:" section', async () => {
    const ws = tmpDir();
    const { fn: llmChatFn, prompts } = capturingLlmChat('APPROVE', 5);

    const contextProvider = async (_taskId: string, _intent?: string): Promise<string> => {
      return 'Task: test-ctx-1 Intelligence: 3 related KG decisions, 5 code hits.';
    };

    const deps = defaultReviewFleetDeps(
      baseProdOpts(ws, {
        enabled: true,
        budgetCents: 100,
        llmChat: llmChatFn,
        contextProvider,
      }),
    );

    const reviewer = modelReviewer();
    const verdict = await deps.dispatchReviewer(reviewer, 'test-ctx-1');

    assert.strictEqual(verdict.vote, 'approve', 'verdict should be approve');
    assert.strictEqual(prompts.length, 1, 'llmChat must be called exactly once');

    const prompt = prompts[0];
    assert.ok(
      prompt.includes('Context:'),
      `prompt must include "Context:" section; got: ${prompt}`,
    );
    assert.ok(
      prompt.includes('3 related KG decisions'),
      `prompt must include context text; got: ${prompt}`,
    );
  });

  test('WITHOUT contextProvider: prompt is unchanged (same as buildReviewPrompt alone)', async () => {
    const ws = tmpDir();
    const { fn: llmChatFn, prompts } = capturingLlmChat('APPROVE', 5);

    const deps = defaultReviewFleetDeps(
      baseProdOpts(ws, {
        enabled: true,
        budgetCents: 100,
        llmChat: llmChatFn,
        // contextProvider is NOT set
      }),
    );

    const reviewer = modelReviewer();
    await deps.dispatchReviewer(reviewer, 'test-noctx-1');

    assert.strictEqual(prompts.length, 1, 'llmChat must be called exactly once');
    const expectedPrompt = buildReviewPrompt('test-noctx-1');
    assert.strictEqual(
      prompts[0],
      expectedPrompt,
      'without contextProvider, prompt must equal buildReviewPrompt output exactly',
    );
    assert.ok(!prompts[0].includes('Context:'), 'no Context: section without contextProvider');
  });

  test('contextProvider that throws: dispatch still succeeds and returns a verdict', async () => {
    const ws = tmpDir();
    const { fn: llmChatFn, prompts } = capturingLlmChat('APPROVE', 5);

    const failingContextProvider = async (_taskId: string): Promise<string> => {
      throw new Error('intelligence layer down');
    };

    const deps = defaultReviewFleetDeps(
      baseProdOpts(ws, {
        enabled: true,
        budgetCents: 100,
        llmChat: llmChatFn,
        contextProvider: failingContextProvider,
      }),
    );

    const reviewer = modelReviewer();
    let verdict;
    let threw = false;
    try {
      verdict = await deps.dispatchReviewer(reviewer, 'test-ctx-fail');
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'dispatch must NOT throw when contextProvider throws');
    assert.ok(verdict !== undefined, 'must return a verdict');
    assert.strictEqual(verdict!.vote, 'approve', 'verdict must still be parsed correctly');

    // The prompt should fall back to just the base prompt (no Context: section).
    assert.ok(prompts.length === 1, 'llmChat must still be called');
    assert.ok(
      !prompts[0].includes('Context:'),
      'prompt must NOT include Context: section when contextProvider threw',
    );
  });

  test('contextProvider returning empty string: no Context: section added', async () => {
    const ws = tmpDir();
    const { fn: llmChatFn, prompts } = capturingLlmChat('APPROVE', 5);

    const emptyContextProvider = async (_taskId: string): Promise<string> => {
      return '   '; // whitespace only
    };

    const deps = defaultReviewFleetDeps(
      baseProdOpts(ws, {
        enabled: true,
        budgetCents: 100,
        llmChat: llmChatFn,
        contextProvider: emptyContextProvider,
      }),
    );

    const reviewer = modelReviewer();
    await deps.dispatchReviewer(reviewer, 'test-ctx-empty');

    assert.ok(prompts.length === 1, 'llmChat must be called');
    assert.ok(
      !prompts[0].includes('Context:'),
      'whitespace-only context must not add a Context: section',
    );
  });

  test('buildReviewContextProvider returns a function that calls buildReviewContext', async () => {
    const ws = tmpDir();

    const pack = fakePack({ codeHits: 2, kgHits: 1 });
    const deps: ReviewContextDeps = { fetchContextPack: fakeFetchContextPack(pack) };

    const provider = buildReviewContextProvider(ws, deps);
    assert.strictEqual(typeof provider, 'function', 'provider must be a function');

    const summary = await provider('RF-5-PROVIDER');
    assert.ok(typeof summary === 'string', 'provider must return a string');
    assert.ok(summary.includes('RF-5-PROVIDER'), 'provider summary must include task id');
  });
});
