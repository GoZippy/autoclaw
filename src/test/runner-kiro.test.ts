/**
 * runner-kiro.test.ts — Unit tests for the Kiro runner adapter.
 *
 * Covers (RFC §3, §5.3):
 *  1. `id` — exposes the expected stable runner id.
 *  2. Trust-preset → CLI flag translation via `buildArgs` (pure method, no spawn).
 *  3. `buildArgs` arg construction: chat subcommand, prompt, sessionId, requireMcp,
 *     agentProfile, and trust flags.
 *  4. `detect()` auth branch — when the binary probe would succeed but
 *     `KIRO_API_KEY` is absent, detect() returns no_auth (pure env-var check,
 *     no spawn required for that branch logic — but the binary probe is still
 *     spawned, so this path is not reliably testable without a seam; see SEAM NOTE).
 *  5. `listSessions()` — returns empty list on no output (no IO).
 *  6. `cancel()` — swallows errors gracefully (tested via absence of throw
 *     when the binary does not exist, since it catches internally).
 *
 * SEAM NOTE: `detect()`, `listSessions()` and `cancel()` call `execFile`
 * against the hardcoded `KIRO_BIN = 'kiro-cli'` with no injectable transport
 * and no env-var override.  Subprocess behaviours (binary-present, binary-absent,
 * list-sessions parse) cannot be reliably tested without modifying source.
 * The follow-up task (BL-31) should add an `execOverride` seam.
 *
 * Trust mapping and arg construction are fully exercised via `buildArgs()`.
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { promisify } from 'util';

import { KiroRunner } from '../runners/kiro';
import { TRUST_PRESET_TABLE } from '../runners/registry';
import type { DispatchOptions, TrustPreset } from '../runners/types';
import type { execFile as ExecFileType, spawn as SpawnType } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    prompt: 'fix the tests',
    trust: 'auto',
    workingDir: '/workspace/proj',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-kiro: id and capabilities', () => {
  test('id is "kiro"', () => {
    const runner = new KiroRunner();
    assert.strictEqual(runner.id, 'kiro');
  });

  test('capabilities: resumableSessions=true, mcpServers=true, customAgents=true', () => {
    const runner = new KiroRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, true);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, false);
    assert.strictEqual(runner.capabilities.mcpServers, true);
    assert.strictEqual(runner.capabilities.browser, false);
    assert.strictEqual(runner.capabilities.customAgents, true);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: trust-preset → flag translation (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-kiro: trust-preset → CLI flag translation (RFC §3)', () => {
  const TABLE = TRUST_PRESET_TABLE['kiro'];

  test('TRUST_PRESET_TABLE has kiro entry with off/auto/turbo', () => {
    assert.ok(TABLE !== undefined, 'kiro entry missing from TRUST_PRESET_TABLE');
    assert.ok('off' in TABLE, '"off" missing');
    assert.ok('auto' in TABLE, '"auto" missing');
    assert.ok('turbo' in TABLE, '"turbo" missing');
  });

  test('off → no flags (requires manual approval for every tool)', () => {
    assert.deepStrictEqual(TABLE['off'].flags, []);
  });

  test('auto → --trust-tools=read,grep', () => {
    assert.deepStrictEqual(TABLE['auto'].flags, ['--trust-tools=read,grep']);
  });

  test('turbo → --trust-all-tools', () => {
    assert.deepStrictEqual(TABLE['turbo'].flags, ['--trust-all-tools']);
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

suite('runner-kiro: buildArgs — argument construction', () => {
  let runner: KiroRunner;

  setup(() => {
    runner = new KiroRunner();
  });

  test('first two args are always "chat" and "--no-interactive"', () => {
    const args = runner.buildArgs(baseOpts());
    assert.strictEqual(args[0], 'chat');
    assert.strictEqual(args[1], '--no-interactive');
  });

  test('prompt is always the last positional argument', () => {
    const args = runner.buildArgs(baseOpts({ prompt: 'my prompt text' }));
    assert.strictEqual(args[args.length - 1], 'my prompt text');
  });

  test('off trust → no --trust-tools / --trust-all-tools flags in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'off' }));
    assert.ok(!args.some((a) => a.startsWith('--trust-tools') || a === '--trust-all-tools'),
      'unexpected trust flags for off');
  });

  test('auto trust → --trust-tools=read,grep in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'auto' }));
    assert.ok(args.includes('--trust-tools=read,grep'));
  });

  test('turbo trust → --trust-all-tools in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'turbo' }));
    assert.ok(args.includes('--trust-all-tools'));
  });

  test('requireMcp=true → --require-mcp-startup in args', () => {
    const args = runner.buildArgs(baseOpts({ requireMcp: true }));
    assert.ok(args.includes('--require-mcp-startup'));
  });

  test('requireMcp absent → --require-mcp-startup absent', () => {
    const args = runner.buildArgs(baseOpts());
    assert.ok(!args.includes('--require-mcp-startup'));
  });

  test('agentProfile present → --agent <profile> in args', () => {
    const args = runner.buildArgs(baseOpts({ agentProfile: 'code-reviewer' }));
    const idx = args.indexOf('--agent');
    assert.ok(idx >= 0, '--agent missing');
    assert.strictEqual(args[idx + 1], 'code-reviewer');
  });

  test('sessionId present → --resume-id <id> in args', () => {
    const args = runner.buildArgs(baseOpts({ sessionId: 'kiro-sess-99' }));
    const idx = args.indexOf('--resume-id');
    assert.ok(idx >= 0, '--resume-id missing');
    assert.strictEqual(args[idx + 1], 'kiro-sess-99');
  });

  test('no sessionId → --resume-id absent', () => {
    const args = runner.buildArgs(baseOpts());
    assert.ok(!args.includes('--resume-id'));
  });

  test('all options: trust=turbo + sessionId + agentProfile + requireMcp', () => {
    const args = runner.buildArgs(
      baseOpts({
        trust: 'turbo',
        sessionId: 's1',
        agentProfile: 'qa',
        requireMcp: true,
        prompt: 'run qa suite',
      }),
    );
    assert.strictEqual(args[0], 'chat');
    assert.ok(args.includes('--trust-all-tools'));
    assert.ok(args.includes('--require-mcp-startup'));
    assert.ok(args.includes('--agent'));
    assert.ok(args.includes('--resume-id'));
    // prompt is last
    assert.strictEqual(args[args.length - 1], 'run qa suite');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: listSessions and cancel (error-swallowing behaviour)
// ---------------------------------------------------------------------------

suite('runner-kiro: listSessions and cancel', () => {
  test('cancel() swallows errors — does not throw when binary is absent', async () => {
    // kiro-cli is not installed in CI; cancel() must not propagate the error.
    const runner = new KiroRunner();
    await assert.doesNotReject(() => runner.cancel('nonexistent-session'));
  });

  test('listSessions() returns empty array when binary is absent', async () => {
    // When kiro-cli is not installed, execFile will fail and the catch returns [].
    const runner = new KiroRunner();
    const sessions = await runner.listSessions();
    assert.ok(Array.isArray(sessions));
    // We can only assert it is an array; length depends on environment.
    // On a machine without kiro-cli installed, it will be [].
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
// Suite 5: detect() with injected execFileFn (binary-present / binary-absent)
// ---------------------------------------------------------------------------

suite('runner-kiro: detect() with injected execFileFn', () => {
  let savedKey: string | undefined;

  setup(() => {
    savedKey = process.env.KIRO_API_KEY;
    process.env.KIRO_API_KEY = 'fake-api-key';
  });

  teardown(() => {
    if (savedKey === undefined) {
      delete process.env.KIRO_API_KEY;
    } else {
      process.env.KIRO_API_KEY = savedKey;
    }
  });

  test('binary-present + KIRO_API_KEY set: detect() returns found:true with version', async () => {
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileOk('kiro-cli 2.0.1\n'),
    });
    const result = await runner.detect();
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, 'kiro-cli 2.0.1');
      assert.strictEqual(result.path, 'kiro-cli-fake');
    }
  });

  test('binary-absent (ENOENT): detect() returns found:false, reason:not_installed', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileErr(enoent),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'not_installed');
      assert.ok(result.hint.length > 0);
    }
  });

  test('binary-present but KIRO_API_KEY absent: detect() returns found:false, reason:no_auth', async () => {
    delete process.env.KIRO_API_KEY;
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileOk('kiro-cli 2.0.0\n'),
    });
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'no_auth');
    }
  });

  test('probe error (non-ENOENT): detect() returns found:false without throwing', async () => {
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileErr(new Error('timeout')),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: dispatch() with injected spawnFn
// ---------------------------------------------------------------------------

suite('runner-kiro: dispatch() with injected spawnFn', () => {
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

  test('success: exit 0 → ok:true, exitCode:0, correct trust flags + prompt in args', async () => {
    const captured: { bin?: string; args?: string[] } = {};
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ stdout: 'done', exit: 0 }, captured),
    });
    const result = await runner.dispatch({
      prompt: 'fix the tests',
      trust: 'turbo',
      workingDir: '/workspace/proj',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(captured.bin, 'kiro-cli-fake');
    // Kiro args: ['chat', '--no-interactive', ...trust, prompt]
    assert.strictEqual(captured.args?.[0], 'chat');
    assert.ok(captured.args?.includes('--trust-all-tools'), '--trust-all-tools missing for turbo');
    assert.strictEqual(captured.args?.[captured.args.length - 1], 'fix the tests');
  });

  test('non-zero exit → ok:false, exitCode propagated, mcp_startup for exit 3', async () => {
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ exit: 3 }),
    });
    const result = await runner.dispatch({
      prompt: 'p',
      trust: 'off',
      workingDir: '/tmp',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 3);
    assert.strictEqual(result.errorClass, 'mcp_startup');
  });

  test('spawn error → ok:false with internal errorClass, does not throw', async () => {
    const runner = new KiroRunner({
      bin: 'kiro-cli-fake',
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
    const runner = new KiroRunner();
    assert.strictEqual(runner.id, 'kiro');
  });
});
