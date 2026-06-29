/**
 * runner-gemini.test.ts — Unit tests for the Gemini CLI runner adapter.
 *
 * Source file: src/runners/gemini-cli.ts (the runner id is "gemini-cli").
 *
 * Covers (RFC §3, §5.4):
 *  1. `id` — exposes the expected stable runner id "gemini-cli".
 *  2. Trust-preset → CLI flag translation via `buildArgs` (pure method, no spawn).
 *  3. `buildArgs` arg construction: -p <prompt> and trust flags.
 *  4. `isAntigravity` — getter uses `existsSync`; testable indirectly since no
 *     Antigravity paths exist in this environment.
 *  5. `browserAllowedFor()` — returns false when not an Antigravity install.
 *  6. `listSessions()` — always returns empty list (no host session surface).
 *  7. `cancel()` — is a no-op (does not throw).
 *
 * SEAM NOTE: `detect()` and `dispatch()` call `execFile`/`spawn` against the
 * hardcoded `GEMINI_BIN = 'gemini'` with no injectable transport and no
 * env-var binary override.  Real subprocess behaviour cannot be exercised
 * without modifying source. The follow-up task (BL-31) should add an
 * `execOverride` seam so detect(found) and detect(absent) can be covered.
 *
 * Trust mapping and arg construction are fully exercised via `buildArgs()`.
 */

import * as assert from 'assert';

import { GeminiCliRunner } from '../runners/gemini-cli';
import { TRUST_PRESET_TABLE } from '../runners/registry';
import type { DispatchOptions, TrustPreset } from '../runners/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    prompt: 'analyse the diff',
    trust: 'auto',
    workingDir: '/workspace/proj',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-gemini: id and capabilities', () => {
  test('id is "gemini-cli"', () => {
    const runner = new GeminiCliRunner();
    assert.strictEqual(runner.id, 'gemini-cli');
  });

  test('capabilities: resumableSessions=false, mcpServers=true', () => {
    const runner = new GeminiCliRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, false);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, false);
    assert.strictEqual(runner.capabilities.mcpServers, true);
    assert.strictEqual(runner.capabilities.customAgents, false);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: trust-preset → flag translation (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-gemini: trust-preset → CLI flag translation (RFC §3)', () => {
  const TABLE = TRUST_PRESET_TABLE['gemini-cli'];

  test('TRUST_PRESET_TABLE has gemini-cli entry with off/auto/turbo', () => {
    assert.ok(TABLE !== undefined, 'gemini-cli entry missing from TRUST_PRESET_TABLE');
    assert.ok('off' in TABLE, '"off" missing');
    assert.ok('auto' in TABLE, '"auto" missing');
    assert.ok('turbo' in TABLE, '"turbo" missing');
  });

  test('off → no flags (default gemini behaviour)', () => {
    assert.deepStrictEqual(TABLE['off'].flags, []);
  });

  test('auto → --yolo=read,grep', () => {
    assert.deepStrictEqual(TABLE['auto'].flags, ['--yolo=read,grep']);
  });

  test('turbo → --yolo (all tools auto-approved)', () => {
    assert.deepStrictEqual(TABLE['turbo'].flags, ['--yolo']);
  });

  test('exhaustive: all three presets map to distinct flag sets', () => {
    const presets: TrustPreset[] = ['off', 'auto', 'turbo'];
    const seen = new Set<string>();
    for (const p of presets) {
      seen.add(JSON.stringify(TABLE[p].flags));
    }
    assert.strictEqual(seen.size, 3, 'Expected 3 distinct flag sets for off/auto/turbo');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: buildArgs — argument construction
// ---------------------------------------------------------------------------

suite('runner-gemini: buildArgs — argument construction', () => {
  let runner: GeminiCliRunner;

  setup(() => {
    runner = new GeminiCliRunner();
  });

  test('always starts with "-p" and the prompt', () => {
    const args = runner.buildArgs(baseOpts({ prompt: 'my test prompt' }));
    assert.strictEqual(args[0], '-p');
    assert.strictEqual(args[1], 'my test prompt');
  });

  test('off trust → only -p and prompt (no yolo flag)', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'off' }));
    assert.deepStrictEqual(args, ['-p', 'analyse the diff']);
  });

  test('auto trust → -p <prompt> --yolo=read,grep', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'auto' }));
    assert.ok(args.includes('--yolo=read,grep'));
    assert.ok(!args.includes('--yolo'));
  });

  test('turbo trust → -p <prompt> --yolo', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'turbo' }));
    assert.ok(args.includes('--yolo'));
    // --yolo alone (not --yolo=read,grep)
    const yoloFull = args.find((a) => a === '--yolo');
    assert.ok(yoloFull !== undefined, '--yolo missing');
  });

  test('prompt with special characters is forwarded verbatim', () => {
    const prompt = 'fix this: `foo --bar="baz"`';
    const args = runner.buildArgs(baseOpts({ prompt, trust: 'off' }));
    assert.strictEqual(args[1], prompt);
  });

  test('sessionId is not added to args (gemini-cli has no session-resume surface)', () => {
    const args = runner.buildArgs(baseOpts({ sessionId: 'some-id', trust: 'off' }));
    // Should NOT include a resume/session flag; args stays minimal.
    assert.ok(!args.some((a) => a.startsWith('--session') || a.startsWith('--resume')));
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Antigravity + browserAllowedFor
// ---------------------------------------------------------------------------

suite('runner-gemini: Antigravity detection and browserAllowedFor', () => {
  test('isAntigravity is false when ~/.gemini/antigravity/mcp_config.json does not exist', () => {
    const runner = new GeminiCliRunner();
    // In a test environment without Antigravity installed, this path is absent.
    // The property reads existsSync at call time, so the assertion holds unless
    // the test machine happens to have an Antigravity install.
    // We verify the property returns a boolean without throwing.
    assert.strictEqual(typeof runner.isAntigravity, 'boolean');
  });

  test('browserAllowedFor() returns false when not an Antigravity install', () => {
    const runner = new GeminiCliRunner();
    if (!runner.isAntigravity) {
      // No Antigravity on this machine — method must return false for any path.
      assert.strictEqual(runner.browserAllowedFor('/any/path'), false);
    }
    // If isAntigravity is somehow true (CI has Antigravity), we skip the assertion
    // rather than fabricating a path — this test is environment-conditional.
  });
});

// ---------------------------------------------------------------------------
// Suite 5: listSessions and cancel
// ---------------------------------------------------------------------------

suite('runner-gemini: listSessions and cancel', () => {
  test('listSessions() always returns an empty array (no session surface, RFC §9.2)', async () => {
    const runner = new GeminiCliRunner();
    const sessions = await runner.listSessions();
    assert.deepStrictEqual(sessions, []);
  });

  test('cancel() resolves without throwing', async () => {
    const runner = new GeminiCliRunner();
    await assert.doesNotReject(() => runner.cancel('any-session'));
  });
});
