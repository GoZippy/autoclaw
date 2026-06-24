/**
 * intelligence-contract.test.ts — the agent-orientation contract (single source
 * of truth) and the orientation file writer.
 *
 * Verifies the exact confabulations a foreign agent made are now pre-empted:
 *  - the command surface names `/index-code` (never `/index`);
 *  - `/index-code` is documented as writing the vector store and NOT the KG;
 *  - the KG store is documented as coordination facts, NOT code structure;
 *  - the orientation doc + per-store READMEs carry those facts;
 *  - writeAgentOrientation drops the files, is deterministic, and is churn-free
 *    (a second run rewrites nothing).
 *
 * Pure + offline. Temp dirs use os.tmpdir so the test is OS-agnostic.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CONTRACT_VERSION,
  COMMANDS,
  renderCommandTable,
  renderMistakes,
  renderOrientationBlock,
  renderOrientationMarkdown,
  renderStoreReadme,
  renderStoreTable,
} from '../intelligence/contract';
import { writeAgentOrientation } from '../intelligence/orientation';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-contract-'));
}

suite('intelligence-contract', function () {
  test('command surface uses /index-code, never a bare /index', () => {
    const ids = COMMANDS.map((c) => c.command);
    assert.ok(ids.includes('/index-code'), 'expected /index-code in the command surface');
    assert.ok(!ids.includes('/index'), 'the bare /index command must not exist');
    const table = renderCommandTable();
    assert.ok(table.includes('/index-code'));
    // No occurrence of `/index` that is not part of `/index-code`.
    assert.ok(!/\/index(?![-a-z])/.test(table), 'rendered table must not reference a bare /index');
  });

  test('/index-code is documented as writing the vector store and NOT the KG', () => {
    const indexCode = COMMANDS.find((c) => c.command === '/index-code');
    assert.ok(indexCode, 'index-code command fact present');
    assert.match(indexCode!.writes, /vector store/i);
    assert.match(indexCode!.writes, /\.autoclaw\/vector\/db\.sqlite/);
    assert.ok(indexCode!.doesNotWrite, 'index-code must declare what it does NOT write');
    assert.match(indexCode!.doesNotWrite!, /kg\.db|knowledge graph/i);
  });

  test('store table distinguishes the KG (coordination) from the vector store (code)', () => {
    const table = renderStoreTable();
    assert.ok(table.includes('.autoclaw/kg/kg.db'));
    assert.ok(table.includes('.autoclaw/vector/db.sqlite'));
    // KG row must say it is coordination and explicitly NOT code structure.
    assert.match(table, /coordination/i);
    assert.match(table, /NOT a code-symbol|does NOT write here/i);
  });

  test('common mistakes pre-empt the index→kg conflation', () => {
    const mistakes = renderMistakes();
    assert.match(mistakes, /index-code/);
    assert.match(mistakes, /vector store/i);
    assert.match(mistakes, /session_id/);
  });

  test('orientation markdown carries identity, the read-first step, both tables, and mistakes', () => {
    const md = renderOrientationMarkdown({ projectName: 'demo-proj' });
    assert.ok(md.includes('demo-proj'));
    assert.match(md, /What AutoClaw is/);
    assert.match(md, /agent-style\.md/);
    assert.ok(md.includes(renderCommandTable()), 'embeds the command table');
    assert.ok(md.includes(renderStoreTable()), 'embeds the store table');
    assert.ok(md.includes(renderMistakes()), 'embeds the mistakes list');
    assert.ok(md.includes(`contract v${CONTRACT_VERSION}`), 'stamps the contract version');
  });

  test('orientation markdown is deterministic without a timestamp', () => {
    const a = renderOrientationMarkdown({ projectName: 'demo-proj' });
    const b = renderOrientationMarkdown({ projectName: 'demo-proj' });
    assert.strictEqual(a, b);
    // A supplied generatedAt is the only thing that changes the body.
    const stamped = renderOrientationMarkdown({ projectName: 'demo-proj', generatedAt: '2026-06-24T00:00:00Z' });
    assert.notStrictEqual(stamped, a);
  });

  test('renderStoreReadme resolves a store dir prefix and corrects the KG mental model', () => {
    const kg = renderStoreReadme('.autoclaw/kg/kg.db');
    assert.ok(kg, 'kg readme rendered');
    assert.match(kg!, /Knowledge Graph/);
    assert.match(kg!, /coordination/i);
    assert.match(kg!, /NOT a code-symbol|does NOT write here/i);
    // Unknown store path → null.
    assert.strictEqual(renderStoreReadme('.autoclaw/does-not-exist'), null);
  });

  test('orientation block (for cross-agent rules) carries the command→store contract', () => {
    const block = renderOrientationBlock();
    assert.match(block, /About AutoClaw/);
    assert.ok(block.includes(renderCommandTable()));
    assert.match(block, /AGENT-ORIENTATION\.md/);
  });

  test('writeAgentOrientation drops the file set and is churn-free on re-run', async () => {
    const root = mkTmp();
    try {
      const first = await writeAgentOrientation(root, { projectName: 'demo-proj' });
      assert.strictEqual(first.failed.length, 0, 'no write failures');
      // Four files: AGENT-ORIENTATION.md, README.md, kg/README.md, vector/README.md.
      assert.strictEqual(first.written.length, 4, 'writes the full set on first run');

      const orientation = fs.readFileSync(path.join(root, '.autoclaw', 'AGENT-ORIENTATION.md'), 'utf8');
      assert.ok(orientation.includes('demo-proj'));
      const kgReadme = fs.readFileSync(path.join(root, '.autoclaw', 'kg', 'README.md'), 'utf8');
      assert.match(kgReadme, /coordination/i);
      const vectorReadme = fs.readFileSync(path.join(root, '.autoclaw', 'vector', 'README.md'), 'utf8');
      assert.match(vectorReadme, /NOT a knowledge graph/i);
      const rootReadme = fs.readFileSync(path.join(root, '.autoclaw', 'README.md'), 'utf8');
      assert.match(rootReadme, /AGENT-ORIENTATION\.md/);

      // Second run: identical content already on disk → nothing rewritten.
      const second = await writeAgentOrientation(root, { projectName: 'demo-proj' });
      assert.strictEqual(second.written.length, 0, 'no churn on re-run');
      assert.strictEqual(second.unchanged.length, 4, 'all four recognized as current');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
