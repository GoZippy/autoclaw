/**
 * intelligence-ragcode.test.ts — unit tests for the codebase RAG module
 * (Phase-1 intelligence-core-loop, Group 5 / tasks 5.1-5.3).
 *
 * Verifies:
 *  - chunkCode line-aware chunking + overlap with deterministic line ranges,
 *    plus small-file and overlap >= size defensive handling (R4.1)
 *  - indexCodebase honors ignoredDirs/fileExtensions, redacts chunk text before
 *    storing (R7.1), and tags chunks with project key + file metadata (R4.2)
 *  - incremental git-diff selection re-indexes only changed files, --force does
 *    a full reindex and updates last-index.json (R4.2 / R4.3) — using a STUBBED
 *    git runner so the test needs no real repo
 *  - retrieveCode returns { file, content, score } scoped to the current project
 *    namespace; a different project does not see project A's content (R4.4 / D11)
 *  - a degraded vector backend yields 0-indexed / empty retrieval without
 *    throwing (R3.1)
 *
 * Uses provider 'none' embeddings for determinism/offline. All temp dirs live
 * inside a SINGLE enclosing suite (suiteSetup/suiteTeardown) so teardown never
 * races sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  chunkCode,
  indexCodebase,
  retrieveCode,
  GitRunner,
} from '../intelligence/ragCode';
import { defaultConfig } from '../intelligence/config';
import { IntelligenceConfig } from '../intelligence/types';
import { nativeVectorAvailable } from './_vectorBackendAvailable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** A config wired for deterministic, offline 'none' embeddings. */
function noneConfig(): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding = { provider: 'none', model: 'none-test', dimension: 64 };
  cfg.rag.codeChunkSize = 50;
  cfg.rag.codeOverlap = 0;
  cfg.rag.fileExtensions = ['.ts'];
  cfg.rag.incremental = true;
  cfg.search.defaultLimit = 10;
  // keep all matches for deterministic retrieval assertions
  cfg.search.minSimilarity = -1;
  return cfg;
}

/** Build a stub git runner from a map of arg-prefix -> stdout. */
function stubGit(handler: (args: string) => string): GitRunner {
  return (args: string) => handler(args);
}

// ---------------------------------------------------------------------------
// Enclosing suite (owns the temp root)
// ---------------------------------------------------------------------------

suite('intelligence-ragcode', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ragcode-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  // chunkCode (R4.1)
  // -------------------------------------------------------------------------

  suite('intelligence-ragcode: chunkCode', function () {
    const FIVE = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'); // each 5 chars

    test('splits into line-aware chunks with deterministic ranges (no overlap)', function () {
      const chunks = chunkCode(FIVE, 11, 0);
      assert.deepStrictEqual(
        chunks.map((c) => [c.startLine, c.endLine]),
        [
          [1, 2],
          [3, 4],
          [5, 5],
        ],
      );
      assert.strictEqual(chunks[0].content, 'line1\nline2');
      assert.strictEqual(chunks[2].content, 'line5');
    });

    test('overlap re-includes trailing lines between adjacent chunks', function () {
      const chunks = chunkCode(FIVE, 11, 6);
      assert.deepStrictEqual(
        chunks.map((c) => [c.startLine, c.endLine]),
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
        ],
      );
    });

    test('a file smaller than one chunk yields a single chunk spanning all lines', function () {
      const chunks = chunkCode('only one small line', 1000, 200);
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0].startLine, 1);
      assert.strictEqual(chunks[0].endLine, 1);
      assert.strictEqual(chunks[0].content, 'only one small line');
    });

    test('empty content yields no chunks', function () {
      assert.deepStrictEqual(chunkCode('', 100, 10), []);
    });

    test('overlap >= size still terminates and covers every line', function () {
      const chunks = chunkCode(FIVE, 11, 1000);
      assert.ok(chunks.length > 0, 'must produce chunks without looping forever');
      // every line number 1..5 should appear within some chunk range
      for (let ln = 1; ln <= 5; ln++) {
        assert.ok(
          chunks.some((c) => ln >= c.startLine && ln <= c.endLine),
          `line ${ln} should be covered by some chunk`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // indexCodebase + retrieveCode (R4.2-R4.4, R7.1)
  // -------------------------------------------------------------------------

  suite('intelligence-ragcode: index + retrieve', function () {
    suiteSetup(function () {
      // Indexing + retrieval need a WORKING native vector backend; skip cleanly
      // where it cannot load (e.g. the Electron integration runner). The
      // "degraded backend" suite below stays running regardless.
      if (!nativeVectorAvailable()) {
        this.skip();
      }
    });

    test('full index honors fileExtensions/ignoredDirs and retrieveCode returns file-scoped hits', async function () {
      const ws = freshDir('ws-basic');
      writeFile(ws, 'alpha.ts', 'export function alphaSearchToken() { return 42; }');
      writeFile(ws, 'beta.ts', 'export const betaSearchToken = "hello world";');
      // ignored by extension
      writeFile(ws, 'notes.txt', 'plain text alphaSearchToken should not be indexed');
      // ignored by directory
      writeFile(ws, 'node_modules/pkg/index.ts', 'export const ignoredToken = 1;');

      const cfg = noneConfig();
      const git = stubGit(() => ''); // no commit / no diff

      const res = await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: git });
      assert.strictEqual(res.degraded, false);
      assert.strictEqual(res.incremental, false);
      assert.strictEqual(res.filesIndexed, 2, 'only the two .ts files outside node_modules');

      const hits = await retrieveCode('alphaSearchToken', { workspaceRoot: ws, config: cfg });
      assert.ok(hits.length >= 1, 'should retrieve the indexed chunk');
      assert.strictEqual(hits[0].file, 'alpha.ts');
      assert.ok(hits[0].content.includes('alphaSearchToken'));
      assert.ok(typeof hits[0].score === 'number');
    });

    test('redacts secret material before storing (R7.1)', async function () {
      const ws = freshDir('ws-redact');
      writeFile(
        ws,
        'config.ts',
        'export const redactProbeToken = "AKIAIOSFODNN7EXAMPLE";\nexport function redactProbeFn() {}',
      );
      const cfg = noneConfig();
      cfg.rag.codeChunkSize = 1000; // single chunk

      await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: stubGit(() => '') });

      const hits = await retrieveCode('redactProbeToken redactProbeFn', {
        workspaceRoot: ws,
        config: cfg,
      });
      assert.ok(hits.length >= 1, 'chunk should be retrievable');
      assert.ok(
        !hits[0].content.includes('AKIAIOSFODNN7EXAMPLE'),
        'the raw secret must not be stored',
      );
      assert.ok(hits[0].content.includes('redacted'), 'stored content should carry a redaction marker');
    });

    test('incremental selection re-indexes only changed files; --force re-indexes fully', async function () {
      const ws = freshDir('ws-incremental');
      writeFile(ws, 'a.ts', 'export const aToken = 1;');
      writeFile(ws, 'b.ts', 'export const bToken = 2;');
      const cfg = noneConfig();

      // Pass 1: no prior state -> full index, records HEAD = C1.
      const git1 = stubGit((args) => {
        if (args.startsWith('rev-parse')) return 'C1';
        return '';
      });
      const first = await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: git1 });
      assert.strictEqual(first.incremental, false);
      assert.strictEqual(first.filesIndexed, 2);
      assert.strictEqual(first.commit, 'C1');

      // last-index.json should now record the project's commit.
      const lastIndexPath = path.join(ws, '.autoclaw', 'vector', 'last-index.json');
      assert.ok(fs.existsSync(lastIndexPath), 'last-index.json should be written');
      const recorded = JSON.parse(fs.readFileSync(lastIndexPath, 'utf8'));
      const entries = Object.values(recorded) as Array<{ commit: string }>;
      assert.ok(
        entries.some((e) => e.commit === 'C1'),
        'recorded commit should be C1 keyed by project namespace',
      );

      // Pass 2: incremental, git diff reports only a.ts changed since C1.
      const git2 = stubGit((args) => {
        if (args.startsWith('rev-parse')) return 'C2';
        if (args.startsWith('diff')) {
          assert.ok(args.includes('C1'), 'diff must run against the recorded commit');
          return 'a.ts\n';
        }
        return '';
      });
      const inc = await indexCodebase({ workspaceRoot: ws, config: cfg, gitRunner: git2 });
      assert.strictEqual(inc.incremental, true, 'should use incremental selection');
      assert.strictEqual(inc.filesIndexed, 1, 'only the changed file is re-indexed');
      assert.strictEqual(inc.commit, 'C2');

      // Pass 3: --force ignores prior state and re-indexes everything.
      const git3 = stubGit((args) => {
        if (args.startsWith('rev-parse')) return 'C3';
        if (args.startsWith('diff')) return 'a.ts\n'; // would limit, but force overrides
        return '';
      });
      const forced = await indexCodebase({
        workspaceRoot: ws,
        config: cfg,
        gitRunner: git3,
        force: true,
      });
      assert.strictEqual(forced.incremental, false, 'force must do a full walk');
      assert.strictEqual(forced.filesIndexed, 2);
      assert.strictEqual(forced.commit, 'C3');

      const after = JSON.parse(fs.readFileSync(lastIndexPath, 'utf8'));
      const afterEntries = Object.values(after) as Array<{ commit: string }>;
      assert.ok(
        afterEntries.some((e) => e.commit === 'C3'),
        'force should update the recorded commit to C3',
      );
    });

    test('namespace isolation: project A content is not retrieved for project B (D11)', async function () {
      const wsA = freshDir('ws-A');
      const wsB = freshDir('ws-B');
      writeFile(wsA, 'secret.ts', 'export const projectAlphaOnlyToken = "alpha";');
      writeFile(wsB, 'other.ts', 'export const projectBetaOnlyToken = "beta";');
      const cfg = noneConfig();
      const git = stubGit(() => '');

      await indexCodebase({ workspaceRoot: wsA, config: cfg, gitRunner: git });
      await indexCodebase({ workspaceRoot: wsB, config: cfg, gitRunner: git });

      const fromA = await retrieveCode('projectAlphaOnlyToken', { workspaceRoot: wsA, config: cfg });
      assert.ok(
        fromA.some((h) => h.file === 'secret.ts'),
        'project A search should find its own content',
      );

      const fromB = await retrieveCode('projectAlphaOnlyToken', { workspaceRoot: wsB, config: cfg });
      assert.ok(
        !fromB.some((h) => h.content.includes('projectAlphaOnlyToken')),
        "project B must not retrieve project A's content",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Degraded backend (R3.1)
  // -------------------------------------------------------------------------

  suite('intelligence-ragcode: degraded backend', function () {
    test('indexCodebase reports 0 indexed and retrieveCode returns [] without throwing', async function () {
      const ws = freshDir('ws-degraded');
      writeFile(ws, 'a.ts', 'export const x = 1;');
      // Force the vector backend to fail to open: make `.autoclaw/vector` a FILE
      // so the db path `.autoclaw/vector/db.sqlite` cannot be created/opened.
      fs.mkdirSync(path.join(ws, '.autoclaw'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.autoclaw', 'vector'), 'not a directory', 'utf8');

      const cfg = noneConfig();
      const warnings: string[] = [];
      const git = stubGit(() => '');

      const res = await indexCodebase({
        workspaceRoot: ws,
        config: cfg,
        gitRunner: git,
        log: (m) => warnings.push(m),
      });
      assert.strictEqual(res.degraded, true);
      assert.strictEqual(res.filesIndexed, 0);
      assert.strictEqual(res.chunksIndexed, 0);

      const hits = await retrieveCode('anything', {
        workspaceRoot: ws,
        config: cfg,
        log: (m) => warnings.push(m),
      });
      assert.deepStrictEqual(hits, [], 'degraded retrieval must return an empty array');
    });
  });
});
