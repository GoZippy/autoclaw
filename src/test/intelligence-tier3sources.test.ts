/**
 * intelligence-tier3sources.test.ts — unit tests for the Tier-3 third-party
 * source adapters wired into the registry: Cline / Roo, Continue.dev, Kilo Code.
 *
 * Fixture-based normalization for each adapter plus registry wiring:
 *   - discover() degrades gracefully (available:false + hint) when no store
 *     exists, and reports available:true + locations when fixtures are present.
 *   - extract() normalizes the on-disk transcript into a UnifiedSession with the
 *     adapter-prefixed id, source tag, role mapping, project attribution, and
 *     respects the `limit` cap.
 *   - createDefaultRegistry registers all three ids, and they default OFF (D13).
 *
 * Pure-logic tests — no vscode, no extension host. Temp dirs live under a single
 * enclosing suite so teardown never races sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createClineRooAdapter } from '../intelligence/sources/clineRoo';
import { createContinueAdapter } from '../intelligence/sources/continue';
import { createKilocodeAdapter } from '../intelligence/sources/kilocode';
import {
  createDefaultRegistry,
  resolveEnabledSources,
  DEFAULT_SOURCE_ENABLED,
} from '../intelligence/sources/registry';
import { AdapterEnv, ExtractOptions, UnifiedSession } from '../intelligence/types';

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function envFor(workspaceRoot?: string): AdapterEnv {
  return { homeDir: '', workspaceRoot, platform: process.platform, env: {} };
}

async function collect(it: AsyncIterable<UnifiedSession>, opts?: ExtractOptions): Promise<UnifiedSession[]> {
  const out: UnifiedSession[] = [];
  for await (const s of it) {
    out.push(s);
  }
  return out;
}

/** Write a Cline/Kilo-style task dir: <extDir>/tasks/<taskId>/api_conversation_history.json */
function writeTask(extDir: string, taskId: string, records: unknown[]): void {
  writeJson(path.join(extDir, 'tasks', taskId, 'api_conversation_history.json'), records);
}

suite('intelligence — Tier-3 third-party source adapters', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-tier3-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // -------------------------------------------------------------------------
  // Cline / Roo
  // -------------------------------------------------------------------------
  suite('Cline / Roo adapter', () => {
    test('discover reports unavailable with a hint when no task history exists', async () => {
      const extDir = freshDir('clineroo-empty');
      const adapter = createClineRooAdapter({ globalStorageDirs: [extDir] });
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0, 'expected a hint');
      assert.deepStrictEqual(presence.locations, []);
    });

    test('discover + extract normalize a task transcript and tag the project', async () => {
      const extDir = freshDir('clineroo');
      writeTask(extDir, 'task-1', [
        { role: 'user', content: 'add a retry helper' },
        { role: 'assistant', content: [{ type: 'text', text: 'here is the helper' }] },
      ]);
      const adapter = createClineRooAdapter({ globalStorageDirs: [extDir] });

      const presence = await adapter.discover(envFor('k:/proj/demo'));
      assert.strictEqual(presence.available, true);
      assert.strictEqual(presence.locations.length, 1);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1);
      const s = sessions[0];
      assert.strictEqual(s.id, 'cline-roo:task-1');
      assert.strictEqual(s.source, 'cline-roo');
      assert.strictEqual(s.project, 'k:/proj/demo');
      assert.deepStrictEqual(s.messages.map((m) => m.role), ['user', 'assistant']);
      assert.strictEqual(s.messages[0].text, 'add a retry helper');
      assert.strictEqual(s.messages[1].text, 'here is the helper');
    });

    test('extract respects the limit cap', async () => {
      const extDir = freshDir('clineroo-limit');
      for (const id of ['a', 'b', 'c']) {
        writeTask(extDir, id, [{ role: 'user', content: `msg ${id}` }]);
      }
      const adapter = createClineRooAdapter({ globalStorageDirs: [extDir] });
      await adapter.discover(envFor());
      const sessions = await collect(adapter.extract({ limit: 2 }));
      assert.strictEqual(sessions.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Kilo Code
  // -------------------------------------------------------------------------
  suite('Kilo Code adapter', () => {
    test('discover reports unavailable when the globalStorage dir is empty', async () => {
      const extDir = freshDir('kilo-empty');
      const adapter = createKilocodeAdapter({ globalStorageDir: extDir });
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0);
    });

    test('discover + extract normalize a task transcript, including tool blocks', async () => {
      const extDir = freshDir('kilo');
      writeTask(extDir, 'k-task', [
        { role: 'user', content: 'run the tests' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running' },
            { type: 'tool_use', name: 'bash', input: { cmd: 'npm test' } },
          ],
        },
      ]);
      const adapter = createKilocodeAdapter({ globalStorageDir: extDir });
      const presence = await adapter.discover(envFor('k:/proj/kilo'));
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1);
      const s = sessions[0];
      assert.strictEqual(s.id, 'kilocode:k-task');
      assert.strictEqual(s.source, 'kilocode');
      assert.strictEqual(s.project, 'k:/proj/kilo');
      assert.strictEqual(s.messages[0].text, 'run the tests');
      assert.ok(
        s.messages[1].text.includes('running') && s.messages[1].text.includes('[tool_use bash'),
        'assistant turn should flatten text + tool_use block',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Continue.dev
  // -------------------------------------------------------------------------
  suite('Continue adapter', () => {
    test('discover reports unavailable when no sessions dir exists', async () => {
      const dir = path.join(freshDir('continue-empty'), 'does-not-exist');
      const adapter = createContinueAdapter({ sessionsDir: dir });
      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, false);
      assert.ok(presence.hint && presence.hint.length > 0);
    });

    test('discover + extract normalize a session file and skip the index', async () => {
      const dir = freshDir('continue');
      // The sessions.json index must be ignored, not parsed as a transcript.
      writeJson(path.join(dir, 'sessions.json'), [{ sessionId: 's1', title: 'idx' }]);
      writeJson(path.join(dir, 's1.json'), {
        sessionId: 's1',
        title: 'Refactor auth',
        workspaceDirectory: 'k:/proj/continue',
        history: [
          { message: { role: 'user', content: 'refactor the auth module' } },
          { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        ],
      });
      const adapter = createContinueAdapter({ sessionsDir: dir });

      const presence = await adapter.discover(envFor());
      assert.strictEqual(presence.available, true);

      const sessions = await collect(adapter.extract({}));
      assert.strictEqual(sessions.length, 1, 'sessions.json index must be skipped');
      const s = sessions[0];
      assert.strictEqual(s.id, 'continue:s1');
      assert.strictEqual(s.source, 'continue');
      assert.strictEqual(s.title, 'Refactor auth');
      assert.strictEqual(s.project, 'k:/proj/continue');
      assert.deepStrictEqual(s.messages.map((m) => m.role), ['user', 'assistant']);
      assert.strictEqual(s.messages[0].text, 'refactor the auth module');
    });
  });

  // -------------------------------------------------------------------------
  // Registry wiring (D13)
  // -------------------------------------------------------------------------
  suite('registry wiring', () => {
    test('createDefaultRegistry registers all three Tier-3 adapters', () => {
      const ids = createDefaultRegistry().ids();
      for (const id of ['cline-roo', 'continue', 'kilocode']) {
        assert.ok(ids.includes(id), `expected default registry to include ${id}`);
      }
    });

    test('all three default OFF and stay off unless explicitly enabled', () => {
      for (const id of ['cline-roo', 'continue', 'kilocode']) {
        assert.strictEqual(DEFAULT_SOURCE_ENABLED[id], false, `${id} must default off`);
      }
      const known = ['autoclaw-native', 'cline-roo', 'continue', 'kilocode'];
      // No config → only the native default-on adapter runs.
      assert.deepStrictEqual(resolveEnabledSources(undefined, known), ['autoclaw-native']);
      // Explicit opt-in for one third-party source includes just that one.
      assert.deepStrictEqual(
        resolveEnabledSources({ continue: { enabled: true } }, known).sort(),
        ['autoclaw-native', 'continue'],
      );
    });
  });
});
