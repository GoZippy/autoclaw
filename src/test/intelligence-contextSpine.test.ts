/**
 * intelligence-contextSpine.test.ts - Context Spine contracts and local store.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CONTEXT_SPINE_SCHEMA,
  ContextBlockRecord,
  appendContextBlock,
  coarseToFineContextIndex,
  contextBlockId,
  contextBlocksPath,
  queryContextBlocks,
  queryContextIndex,
  readContextBlocks,
  sanitizeContextBlockRecord,
  updateContextBlock,
} from '../intelligence';

let tmpRoot: string;

function freshWorkspace(): string {
  return fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
}

function block(overrides: Partial<ContextBlockRecord> = {}): ContextBlockRecord {
  const merged = {
    schema: CONTEXT_SPINE_SCHEMA,
    id: '',
    level: 'file',
    project: 'AutoClaw',
    key: 'src/demo.ts',
    path: 'src/demo.ts',
    updatedAt: '2026-07-01T00:00:00.000Z',
    summary: 'Demo file context',
    tags: ['routing', 'context'],
    snippet: 'export const demo = true;',
    metadata: { owner: 'codex' },
    ...overrides,
  } as ContextBlockRecord;
  merged.id = overrides.id || contextBlockId({ project: merged.project, level: merged.level, key: merged.key });
  return merged;
}

suite('intelligence-contextSpine', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-context-spine-'));
  });

  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('builds stable block ids from normalized parts', () => {
    const a = contextBlockId({ project: 'AutoClaw', level: 'file', key: 'SRC\\Demo.ts' });
    const b = contextBlockId({ project: 'autoclaw', level: 'file', key: 'src/demo.ts' });
    assert.strictEqual(a, b);
    assert.strictEqual(a, 'ctx:autoclaw:file:src/demo.ts');
  });

  test('sanitizes prompt-like metadata while preserving retrieval metadata', () => {
    const clean = sanitizeContextBlockRecord(
      block({
        metadata: {
          owner: 'codex',
          rawPrompt: 'do not store this',
          messages: [{ role: 'user', text: 'also not stored' }],
          nested: { response: 'remove nested response', kept: true },
          hidden_cot: 'nope',
        },
      }),
    );
    assert.deepStrictEqual(clean.metadata, { owner: 'codex', nested: { kept: true } });
    assert.strictEqual(clean.schema, CONTEXT_SPINE_SCHEMA);
  });

  test('append/read/update roundtrips and latest record wins by id', async () => {
    const ws = freshWorkspace();
    const original = await appendContextBlock(ws, block({ summary: 'old summary' }));
    await appendContextBlock(ws, block({ id: contextBlockId({ project: 'AutoClaw', level: 'spec', key: 'plan' }), level: 'spec', key: 'plan' }));
    await updateContextBlock(ws, { ...original, summary: 'new summary', updatedAt: '2026-07-01T00:01:00.000Z' });

    const read = await readContextBlocks(ws);
    assert.strictEqual(read.missing, false);
    assert.strictEqual(read.warnings.length, 0);
    assert.strictEqual(read.blocks.length, 2);
    const updated = read.blocks.find((b) => b.id === original.id);
    assert.strictEqual(updated?.summary, 'new summary');
  });

  test('skips malformed JSONL lines with warnings instead of throwing', async () => {
    const ws = freshWorkspace();
    const file = contextBlocksPath(ws);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(block())}\n{not-json}\n`, 'utf8');

    const read = await readContextBlocks(ws);
    assert.strictEqual(read.blocks.length, 1);
    assert.strictEqual(read.warnings.length, 1);
    assert.ok(read.warnings[0].includes('line 2'));
  });

  test('query returns references first and never exposes snippets', () => {
    const refs = queryContextBlocks(
      [
        block({ level: 'file', key: 'src/router.ts', path: 'src/router.ts', summary: 'intent router' }),
        block({ level: 'symbol', key: 'routeIntent', symbol: 'routeIntent', summary: 'routes task intent' }),
      ],
      { text: 'route intent', limit: 2 },
    );
    assert.strictEqual(refs.length, 2);
    assert.strictEqual((refs[0] as { snippet?: string }).snippet, undefined);
  });

  test('coarse-to-fine index retrieval degrades safely without semantic backends', async () => {
    const ws = freshWorkspace();
    await appendContextBlock(ws, block({ level: 'project', key: 'autoclaw', summary: 'project root' }));
    await appendContextBlock(ws, block({ level: 'spec', key: 'adaptive-workflow-learning', summary: 'workflow plan' }));
    await appendContextBlock(ws, block({ level: 'file', key: 'src/intelligence/contextSpine.ts', path: 'src/intelligence/contextSpine.ts', summary: 'context contracts' }));
    await appendContextBlock(ws, block({ level: 'symbol', key: 'queryContextBlocks', symbol: 'queryContextBlocks', summary: 'metadata retrieval' }));
    await appendContextBlock(ws, block({ level: 'span', key: 'context-span', path: 'src/intelligence/contextSpine.ts', span: { startLine: 1, endLine: 12 }, summary: 'file header' }));

    const result = await coarseToFineContextIndex(ws, { text: 'context' }, { coarseLimit: 3, fineLimit: 3 });
    assert.strictEqual(result.degraded, true);
    assert.ok(result.notes.some((n) => n.includes('semantic backends unavailable')));
    assert.ok(result.coarse.some((r) => r.level === 'file'));
    assert.ok(result.fine.some((r) => r.level === 'symbol'));
  });

  test('missing store returns empty degraded query results', async () => {
    const ws = freshWorkspace();
    const result = await queryContextIndex(ws, { text: 'anything' });
    assert.deepStrictEqual(result.blocks, []);
    assert.strictEqual(result.degraded, true);
    assert.ok(result.warnings.some((w) => w.includes('empty')));
  });
});
