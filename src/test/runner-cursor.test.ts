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

import { CursorRunner } from '../runners/cursor';
import { TRUST_PRESET_TABLE } from '../runners/registry';
import type { DispatchOptions, TrustPreset } from '../runners/types';

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
