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
});
