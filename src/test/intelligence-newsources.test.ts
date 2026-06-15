/**
 * intelligence-newsources.test.ts — unit tests for the Tier-2 transcript
 * adapters and the cross-cutting ingestion machinery
 * (intelligence-universal-ingestion, tasks 2.2, 3.2, 4.5, 5.2).
 *
 * Fixture-based normalization for each new adapter (Claude Code, Claude Desktop,
 * Kiro, Gemini) plus:
 *   - per-source watermarks (get/set round-trip + corruption tolerance) (R4.1)
 *   - consent gating (native default-on, third-party default-off, persistence)
 *     (R3.4, R5.1)
 *   - cross-source dedup raises kept-confidence without double-counting (R4.2)
 *   - secret redaction applied at message-build time (R5.2)
 *
 * Pure-logic tests — no vscode, no extension host. Temp dirs live under a single
 * enclosing suite so teardown never races sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createClaudeCodeAdapter } from '../intelligence/sources/claudeCode';
import { createClaudeDesktopAdapter } from '../intelligence/sources/claudeDesktop';
import { createKiroAdapter } from '../intelligence/sources/kiro';
import { createGeminiAdapter } from '../intelligence/sources/gemini';
import {
  WatermarkStore,
  getWatermark,
  setWatermark,
  watermarkStorePath,
} from '../intelligence/sources/watermark';
import {
  ensureFirstRunConsent,
  isEnabled,
  recordConsent,
} from '../intelligence/sources/consent';
import { loadConfig } from '../intelligence/config';
import { dedupSessions } from '../intelligence/sources/registry';
import { AdapterEnv, UnifiedSession } from '../intelligence/types';

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function envFor(home: string, workspaceRoot?: string): AdapterEnv {
  return { homeDir: home, workspaceRoot, platform: process.platform, env: {} };
}

async function collect(it: AsyncIterable<UnifiedSession>): Promise<UnifiedSession[]> {
  const out: UnifiedSession[] = [];
  for await (const s of it) {
    out.push(s);
  }
  return out;
}

function session(over: Partial<UnifiedSession> & { id: string; source: string }): UnifiedSession {
  return {
    tool: over.source,
    startedAt: 1000,
    messages: [],
    signals: { keptCode: [] },
    provenance: { adapterId: over.source, rawRef: over.id, extractedAt: Date.now() },
    ...over,
  } as UnifiedSession;
}

suite('intelligence-newsources', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-newsources-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // -------------------------------------------------------------------------
  suite('claudeCode adapter', function () {
    test('parses ~/.claude/projects jsonl into a full transcript with code + project', async function () {
      const home = freshDir('home');
      const file = path.join(home, '.claude', 'projects', '-Users-me-proj', 'abc.jsonl');
      writeFile(
        file,
        [
          JSON.stringify({ type: 'summary', summary: 'Add parser' }),
          JSON.stringify({
            type: 'user',
            sessionId: 'abc',
            cwd: '/Users/me/proj',
            timestamp: '2024-01-01T00:00:00Z',
            message: { role: 'user', content: 'my key is sk-ABCDEFGHIJ1234567890KLMN, how do I parse?' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2024-01-01T00:01:00Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Use this:\n```ts\nconst x = 1;\n```' }],
            },
          }),
        ].join('\n'),
      );

      const adapter = createClaudeCodeAdapter();
      const presence = await adapter.discover(envFor(home));
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1);
      const s = sessions[0];
      assert.strictEqual(s.source, 'claude-code');
      assert.strictEqual(s.project, '/Users/me/proj', 'project derived from cwd');
      assert.strictEqual(s.title, 'Add parser', 'summary line used as title');
      assert.strictEqual(s.messages.length, 2, 'summary skipped, user+assistant kept');
      assert.ok(s.startedAt > 0 && s.endedAt && s.endedAt >= s.startedAt, 'timestamps set');

      const assistant = s.messages.find((m) => m.role === 'assistant');
      assert.ok(assistant?.codeBlocks?.length === 1, 'code block captured');
      assert.ok(assistant!.codeBlocks![0].code.includes('const x = 1;'));

      // R5.2: redaction applied at message-build time.
      const user = s.messages.find((m) => m.role === 'user');
      assert.ok(user && !user.text.includes('sk-ABCDEFGHIJ1234567890KLMN'), 'secret redacted');
      assert.ok(user!.text.includes('redacted'), 'redaction marker present');
    });

    test('missing store degrades to unavailable, no throw', async function () {
      const home = freshDir('home-empty');
      const adapter = createClaudeCodeAdapter();
      const presence = await adapter.discover(envFor(home));
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0);
      assert.deepStrictEqual(await collect(adapter.extract({})), []);
    });

    test('honors the watermark (sinceTs filters older sessions)', async function () {
      const home = freshDir('home-wm');
      writeFile(
        path.join(home, '.claude', 'projects', 'p', 'old.jsonl'),
        JSON.stringify({
          type: 'user',
          timestamp: '2020-01-01T00:00:00Z',
          message: { role: 'user', content: 'old' },
        }),
      );
      const adapter = createClaudeCodeAdapter();
      await adapter.discover(envFor(home));
      const future = Date.parse('2030-01-01T00:00:00Z');
      assert.deepStrictEqual(await collect(adapter.extract({ sinceTs: future })), []);
    });

    test('applied edit → applied_edit kept signal (shipped)', async function () {
      const home = freshDir('home-edit');
      writeFile(
        path.join(home, '.claude', 'projects', 'p', 'edit.jsonl'),
        [
          JSON.stringify({
            type: 'assistant',
            cwd: '/Users/me/proj',
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { new_string: 'const y = 2;' } }],
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2024-01-01T00:00:05Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
          }),
        ].join('\n'),
      );
      const adapter = createClaudeCodeAdapter();
      await adapter.discover(envFor(home));
      const [s] = await collect(adapter.extract({}));
      assert.strictEqual(s.signals.keptCode.length, 1, 'one applied_edit kept signal');
      assert.strictEqual(s.signals.keptCode[0].reason, 'applied_edit');
      assert.ok(s.signals.keptCode[0].code.includes('const y = 2;'));
      assert.notStrictEqual(s.signals.outcome, 'discarded');
    });

    test('every edit failed → discarded; no kept code', async function () {
      const home = freshDir('home-fail');
      writeFile(
        path.join(home, '.claude', 'projects', 'p', 'fail.jsonl'),
        [
          JSON.stringify({
            type: 'assistant',
            cwd: '/Users/me/proj',
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { new_string: 'broken' } }],
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2024-01-01T00:00:05Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'no match', is_error: true }] },
          }),
        ].join('\n'),
      );
      const adapter = createClaudeCodeAdapter();
      await adapter.discover(envFor(home));
      const [s] = await collect(adapter.extract({}));
      assert.strictEqual(s.signals.keptCode.length, 0, 'failed edit is not kept');
      assert.strictEqual(s.signals.outcome, 'discarded');
    });

    test('read-only session stays unknown (no edit attempts)', async function () {
      const home = freshDir('home-ro');
      writeFile(
        path.join(home, '.claude', 'projects', 'p', 'ro.jsonl'),
        [
          JSON.stringify({
            type: 'assistant',
            cwd: '/Users/me/proj',
            timestamp: '2024-01-01T00:00:00Z',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x' } }],
            },
          }),
        ].join('\n'),
      );
      const adapter = createClaudeCodeAdapter();
      await adapter.discover(envFor(home));
      const [s] = await collect(adapter.extract({}));
      assert.strictEqual(s.signals.keptCode.length, 0);
      assert.strictEqual(s.signals.outcome, undefined, 'read-only ⇒ unknown, not shipped/discarded');
    });

    test('scopes to the open workspace (other repos excluded)', async function () {
      const home = freshDir('home-scope');
      const mk = (dir: string, cwd: string) =>
        writeFile(
          path.join(home, '.claude', 'projects', dir, 'a.jsonl'),
          JSON.stringify({
            type: 'user',
            cwd,
            timestamp: '2024-01-01T00:00:00Z',
            message: { role: 'user', content: 'hi' },
          }),
        );
      mk('A', '/Users/me/projA');
      mk('A-sub', '/Users/me/projA/src'); // sub-dir of the workspace ⇒ included
      mk('B', '/Users/me/projB'); // different repo ⇒ excluded

      const adapter = createClaudeCodeAdapter();
      // Workspace set ⇒ only projA (and its sub-dir) are emitted.
      await adapter.discover(envFor(home, '/Users/me/projA'));
      const scoped = await collect(adapter.extract({}));
      assert.deepStrictEqual(
        scoped.map((s) => s.project).sort(),
        ['/Users/me/projA', '/Users/me/projA/src'],
      );

      // No workspace ⇒ corpus mode emits every repo.
      const adapter2 = createClaudeCodeAdapter();
      await adapter2.discover(envFor(home));
      const all = await collect(adapter2.extract({}));
      assert.strictEqual(all.length, 3, 'corpus mode emits all repos');
    });
  });

  // -------------------------------------------------------------------------
  suite('claudeDesktop adapter', function () {
    test('reads the desktop session index + resolves transcripts, thin-falls-back', async function () {
      const home = freshDir('home');
      const ws = freshDir('ws');
      writeFile(
        path.join(ws, '.autoclaw', 'runners', 'claude-desktop-sessions.json'),
        JSON.stringify({
          sessions: {
            'sess-1': {
              sessionId: 'sess-1',
              createdAt: '2024-01-01T00:00:00Z',
              lastActivityAt: '2024-01-02T00:00:00Z',
              promptPreview: 'Fix the bug',
            },
            'sess-2': {
              sessionId: 'sess-2',
              lastActivityAt: '2024-01-03T00:00:00Z',
              promptPreview: 'thin only',
            },
          },
        }),
      );
      // sess-1 has a real transcript under ~/.claude/projects.
      writeFile(
        path.join(home, '.claude', 'projects', 'p', 'sess-1.jsonl'),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2024-01-02T00:00:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'fixed it' }] },
        }),
      );

      const adapter = createClaudeDesktopAdapter();
      const presence = await adapter.discover(envFor(home, ws));
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 2, 'one full + one thin');

      const full = sessions.find((s) => s.id.endsWith('sess-1'));
      assert.ok(full, 'sess-1 present');
      assert.ok(full!.messages.some((m) => m.text.includes('fixed it')), 'transcript parsed');

      const thin = sessions.find((s) => s.id.endsWith('sess-2'));
      assert.ok(thin, 'sess-2 present');
      assert.ok(thin!.messages.some((m) => m.text.includes('thin only')), 'preview used');
    });
  });

  // -------------------------------------------------------------------------
  suite('kiro adapter', function () {
    test('reads workspace .kiro/specs docs into one session per spec', async function () {
      const home = freshDir('home');
      const ws = freshDir('ws');
      writeFile(
        path.join(ws, '.kiro', 'specs', 'myspec', 'requirements.md'),
        '# Requirements\n\n```ts\ninterface X {}\n```\n',
      );
      writeFile(path.join(ws, '.kiro', 'specs', 'myspec', 'design.md'), '# Design\n\nstuff');

      const adapter = createKiroAdapter({ useCli: false });
      const presence = await adapter.discover(envFor(home, ws));
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1, 'one session for the spec');
      const s = sessions[0];
      assert.strictEqual(s.source, 'kiro');
      assert.ok(s.id.endsWith('spec:myspec'));
      assert.strictEqual(s.messages.length, 2, 'requirements + design docs');
      assert.ok(
        s.messages.some((m) => m.codeBlocks && m.codeBlocks.length === 1),
        'code block captured from requirements',
      );
    });

    test('no local Kiro state => unavailable, no throw (CLI probe disabled)', async function () {
      const home = freshDir('home-empty');
      const ws = freshDir('ws-empty');
      const adapter = createKiroAdapter({ useCli: false });
      const presence = await adapter.discover(envFor(home, ws));
      assert.strictEqual(presence.available, false);
      assert.deepStrictEqual(await collect(adapter.extract({})), []);
    });
  });

  // -------------------------------------------------------------------------
  suite('gemini adapter', function () {
    test('parses ~/.gemini logs (role:model, parts[].text) with code blocks', async function () {
      const home = freshDir('home');
      writeFile(
        path.join(home, '.gemini', 'tmp', 'h', 'logs.json'),
        JSON.stringify([
          { role: 'user', parts: [{ text: 'how to sort?' }] },
          { role: 'model', parts: [{ text: 'Use:\n```py\nsorted(x)\n```' }] },
        ]),
      );
      // A settings file in the same tree must be ignored.
      writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark' }));

      const adapter = createGeminiAdapter();
      const presence = await adapter.discover(envFor(home));
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1, 'settings.json ignored, one log session');
      const s = sessions[0];
      assert.strictEqual(s.source, 'gemini');
      assert.strictEqual(s.messages.length, 2);
      assert.strictEqual(s.messages[0].role, 'user');
      assert.strictEqual(s.messages[1].role, 'assistant', 'model role mapped to assistant');
      assert.ok(s.messages[1].codeBlocks?.length === 1, 'code block captured');
    });
  });

  // -------------------------------------------------------------------------
  suite('watermarks (R4.1)', function () {
    test('set/get round-trip per (source, project)', async function () {
      const ws = freshDir('ws');
      const store = new WatermarkStore(ws);
      assert.deepStrictEqual(store.get('claude-code', 'proj'), {}, 'absent => empty (full extract)');

      await store.set('claude-code', 'proj', { lastTs: 1700000000000 });
      await store.set('gemini', 'proj', { offset: 'cursor-9' });

      assert.deepStrictEqual(new WatermarkStore(ws).get('claude-code', 'proj'), {
        lastTs: 1700000000000,
      });
      assert.deepStrictEqual(getWatermark(ws, 'gemini', 'proj'), { offset: 'cursor-9' });
      // Distinct projects are isolated.
      assert.deepStrictEqual(getWatermark(ws, 'claude-code', 'other'), {});
    });

    test('free setWatermark helper persists', async function () {
      const ws = freshDir('ws-free');
      await setWatermark(ws, 'kiro', 'p', { lastTs: 42 });
      assert.deepStrictEqual(getWatermark(ws, 'kiro', 'p'), { lastTs: 42 });
    });

    test('corrupt store is treated as empty (full extract) + warns', async function () {
      const ws = freshDir('ws-corrupt');
      const storePath = watermarkStorePath(ws);
      writeFile(storePath, '{ this is not valid json ');
      const warnings: string[] = [];
      const store = new WatermarkStore(ws, (m) => warnings.push(m));
      assert.deepStrictEqual(store.get('claude-code', 'proj'), {});
      assert.ok(
        warnings.some((w) => /corrupt|empty/i.test(w)),
        `expected a corruption warning, got ${JSON.stringify(warnings)}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  suite('consent gating (R3.4 / R5.1 / D13)', function () {
    test('defaults: native on, third-party off; explicit toggle wins', function () {
      const cfg = { sources: {} };
      assert.strictEqual(isEnabled(cfg, 'autoclaw-native'), true);
      assert.strictEqual(isEnabled(cfg, 'claude-code'), false);
      assert.strictEqual(isEnabled(cfg, 'gemini'), false);

      const withToggle = { sources: { 'claude-code': { enabled: true }, 'autoclaw-native': { enabled: false } } };
      assert.strictEqual(isEnabled(withToggle, 'claude-code'), true);
      assert.strictEqual(isEnabled(withToggle, 'autoclaw-native'), false);
    });

    test('ensureFirstRunConsent surfaces available, undecided third-party sources', function () {
      const decision = ensureFirstRunConsent(
        [
          { id: 'autoclaw-native', available: true },
          { id: 'claude-code', available: true },
          { id: 'gemini', available: false },
          { id: 'kiro', available: true },
        ],
        { sources: { kiro: { enabled: false } } }, // kiro already decided
      );
      assert.deepStrictEqual(decision.toPrompt.sort(), ['claude-code']);
      assert.deepStrictEqual(decision.autoEnabled, ['autoclaw-native']);
      assert.ok(decision.alreadyDecided.includes('kiro'));
    });

    test('recordConsent persists to config.sources and survives reload', async function () {
      const ws = freshDir('ws-consent');
      await recordConsent(ws, 'claude-code', true);
      const cfg = loadConfig(ws);
      assert.strictEqual(cfg.sources['claude-code']?.enabled, true);
      assert.strictEqual(isEnabled(cfg, 'claude-code'), true);

      // A second decision touches only its own key.
      await recordConsent(ws, 'gemini', false);
      const cfg2 = loadConfig(ws);
      assert.strictEqual(cfg2.sources['claude-code']?.enabled, true, 'prior key preserved');
      assert.strictEqual(cfg2.sources['gemini']?.enabled, false);
    });
  });

  // -------------------------------------------------------------------------
  suite('cross-source dedup raises confidence (R4.2 / D12)', function () {
    test('same logical session via two sources merges + raises kept confidence', function () {
      const messages = [{ role: 'assistant' as const, text: 'apply this fix to the parser' }];
      const a = session({
        id: 'claude-code:1',
        source: 'claude-code',
        project: 'proj',
        startedAt: 1000,
        messages,
        signals: { keptCode: [{ code: 'const x = 1;', reason: 'user_approval', confidence: 0.6 }] },
      });
      const b = session({
        id: 'gemini:1',
        source: 'gemini',
        project: 'proj',
        startedAt: 1500,
        messages,
        signals: { keptCode: [{ code: 'const x = 1;', reason: 'user_approval', confidence: 0.6 }] },
      });

      const merged = dedupSessions([a, b]);
      assert.strictEqual(merged.length, 1, 'merged into one (no double-count)');
      assert.strictEqual(merged[0].signals.keptCode.length, 1, 'kept code de-duplicated');
      assert.ok(
        Math.abs(merged[0].signals.keptCode[0].confidence - 0.84) < 1e-9,
        `noisy-OR of 0.6 and 0.6 is 0.84, got ${merged[0].signals.keptCode[0].confidence}`,
      );
    });
  });
});
