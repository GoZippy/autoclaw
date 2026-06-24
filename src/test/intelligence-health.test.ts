/**
 * intelligence-health.test.ts — the Intelligence-Layer health aggregator
 * (getIntelligenceHealth) + the index-health snapshot round-trip + the
 * force-rebuild pre-flight guard that refuses to poison the store when the
 * configured embedding provider is down.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { getIntelligenceHealth } from '../intelligence/health';
import { loadConfig } from '../intelligence/config';
import { intelligencePaths } from '../intelligence/paths';
import { resolveProjectKey } from '../intelligence/project';
import { readIndexHealth, indexCodebase, IndexHealthSnapshot } from '../intelligence/ragCode';

let tmpRoot: string;
function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeSnapshot(ws: string, snap: Partial<IndexHealthSnapshot>): void {
  const paths = intelligencePaths(ws);
  const project = resolveProjectKey(ws);
  const full: IndexHealthSnapshot = {
    schemaVersion: 1,
    project,
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimension: 768,
    chunkCount: 100,
    staleIndex: false,
    embeddingDegraded: false,
    indexedAt: new Date().toISOString(),
    commit: 'abc123',
    lastRun: {
      filesIndexed: 10,
      chunksIndexed: 100,
      chunksDeleted: 0,
      incremental: false,
      cancelled: false,
    },
    ...snap,
  };
  fs.mkdirSync(paths.vectorDir, { recursive: true });
  fs.writeFileSync(paths.indexHealthPath, JSON.stringify({ [project]: full }, null, 2), 'utf8');
}

const nudgeIds = (h: { nudges: { id: string }[] }) => h.nudges.map((n) => n.id);

suite('intelligence — health aggregator + index stability', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-health-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  suite('getIntelligenceHealth', () => {
    test('a fresh, never-indexed workspace is not green and nudges to index + learn', async () => {
      const ws = freshDir('fresh');
      const h = await getIntelligenceHealth(ws, { probe: false });
      assert.strictEqual(h.index.neverIndexed, true);
      assert.notStrictEqual(h.status, 'green');
      const ids = nudgeIds(h);
      assert.ok(ids.includes('never-indexed'), `expected never-indexed, got ${ids}`);
      assert.ok(ids.includes('learn-never'), `expected learn-never, got ${ids}`);
      // auto + no pin → provider unresolved
      assert.strictEqual(h.provider.resolved, undefined);
      assert.ok(ids.includes('provider-unresolved'));
    });

    test('a stale snapshot drives status RED with an index-stale error nudge', async () => {
      const ws = freshDir('stale');
      writeSnapshot(ws, { staleIndex: true, chunkCount: 50 });
      const h = await getIntelligenceHealth(ws, { probe: false });
      assert.strictEqual(h.index.stale, true);
      assert.strictEqual(h.status, 'red');
      const stale = h.nudges.find((n) => n.id === 'index-stale');
      assert.ok(stale && stale.severity === 'error', 'expected an error-severity index-stale nudge');
    });

    test('many changed files since last index produces an index-drift nudge', async () => {
      const ws = freshDir('drift');
      writeSnapshot(ws, { chunkCount: 200, commit: 'OLDCOMMIT' });
      const manyFiles = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join('\n');
      const h = await getIntelligenceHealth(ws, {
        probe: false,
        gitRunner: (args) => (args.startsWith('diff') ? manyFiles : 'HEADSHA'),
      });
      assert.ok((h.index.driftFiles ?? 0) >= 25);
      assert.ok(nudgeIds(h).includes('index-drift'));
    });

    test('explicit "none" provider yields a provider-none warn (not green)', async () => {
      const ws = freshDir('none');
      writeSnapshot(ws, { chunkCount: 10, provider: 'none', model: 'none-hashed-bow' });
      const base = loadConfig(ws);
      const config = {
        ...base,
        embedding: { ...base.embedding, provider: 'none' as const, model: 'none-hashed-bow', dimension: 768 },
      };
      const h = await getIntelligenceHealth(ws, {
        config,
        probe: false,
        gitRunner: (args) => (args.startsWith('diff') ? '' : 'HEADSHA'),
      });
      assert.ok(nudgeIds(h).includes('provider-none'));
      assert.notStrictEqual(h.status, 'green');
    });
  });

  suite('index-health snapshot round-trip', () => {
    test('readIndexHealth returns a written per-project snapshot', () => {
      const ws = freshDir('rt');
      writeSnapshot(ws, { chunkCount: 7 });
      const paths = intelligencePaths(ws);
      const project = resolveProjectKey(ws);
      const snap = readIndexHealth(paths.indexHealthPath, project);
      assert.ok(snap, 'expected a snapshot');
      assert.strictEqual(snap!.chunkCount, 7);
      assert.strictEqual(snap!.schemaVersion, 1);
    });

    test('readIndexHealth is absent-tolerant (undefined for an unindexed project)', () => {
      const ws = freshDir('absent');
      const paths = intelligencePaths(ws);
      assert.strictEqual(readIndexHealth(paths.indexHealthPath, 'nope'), undefined);
    });
  });

  suite('force-rebuild pre-flight guard', () => {
    test('a force rebuild against a down provider aborts WITHOUT touching the store', async () => {
      const ws = freshDir('preflight');
      const base = loadConfig(ws);
      const config = {
        ...base,
        embedding: {
          ...base.embedding,
          provider: 'ollama' as const,
          model: 'nomic-embed-text',
          dimension: 768,
          // a closed port → connection refused → instant degrade (no 30s wait)
          ollamaHost: 'http://127.0.0.1:1',
        },
      };
      const result = await indexCodebase({
        workspaceRoot: ws,
        force: true,
        config,
        gitRunner: () => 'HEADSHA',
      });
      assert.strictEqual(result.abortedProviderDown, true, 'expected the rebuild to be refused');
      assert.strictEqual(result.filesIndexed, 0);
      assert.strictEqual(result.staleIndex, false);
      // the store was never opened/created
      const paths = intelligencePaths(ws);
      assert.strictEqual(fs.existsSync(paths.dbPath), false, 'db must not be created on abort');
    });

    test('a HUNG (accepting-but-silent) provider host aborts via the ~1.5s detect path, not a 30s embed wait', async () => {
      // A TCP server that accepts the socket and never responds — this is the
      // case the embed-timeout path (30s) would stall on. The detect path bounds
      // it to DETECT_TIMEOUT_MS (1.5s). We track + destroy server-side sockets so
      // teardown does not block on the lingering half-open connection.
      const sockets = new Set<net.Socket>();
      const server = net.createServer((s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
        // accept and hang — never write a response
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      server.unref();
      const port = (server.address() as net.AddressInfo).port;
      try {
        const ws = freshDir('hung');
        const base = loadConfig(ws);
        const config = {
          ...base,
          embedding: {
            ...base.embedding,
            provider: 'ollama' as const,
            model: 'nomic-embed-text',
            dimension: 768,
            ollamaHost: `http://127.0.0.1:${port}`,
          },
        };
        const started = Date.now();
        const result = await indexCodebase({ workspaceRoot: ws, force: true, config, gitRunner: () => 'HEADSHA' });
        const elapsed = Date.now() - started;
        assert.strictEqual(result.abortedProviderDown, true, 'a hung host must abort the rebuild');
        assert.ok(elapsed < 10000, `pre-flight should bound to ~1.5s, took ${elapsed}ms`);
      } finally {
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            /* ignore */
          }
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    test('provider "auto" is resolved before the pre-flight, so it never falsely aborts', async () => {
      const ws = freshDir('autopf');
      const base = loadConfig(ws);
      // auto with nothing reachable → resolves to none → pre-flight is skipped
      // (none cannot poison geometry); the run degrades on the missing backend
      // rather than reporting a provider-down abort.
      const config = { ...base, embedding: { ...base.embedding, provider: 'auto' as const } };
      const result = await indexCodebase({ workspaceRoot: ws, force: true, config, gitRunner: () => 'HEADSHA' });
      assert.notStrictEqual(result.abortedProviderDown, true, 'auto must not be treated as a down provider');
    });
  });

  suite('empty-index reporting', () => {
    test('a written snapshot with 0 chunks is NOT reported as never-indexed', async () => {
      const ws = freshDir('empty');
      writeSnapshot(ws, { chunkCount: 0 });
      const h = await getIntelligenceHealth(ws, {
        probe: false,
        gitRunner: (args) => (args.startsWith('diff') ? '' : 'HEADSHA'),
      });
      assert.strictEqual(h.index.neverIndexed, false, 'a successful empty index is still indexed');
      assert.ok(!nudgeIds(h).includes('never-indexed'), 'must not nag as un-indexed');
    });
  });
});
