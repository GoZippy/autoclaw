/**
 * intelligence-hostcontext.test.ts — unit tests for Channel C (per-host ambient
 * project-context digest).
 *
 * Verifies:
 *  - resolveHostContextTargets returns only hosts whose rules dir EXISTS, with
 *    the right per-host filename/extension (cross-platform via path.join).
 *  - formatForHost wraps the body in each host's auto-load format (Cursor `.mdc`
 *    frontmatter, Kiro `inclusion: auto`, Windsurf `trigger`, Continue `<s>`
 *    wrapper, plain markdown for Cline/Antigravity).
 *  - writeHostContextFiles writes the digest into every detected host dir, skips
 *    undetected hosts, and never throws when one target is unwritable.
 *
 * The pack is injected (no vector backend / embeddings / KG), so the test runs
 * fully offline. Temp dirs use os.tmpdir so the test is OS-agnostic.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  formatForHost,
  resolveHostContextTargets,
  writeHostContextFiles,
} from '../intelligence/hostContext';
import { ContextPackResult } from '../intelligence/contextPack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-hostctx-'));
}

function fakePack(degraded = false): ContextPackResult {
  return {
    markdown: '# AutoClaw Context Pack\n\n## Grounded Context (RAG-retrieved)\n\nbody\n',
    ragPrompt: '',
    kgFacts: [],
    usedCode: !degraded,
    codeHits: degraded ? 0 : 2,
    learningHits: 1,
    kgHits: 0,
    degraded,
    notes: [],
    generatedAt: '2026-06-22T00:00:00.000Z',
    summary: {
      task: 'x', used_code: !degraded, code_hits: degraded ? 0 : 2, learning_hits: 1,
      kg_hits: 0, degraded, notes: [], generated_at: '2026-06-22T00:00:00.000Z',
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-hostcontext', function () {
  test('resolveHostContextTargets returns only existing host dirs', () => {
    const root = mkTmp();
    try {
      // Only set up Cursor + Kiro.
      fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
      const targets = resolveHostContextTargets(root);
      const ids = targets.map((t) => t.id).sort();
      assert.deepStrictEqual(ids, ['cursor', 'kiro']);
      const cursor = targets.find((t) => t.id === 'cursor')!;
      assert.ok(cursor.file.endsWith('autoclaw-project-context.mdc'), 'cursor uses .mdc');
      const kiro = targets.find((t) => t.id === 'kiro')!;
      assert.ok(kiro.file.endsWith('autoclaw-project-context.md'), 'kiro uses .md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('formatForHost wraps the body in each host format', () => {
    const body = '# AutoClaw Context Pack\n\nhello\n';
    const cursor = formatForHost('cursor', body);
    assert.ok(cursor.startsWith('---\ndescription: '), 'cursor frontmatter');
    assert.ok(cursor.includes('alwaysApply: false'));

    const kiro = formatForHost('kiro', body);
    assert.ok(kiro.includes('inclusion: auto'), 'kiro inclusion');

    const windsurf = formatForHost('windsurf', body);
    assert.ok(windsurf.includes('trigger: model_decision'), 'windsurf trigger');

    const cont = formatForHost('continue', body);
    assert.ok(cont.includes('<s>') && cont.includes('</s>'), 'continue wrapper');
    assert.ok(cont.trimEnd().endsWith('{{{ input }}}'), 'continue input template');

    const plain = formatForHost('plain', body);
    assert.ok(plain.startsWith('> '), 'plain tagline');
    assert.ok(plain.endsWith('\n'), 'trailing newline');
  });

  test('writeHostContextFiles writes into every detected host dir', async () => {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, '.clinerules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.windsurf', 'rules'), { recursive: true });
      const res = await writeHostContextFiles(root, { pack: fakePack() });
      assert.strictEqual(res.targetsDetected, 2);
      assert.strictEqual(res.written.length, 2);
      assert.strictEqual(res.failed.length, 0);
      assert.ok(res.written.every((w) => fs.existsSync(w.path)), 'all files exist');
      const windsurf = fs.readFileSync(path.join(root, '.windsurf', 'rules', 'autoclaw-project-context.md'), 'utf8');
      assert.ok(windsurf.includes('trigger: model_decision'));
      assert.ok(windsurf.includes('AutoClaw Context Pack'), 'digest body embedded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns early with zero targets when no host dirs exist', async () => {
    const root = mkTmp();
    try {
      const res = await writeHostContextFiles(root, { pack: fakePack() });
      assert.strictEqual(res.targetsDetected, 0);
      assert.strictEqual(res.written.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a single unwritable target does not throw or block others', async () => {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
      // Inject a target whose file path is invalid (a dir where a file should be).
      const badDir = path.join(root, '.cursor', 'rules', 'autoclaw-project-context.mdc');
      fs.mkdirSync(badDir, { recursive: true }); // now writing a file at this path fails
      const targets = resolveHostContextTargets(root);
      const res = await writeHostContextFiles(root, { pack: fakePack(), targets });
      assert.ok(res.written.some((w) => w.id === 'kiro'), 'kiro still written');
      assert.ok(res.failed.some((f) => f.id === 'cursor'), 'cursor recorded as failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('onlyExisting refreshes existing digests and never creates new ones', async () => {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.kiro', 'steering'), { recursive: true });
      // Pre-seed ONLY the cursor digest (simulates a prior opt-in run).
      const cursorFile = path.join(root, '.cursor', 'rules', 'autoclaw-project-context.mdc');
      fs.writeFileSync(cursorFile, 'stale\n', 'utf8');

      const res = await writeHostContextFiles(root, { pack: fakePack(), onlyExisting: true });
      assert.deepStrictEqual(res.written.map((w) => w.id), ['cursor'], 'only the pre-existing digest is refreshed');
      assert.ok(fs.readFileSync(cursorFile, 'utf8').includes('AutoClaw Context Pack'), 'cursor digest refreshed');
      // Kiro had a dir but no digest file ⇒ not created.
      assert.ok(!fs.existsSync(path.join(root, '.kiro', 'steering', 'autoclaw-project-context.md')), 'no new digest created');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('onlyExisting with no existing digests writes nothing', async () => {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, '.windsurf', 'rules'), { recursive: true });
      const res = await writeHostContextFiles(root, { pack: fakePack(), onlyExisting: true });
      assert.strictEqual(res.written.length, 0);
      assert.strictEqual(res.targetsDetected, 0, 'no opted-in hosts ⇒ zero targets');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('degraded pack flag propagates', async () => {
    const root = mkTmp();
    try {
      fs.mkdirSync(path.join(root, '.agent', 'rules'), { recursive: true });
      const res = await writeHostContextFiles(root, { pack: fakePack(true) });
      assert.strictEqual(res.degraded, true);
      assert.strictEqual(res.written.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
