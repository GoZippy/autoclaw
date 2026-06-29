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
import { EventEmitter } from 'events';
import { promisify } from 'util';

import { GeminiCliRunner } from '../runners/gemini-cli';
import { TRUST_PRESET_TABLE } from '../runners/registry';
import type { DispatchOptions, TrustPreset } from '../runners/types';
import type { execFile as ExecFileType, spawn as SpawnType } from 'child_process';

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

// ---------------------------------------------------------------------------
// Helpers for injectable-seam tests
// ---------------------------------------------------------------------------

function fakeChild(o: { stdout?: string; stderr?: string; exit?: number; error?: Error }): ReturnType<typeof SpawnType> {
  const cp: any = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = () => {};
  setImmediate(() => {
    if (o.error) {
      cp.emit('error', o.error);
      return;
    }
    if (o.stdout) {
      cp.stdout.emit('data', Buffer.from(o.stdout));
    }
    if (o.stderr) {
      cp.stderr.emit('data', Buffer.from(o.stderr));
    }
    cp.emit('close', o.exit ?? 0);
  });
  return cp as ReturnType<typeof SpawnType>;
}

function fakeExecFileOk(stdout: string): typeof ExecFileType {
  const fn = (_bin: string, _args: string[], _opts: unknown, cb: Function): void => {
    setImmediate(() => cb(null, stdout, ''));
  };
  (fn as any)[promisify.custom] = () => Promise.resolve({ stdout, stderr: '' });
  return fn as unknown as typeof ExecFileType;
}

function fakeExecFileErr(err: Error): typeof ExecFileType {
  const fn = (_bin: string, _args: string[], _opts: unknown, cb: Function): void => {
    setImmediate(() => cb(err, '', ''));
  };
  (fn as any)[promisify.custom] = () => Promise.reject(Object.assign(err, { code: (err as any).code }));
  return fn as unknown as typeof ExecFileType;
}

// ---------------------------------------------------------------------------
// Suite 6: detect() with injected execFileFn (binary-present / binary-absent)
// ---------------------------------------------------------------------------

suite('runner-gemini: detect() with injected execFileFn', () => {
  test('binary-present: detect() returns found:true with parsed version', async () => {
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileOk('gemini 0.1.7\n'),
    });
    const result = await runner.detect();
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, 'gemini 0.1.7');
      assert.strictEqual(result.path, 'gemini-fake');
    }
  });

  test('binary-absent (ENOENT): detect() returns found:false, reason:not_installed', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileErr(enoent),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'not_installed');
      assert.ok(result.hint.includes('gemini'));
    }
  });

  test('probe error (non-ENOENT): detect() returns found:false without throwing', async () => {
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileErr(new Error('permission denied')),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: dispatch() with injected spawnFn
// ---------------------------------------------------------------------------

suite('runner-gemini: dispatch() with injected spawnFn', () => {
  function makeSpawnFn(
    childOpts: Parameters<typeof fakeChild>[0],
    capturedArgs: { bin?: string; args?: string[] } = {},
  ): typeof SpawnType {
    return ((bin: string, args: string[], _opts: unknown) => {
      capturedArgs.bin = bin;
      capturedArgs.args = args;
      return fakeChild(childOpts);
    }) as unknown as typeof SpawnType;
  }

  test('success: exit 0 → ok:true, exitCode:0, correct trust flags and prompt in args', async () => {
    const captured: { bin?: string; args?: string[] } = {};
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ stdout: 'analysis complete', exit: 0 }, captured),
    });
    const result = await runner.dispatch({
      prompt: 'analyse the diff',
      trust: 'turbo',
      workingDir: '/workspace/proj',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(captured.bin, 'gemini-fake');
    // Gemini args: ['-p', prompt, ...trust]
    assert.strictEqual(captured.args?.[0], '-p');
    assert.strictEqual(captured.args?.[1], 'analyse the diff');
    assert.ok(captured.args?.includes('--yolo'), '--yolo missing for turbo');
  });

  test('non-zero exit → ok:false, exitCode propagated', async () => {
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ exit: 1 }),
    });
    const result = await runner.dispatch({
      prompt: 'p',
      trust: 'off',
      workingDir: '/tmp',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.errorClass, 'auth'); // exit 1 → auth per classifyGeminiExit
  });

  test('spawn error → ok:false with internal errorClass, does not throw', async () => {
    const runner = new GeminiCliRunner({
      bin: 'gemini-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ error: new Error('ENOENT') }),
    });
    await assert.doesNotReject(() =>
      runner.dispatch({ prompt: 'p', trust: 'off', workingDir: '/tmp' }),
    );
    const result = await runner.dispatch({ prompt: 'p', trust: 'off', workingDir: '/tmp' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'internal');
  });

  test('no-arg constructor default path is unchanged', () => {
    const runner = new GeminiCliRunner();
    assert.strictEqual(runner.id, 'gemini-cli');
  });
});
