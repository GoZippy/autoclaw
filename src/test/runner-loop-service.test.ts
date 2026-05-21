/**
 * runner-loop-service.test.ts — Unit tests for the generic LoopServiceAdapter
 * and the AutoGPT + Claude Desktop runners (Sprint 4 / WA-2, F4 + F5).
 *
 * Covers:
 *  1. `parseLoopServicesConfig` — config array validation.
 *  2. `loopServiceAutonomy` / `loopServiceErrorClass` / `classifyLoopState`.
 *  3. `LoopServiceAdapter` route + auth resolution.
 *  4. AutoGPT remote-vs-local detection + request-body shape.
 *  5. `detectHostContext` for the Claude Desktop runner.
 *  6. `buildDesktopCliArgs` — --session-id assignment vs --resume.
 *  7. `DesktopSessionStore` restart-safe persistence.
 *  8. `ClaudeDesktopRunner.dispatch` against an injected mock transport.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LoopServiceAdapter,
  classifyLoopState,
  loopServiceAutonomy,
  loopServiceErrorClass,
  parseLoopServicesConfig,
} from '../runners/loop-service-adapter';
import { AutoGptRunner } from '../runners/autogpt';
import {
  ClaudeDesktopRunner,
  DesktopSessionStore,
  buildDesktopCliArgs,
  detectHostContext,
  type DesktopRunArgs,
  type DesktopTransport,
} from '../runners/claude-desktop';
import type { ClaudeRunOutcome } from '../runners/claude-code';

/* -------------------------------------------------------------------------- */
/*  F4 — parseLoopServicesConfig                                              */
/* -------------------------------------------------------------------------- */

suite('loop-service: parseLoopServicesConfig', () => {
  test('non-array input yields empty list', () => {
    assert.deepStrictEqual(parseLoopServicesConfig(undefined), []);
    assert.deepStrictEqual(parseLoopServicesConfig({}), []);
    assert.deepStrictEqual(parseLoopServicesConfig('nope'), []);
  });

  test('drops entries missing id or endpoint', () => {
    const parsed = parseLoopServicesConfig([
      { id: 'good', endpoint: 'http://x' },
      { id: 'no-endpoint' },
      { endpoint: 'http://y' },
      42,
      null,
    ]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'good');
  });

  test('carries through optional fields', () => {
    const [cfg] = parseLoopServicesConfig([
      {
        id: 'svc',
        endpoint: 'http://svc',
        auth: { kind: 'bearer', tokenEnv: 'SVC_TOKEN' },
        routes: { dispatch: '/go' },
        pollIntervalMs: 500,
        idField: 'run_id',
      },
    ]);
    assert.strictEqual(cfg.pollIntervalMs, 500);
    assert.strictEqual(cfg.idField, 'run_id');
    assert.strictEqual(cfg.auth?.kind, 'bearer');
    assert.strictEqual(cfg.routes?.dispatch, '/go');
  });
});

/* -------------------------------------------------------------------------- */
/*  F4 — autonomy / error / state mapping                                     */
/* -------------------------------------------------------------------------- */

suite('loop-service: trust + error + state mapping', () => {
  test('autonomy mapping is exhaustive', () => {
    assert.strictEqual(loopServiceAutonomy('off'), 'manual');
    assert.strictEqual(loopServiceAutonomy('auto'), 'assisted');
    assert.strictEqual(loopServiceAutonomy('turbo'), 'autonomous');
  });

  test('error class mapping', () => {
    assert.strictEqual(loopServiceErrorClass({ error_class: 'auth' }), 'auth');
    assert.strictEqual(loopServiceErrorClass({ error_class: 'timeout' }), 'timeout');
    assert.strictEqual(
      loopServiceErrorClass({ error_class: 'permission_denied' }),
      'tool_denied',
    );
    assert.strictEqual(loopServiceErrorClass({ error_class: 'mcp' }), 'mcp_startup');
    assert.strictEqual(loopServiceErrorClass({}), 'internal');
  });

  test('state classification', () => {
    assert.strictEqual(classifyLoopState('completed'), 'ok');
    assert.strictEqual(classifyLoopState('SUCCESS'), 'ok');
    assert.strictEqual(classifyLoopState('failed'), 'failed');
    assert.strictEqual(classifyLoopState('cancelled'), 'failed');
    assert.strictEqual(classifyLoopState('running'), 'pending');
    assert.strictEqual(classifyLoopState(undefined), 'pending');
  });
});

/* -------------------------------------------------------------------------- */
/*  F4 — LoopServiceAdapter route + auth resolution                           */
/* -------------------------------------------------------------------------- */

/** Test subclass exposing the protected route/auth helpers. */
class ProbeAdapter extends LoopServiceAdapter {
  publicRoute(name: 'health' | 'dispatch' | 'status' | 'cancel' | 'list'): string {
    return this.route(name);
  }
  publicAuthHeaders(): Record<string, string> {
    return this.authHeaders();
  }
  publicWithId(url: string, id: string): string {
    return this.withId(url, id);
  }
}

suite('loop-service: route + auth resolution', () => {
  test('default routes resolve against the endpoint', () => {
    const a = new ProbeAdapter({ id: 'x', endpoint: 'http://host:9000/' });
    assert.strictEqual(a.publicRoute('health'), 'http://host:9000/health');
    assert.strictEqual(a.publicRoute('dispatch'), 'http://host:9000/run');
    assert.strictEqual(a.publicRoute('status'), 'http://host:9000/run/{id}');
  });

  test('route overrides are honored', () => {
    const a = new ProbeAdapter({
      id: 'x',
      endpoint: 'http://host',
      routes: { dispatch: '/api/go', status: '/api/go/{id}' },
    });
    assert.strictEqual(a.publicRoute('dispatch'), 'http://host/api/go');
    assert.strictEqual(a.publicWithId(a.publicRoute('status'), 'abc'), 'http://host/api/go/abc');
  });

  test('bearer auth header present only when env var set', () => {
    const a = new ProbeAdapter({
      id: 'x',
      endpoint: 'http://host',
      auth: { kind: 'bearer', tokenEnv: '__LST_TOKEN__' },
    });
    delete process.env.__LST_TOKEN__;
    assert.deepStrictEqual(a.publicAuthHeaders(), {});
    process.env.__LST_TOKEN__ = 'secret';
    assert.deepStrictEqual(a.publicAuthHeaders(), { Authorization: 'Bearer secret' });
    delete process.env.__LST_TOKEN__;
  });

  test('custom header auth uses the configured header name', () => {
    process.env.__LST_KEY__ = 'k123';
    const a = new ProbeAdapter({
      id: 'x',
      endpoint: 'http://host',
      auth: { kind: 'header', tokenEnv: '__LST_KEY__', headerName: 'X-API-Key' },
    });
    assert.deepStrictEqual(a.publicAuthHeaders(), { 'X-API-Key': 'k123' });
    delete process.env.__LST_KEY__;
  });

  test('id substitution is URL-encoded', () => {
    const a = new ProbeAdapter({ id: 'x', endpoint: 'http://host' });
    assert.strictEqual(
      a.publicWithId('http://host/run/{id}', 'a b/c'),
      'http://host/run/a%20b%2Fc',
    );
  });
});

suite('loop-service: detect rejects unconfigured service', () => {
  test('empty endpoint → not_installed', async () => {
    const a = new LoopServiceAdapter({ id: 'x', endpoint: '   ' });
    const result = await a.detect();
    assert.strictEqual(result.found, false);
    if (result.found === false) {
      assert.strictEqual(result.reason, 'not_installed');
    }
  });

  test('missing required auth token → no_auth', async () => {
    delete process.env.__LST_MISSING__;
    const a = new LoopServiceAdapter({
      id: 'x',
      endpoint: 'http://host',
      auth: { kind: 'bearer', tokenEnv: '__LST_MISSING__' },
    });
    const result = await a.detect();
    assert.strictEqual(result.found, false);
    if (result.found === false) {
      assert.strictEqual(result.reason, 'no_auth');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  F4 — AutoGPT runner                                                       */
/* -------------------------------------------------------------------------- */

suite('autogpt: runner identity + capabilities', () => {
  test('runner id and browser capability', () => {
    const r = new AutoGptRunner({ endpoint: 'http://gpt' });
    assert.strictEqual(r.id, 'autogpt');
    assert.strictEqual(r.capabilities.browser, true);
  });

  test('remote-configured runner uses the inherited HTTP health check', async () => {
    // Unreachable endpoint — detect resolves to a not-found result, never throws.
    const r = new AutoGptRunner({ endpoint: 'http://127.0.0.1:1/nope' });
    const result = await r.detect();
    assert.strictEqual(result.found, false);
  });

  test('local-configured runner without launch command → not_installed', async () => {
    delete process.env.AUTOGPT_ENDPOINT;
    delete process.env.AUTOGPT_COMMAND;
    const r = new AutoGptRunner({});
    const result = await r.detect();
    assert.strictEqual(result.found, false);
    if (result.found === false) {
      assert.strictEqual(result.reason, 'not_installed');
    }
  });

  test('dispatch body uses AutoGPT task schema', () => {
    const r = new AutoGptRunner({ endpoint: 'http://gpt' }) as unknown as {
      buildDispatchBody(opts: {
        prompt: string;
        trust: string;
        workingDir: string;
        trustDenyList?: string[];
      }): Record<string, unknown>;
    };
    const body = r.buildDispatchBody({
      prompt: 'do the thing',
      trust: 'turbo',
      workingDir: '/w',
      trustDenyList: ['Bash'],
    });
    assert.strictEqual(body.task, 'do the thing');
    const settings = body.agent_settings as Record<string, unknown>;
    assert.strictEqual(settings.continuous_mode, true);
    assert.deepStrictEqual(settings.denied_commands, ['Bash']);
  });
});

/* -------------------------------------------------------------------------- */
/*  F5 — detectHostContext                                                    */
/* -------------------------------------------------------------------------- */

suite('claude-desktop: detectHostContext', () => {
  test('explicit override wins', () => {
    assert.strictEqual(detectHostContext({ AUTOCLAW_CLAUDE_CONTEXT: 'desktop' }), 'desktop');
    assert.strictEqual(detectHostContext({ AUTOCLAW_CLAUDE_CONTEXT: 'vscode' }), 'vscode');
  });

  test('desktop markers detected', () => {
    assert.strictEqual(detectHostContext({ CLAUDE_DESKTOP: '1' }), 'desktop');
    assert.strictEqual(
      detectHostContext({ CLAUDE_CODE_ENTRYPOINT: 'desktop' }),
      'desktop',
    );
  });

  test('vscode markers detected', () => {
    assert.strictEqual(detectHostContext({ VSCODE_PID: '999' }), 'vscode');
    assert.strictEqual(detectHostContext({ TERM_PROGRAM: 'vscode' }), 'vscode');
  });

  test('bare environment falls back to cli', () => {
    assert.strictEqual(detectHostContext({}), 'cli');
  });
});

/* -------------------------------------------------------------------------- */
/*  F5 — buildDesktopCliArgs                                                  */
/* -------------------------------------------------------------------------- */

suite('claude-desktop: buildDesktopCliArgs', () => {
  const base: DesktopRunArgs = {
    prompt: 'hello',
    workingDir: '/w',
    permissionMode: 'acceptEdits',
  };

  test('new session is assigned --session-id', () => {
    const args = buildDesktopCliArgs({ ...base, assignSessionId: 'uuid-1' });
    const i = args.indexOf('--session-id');
    assert.ok(i >= 0, '--session-id present');
    assert.strictEqual(args[i + 1], 'uuid-1');
    assert.ok(!args.includes('--resume'));
  });

  test('resume uses --resume and never --session-id', () => {
    const args = buildDesktopCliArgs({
      ...base,
      resumeSessionId: 'uuid-2',
      assignSessionId: 'uuid-ignored',
    });
    const i = args.indexOf('--resume');
    assert.ok(i >= 0);
    assert.strictEqual(args[i + 1], 'uuid-2');
    assert.ok(!args.includes('--session-id'));
  });

  test('prompt is the final positional', () => {
    const args = buildDesktopCliArgs(base);
    assert.strictEqual(args[args.length - 1], 'hello');
  });
});

/* -------------------------------------------------------------------------- */
/*  F5 — DesktopSessionStore                                                  */
/* -------------------------------------------------------------------------- */

suite('claude-desktop: DesktopSessionStore (restart-safe)', () => {
  test('upsert then get round-trips a record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const store = new DesktopSessionStore(dir);
      await store.upsert({
        sessionId: 's-1',
        context: 'desktop',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        promptPreview: 'first',
      });
      // A fresh store instance simulates a process restart.
      const reloaded = await new DesktopSessionStore(dir).get('s-1');
      assert.ok(reloaded);
      assert.strictEqual(reloaded?.context, 'desktop');
      assert.strictEqual(reloaded?.promptPreview, 'first');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('upsert preserves the original createdAt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const store = new DesktopSessionStore(dir);
      await store.upsert({
        sessionId: 's-2',
        context: 'cli',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      });
      await store.upsert({
        sessionId: 's-2',
        context: 'cli',
        createdAt: '2026-09-09T00:00:00.000Z',
        lastActivityAt: '2026-09-09T00:00:00.000Z',
      });
      const rec = await store.get('s-2');
      assert.strictEqual(rec?.createdAt, '2026-01-01T00:00:00.000Z');
      assert.strictEqual(rec?.lastActivityAt, '2026-09-09T00:00:00.000Z');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('get on a missing store returns undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const rec = await new DesktopSessionStore(dir).get('nope');
      assert.strictEqual(rec, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  F5 — ClaudeDesktopRunner dispatch (mock transport)                        */
/* -------------------------------------------------------------------------- */

/** Mock transport — captures args, never spawns a subprocess. */
class MockDesktopTransport implements DesktopTransport {
  lastArgs: DesktopRunArgs | undefined;
  constructor(
    private readonly outcome: ClaudeRunOutcome,
    private readonly versionString: string | null = '1.5.0 (Claude Code)',
  ) {}
  async run(args: DesktopRunArgs): Promise<ClaudeRunOutcome> {
    this.lastArgs = args;
    return this.outcome;
  }
  async version(): Promise<string | null> {
    return this.versionString;
  }
}

suite('claude-desktop: ClaudeDesktopRunner.dispatch', () => {
  const okOutcome: ClaudeRunOutcome = {
    exitCode: 0,
    events: [
      { type: 'system', session_id: 'host-session-9' },
      { type: 'result', subtype: 'success', result: 'done' },
    ],
    stdout: '',
    stderr: '',
    timedOut: false,
  };

  test('new dispatch assigns a session id and reports success', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const transport = new MockDesktopTransport(okOutcome);
      const runner = new ClaudeDesktopRunner(transport, 'desktop');
      const result = await runner.dispatch({
        prompt: 'task',
        trust: 'auto',
        workingDir: dir,
      });
      assert.strictEqual(result.ok, true);
      // Host-reported session id wins.
      assert.strictEqual(result.sessionId, 'host-session-9');
      // A new session was assigned an explicit id on the way in.
      assert.ok(transport.lastArgs?.assignSessionId);
      assert.strictEqual(transport.lastArgs?.resumeSessionId, undefined);
      // Persisted for restart-safe resume.
      const rec = await new DesktopSessionStore(dir).get('host-session-9');
      assert.ok(rec);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('resume passes resumeSessionId, not assignSessionId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const transport = new MockDesktopTransport(okOutcome);
      const runner = new ClaudeDesktopRunner(transport, 'cli');
      await runner.resume('prev-session', 'follow up', { workingDir: dir });
      assert.strictEqual(transport.lastArgs?.resumeSessionId, 'prev-session');
      assert.strictEqual(transport.lastArgs?.assignSessionId, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('spawn error maps to ErrorClass internal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-desktop-'));
    try {
      const failOutcome: ClaudeRunOutcome = {
        exitCode: 127,
        events: [],
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: 'ENOENT',
      };
      const runner = new ClaudeDesktopRunner(new MockDesktopTransport(failOutcome), 'cli');
      const result = await runner.dispatch({
        prompt: 'task',
        trust: 'off',
        workingDir: dir,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'internal');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('detect folds host context into the version string', async () => {
    const runner = new ClaudeDesktopRunner(new MockDesktopTransport(okOutcome), 'vscode');
    const result = await runner.detect();
    if (result.found) {
      assert.ok(result.version.includes('context=vscode'));
    }
  });
});
