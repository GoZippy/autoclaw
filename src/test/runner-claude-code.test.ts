/**
 * runner-claude-code.test.ts — Unit tests for the Claude Code runner.
 *
 * Covers (RFC §3, §5.1, §7):
 *  1. Trust preset → permissionMode translation (off/auto/turbo).
 *  2. `buildCliArgs` headless flag construction.
 *  3. `parseStreamJson` event extraction and non-JSON tolerance.
 *  4. `classifyError` failure-mode mapping → ErrorClass.
 *  5. `dispatch` against an injected mock transport (success + failure).
 */

import * as assert from 'assert';

import {
  ClaudeCodeRunner,
  buildCliArgs,
  classifyError,
  extractSessionId,
  isVersionSupported,
  parseStreamJson,
  trustToPermissionMode,
  type ClaudeHeadlessTransport,
  type ClaudeRunArgs,
  type ClaudeRunOutcome,
} from '../runners/claude-code';
import type { TrustPreset } from '../runners/types';

// ---------------------------------------------------------------------------
// Mock transport — never spawns a real subprocess.
// ---------------------------------------------------------------------------

class MockTransport implements ClaudeHeadlessTransport {
  lastArgs: ClaudeRunArgs | undefined;
  constructor(
    private readonly outcome: ClaudeRunOutcome,
    private readonly versionString: string | null = '1.2.3 (Claude Code)',
  ) {}

  async run(args: ClaudeRunArgs): Promise<ClaudeRunOutcome> {
    this.lastArgs = args;
    return this.outcome;
  }
  async version(): Promise<string | null> {
    return this.versionString;
  }
}

suite('runner-claude-code: trust → permissionMode (RFC §3)', () => {
  test('off → default', () => {
    assert.strictEqual(trustToPermissionMode('off'), 'default');
  });
  test('auto → acceptEdits', () => {
    assert.strictEqual(trustToPermissionMode('auto'), 'acceptEdits');
  });
  test('turbo → bypassPermissions', () => {
    assert.strictEqual(trustToPermissionMode('turbo'), 'bypassPermissions');
  });
  test('exhaustive over every TrustPreset', () => {
    const expected: Record<TrustPreset, string> = {
      off: 'default',
      auto: 'acceptEdits',
      turbo: 'bypassPermissions',
    };
    for (const preset of Object.keys(expected) as TrustPreset[]) {
      assert.strictEqual(trustToPermissionMode(preset), expected[preset]);
    }
  });
});

suite('runner-claude-code: buildCliArgs', () => {
  test('headless flags are always present', () => {
    const args = buildCliArgs({
      prompt: 'do the thing',
      workingDir: '/tmp/x',
      permissionMode: 'default',
    });
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.deepStrictEqual(args.slice(-1), ['do the thing']);
  });

  test('permission mode is forwarded', () => {
    const args = buildCliArgs({
      prompt: 'p',
      workingDir: '/tmp/x',
      permissionMode: 'bypassPermissions',
    });
    const idx = args.indexOf('--permission-mode');
    assert.ok(idx >= 0);
    assert.strictEqual(args[idx + 1], 'bypassPermissions');
  });

  test('resume id and deny list are forwarded when set', () => {
    const args = buildCliArgs({
      prompt: 'p',
      workingDir: '/tmp/x',
      permissionMode: 'acceptEdits',
      resumeSessionId: 'sess-42',
      trustDenyList: ['force_push', 'delete_branch'],
    });
    assert.strictEqual(args[args.indexOf('--resume') + 1], 'sess-42');
    assert.strictEqual(
      args[args.indexOf('--disallowed-tools') + 1],
      'force_push,delete_branch',
    );
  });
});

suite('runner-claude-code: parseStreamJson', () => {
  test('parses one-object-per-line and tolerates noise', () => {
    const stdout = [
      'Starting Claude Code...',
      '{"type":"system","session_id":"abc-1"}',
      'garbage line',
      '{"type":"result","subtype":"success","result":"OK"}',
    ].join('\n');
    const events = parseStreamJson(stdout);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'system');
    assert.strictEqual(extractSessionId(events), 'abc-1');
  });

  test('returns empty list for empty stdout', () => {
    assert.deepStrictEqual(parseStreamJson(''), []);
  });
});

suite('runner-claude-code: classifyError (RFC §7)', () => {
  const base: ClaudeRunOutcome = {
    exitCode: 1,
    events: [],
    stdout: '',
    stderr: '',
    timedOut: false,
  };

  test('auth failures → auth', () => {
    assert.strictEqual(
      classifyError({ ...base, stderr: 'Error: invalid x-api-key (401)' }),
      'auth',
    );
  });
  test('mcp startup failures → mcp_startup', () => {
    assert.strictEqual(
      classifyError({ ...base, stderr: 'MCP server failed to start' }),
      'mcp_startup',
    );
  });
  test('permission denial → tool_denied', () => {
    assert.strictEqual(
      classifyError({ ...base, stderr: 'permission denied for tool Bash' }),
      'tool_denied',
    );
  });
  test('timeout → timeout', () => {
    assert.strictEqual(classifyError({ ...base, timedOut: true }), 'timeout');
  });
  test('unknown crash → internal', () => {
    assert.strictEqual(
      classifyError({ ...base, stderr: 'segfault' }),
      'internal',
    );
  });
});

suite('runner-claude-code: isVersionSupported', () => {
  test('accepts v1+', () => {
    assert.strictEqual(isVersionSupported('1.0.0'), true);
    assert.strictEqual(isVersionSupported('2.5.9 (Claude Code)'), true);
  });
  test('rejects v0.x', () => {
    assert.strictEqual(isVersionSupported('0.9.1'), false);
  });
  test('accepts unparseable version (forward-compat)', () => {
    assert.strictEqual(isVersionSupported('weird-build'), true);
  });
});

suite('runner-claude-code: ClaudeCodeRunner dispatch', () => {
  test('successful dispatch maps result event', async () => {
    const transport = new MockTransport({
      exitCode: 0,
      events: [
        { type: 'system', session_id: 'sess-ok' },
        {
          type: 'result',
          subtype: 'success',
          result: 'OK',
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      ],
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    });
    const runner = new ClaudeCodeRunner(transport);
    const result = await runner.dispatch({
      prompt: 'respond with the literal text OK and nothing else',
      trust: 'auto',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sessionId, 'sess-ok');
    assert.strictEqual(result.errorClass, undefined);
    assert.deepStrictEqual(result.tokens, { input: 10, output: 3 });
    assert.strictEqual(transport.lastArgs?.permissionMode, 'acceptEdits');
  });

  test('failing dispatch yields an ErrorClass', async () => {
    const transport = new MockTransport({
      exitCode: 1,
      events: [{ type: 'result', subtype: 'error_auth', is_error: true }],
      stdout: '',
      stderr: 'invalid x-api-key',
      timedOut: false,
    });
    const runner = new ClaudeCodeRunner(transport);
    const result = await runner.dispatch({
      prompt: 'p',
      trust: 'off',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'auth');
  });

  test('runner exposes the claude-code id and capabilities', () => {
    const runner = new ClaudeCodeRunner(
      new MockTransport({
        exitCode: 0,
        events: [],
        stdout: '',
        stderr: '',
        timedOut: false,
      }),
    );
    assert.strictEqual(runner.id, 'claude-code');
    assert.strictEqual(runner.capabilities.resumableSessions, true);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, true);
  });
});
