/**
 * intelligence-sources.test.ts — unit tests for the Source Adapter framework
 * (Phase-1 intelligence-core-loop, Group 4 / tasks 4.1-4.6).
 *
 * Verifies against real fixtures in OS temp dirs:
 *  - autoclawNative parses audit JSONL + comms-log + board into UnifiedSessions
 *    with derived outcomes and complete provenance (R1.2)
 *  - cursor parses a fixture state.vscdb (ItemTable chat key) into messages +
 *    code blocks and infers keptCode from approval phrases (R1.3)
 *  - generic parses .jsonl + .md exports from a configured dir (R1.4)
 *  - a per-adapter failure/unavailable path continues the run (R1.5)
 *  - enabled defaults: native on, cursor + generic off (R1.7 / D13)
 *  - cross-source dedup merges duplicates and raises kept-code confidence (R5.5)
 *
 * Pure-logic tests — no vscode, no extension host. All temp dirs live inside a
 * SINGLE enclosing suite (suiteSetup/suiteTeardown) so teardown never races
 * sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SourceRegistry,
  createDefaultRegistry,
  resolveEnabledSources,
  dedupSessions,
  DEFAULT_SOURCE_ENABLED,
} from '../intelligence/sources/registry';
import { createAutoclawNativeAdapter } from '../intelligence/sources/autoclawNative';
import { createCursorAdapter } from '../intelligence/sources/cursor';
import { createGenericAdapter } from '../intelligence/sources/generic';
import {
  AdapterEnv,
  ExtractOptions,
  SourceAdapter,
  UnifiedSession,
} from '../intelligence/types';
import { nativeVectorAvailable } from './_vectorBackendAvailable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function envFor(workspaceRoot?: string, extra: Partial<AdapterEnv> = {}): AdapterEnv {
  return {
    homeDir: tmpRoot,
    workspaceRoot,
    platform: process.platform,
    env: {},
    ...extra,
  };
}

async function collectIterable(it: AsyncIterable<UnifiedSession>): Promise<UnifiedSession[]> {
  const out: UnifiedSession[] = [];
  for await (const s of it) {
    out.push(s);
  }
  return out;
}

/** Minimal in-memory adapter for isolation / dedup tests. */
function fakeAdapter(
  id: string,
  behaviour: {
    available?: boolean;
    hint?: string;
    sessions?: UnifiedSession[];
    throwOnExtract?: boolean;
  },
): SourceAdapter {
  return {
    id,
    displayName: id,
    tier: 3,
    capabilities: {
      fullTranscripts: true,
      codeBlocks: true,
      timestamps: false,
      workspaceAttribution: false,
      incremental: false,
    },
    async discover(): Promise<any> {
      return {
        available: behaviour.available !== false,
        locations: [],
        hint: behaviour.hint,
      };
    },
    async *extract(_opts: ExtractOptions): AsyncIterable<UnifiedSession> {
      if (behaviour.throwOnExtract) {
        throw new Error('boom');
      }
      for (const s of behaviour.sessions ?? []) {
        yield s;
      }
    },
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('intelligence-sources', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-sources-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  suite('autoclawNative adapter', function () {
    test('discover reports available when .autoclaw exists; parses audit + comms + board', async function () {
      const ws = freshDir('ws');
      const base = path.join(ws, '.autoclaw');
      writeFile(
        path.join(base, 'orchestrator', 'audit', 'run-1.jsonl'),
        [
          JSON.stringify({ ts: 1700000000000, role: 'system', message: 'Created plan' }),
          JSON.stringify({
            ts: 1700000001000,
            role: 'assistant',
            message: 'Implemented feature',
            status: 'completed',
          }),
        ].join('\n'),
      );
      writeFile(
        path.join(base, 'comms', 'comms-log.jsonl'),
        [
          JSON.stringify({ ts: 1700000002000, from: 'agent-a', message: 'Need review on PR' }),
          JSON.stringify({ ts: 1700000003000, from: 'agent-b', message: 'LGTM' }),
        ].join('\n'),
      );
      writeFile(
        path.join(base, 'board.json'),
        JSON.stringify({ tasks: [{ id: '1', status: 'done' }, { id: '2', status: 'done' }] }),
      );

      const adapter = createAutoclawNativeAdapter();
      const env = envFor(ws);
      const presence = await adapter.discover(env);
      assert.strictEqual(presence.available, true, 'should be available when .autoclaw exists');

      const sessions = await collectIterable(adapter.extract({ workspace: ws }));
      assert.ok(sessions.length >= 3, `expected audit+comms+board sessions, got ${sessions.length}`);

      const audit = sessions.find((s) => s.id.includes(':audit:'));
      assert.ok(audit, 'audit session present');
      assert.strictEqual(audit!.messages.length, 2, 'two audit messages');
      assert.strictEqual(audit!.signals.outcome, 'shipped', 'completed audit => shipped');
      assert.strictEqual(audit!.provenance.adapterId, 'autoclaw-native');
      assert.ok(audit!.provenance.rawRef.endsWith('run-1.jsonl'), 'provenance points at the file');

      const comms = sessions.find((s) => s.id.endsWith(':comms'));
      assert.ok(comms, 'comms session present');
      assert.strictEqual(comms!.messages.length, 2, 'two comms messages');

      const board = sessions.find((s) => s.id.endsWith(':board'));
      assert.ok(board, 'board session present');
      assert.strictEqual(board!.signals.outcome, 'shipped', 'all-done board => shipped');
    });

    test('missing .autoclaw degrades to unavailable without throwing', async function () {
      const ws = freshDir('ws-empty');
      const adapter = createAutoclawNativeAdapter();
      const presence = await adapter.discover(envFor(ws));
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0, 'hint explains why');
      const sessions = await collectIterable(adapter.extract({ workspace: ws }));
      assert.deepStrictEqual(sessions, [], 'no sessions, no throw');
    });
  });

  // -------------------------------------------------------------------------
  suite('cursor adapter', function () {
    function buildFixtureDb(): string | undefined {
      let Database: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Database = require('better-sqlite3');
      } catch {
        return undefined;
      }
      const dir = freshDir('cursor');
      const dbPath = path.join(dir, 'state.vscdb');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      const chat = {
        tabs: [
          {
            tabId: 't1',
            bubbles: [
              { type: 1, text: 'How do I declare a const?' },
              { type: 2, text: 'Like this:\n```ts\nconst x = 1;\n```' },
              { type: 1, text: 'looks good, apply' },
            ],
          },
        ],
      };
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'workbench.panel.aichat.view.aichat.chatdata',
        JSON.stringify(chat),
      );
      db.close();
      return dbPath;
    }

    test('parses chat messages + code blocks and infers keptCode from approval', async function () {
      // buildFixtureDb requires the native better-sqlite3 binding directly. Guard
      // BEFORE it is invoked so the require cannot throw in a runtime where the
      // native backend is unavailable (e.g. the Electron integration runner).
      if (!nativeVectorAvailable()) {
        this.skip();
        return;
      }
      const dbPath = buildFixtureDb();
      if (!dbPath) {
        this.skip();
        return;
      }
      const adapter = createCursorAdapter({ dbPath });
      const presence = await adapter.discover(envFor(undefined, { platform: 'win32' }));
      assert.strictEqual(presence.available, true, 'available when db exists');

      const sessions = await collectIterable(adapter.extract({}));
      assert.strictEqual(sessions.length, 1, 'one chat session');
      const s = sessions[0];
      assert.strictEqual(s.source, 'cursor');
      assert.strictEqual(s.messages.length, 3, 'three bubbles');

      const assistant = s.messages.find((m) => m.role === 'assistant');
      assert.ok(assistant && assistant.codeBlocks && assistant.codeBlocks.length === 1, 'code block captured');
      assert.ok(assistant!.codeBlocks![0].code.includes('const x = 1;'), 'code content preserved');

      assert.strictEqual(s.signals.keptCode.length, 1, 'approval => one kept code');
      assert.strictEqual(s.signals.keptCode[0].reason, 'user_approval');
      assert.ok(s.signals.keptCode[0].confidence > 0, 'kept confidence set');
    });

    test('missing db / native module degrades to unavailable, never throws', async function () {
      const adapter = createCursorAdapter({ dbPath: path.join(tmpRoot, 'does-not-exist.vscdb') });
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0);
      const sessions = await collectIterable(adapter.extract({}));
      assert.deepStrictEqual(sessions, [], 'no sessions, no throw');
    });
  });

  // -------------------------------------------------------------------------
  suite('generic adapter', function () {
    test('parses .jsonl and .md exports from a configured directory', async function () {
      const dir = freshDir('generic');
      writeFile(
        path.join(dir, 'export.jsonl'),
        [
          JSON.stringify({ role: 'user', text: 'How do I add two numbers?' }),
          JSON.stringify({ role: 'assistant', text: 'Use +:\n```js\na + b\n```' }),
        ].join('\n'),
      );
      writeFile(path.join(dir, 'notes.md'), '# Notes\n\n```python\nprint(1)\n```\n');

      const adapter = createGenericAdapter({ dir });
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, true);

      const sessions = await collectIterable(adapter.extract({}));
      assert.strictEqual(sessions.length, 2, 'one session per export file');

      const jsonl = sessions.find((s) => s.id.endsWith('export.jsonl'));
      assert.ok(jsonl, 'jsonl session present');
      assert.strictEqual(jsonl!.messages.length, 2);
      const asst = jsonl!.messages.find((m) => m.role === 'assistant');
      assert.ok(asst && asst.codeBlocks && asst.codeBlocks.length === 1, 'jsonl code block captured');

      const md = sessions.find((s) => s.id.endsWith('notes.md'));
      assert.ok(md, 'md session present');
      assert.ok(
        md!.messages[0].codeBlocks && md!.messages[0].codeBlocks.length === 1,
        'md code block captured',
      );
    });

    test('no configured directory => unavailable with hint, no throw', async function () {
      const adapter = createGenericAdapter();
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && /directory/i.test(presence.hint));
      const sessions = await collectIterable(adapter.extract({}));
      assert.deepStrictEqual(sessions, []);
    });
  });

  // -------------------------------------------------------------------------
  suite('registry: enablement defaults (D13)', function () {
    test('default registry exposes the built-in + Wave A + Tier-3 adapters', function () {
      const reg = createDefaultRegistry();
      assert.deepStrictEqual(reg.ids().sort(), [
        'autoclaw-native',
        'claude-code',
        'claude-desktop',
        'cline-roo',
        'continue',
        'cursor',
        'gemini',
        'generic',
        'kilocode',
        'kiro',
      ]);
    });

    test('defaults: native on, cursor + generic off', function () {
      const ids = ['autoclaw-native', 'cursor', 'generic'];
      assert.deepStrictEqual(resolveEnabledSources(undefined, ids), ['autoclaw-native']);
      assert.strictEqual(DEFAULT_SOURCE_ENABLED['autoclaw-native'], true);
      assert.strictEqual(DEFAULT_SOURCE_ENABLED['cursor'], false);
      assert.strictEqual(DEFAULT_SOURCE_ENABLED['generic'], false);
    });

    test('explicit config.sources toggle overrides defaults', function () {
      const ids = ['autoclaw-native', 'cursor', 'generic'];
      const enabled = resolveEnabledSources(
        { 'autoclaw-native': { enabled: false }, cursor: { enabled: true } },
        ids,
      );
      assert.deepStrictEqual(enabled.sort(), ['cursor']);
    });
  });

  // -------------------------------------------------------------------------
  suite('registry: per-adapter isolation (R1.5)', function () {
    test('a throwing / unavailable adapter does not abort the run', async function () {
      const reg = new SourceRegistry();
      reg.registerAdapter(
        fakeAdapter('good', {
          available: true,
          sessions: [session({ id: 'good:1', source: 'good', messages: [{ role: 'user', text: 'hi' }] })],
        }),
      );
      reg.registerAdapter(fakeAdapter('bad', { available: true, throwOnExtract: true }));
      reg.registerAdapter(fakeAdapter('gone', { available: false, hint: 'not installed' }));

      const warnings: string[] = [];
      const sessions = await reg.collectSessions({
        enabledIds: ['good', 'bad', 'gone'],
        env: envFor(),
        project: 'proj',
        log: (m) => warnings.push(m),
      });

      assert.strictEqual(sessions.length, 1, 'only the good adapter produced a session');
      assert.strictEqual(sessions[0].source, 'good');
      assert.strictEqual(sessions[0].project, 'proj', 'session tagged with resolved project (R1.6)');
      assert.ok(
        warnings.some((w) => w.includes('bad')),
        `expected a warning about the failing adapter, got ${JSON.stringify(warnings)}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  suite('registry: cross-source dedup (R5.5 / D12)', function () {
    test('merges duplicates across sources and raises kept-code confidence', async function () {
      const msg = [{ role: 'assistant' as const, text: 'apply this fix to the parser' }];
      const a = session({
        id: 'srcA:1',
        source: 'srcA',
        startedAt: 1000,
        messages: msg,
        signals: { keptCode: [{ code: 'const x = 1;', reason: 'user_approval', confidence: 0.6 }] },
      });
      const b = session({
        id: 'srcB:1',
        source: 'srcB',
        startedAt: 1500,
        messages: msg,
        signals: { keptCode: [{ code: 'const x = 1;', reason: 'user_approval', confidence: 0.6 }] },
      });

      const reg = new SourceRegistry();
      reg.registerAdapter(fakeAdapter('srcA', { available: true, sessions: [a] }));
      reg.registerAdapter(fakeAdapter('srcB', { available: true, sessions: [b] }));

      const sessions = await reg.collectSessions({
        enabledIds: ['srcA', 'srcB'],
        env: envFor(),
        project: 'proj',
      });

      assert.strictEqual(sessions.length, 1, 'duplicates merged into one session');
      const merged = sessions[0];
      assert.strictEqual(merged.signals.keptCode.length, 1, 'kept code de-duplicated');
      assert.ok(
        merged.signals.keptCode[0].confidence > 0.6,
        `confidence should rise above either source's 0.6, got ${merged.signals.keptCode[0].confidence}`,
      );
      assert.ok(
        Math.abs(merged.signals.keptCode[0].confidence - 0.84) < 1e-9,
        'noisy-OR of 0.6 and 0.6 is 0.84',
      );
    });

    test('dedupSessions leaves distinct sessions untouched', function () {
      const a = session({
        id: 'a',
        source: 'x',
        project: 'p',
        messages: [{ role: 'user', text: 'alpha' }],
      });
      const b = session({
        id: 'b',
        source: 'x',
        project: 'p',
        messages: [{ role: 'user', text: 'beta' }],
      });
      assert.strictEqual(dedupSessions([a, b]).length, 2);
    });
  });
});
