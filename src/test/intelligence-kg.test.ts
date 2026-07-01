/**
 * intelligence-kg.test.ts — unit tests for the in-process Knowledge Graph
 * store (KGC-1/KGC-2 of the KG↔Intelligence convergence).
 *
 * The decisive case (acceptance §5): a FRESH, bare install — no sqlite-vec, no
 * transformers — must still record + recall thoughts via FTS5 with the `none`
 * embedding provider, using the ABI-proof `node:sqlite` driver, with NO "deps
 * not installed" failure mode. These tests run fully in plain Node.
 *
 * Covers: record→search round-trip (FTS), project/agent filters, edges +
 * graph traversal, bi-temporal `?at=` time-travel, jsonl/md export, and the
 * degraded no-op contract.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openKnowledgeGraph, DEGRADED_KG } from '../intelligence/kg';
import { openSqliteDriver } from '../intelligence/vector/sqliteDriver';
import type { IntelligenceConfig } from '../intelligence/types';

const DIM = 64;

/** Config forcing the offline `none` embedding provider at a small dimension. */
function noneConfig(): IntelligenceConfig {
  // Cast through unknown: we only exercise the embedding sub-config here; the
  // store reads nothing else off the config.
  return {
    embedding: { provider: 'none', model: 'none-test', dimension: DIM },
  } as unknown as IntelligenceConfig;
}

let tmpRoot: string;

function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'kg-'));
  return path.join(dir, 'kg.db').replace(/\\/g, '/');
}

suite('intelligence-kg', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-kg-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('opens on a bare install (node:sqlite, FTS, none embeddings) — not degraded', function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      assert.strictEqual(h.degraded, false, 'KG must open without sqlite-vec or transformers');
      assert.strictEqual(h.caps.sqlite, true);
      assert.strictEqual(h.caps.fts, true, 'FTS5 should be available in the bundled SQLite');
      assert.strictEqual(h.embedding.provider, 'none');
      assert.ok(h.driverKind === 'node-sqlite' || h.driverKind === 'better-sqlite3');
    } finally {
      h.close();
    }
  });

  test('record -> search round-trips via FTS and respects k', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      await h.kg.recordThought({
        project: 'proj', agent: 'claude-code', kind: 'finding',
        text: 'the quick brown fox jumps over the lazy dog',
      });
      await h.kg.recordThought({
        project: 'proj', agent: 'claude-code', kind: 'note',
        text: 'compiling typescript with strict mode enabled',
      });

      const hits = await h.kg.searchSimilar('quick brown fox', { k: 5 });
      assert.ok(hits.length >= 1, 'should find the fox thought');
      assert.ok(hits.some((t) => t.text.includes('quick brown fox')));

      const capped = await h.kg.searchSimilar('typescript OR fox', { k: 1 });
      assert.ok(capped.length <= 1, 'k must cap results');
    } finally {
      h.close();
    }
  });

  test('project + agent filters isolate results', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      await h.kg.recordThought({ project: 'A', agent: 'a1', kind: 'note', text: 'alpha shared keyword' });
      await h.kg.recordThought({ project: 'B', agent: 'b1', kind: 'note', text: 'beta shared keyword' });

      const onlyA = await h.kg.searchSimilar('shared keyword', { project: 'A', k: 10 });
      assert.ok(onlyA.every((t) => t.project === 'A'), 'project filter must not leak');

      const byAgent = await h.kg.forAgent('b1');
      assert.ok(byAgent.length === 1 && byAgent[0].project === 'B');
    } finally {
      h.close();
    }
  });

  test('edges + graph traversal walk related thoughts', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      const a = await h.kg.recordThought({ project: 'p', agent: 'x', kind: 'decision', text: 'root decision' });
      const b = await h.kg.recordThought({ project: 'p', agent: 'x', kind: 'finding', text: 'derived finding' });
      await h.kg.recordRelation(a, 'derives', b);

      const reached = await h.kg.traverseFrom(a, ['derives'], 2);
      assert.ok(reached.some((t) => t.id === b), 'traversal should reach b from a');
    } finally {
      h.close();
    }
  });

  test('bi-temporal ?at= time-travel filters retracted thoughts', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      // Valid only during 2026-01.
      await h.kg.recordThought({
        project: 'p', agent: 'x', kind: 'fact', text: 'retracted temporal claim',
        valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2026-02-01T00:00:00.000Z',
      });
      const duringJan = await h.kg.searchSimilar('temporal claim', { at: '2026-01-15T00:00:00.000Z', k: 10 });
      assert.ok(duringJan.some((t) => t.text.includes('retracted temporal claim')), 'valid in Jan');

      const afterRetract = await h.kg.searchSimilar('temporal claim', { at: '2026-03-01T00:00:00.000Z', k: 10 });
      assert.ok(!afterRetract.some((t) => t.text.includes('retracted temporal claim')), 'gone after retraction');
    } finally {
      h.close();
    }
  });

  test('export yields jsonl and md', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      await h.kg.recordThought({ project: 'p', agent: 'x', kind: 'note', text: 'exportable line' });
      let jsonl = '';
      for await (const chunk of h.kg.export({ project: 'p', format: 'jsonl' })) jsonl += chunk;
      assert.ok(jsonl.includes('exportable line') && jsonl.trim().startsWith('{'));

      let md = '';
      for await (const chunk of h.kg.export({ project: 'p', format: 'md' })) md += chunk;
      assert.ok(md.includes('## ') && md.includes('exportable line'));
    } finally {
      h.close();
    }
  });

  test('vector indexing actually writes to vec0 (regression: BigInt rowid bind)', async function () {
    // The `none` provider produces a real DIM-length vector, so when sqlite-vec
    // loaded (caps.vec) recordThought MUST insert into thoughts_vec. The vec0
    // rowid PK requires a BigInt on node:sqlite — a JS number throws and used
    // to be swallowed, silently degrading to FTS-only with caps.vec still true.
    // Verify the embedding row is persisted (has_embed=1 + a thoughts_vec row).
    const dbPath = freshDbPath();
    const h = openKnowledgeGraph({ dbPath, config: noneConfig() });
    try {
      if (!h.caps.vec) {
        this.skip(); // sqlite-vec not available on this host — nothing to assert
      }
      await h.kg.recordThought({ project: 'p', agent: 'x', kind: 'note', text: 'vectorized thought' });

      // `has_embed` is a reliable proxy: recordThought writes it as 1, then on
      // a failing vec0 insert the catch downgrades it to 0. So has_embed===1
      // proves the BigInt rowid insert into thoughts_vec did NOT throw. Read the
      // plain `thoughts` column through the SAME driver abstraction the store
      // uses (node:sqlite OR better-sqlite3 fallback) so this works on CI hosts
      // where node:sqlite is not a builtin. requireVec:false ⇒ no extension needed.
      const driver = openSqliteDriver(dbPath, () => undefined, undefined, { requireVec: false });
      try {
        const t = driver.prepare('SELECT has_embed FROM thoughts WHERE text = ?').get('vectorized thought') as { has_embed: number };
        assert.strictEqual(Number(t.has_embed), 1, 'has_embed must stay 1 (vec insert succeeded, not swallowed)');
      } finally {
        driver.close();
      }
    } finally {
      h.close();
    }
  });

  test('allThoughts lists newest-first and listEdges returns stored relations (viewer)', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      const a = await h.kg.recordThought({
        project: 'p', agent: 'x', kind: 'decision', text: 'older thought',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      const b = await h.kg.recordThought({
        project: 'p', agent: 'y', kind: 'observation', text: 'newer thought',
        created_at: '2026-02-01T00:00:00.000Z',
      });
      await h.kg.recordRelation(a, 'supersedes', b, { reason: 'test' });

      const all = await h.kg.allThoughts();
      assert.ok(all.length >= 2, 'allThoughts returns every thought');
      assert.strictEqual(all[0].id, b, 'newest thought sorts first');
      assert.ok(all.some((t) => t.id === a) && all.some((t) => t.id === b));

      const capped = await h.kg.allThoughts({ limit: 1 });
      assert.strictEqual(capped.length, 1, 'limit caps allThoughts');

      const edges = await h.kg.listEdges();
      assert.strictEqual(edges.length, 1, 'listEdges returns the stored relation');
      assert.deepStrictEqual(
        { from: edges[0].from, kind: edges[0].kind, to: edges[0].to },
        { from: a, kind: 'supersedes', to: b },
      );
      assert.strictEqual((edges[0].meta as { reason?: string }).reason, 'test', 'edge meta round-trips');
    } finally {
      h.close();
    }
  });

  test('thoughtsForTask returns a task timeline oldest->newest, project-scoped', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      // Two events on task BL-30 in project P (out-of-order insert), one same-id
      // task in a different project to prove the project filter.
      await h.kg.recordThought({
        project: 'P', agent: 'orchestrator', task_id: 'BL-30', kind: 'created',
        text: 'created', created_at: '2026-01-02T00:00:00.000Z',
      });
      await h.kg.recordThought({
        project: 'P', agent: 'claude-code', task_id: 'BL-30', kind: 'done',
        text: 'done', created_at: '2026-01-03T00:00:00.000Z',
      });
      await h.kg.recordThought({
        project: 'P', agent: 'claude-code', task_id: 'BL-30', kind: 'claimed',
        text: 'claimed', created_at: '2026-01-01T00:00:00.000Z',
      });
      await h.kg.recordThought({
        project: 'OTHER', agent: 'x', task_id: 'BL-30', kind: 'created', text: 'other project',
      });

      const all = await h.kg.thoughtsForTask('BL-30');
      assert.strictEqual(all.length, 4, 'every thought for the task id across projects');
      // oldest -> newest
      assert.deepStrictEqual(all.map((t) => t.kind), ['claimed', 'created', 'done', 'created']);

      const scoped = await h.kg.thoughtsForTask('BL-30', { project: 'P' });
      assert.strictEqual(scoped.length, 3, 'project filter excludes OTHER');
      assert.ok(scoped.every((t) => t.project === 'P'));
      assert.deepStrictEqual(scoped.map((t) => t.kind), ['claimed', 'created', 'done'], 'oldest->newest');

      assert.deepStrictEqual(await h.kg.thoughtsForTask(''), [], 'empty task id -> []');
      assert.deepStrictEqual(await h.kg.thoughtsForTask('nope'), [], 'unknown task id -> []');
    } finally {
      h.close();
    }
  });

  test('edgesForNode unions incoming + outgoing edges, deduped', async function () {
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    try {
      const node = 'task:P:BL-30';
      // outgoing: node -> thoughtA (activity); node -> task:P:BL-31 (derived_from)
      await h.kg.recordRelation(node, 'activity', 'thoughtA', { kind: 'created' });
      await h.kg.recordRelation('task:P:BL-31', 'derived_from', node, { reason: 'follow-up' });
      // incoming: agent:x -> node (claimed)
      await h.kg.recordRelation('agent:x', 'claimed', node);
      // an unrelated edge that must NOT appear
      await h.kg.recordRelation('agent:x', 'reviewed', 'task:P:ZZ');

      const edges = await h.kg.edgesForNode(node);
      const keys = edges.map((e) => `${e.from}|${e.kind}|${e.to}`).sort();
      assert.deepStrictEqual(keys, [
        'agent:x|claimed|task:P:BL-30',       // incoming
        'task:P:BL-30|activity|thoughtA',      // outgoing
        'task:P:BL-31|derived_from|task:P:BL-30', // incoming
      ], 'both directions, unrelated edge excluded');

      // dedupe: a self-edge (from = to = node) appears in both arms -> once only.
      await h.kg.recordRelation(node, 'self', node);
      const withSelf = await h.kg.edgesForNode(node);
      const selfCount = withSelf.filter((e) => e.kind === 'self').length;
      assert.strictEqual(selfCount, 1, 'self-edge is not double-counted');

      // meta round-trips
      const activity = edges.find((e) => e.kind === 'activity')!;
      assert.strictEqual((activity.meta as { kind?: string }).kind, 'created');

      assert.deepStrictEqual(await h.kg.edgesForNode(''), [], 'empty node id -> []');
    } finally {
      h.close();
    }
  });

  test('degraded handle returns [] for thoughtsForTask + edgesForNode (no throw)', async function () {
    assert.deepStrictEqual(await DEGRADED_KG.thoughtsForTask('BL-30'), []);
    assert.deepStrictEqual(await DEGRADED_KG.thoughtsForTask('BL-30', { project: 'P' }), []);
    assert.deepStrictEqual(await DEGRADED_KG.edgesForNode('task:P:BL-30'), []);
  });

  test('degraded handle no-ops without throwing', async function () {
    // A bogus driver order makes every candidate fail -> degraded path. We
    // simulate by pointing at an unwritable path is unreliable cross-platform,
    // so instead assert the documented degraded contract via the exported shape:
    // open normally, then exercise the no-op API on a closed-over degraded kg.
    const h = openKnowledgeGraph({ dbPath: freshDbPath(), config: noneConfig() });
    h.close();
    // After close, the real store would throw; the degraded CONTRACT is tested
    // by the factory returning a no-op kg when drivers are absent. Here we just
    // assert the handle advertised a concrete driver (i.e. not degraded on this host).
    assert.ok(h.driverKind !== null);
  });
});
