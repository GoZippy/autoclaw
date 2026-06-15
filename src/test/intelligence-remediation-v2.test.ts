/**
 * intelligence-remediation-v2.test.ts — unit tests for the v2-review remediation
 * (FEAT-010). Each suite pins one corrected behavior so a regression is loud:
 *
 *  - Issue 2: repeated `/learn` runs no longer accumulate unbounded duplicate
 *    `learn` vectors — each run replaces the project's prior `learn` records, so
 *    the embedded count stays stable instead of growing every run (R6.2).
 *  - Issue 3: a model change raises a PERSISTENT stale-index signal that survives
 *    reopen (it is not a one-shot warning) and is cleared only by a `--force`
 *    index rebuild — surfaced via `VectorDB.staleIndex` and `IndexResult.staleIndex`.
 *
 * Offline + deterministic (provider 'none' embeddings, stubbed git). All temp
 * dirs live inside a SINGLE enclosing suite so teardown never races siblings.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { indexCodebase, GitRunner } from '../intelligence/ragCode';
import { learnFromSessions } from '../intelligence/learn';
import { initVectorDB } from '../intelligence/vector';
import { getNoneEmbedding } from '../intelligence/embeddings';
import { defaultConfig } from '../intelligence/config';
import { resolveProjectKey } from '../intelligence/project';
import { intelligencePaths } from '../intelligence/paths';
import { SourceRegistry } from '../intelligence/sources/registry';
import {
  AdapterEnv,
  EmbeddingSignature,
  ExtractOptions,
  IntelligenceConfig,
  SourceAdapter,
  UnifiedSession,
} from '../intelligence/types';
import { nativeVectorAvailable } from './_vectorBackendAvailable';

const DIM = 64;
const SIGNATURE: EmbeddingSignature = { model: 'none-test', dimension: DIM };

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'vec-'));
  return path.join(dir, 'db.sqlite').replace(/\\/g, '/');
}

function embed(text: string): number[] {
  return getNoneEmbedding(text, DIM);
}

/** Deterministic offline config with an explicit none-provider signature. */
function offlineConfig(): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding = { provider: 'none', model: SIGNATURE.model, dimension: DIM };
  return cfg;
}

/** Deterministic offline RAG config with tiny chunks (a given embedding model). */
function ragConfig(model: string): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding = { provider: 'none', model, dimension: DIM };
  cfg.rag.codeChunkSize = 1000;
  cfg.rag.codeOverlap = 0;
  cfg.rag.fileExtensions = ['.ts'];
  cfg.rag.incremental = true;
  cfg.search.defaultLimit = 50;
  cfg.search.minSimilarity = -1;
  return cfg;
}

const stubGit = (handler: (args: string) => string): GitRunner => (args: string) => handler(args);

// learn helpers ------------------------------------------------------------

function fakeAdapter(id: string, sessions: UnifiedSession[]): SourceAdapter {
  return {
    id,
    displayName: id,
    tier: 3,
    capabilities: {
      fullTranscripts: true,
      codeBlocks: true,
      timestamps: true,
      workspaceAttribution: true,
      incremental: false,
    },
    async discover(): Promise<any> {
      return { available: true, locations: [] };
    },
    async *extract(_opts: ExtractOptions): AsyncIterable<UnifiedSession> {
      for (const s of sessions) {
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

function registryWith(adapters: SourceAdapter[]): SourceRegistry {
  const reg = new SourceRegistry();
  for (const a of adapters) {
    reg.registerAdapter(a);
  }
  return reg;
}

function envFor(ws: string): AdapterEnv {
  return { homeDir: tmpRoot, workspaceRoot: ws, platform: process.platform, env: {} };
}

async function countLearnRecords(ws: string, signature: EmbeddingSignature): Promise<number> {
  const project = resolveProjectKey(ws);
  const { dbPath } = intelligencePaths(ws);
  const db = await initVectorDB(dbPath, signature);
  try {
    const ids = await db.listIds({ project, source: 'learn' });
    return ids.length;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

suite('intelligence-remediation-v2', function () {
  suiteSetup(function () {
    // Every test in this file exercises a WORKING native vector backend
    // (initVectorDB / learnFromSessions / indexCodebase round-trips). Skip
    // cleanly where the native backend cannot load (e.g. the Electron
    // integration runner); runs fully in plain Node.
    if (!nativeVectorAvailable()) {
      this.skip();
    }
  });
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-remediation-v2-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  // Issue 2 — /learn replaces prior learn vectors (no unbounded accumulation)
  // -------------------------------------------------------------------------

  suite('learn does not accumulate duplicate vectors (issue 2)', function () {
    function learnOnce(ws: string): Promise<unknown> {
      const s = session({
        id: 'native:1',
        source: 'autoclaw-native',
        tool: 'AutoClaw',
        title: 'Parser fix',
        summary: 'Refactored the tokenizer for clarity',
        signals: {
          keptCode: [
            { code: 'const parsed = parse(input);', reason: 'user_approval', confidence: 0.8 },
          ],
          outcome: 'shipped',
        },
      });
      return learnFromSessions({
        workspaceRoot: ws,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('autoclaw-native', [s])]),
        enabledIds: ['autoclaw-native'],
        env: envFor(ws),
      });
    }

    test('repeated identical /learn runs keep the learn-record count stable', async function () {
      const ws = freshDir('ws-learn-dedup');

      await learnOnce(ws);
      const afterFirst = await countLearnRecords(ws, SIGNATURE);
      assert.ok(afterFirst > 1, `first run should embed multiple learn records (got ${afterFirst})`);

      await learnOnce(ws);
      const afterSecond = await countLearnRecords(ws, SIGNATURE);

      assert.strictEqual(
        afterSecond,
        afterFirst,
        `repeated /learn must not accumulate duplicates: ${afterFirst} -> ${afterSecond}`,
      );

      // A third run for good measure — still bounded, never growing.
      await learnOnce(ws);
      const afterThird = await countLearnRecords(ws, SIGNATURE);
      assert.strictEqual(
        afterThird,
        afterFirst,
        `learn corpus must stay one generation per project: ${afterFirst} -> ${afterThird}`,
      );
    });

    test('replacing a project\'s learn vectors leaves other sources untouched', async function () {
      const ws = freshDir('ws-learn-isolation');
      const project = resolveProjectKey(ws);
      const { dbPath } = intelligencePaths(ws);

      // Seed an unrelated code-rag record for the same project.
      const seed = await initVectorDB(dbPath, SIGNATURE);
      await seed.storeEmbeddings([
        {
          id: `code-rag:${project}:a.ts:1-2`,
          content: 'seed',
          embedding: embed('seed'),
          source: 'code-rag',
          project,
        },
      ]);
      seed.close();

      await learnOnce(ws);
      await learnOnce(ws);

      const db = await initVectorDB(dbPath, SIGNATURE);
      try {
        const codeIds = await db.listIds({ project, source: 'code-rag' });
        assert.strictEqual(codeIds.length, 1, 'the unrelated code-rag record must survive /learn');
      } finally {
        db.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Issue 3 — persistent stale-index signal (survives reopen until --force)
  // -------------------------------------------------------------------------

  suite('persistent stale-index signal (issue 3)', function () {
    test('a model change raises a stale signal that survives reopen until --force', async function () {
      const dbPath = freshDbPath();

      // Provision with model-A.
      const a = await initVectorDB(dbPath, { model: 'model-A', dimension: DIM });
      assert.strictEqual(a.staleIndex, false, 'fresh index is not stale');
      await a.storeEmbedding({
        id: 'x',
        content: 'hello',
        embedding: embed('hello'),
        source: 'unit',
        project: 'proj',
      });
      a.close();

      // Reopen with model-B: model-change warning AND stale flag set.
      const warnsB: string[] = [];
      const b = await initVectorDB(dbPath, { model: 'model-B', dimension: DIM }, (m) =>
        warnsB.push(m),
      );
      assert.strictEqual(b.staleIndex, true, 'model change marks the index stale');
      assert.ok(
        warnsB.some((w) => /embedding model changed/i.test(w)),
        `expected a model-change warning: ${JSON.stringify(warnsB)}`,
      );
      b.close();

      // Reopen AGAIN with model-B (no model change now) — the signal must persist
      // and re-surface; it is NOT a one-shot warning.
      const warnsC: string[] = [];
      const c = await initVectorDB(dbPath, { model: 'model-B', dimension: DIM }, (m) =>
        warnsC.push(m),
      );
      assert.strictEqual(c.staleIndex, true, 'stale signal survives reopen');
      assert.ok(
        warnsC.some((w) => /stale/i.test(w)),
        `expected a persisted stale warning on reopen: ${JSON.stringify(warnsC)}`,
      );
      c.close();

      // A --force rebuild clears the signal.
      const d = await initVectorDB(dbPath, { model: 'model-B', dimension: DIM }, undefined, {
        forceRebuild: true,
      });
      assert.strictEqual(d.staleIndex, false, '--force rebuild clears the stale signal');
      d.close();

      // And it stays cleared on the next normal open.
      const warnsE: string[] = [];
      const e = await initVectorDB(dbPath, { model: 'model-B', dimension: DIM }, (m) =>
        warnsE.push(m),
      );
      assert.strictEqual(e.staleIndex, false, 'stale signal stays cleared after rebuild');
      assert.ok(
        !warnsE.some((w) => /stale/i.test(w)),
        `unexpected stale warning after rebuild: ${JSON.stringify(warnsE)}`,
      );
      e.close();
    });

    test('indexCodebase surfaces staleIndex on a non-force run and a --force run clears it', async function () {
      const ws = freshDir('ws-stale-index');
      writeFile(ws, 'mod.ts', 'export const ONE = 1;');

      // First index under model "m-a".
      const first = await indexCodebase({
        workspaceRoot: ws,
        config: ragConfig('m-a'),
        gitRunner: stubGit(() => ''),
      });
      assert.strictEqual(first.staleIndex, false, 'fresh index is not stale');

      // Re-index (non-force) under a different model at the same dimension:
      // the result must report the persisted stale signal.
      const changed = await indexCodebase({
        workspaceRoot: ws,
        config: ragConfig('m-b'),
        gitRunner: stubGit(() => ''),
      });
      assert.strictEqual(changed.staleIndex, true, 'model change surfaces a stale index');

      // A --force rebuild with the new model clears it.
      const rebuilt = await indexCodebase({
        workspaceRoot: ws,
        config: ragConfig('m-b'),
        force: true,
        gitRunner: stubGit(() => ''),
      });
      assert.strictEqual(rebuilt.staleIndex, false, '--force rebuild clears the stale signal');

      // Subsequent normal run stays clean.
      const after = await indexCodebase({
        workspaceRoot: ws,
        config: ragConfig('m-b'),
        gitRunner: stubGit(() => ''),
      });
      assert.strictEqual(after.staleIndex, false, 'stale signal stays cleared');
    });
  });
});
