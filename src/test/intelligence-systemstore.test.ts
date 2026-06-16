/**
 * intelligence-systemstore.test.ts — the cross-project SYSTEM tier: the
 * project↔store registry and the tier classifier.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { systemPaths } from '../intelligence/storage';
import {
  ensureSystemStore,
  readRegistry,
  upsertProject,
  classifyTier,
  parseInsightItems,
  promoteInsight,
  readSystemLearnings,
  searchSystemLearnings,
} from '../intelligence/systemStore';

let tmpRoot: string;
function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

suite('intelligence — system tier (cross-project)', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-systier-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('ensureSystemStore creates the store dirs', () => {
    const sys = systemPaths(freshDir('sys'))!;
    ensureSystemStore(sys);
    assert.ok(fs.existsSync(sys.root));
    assert.ok(fs.existsSync(sys.vectorDir));
    assert.ok(fs.existsSync(sys.learningsDir));
  });

  test('readRegistry returns empty for an absent or malformed file', () => {
    const missing = path.join(freshDir('r'), 'projects.json');
    assert.deepStrictEqual(readRegistry(missing), { version: 1, projects: [] });
    const bad = path.join(freshDir('r2'), 'projects.json');
    fs.writeFileSync(bad, '{ not json');
    assert.deepStrictEqual(readRegistry(bad), { version: 1, projects: [] });
  });

  test('upsertProject inserts, then merges by path (case-insensitive) and unions topics', () => {
    const reg = path.join(freshDir('reg'), 'projects.json');

    upsertProject(reg, { path: 'K:/proj/alpha', indexChunks: 100, topics: ['rag'] });
    let r = readRegistry(reg);
    assert.strictEqual(r.projects.length, 1);
    assert.strictEqual(r.projects[0].name, 'alpha');
    assert.strictEqual(r.projects[0].indexChunks, 100);

    // same project (different case + trailing slash) → merge, not duplicate
    upsertProject(reg, { path: 'k:/proj/alpha/', learnSessions: 42, topics: ['tools'] });
    r = readRegistry(reg);
    assert.strictEqual(r.projects.length, 1, 'must not duplicate the same project');
    assert.strictEqual(r.projects[0].indexChunks, 100, 'prior fields preserved');
    assert.strictEqual(r.projects[0].learnSessions, 42, 'new fields merged');
    assert.deepStrictEqual(r.projects[0].topics!.sort(), ['rag', 'tools']);

    // a different project adds a row
    upsertProject(reg, { path: 'K:/proj/beta', indexChunks: 5 });
    r = readRegistry(reg);
    assert.strictEqual(r.projects.length, 2);
  });

  suite('classifyTier', () => {
    test('generic tool / CLI knowledge → system', () => {
      assert.strictEqual(classifyTier('run `npm ci` to install deps reproducibly'), 'system');
      assert.strictEqual(classifyTier('use git rebase --onto to move a branch'), 'system');
      assert.strictEqual(classifyTier('docker compose up -d starts the stack'), 'system');
    });
    test('environment / OS facts → system', () => {
      assert.strictEqual(classifyTier('node:sqlite is ABI-stable on recent Electron'), 'system');
      assert.strictEqual(classifyTier('on Windows the PATH separator is a semicolon'), 'system');
    });
    test('cross-project conventions / preferences → system', () => {
      assert.strictEqual(classifyTier('I always prefer forward slashes in paths'), 'system');
      assert.strictEqual(classifyTier('this convention applies across projects'), 'system');
    });
    test('project-specific domain text → project', () => {
      assert.strictEqual(
        classifyTier('the CheckoutController validates the cart total before payment'),
        'project',
      );
      assert.strictEqual(classifyTier('the Foo widget renders the Bar panel'), 'project');
      assert.strictEqual(classifyTier(''), 'project');
    });
  });

  const INSIGHT = [
    '# Insight — 2026-06-16T05:53:09.313Z',
    '',
    '- Sessions analyzed: 6',
    '- Sources: autoclaw-native',
    '',
    '## Successful Patterns (procedural)',
    '',
    '- Make focused, single-responsibility changes and verify them with tests.',
    '- Match existing project conventions for naming and structure.',
    '',
    '## Patterns to Avoid (failure)',
    '',
    '- Avoid large speculative rewrites that are not backed by tests.',
    '',
    '## Preferred Tools',
    '',
    '- general-purpose coding agent',
    '',
    '## Reflection',
    '',
    'Analyzed 6 session(s). This prose paragraph must NOT be captured as a bullet.',
  ].join('\n');

  suite('promote insights → system learnings (v2)', () => {
    test('parseInsightItems captures only the distilled pattern bullets', () => {
      const items = parseInsightItems(INSIGHT);
      // 2 patterns + 1 avoid + 1 tool = 4; the top metadata bullets + Reflection prose excluded
      assert.strictEqual(items.length, 4);
      assert.deepStrictEqual(
        items.map((i) => i.kind).sort(),
        ['avoid', 'pattern', 'pattern', 'tool'],
      );
      assert.ok(items.every((i) => !/Sessions analyzed/.test(i.text)), 'metadata excluded');
    });

    test('promoteInsight writes deduped learnings; re-promoting the same insight adds nothing', () => {
      const sys = systemPaths(freshDir('sysl'))!;
      const first = promoteInsight(sys, { project: 'K:/proj/alpha', insightMarkdown: INSIGHT, capturedAt: '2026-06-16T00:00:00Z' });
      assert.strictEqual(first.scanned, 4);
      assert.strictEqual(first.promoted, 4);
      assert.strictEqual(readSystemLearnings(sys).length, 4);

      const again = promoteInsight(sys, { project: 'K:/proj/alpha', insightMarkdown: INSIGHT });
      assert.strictEqual(again.promoted, 0, 'identical bullets are deduped by content hash');
      assert.strictEqual(readSystemLearnings(sys).length, 4);

      // a different project contributing one shared + one new bullet adds only the new one
      const other = promoteInsight(sys, {
        project: 'K:/proj/beta',
        insightMarkdown: '## Preferred Tools\n- general-purpose coding agent\n## Successful Patterns\n- Pin dependency versions for reproducible builds.',
      });
      assert.strictEqual(other.promoted, 1);
    });

    test('searchSystemLearnings ranks by token overlap and tags provenance', () => {
      const sys = systemPaths(freshDir('syss'))!;
      promoteInsight(sys, { project: 'K:/proj/alpha', insightMarkdown: INSIGHT });
      const hits = searchSystemLearnings(sys, 'tests rewrites', 10);
      assert.ok(hits.length >= 1);
      // the "speculative rewrites ... backed by tests" bullet matches both tokens → top
      assert.ok(/rewrites/.test(hits[0].text));
      assert.strictEqual(hits[0].project, 'K:/proj/alpha');
      assert.ok(hits[0].score >= 1);
      assert.deepStrictEqual(searchSystemLearnings(sys, '', 10), []);
    });
  });
});
