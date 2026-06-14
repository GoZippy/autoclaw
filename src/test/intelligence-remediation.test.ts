/**
 * intelligence-remediation.test.ts — unit tests for the v1-review remediation
 * (FEAT-009). Each suite pins one corrected behavior so a regression is loud:
 *
 *  - Issue 1: re-indexing converges — a modified file's stale chunk ranges are
 *    deleted before re-insert, and a deleted file's chunks are swept, so the
 *    RAG index no longer accumulates orphans (R4.2/R4.3).
 *  - Issue 3: code-RAG redaction preserves benign long tokens (base64/hashes)
 *    while still removing real secrets via the targeted patterns (R7.1).
 *  - Issue 4: `/learn` embeds every distilled LearnedMemory record (not just a
 *    single per-run reflection), so `/search` covers individual learnings (R6.2).
 *  - Issue 6: a model change at equal dimension warns instead of silently mixing
 *    incomparable vector geometries.
 *  - New vector-store primitives (storeEmbeddings batch + deleteByIdPrefix +
 *    listIds) round-trip against a real sqlite-vec DB.
 *
 * Offline + deterministic (provider 'none' embeddings, stubbed git). All temp
 * dirs live inside a SINGLE enclosing suite so teardown never races siblings.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { indexCodebase, retrieveCode, GitRunner } from '../intelligence/ragCode';
import { learnFromSessions } from '../intelligence/learn';
import { initVectorDB } from '../intelligence/vectorEngine';
import { redactSecrets } from '../intelligence/redact';
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

/** Deterministic offline RAG config with tiny chunks. */
function noneRagConfig(): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding = { provider: 'none', model: 'none-test', dimension: DIM };
  cfg.rag.codeChunkSize = 30;
  cfg.rag.codeOverlap = 0;
  cfg.rag.fileExtensions = ['.ts'];
  cfg.rag.incremental = true;
  cfg.search.defaultLimit = 50;
  cfg.search.minSimilarity = -1; // keep every match for deterministic assertions
  return cfg;
}

function offlineConfig(): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding.provider = 'none';
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

// ---------------------------------------------------------------------------

suite('intelligence-remediation', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-remediation-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  // Issue 1 — re-indexing converges (no stale orphans)
  // -------------------------------------------------------------------------

  suite('re-index convergence (issue 1)', function () {
    suiteSetup(function () {
      if (!nativeVectorAvailable()) {
        this.skip();
      }
    });

    test('a modified file drops its stale chunks instead of orphaning them', async function () {
      const ws = freshDir('ws-modify');
      // Original: 3 short lines -> id range ...:1-3 with the stale token.
      writeFile(ws, 'mod.ts', 'const STALEONLYTOKEN = 1;\nconst two = 2;\nconst three = 3;');
      const cfg = noneRagConfig();
      cfg.rag.codeChunkSize = 1000; // single chunk spanning all lines

      await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: stubGit(() => '') });
      const before = await retrieveCode('STALEONLYTOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        before.some((h) => h.content.includes('STALEONLYTOKEN')),
        'baseline: stale token should be retrievable after the first index',
      );

      // Rewrite with FEWER lines + different content -> id range ...:1-1.
      writeFile(ws, 'mod.ts', 'const FRESHTOKEN = 99;');
      const forced = await indexCodebase({
        workspaceRoot: ws,
        config: cfg,
        force: true,
        gitRunner: stubGit(() => ''),
      });
      assert.ok(forced.chunksDeleted >= 0, 'result reports a sweep count');

      const after = await retrieveCode('STALEONLYTOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        !after.some((h) => h.content.includes('STALEONLYTOKEN')),
        'the modified file must not leave behind its old chunk',
      );
      const fresh = await retrieveCode('FRESHTOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        fresh.some((h) => h.content.includes('FRESHTOKEN')),
        'the current chunk should be retrievable',
      );
    });

    test('a deleted file is swept from the index on the next run', async function () {
      const ws = freshDir('ws-delete');
      writeFile(ws, 'keep.ts', 'export const KEEPUNIQUETOKEN = 1;');
      writeFile(ws, 'gone.ts', 'export const GONEUNIQUETOKEN = 2;');
      const cfg = noneRagConfig();

      await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: stubGit(() => '') });
      const before = await retrieveCode('GONEUNIQUETOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        before.some((h) => h.content.includes('GONEUNIQUETOKEN')),
        'baseline: deleted-file content present before removal',
      );

      // Remove the file from disk, then re-index.
      fs.rmSync(path.join(ws, 'gone.ts'));
      const res = await indexCodebase({
        workspaceRoot: ws,
        config: cfg,
        gitRunner: stubGit(() => ''),
      });
      assert.ok(res.chunksDeleted >= 1, 'sweep should delete the removed file chunks');

      const after = await retrieveCode('GONEUNIQUETOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        !after.some((h) => h.content.includes('GONEUNIQUETOKEN')),
        "the deleted file's chunks must be gone",
      );
      const keep = await retrieveCode('KEEPUNIQUETOKEN', { workspaceRoot: ws, config: cfg });
      assert.ok(
        keep.some((h) => h.content.includes('KEEPUNIQUETOKEN')),
        'surviving file content must remain indexed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Issue 3 — code-RAG redaction keeps benign long tokens, drops real secrets
  // -------------------------------------------------------------------------

  suite('code redaction tradeoff (issue 3)', function () {
    const BENIGN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718'; // 48-char hex, benign

    test('skipGenericToken preserves benign long runs but still removes targeted secrets', function () {
      const input = `const hash = "${BENIGN}";\nconst key = "AKIAIOSFODNN7EXAMPLE";`;
      const redacted = redactSecrets(input, { skipGenericToken: true });
      assert.ok(redacted.includes(BENIGN), 'benign long token must survive for code retrieval');
      assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'), 'real AWS key still redacted');
      assert.ok(redacted.includes('\u2039redacted:api-key\u203a'), 'api-key marker present');
    });

    test('default redaction (no option) still redacts the generic long token', function () {
      const redacted = redactSecrets(`value = ${BENIGN}`);
      assert.ok(!redacted.includes(BENIGN), 'generic pass still applies by default');
      assert.ok(redacted.includes('\u2039redacted:token\u203a'));
    });

    test('indexed code keeps the benign token in stored content', async function () {
      // This case stores through the native vector backend; skip when it cannot
      // load. The two redactSecrets-only cases above run regardless.
      if (!nativeVectorAvailable()) {
        this.skip();
        return;
      }
      const ws = freshDir('ws-redact-keep');
      writeFile(
        ws,
        'hash.ts',
        `export const contentHash = "${BENIGN}";\nexport const awsKey = "AKIAIOSFODNN7EXAMPLE";`,
      );
      const cfg = noneRagConfig();
      cfg.rag.codeChunkSize = 1000;

      await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: stubGit(() => '') });
      const hits = await retrieveCode('contentHash', { workspaceRoot: ws, config: cfg });
      assert.ok(hits.length >= 1, 'chunk retrievable');
      assert.ok(hits[0].content.includes(BENIGN), 'benign hash preserved in stored chunk');
      assert.ok(
        !hits[0].content.includes('AKIAIOSFODNN7EXAMPLE'),
        'the real secret is still stripped from code',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Issue 4 — /learn embeds every distilled record (search corpus widened)
  // -------------------------------------------------------------------------

  suite('learn embeds every record (issue 4)', function () {
    suiteSetup(function () {
      if (!nativeVectorAvailable()) {
        this.skip();
      }
    });

    test('multiple learning records are embedded, not just one reflection', async function () {
      const ws = freshDir('ws-learn-embed');
      const s = session({
        id: 'native:1',
        source: 'autoclaw-native',
        tool: 'AutoClaw',
        title: 'Parser fix',
        summary: 'Refactored the tokenizer for clarity',
        signals: {
          keptCode: [{ code: 'const parsed = parse(input);', reason: 'user_approval', confidence: 0.8 }],
          outcome: 'shipped',
        },
      });

      await learnFromSessions({
        workspaceRoot: ws,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('autoclaw-native', [s])]),
        enabledIds: ['autoclaw-native'],
        env: envFor(ws),
      });

      // Open the store and confirm several `learn` records were embedded.
      const project = resolveProjectKey(ws);
      const { dbPath } = intelligencePaths(ws);
      const db = await initVectorDB(dbPath, { model: 'none', dimension: 768 });
      try {
        assert.strictEqual(db.degraded, false, 'backend available');
        const ids = await db.listIds({ project, source: 'learn' });
        assert.ok(
          ids.length > 1,
          `expected multiple embedded learnings, got ${ids.length}: ${JSON.stringify(ids)}`,
        );
      } finally {
        db.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Issue 6 — model change at equal dimension warns
  // -------------------------------------------------------------------------

  suite('model-change warning (issue 6)', function () {
    suiteSetup(function () {
      if (!nativeVectorAvailable()) {
        this.skip();
      }
    });

    test('re-opening with a different model (same dim) emits a warning', async function () {
      const dbPath = freshDbPath();
      const first = await initVectorDB(dbPath, { model: 'model-A', dimension: DIM });
      await first.storeEmbedding({
        id: 'x',
        content: 'hello',
        embedding: embed('hello'),
        source: 'unit',
        project: 'proj',
      });
      first.close();

      const warnings: string[] = [];
      const second = await initVectorDB(
        dbPath,
        { model: 'model-B', dimension: DIM },
        (m) => warnings.push(m),
      );
      second.close();

      assert.ok(
        warnings.some((w) => /embedding model changed/i.test(w)),
        `expected a model-change warning, got: ${JSON.stringify(warnings)}`,
      );
    });

    test('re-opening with the same model emits no model-change warning', async function () {
      const dbPath = freshDbPath();
      const first = await initVectorDB(dbPath, SIGNATURE);
      first.close();

      const warnings: string[] = [];
      const second = await initVectorDB(dbPath, SIGNATURE, (m) => warnings.push(m));
      second.close();

      assert.ok(
        !warnings.some((w) => /embedding model changed/i.test(w)),
        `unexpected model-change warning: ${JSON.stringify(warnings)}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // New vector-store primitives (batch store + prefix delete + listIds)
  // -------------------------------------------------------------------------

  suite('vector-store primitives', function () {
    suiteSetup(function () {
      if (!nativeVectorAvailable()) {
        this.skip();
      }
    });

    test('storeEmbeddings batch inserts, deleteIdPrefixes clears, listIds enumerates', async function () {
      const dbPath = freshDbPath();
      const db = await initVectorDB(dbPath, SIGNATURE);
      try {
        const stored = await db.storeEmbeddings([
          { id: 'code-rag:P:a.ts:1-2', content: 'a', embedding: embed('a'), source: 'code-rag', project: 'P' },
          { id: 'code-rag:P:a.ts:3-4', content: 'b', embedding: embed('b'), source: 'code-rag', project: 'P' },
          { id: 'code-rag:P:b.ts:1-1', content: 'c', embedding: embed('c'), source: 'code-rag', project: 'P' },
          { id: 'learn:P:r', content: 'd', embedding: embed('d'), source: 'learn', project: 'P' },
        ]);
        assert.strictEqual(stored, 4, 'all four records stored in one batch');

        const codeIds = await db.listIds({ project: 'P', source: 'code-rag' });
        assert.strictEqual(codeIds.length, 3, 'three code-rag ids');
        const learnIds = await db.listIds({ project: 'P', source: 'learn' });
        assert.strictEqual(learnIds.length, 1, 'one learn id');

        // Prefix delete removes only a.ts chunks (literal match, not LIKE wildcard).
        const removed = await db.deleteByIdPrefix('code-rag:P:a.ts:');
        assert.strictEqual(removed, 2, 'both a.ts chunks removed');
        const afterCode = await db.listIds({ project: 'P', source: 'code-rag' });
        assert.deepStrictEqual(afterCode, ['code-rag:P:b.ts:1-1'], 'only b.ts survives');

        // deleteIdPrefixes inside storeEmbeddings deletes-then-inserts atomically.
        const re = await db.storeEmbeddings(
          [{ id: 'code-rag:P:b.ts:1-3', content: 'c2', embedding: embed('c2'), source: 'code-rag', project: 'P' }],
          { deleteIdPrefixes: ['code-rag:P:b.ts:'] },
        );
        assert.strictEqual(re, 1);
        const finalCode = await db.listIds({ project: 'P', source: 'code-rag' });
        assert.deepStrictEqual(finalCode, ['code-rag:P:b.ts:1-3'], 'old b.ts range replaced');
      } finally {
        db.close();
      }
    });
  });
});
