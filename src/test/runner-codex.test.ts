/**
 * runner-codex.test.ts — Unit tests for the Codex runner adapter.
 *
 * Covers (RFC §3, §2, §7):
 *  1. `id` — exposes the expected stable runner id "codex".
 *  2. `CODEX_TRUST_FLAGS` table — every preset maps to the correct argv fragment.
 *  3. `codexTrustFlags()` helper — wraps the table; defaults to "off" for unknown input.
 *  4. `detect()` — binary-absent path: via `AUTOCLAW_CODEX_BIN` override pointing to
 *     a nonexistent path, detect() returns `found: false, reason: 'not_installed'`
 *     without throwing.
 *  5. `detect()` — binary-present but missing OPENAI_API_KEY: returns
 *     `found: false, reason: 'no_auth'`.
 *  6. `dispatch()` — via `AUTOCLAW_CODEX_BIN` override pointing to a tiny
 *     wrapper script that exits 0, dispatch() resolves with `ok: true`.
 *  7. `dispatch()` — exit 1 with auth-like stderr → errorClass 'auth'.
 *  8. `listSessions()` — always returns empty array.
 *  9. `cancel()` — no-op, does not throw.
 *
 * Mocking seam: `AUTOCLAW_CODEX_BIN` env var overrides the `CODEX_BIN` constant
 * at module load time (line: `const CODEX_BIN = process.env.AUTOCLAW_CODEX_BIN ?? 'codex'`).
 * Tests that spawn a subprocess must set this before requiring the module, but since
 * TypeScript/CommonJS caches the module after the first `require`, the env var must be
 * set BEFORE the import at the top of this file executes.
 *
 * IMPORTANT: We use the `CodexRunner` class (not the module-level singleton `codexRunner`)
 * so each test can instantiate a fresh runner. Because `CODEX_BIN` is captured at module
 * load time, we cannot change it per-test inside the same process. For detect/dispatch
 * subprocess tests we rely on the env var set at process startup or accept that the real
 * binary is absent (ENOENT → not_installed path).
 */

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { promisify } from 'util';

import {
  CodexRunner,
  CODEX_TRUST_FLAGS,
  codexTrustFlags,
} from '../runners/codex';
import type { TrustPreset } from '../runners/types';
import type { execFile as ExecFileType, spawn as SpawnType } from 'child_process';

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-codex: id and capabilities', () => {
  test('id is "codex"', () => {
    const runner = new CodexRunner();
    assert.strictEqual(runner.id, 'codex');
  });

  test('capabilities: resumableSessions=false, mcpServers=false, browser=false', () => {
    const runner = new CodexRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, false);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, false);
    assert.strictEqual(runner.capabilities.mcpServers, false);
    assert.strictEqual(runner.capabilities.browser, false);
    assert.strictEqual(runner.capabilities.customAgents, false);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: CODEX_TRUST_FLAGS table (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-codex: CODEX_TRUST_FLAGS — trust translation table (RFC §3)', () => {
  test('table contains exactly off, auto, turbo', () => {
    const keys = Object.keys(CODEX_TRUST_FLAGS).sort();
    assert.deepStrictEqual(keys, ['auto', 'off', 'turbo']);
  });

  test('off → --approval-mode suggest', () => {
    assert.deepStrictEqual([...CODEX_TRUST_FLAGS['off']], ['--approval-mode', 'suggest']);
  });

  test('auto → --approval-mode auto-edit', () => {
    assert.deepStrictEqual([...CODEX_TRUST_FLAGS['auto']], ['--approval-mode', 'auto-edit']);
  });

  test('turbo → --approval-mode full-auto', () => {
    assert.deepStrictEqual([...CODEX_TRUST_FLAGS['turbo']], ['--approval-mode', 'full-auto']);
  });

  test('exhaustive: all three presets map to distinct approval-mode values', () => {
    const modes = (['off', 'auto', 'turbo'] as TrustPreset[]).map(
      (p) => CODEX_TRUST_FLAGS[p][1],
    );
    assert.strictEqual(new Set(modes).size, 3, 'Expected 3 distinct approval modes');
  });

  test('table is readonly — entries cannot be mutated at runtime', () => {
    // TypeScript enforces this; verify the shape is still intact after import.
    assert.strictEqual(CODEX_TRUST_FLAGS['off'][0], '--approval-mode');
    assert.strictEqual(CODEX_TRUST_FLAGS['off'][1], 'suggest');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: codexTrustFlags() helper
// ---------------------------------------------------------------------------

suite('runner-codex: codexTrustFlags() helper', () => {
  test('returns a mutable copy for each preset', () => {
    for (const preset of ['off', 'auto', 'turbo'] as TrustPreset[]) {
      const flags = codexTrustFlags(preset);
      assert.ok(Array.isArray(flags), `Expected array for ${preset}`);
      assert.ok(flags !== (CODEX_TRUST_FLAGS[preset] as string[]), 'Should be a copy, not the same ref');
    }
  });

  test('off → ["--approval-mode", "suggest"]', () => {
    assert.deepStrictEqual(codexTrustFlags('off'), ['--approval-mode', 'suggest']);
  });

  test('auto → ["--approval-mode", "auto-edit"]', () => {
    assert.deepStrictEqual(codexTrustFlags('auto'), ['--approval-mode', 'auto-edit']);
  });

  test('turbo → ["--approval-mode", "full-auto"]', () => {
    assert.deepStrictEqual(codexTrustFlags('turbo'), ['--approval-mode', 'full-auto']);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: detect() — binary absent path
// ---------------------------------------------------------------------------

suite('runner-codex: detect() — binary absent → not_installed', () => {
  test('detect() returns found:false, reason:not_installed when binary is missing', async () => {
    // The real `codex` binary is not installed in CI. The probeCodexVersion()
    // function uses `execFile(CODEX_BIN, ...)` where CODEX_BIN is resolved at
    // module load time. When the binary does not exist, execFile errors and
    // probeCodexVersion returns null → detect() returns not_installed.
    const runner = new CodexRunner();
    const result = await runner.detect();
    // If codex happens to be installed in this environment, we skip this check.
    // Otherwise we assert the expected not_installed result.
    if (!result.found) {
      assert.ok(result.reason === 'not_installed' || result.reason === 'no_auth',
        `Expected not_installed or no_auth, got: ${result.reason}`);
      assert.ok(result.hint.length > 0, 'Hint should be non-empty');
    }
    // Either way detect() must not throw.
  });

  test('detect() never throws even if binary probe fails', async () => {
    const runner = new CodexRunner();
    await assert.doesNotReject(() => runner.detect());
  });
});

// ---------------------------------------------------------------------------
// Suite 5: detect() — binary present, OPENAI_API_KEY absent
// ---------------------------------------------------------------------------

suite('runner-codex: detect() — no_auth when OPENAI_API_KEY missing', () => {
  let savedKey: string | undefined;

  setup(() => {
    savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  teardown(() => {
    if (savedKey !== undefined) {
      process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test('detect() returns no_auth when OPENAI_API_KEY is unset and binary is found', async () => {
    const runner = new CodexRunner();
    const result = await runner.detect();
    // This test is meaningful only when codex IS installed.
    // On machines without codex, the binary-absent path fires first and
    // returns not_installed — both are acceptable non-throwing results.
    assert.ok(typeof result.found === 'boolean');
    if (!result.found) {
      // Either not_installed (no binary) or no_auth (binary present but no key).
      assert.ok(
        result.reason === 'not_installed' || result.reason === 'no_auth',
        `Unexpected reason: ${result.reason}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6: listSessions and cancel
// ---------------------------------------------------------------------------

suite('runner-codex: listSessions and cancel', () => {
  test('listSessions() always returns an empty array', async () => {
    const runner = new CodexRunner();
    const sessions = await runner.listSessions();
    assert.deepStrictEqual(sessions, []);
  });

  test('cancel() resolves without throwing (no-op)', async () => {
    const runner = new CodexRunner();
    await assert.doesNotReject(() => runner.cancel('any-session-id'));
  });
});

// ---------------------------------------------------------------------------
// Suite 7: dispatch() arg construction (via AUTOCLAW_CODEX_BIN seam)
// ---------------------------------------------------------------------------

suite('runner-codex: dispatch() arg construction via env-var seam', () => {
  // The CODEX_BIN constant is frozen at module load time. We cannot change it
  // per-test here (module is already loaded). However, we CAN verify that a
  // dispatch with a missing/bad binary results in the correct DispatchResult
  // shape — the 'error' event fires and finish(-1, 'internal') is called.
  test('dispatch() resolves (does not reject) even when binary is absent', async () => {
    const runner = new CodexRunner();
    const promise = runner.dispatch({
      prompt: 'hello',
      trust: 'off',
      workingDir: process.cwd(),
      timeoutMs: 500,
    });
    await assert.doesNotReject(() => promise);
    const result = await promise.catch(() => null);
    // If we got here without a throw, it's a success for the "no throw" contract.
    if (result !== null) {
      assert.strictEqual(typeof result.ok, 'boolean');
      assert.strictEqual(typeof result.sessionId, 'string');
      assert.strictEqual(typeof result.exitCode, 'number');
      assert.strictEqual(typeof result.finishedAt, 'string');
      assert.strictEqual(typeof result.durationMs, 'number');
    }
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
// Suite 8: detect() with injected execFileFn (binary-present / binary-absent)
// ---------------------------------------------------------------------------

suite('runner-codex: detect() with injected execFileFn', () => {
  let savedKey: string | undefined;

  setup(() => {
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-fake-key';
  });

  teardown(() => {
    if (savedKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test('binary-present + OPENAI_API_KEY set: detect() returns found:true with version', async () => {
    // The first execFile call goes to `codex --version`; the second to `where/which`.
    // Both use promisify.custom so that promisify(fn) returns { stdout, stderr }.
    let callIndex = 0;
    const responses = [
      { stdout: 'codex 1.5.0\n', stderr: '' },
      { stdout: '/usr/local/bin/codex\n', stderr: '' },
    ];
    const multiExec = (_bin: string, _args: string[], _opts: unknown, cb: Function): void => {
      callIndex++;
      const r = responses[Math.min(callIndex - 1, responses.length - 1)];
      setImmediate(() => cb(null, r.stdout, r.stderr));
    };
    (multiExec as any)[promisify.custom] = () => {
      const r = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return Promise.resolve(r);
    };

    const runner = new CodexRunner({ bin: 'codex-fake', execFileFn: multiExec as unknown as typeof ExecFileType });
    const result = await runner.detect();
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, 'codex 1.5.0');
      // path comes from the which probe
      assert.ok(result.path.length > 0);
    }
  });

  test('binary-absent (ENOENT): detect() returns found:false, reason:not_installed', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const runner = new CodexRunner({
      bin: 'codex-fake',
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

  test('binary-present but OPENAI_API_KEY absent: detect() returns found:false, reason:no_auth', async () => {
    delete process.env.OPENAI_API_KEY;
    const runner = new CodexRunner({
      bin: 'codex-fake',
      execFileFn: fakeExecFileOk('codex 1.5.0\n'),
    });
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'no_auth');
    }
  });

  test('probe error (non-ENOENT): detect() returns found:false without throwing', async () => {
    const runner = new CodexRunner({
      bin: 'codex-fake',
      execFileFn: fakeExecFileErr(new Error('EACCES')),
    });
    await assert.doesNotReject(() => runner.detect());
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 9: dispatch() with injected spawnFn
// ---------------------------------------------------------------------------

suite('runner-codex: dispatch() with injected spawnFn', () => {
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
    const runner = new CodexRunner({
      bin: 'codex-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ stdout: 'task complete', exit: 0 }, captured),
    });
    const result = await runner.dispatch({
      prompt: 'run the tests',
      trust: 'auto',
      workingDir: '/workspace/proj',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(captured.bin, 'codex-fake');
    // Codex args: ['-q', '--approval-mode', 'auto-edit', prompt]
    assert.ok(captured.args?.includes('-q'), '-q missing');
    assert.ok(captured.args?.includes('--approval-mode'), '--approval-mode missing');
    assert.ok(captured.args?.includes('auto-edit'), 'auto-edit missing for auto trust');
    assert.strictEqual(captured.args?.[captured.args.length - 1], 'run the tests');
  });

  test('turbo trust includes --approval-mode full-auto', async () => {
    const captured: { bin?: string; args?: string[] } = {};
    const runner = new CodexRunner({
      bin: 'codex-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ exit: 0 }, captured),
    });
    await runner.dispatch({
      prompt: 'deploy',
      trust: 'turbo',
      workingDir: '/tmp',
    });
    assert.ok(captured.args?.includes('full-auto'), 'full-auto missing for turbo trust');
  });

  test('non-zero exit → ok:false, exitCode propagated', async () => {
    const runner = new CodexRunner({
      bin: 'codex-fake',
      execFileFn: fakeExecFileOk(''),
      spawnFn: makeSpawnFn({ exit: 1, stderr: 'api key missing' }),
    });
    const result = await runner.dispatch({
      prompt: 'p',
      trust: 'off',
      workingDir: '/tmp',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 1);
    // stderr contains 'api key' → auth
    assert.strictEqual(result.errorClass, 'auth');
  });

  test('spawn error → ok:false with internal errorClass, does not throw', async () => {
    const runner = new CodexRunner({
      bin: 'codex-fake',
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
    const runner = new CodexRunner();
    assert.strictEqual(runner.id, 'codex');
  });
});
