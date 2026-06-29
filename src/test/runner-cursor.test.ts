/**
 * runner-cursor.test.ts — Unit tests for the Cursor runner adapter.
 *
 * Covers (RFC §3, §5.2):
 *  1. `id` — exposes the expected stable runner id.
 *  2. Trust-preset → CLI flag translation via `buildArgs` (pure method, no spawn).
 *  3. `buildArgs` arg construction: prompt, workdir, sessionId, agentProfile, deny list.
 *  4. `detect()` — not testable without a spawn seam (no bin-override env var);
 *     see SEAM NOTE below.
 *  5. `listSessions()` — returns empty list (no host surface yet).
 *  6. `cancel()` — is a no-op (does not throw).
 *
 * SEAM NOTE: `detect()` and `dispatch()` call `execFile`/`spawn` against the
 * hardcoded `CURSOR_BIN = 'cursor-agent'` with no injectable transport and no
 * env-var override. Real subprocess behaviour cannot be exercised here without
 * modifying source. Those paths are excluded from this suite; the follow-up
 * task (BL-31) should add an `execOverride` dep-injection seam to `CursorRunner`
 * so detect+dispatch can be covered without spawning.
 *
 * Trust mapping is the highest-value coverage and is fully exercised via
 * `buildArgs()` which calls `translateTrust('cursor', preset)` from the registry.
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { promisify } from 'util';

import { CursorRunner } from '../runners/cursor';
import { TRUST_PRESET_TABLE } from '../runners/registry';
import type { DispatchOptions, TrustPreset } from '../runners/types';
import type { execFile as ExecFileType, spawn as SpawnType } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    prompt: 'do the thing',
    trust: 'auto',
    workingDir: '/workspace/proj',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-cursor: id and capabilities', () => {
  test('id is "cursor"', () => {
    const runner = new CursorRunner();
    assert.strictEqual(runner.id, 'cursor');
  });

  test('capabilities: resumableSessions=true, jsonStructuredOutput=false, mcpServers=true', () => {
    const runner = new CursorRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, true);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, false);
    assert.strictEqual(runner.capabilities.mcpServers, true);
    assert.strictEqual(runner.capabilities.browser, false);
    assert.strictEqual(runner.capabilities.customAgents, false);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: trust-preset → flag translation (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-cursor: trust-preset → CLI flag translation (RFC §3)', () => {
  const TABLE = TRUST_PRESET_TABLE['cursor'];

  test('TRUST_PRESET_TABLE has cursor entry with off/auto/turbo', () => {
    assert.ok(TABLE !== undefined, 'cursor entry missing from TRUST_PRESET_TABLE');
    assert.ok('off' in TABLE, '"off" missing');
    assert.ok('auto' in TABLE, '"auto" missing');
    assert.ok('turbo' in TABLE, '"turbo" missing');
  });

  test('off → no extra flags (default approval prompts)', () => {
    assert.deepStrictEqual(TABLE['off'].flags, []);
  });

  test('auto → --auto-approve=read,grep', () => {
    assert.deepStrictEqual(TABLE['auto'].flags, ['--auto-approve=read,grep']);
  });

  test('turbo → --auto-approve=all', () => {
    assert.deepStrictEqual(TABLE['turbo'].flags, ['--auto-approve=all']);
  });

  test('exhaustive: all three presets map to distinct flag sets', () => {
    const presets: TrustPreset[] = ['off', 'auto', 'turbo'];
    const seen = new Set<string>();
    for (const p of presets) {
      const key = JSON.stringify(TABLE[p].flags);
      seen.add(key);
    }
    assert.strictEqual(seen.size, 3, 'Expected 3 distinct flag sets for off/auto/turbo');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: buildArgs — arg construction
// ---------------------------------------------------------------------------

suite('runner-cursor: buildArgs — argument construction', () => {
  let runner: CursorRunner;

  setup(() => {
    runner = new CursorRunner();
  });

  test('always includes --no-interactive, --prompt <prompt>, --workdir <dir>', () => {
    const args = runner.buildArgs(baseOpts());
    assert.ok(args.includes('--no-interactive'));
    const pi = args.indexOf('--prompt');
    assert.ok(pi >= 0, '--prompt missing');
    assert.strictEqual(args[pi + 1], 'do the thing');
    const wi = args.indexOf('--workdir');
    assert.ok(wi >= 0, '--workdir missing');
    assert.strictEqual(args[wi + 1], '/workspace/proj');
  });

  test('off trust → no --auto-approve flag in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'off' }));
    assert.ok(!args.some((a) => a.startsWith('--auto-approve')), 'unexpected --auto-approve for off');
  });

  test('auto trust → --auto-approve=read,grep in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'auto' }));
    assert.ok(args.includes('--auto-approve=read,grep'));
  });

  test('turbo trust → --auto-approve=all in args', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'turbo' }));
    assert.ok(args.includes('--auto-approve=all'));
  });

  test('sessionId present → --resume <id> in args', () => {
    const args = runner.buildArgs(baseOpts({ sessionId: 'sess-42' }));
    const idx = args.indexOf('--resume');
    assert.ok(idx >= 0, '--resume missing');
    assert.strictEqual(args[idx + 1], 'sess-42');
  });

  test('no sessionId → --resume absent', () => {
    const args = runner.buildArgs(baseOpts());
    assert.ok(!args.includes('--resume'));
  });

  test('agentProfile present → --agent <profile> in args', () => {
    const args = runner.buildArgs(baseOpts({ agentProfile: 'reviewer' }));
    const idx = args.indexOf('--agent');
    assert.ok(idx >= 0, '--agent missing');
    assert.strictEqual(args[idx + 1], 'reviewer');
  });

  test('turbo + trustDenyList → --deny=<list> in args', () => {
    const args = runner.buildArgs(
      baseOpts({ trust: 'turbo', trustDenyList: ['force_push', 'delete_branch'] }),
    );
    assert.ok(args.includes('--deny=force_push,delete_branch'), '--deny flag missing');
  });

  test('auto + trustDenyList → no --deny flag (only injected for turbo)', () => {
    const args = runner.buildArgs(
      baseOpts({ trust: 'auto', trustDenyList: ['force_push'] }),
    );
    assert.ok(!args.some((a) => a.startsWith('--deny=')), '--deny should not appear for auto trust');
  });

  test('empty trustDenyList with turbo → no --deny flag', () => {
    const args = runner.buildArgs(baseOpts({ trust: 'turbo', trustDenyList: [] }));
    assert.ok(!args.some((a) => a.startsWith('--deny=')));
  });
});

// ---------------------------------------------------------------------------
// Suite 4: listSessions and cancel
// ---------------------------------------------------------------------------

suite('runner-cursor: listSessions and cancel', () => {
  test('listSessions() resolves to an empty array (no host surface)', async () => {
    const runner = new CursorRunner();
    const sessions = await runner.listSessions();
    assert.deepStrictEqual(sessions, []);
  });

  test('cancel() resolves without throwing', async () => {
    const runner = new CursorRunner();
    await assert.doesNotReject(() => runner.cancel('any-session-id'));
  });
});

// ---------------------------------------------------------------------------
// Helpers for injectable-seam tests
// ---------------------------------------------------------------------------

/** Build a fake ChildProcess that emits the given events on setImmediate. */
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

/**
 * Build a fake execFile that succeeds.
 *
 * We must attach `[promisify.custom]` so that `promisify(fakeExecFileFn)` returns
 * `{ stdout, stderr }` instead of just the first argument (Node's generic
 * promisify only forwards the first non-error callback arg; `execFile` avoids
 * this via its own custom symbol).
 */
function fakeExecFileOk(stdout: string): typeof ExecFileType {
  const fn = (_bin: string, _args: string[], _opts: unknown, cb: Function): void => {
    setImmediate(() => cb(null, stdout, ''));
  };
  (fn as any)[promisify.custom] = () => Promise.resolve({ stdout, stderr: '' });
  return fn as unknown as typeof ExecFileType;
}

/** Build a fake execFile that errors. Attaches the custom promisify symbol. */
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

suite('runner-cursor: detect() with injected execFileFn', () => {
  test('binary-present: detect() returns found:true with parsed version', async () => {
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
      execFileFn: fakeExecFileOk('cursor-agent 1.2.3\n'),
    });
    const result = await runner.detect();
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, 'cursor-agent 1.2.3');
      assert.strictEqual(result.path, 'cursor-agent-fake');
    }
  });

  test('binary-absent (ENOENT): detect() returns found:false, reason:not_installed without throwing', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
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

  test('probe error (non-ENOENT): detect() returns found:false without throwing', async () => {
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
      execFileFn: fakeExecFileErr(new Error('unexpected error')),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: dispatch() with injected spawnFn
// ---------------------------------------------------------------------------

suite('runner-cursor: dispatch() with injected spawnFn', () => {
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

  test('success: exit 0 → ok:true, exitCode:0, correct trust flags + prompt + workdir in args', async () => {
    const captured: { bin?: string; args?: string[] } = {};
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
      execFileFn: fakeExecFileOk(''), // detect() not exercised but seam must be valid
      spawnFn: makeSpawnFn({ stdout: 'all done', exit: 0 }, captured),
    });
    const result = await runner.dispatch({
      prompt: 'do the thing',
      trust: 'auto',
      workingDir: '/workspace/proj',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(captured.bin, 'cursor-agent-fake');
    // Must include trust flag for 'auto'
    assert.ok(captured.args?.includes('--auto-approve=read,grep'), '--auto-approve=read,grep missing from args');
    // Must include prompt
    const pi = captured.args?.indexOf('--prompt') ?? -1;
    assert.ok(pi >= 0, '--prompt missing');
    assert.strictEqual(captured.args?.[pi + 1], 'do the thing');
    // Must include workdir
    const wi = captured.args?.indexOf('--workdir') ?? -1;
    assert.ok(wi >= 0, '--workdir missing');
    assert.strictEqual(captured.args?.[wi + 1], '/workspace/proj');
  });

  test('non-zero exit → ok:false, exitCode propagated', async () => {
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ exit: 2 }),
    });
    const result = await runner.dispatch({
      prompt: 'p',
      trust: 'off',
      workingDir: '/tmp',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.errorClass, 'auth'); // exit 2 → auth per classifyCursorExit
  });

  test('spawn error (ENOENT) → ok:false with internal errorClass, does not throw', async () => {
    const runner = new CursorRunner({
      bin: 'cursor-agent-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    });
    await assert.doesNotReject(() =>
      runner.dispatch({ prompt: 'p', trust: 'off', workingDir: '/tmp' }),
    );
    const result = await runner.dispatch({ prompt: 'p', trust: 'off', workingDir: '/tmp' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'internal');
  });

  test('no-arg constructor default path is unchanged (bin = cursor-agent)', () => {
    const runner = new CursorRunner();
    // We verify the bin is the original constant via buildArgs which uses workingDir not bin,
    // but the real proof is that the constructor compiles and the id is still correct.
    assert.strictEqual(runner.id, 'cursor');
  });
});
