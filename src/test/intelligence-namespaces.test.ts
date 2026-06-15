/**
 * intelligence-namespaces.test.ts — unit tests for the project + global memory
 * namespace resolver (intelligence-backend-flexibility, task 5.4 / R4.1-R4.3).
 *
 * Verifies:
 *  - `projectNamespace` is deterministic, path-shape insensitive, and distinct
 *    per project (the property that keeps one project's code out of another's
 *    result set — R4.3)
 *  - `globalNamespace` is stable and never collides with a project namespace
 *  - `resolveSearchScope` prefers the project namespace and falls back to global
 *    (R4.2)
 *  - cross-project isolation: distinct keys ⇒ distinct primary scopes
 *
 * Pure functions — runs in plain Node with no native backend.
 */

import * as assert from 'assert';

import {
  projectNamespace,
  globalNamespace,
  isGlobalNamespace,
  resolveSearchScope,
} from '../intelligence/namespaces';

suite('intelligence-namespaces', function () {
  suite('projectNamespace', function () {
    test('produces a deterministic, project-prefixed namespace', function () {
      const ns = projectNamespace('/home/me/code/autoclaw');
      assert.strictEqual(ns, projectNamespace('/home/me/code/autoclaw'), 'must be deterministic');
      assert.ok(ns.startsWith('project:'), `expected project prefix, got "${ns}"`);
      assert.ok(ns.includes('/home/me/code/autoclaw'), 'must carry the normalized key');
    });

    test('is insensitive to slash direction and trailing slashes', function () {
      const a = projectNamespace('C:\\Projects\\autoclaw');
      const b = projectNamespace('C:/Projects/autoclaw');
      const c = projectNamespace('C:/Projects/autoclaw/');
      assert.strictEqual(a, b, 'backslash and forward-slash keys must match');
      assert.strictEqual(b, c, 'a trailing slash must not change the namespace');
    });

    test('distinct project keys produce distinct namespaces (R4.3 isolation)', function () {
      const a = projectNamespace('/repos/project-a');
      const b = projectNamespace('/repos/project-b');
      assert.notStrictEqual(a, b, 'different projects must never share a namespace');
    });

    test('a blank/unknown key degrades to the global rollup', function () {
      assert.strictEqual(projectNamespace(''), globalNamespace());
      assert.strictEqual(projectNamespace('   '), globalNamespace());
    });
  });

  suite('globalNamespace', function () {
    test('is stable and distinct from any project namespace', function () {
      const g = globalNamespace();
      assert.strictEqual(g, globalNamespace(), 'global namespace must be stable');
      assert.ok(isGlobalNamespace(g), 'isGlobalNamespace must recognize it');
      assert.notStrictEqual(
        g,
        projectNamespace('/repos/anything'),
        'a project namespace must never equal the global one',
      );
      assert.strictEqual(
        isGlobalNamespace(projectNamespace('/repos/anything')),
        false,
        'a project namespace must not be classified as global',
      );
    });
  });

  suite('resolveSearchScope', function () {
    test('prefers the project namespace, falls back to global (R4.2)', function () {
      const scope = resolveSearchScope('/repos/project-a');
      assert.strictEqual(scope.primary, projectNamespace('/repos/project-a'));
      assert.strictEqual(scope.fallback, globalNamespace());
      assert.notStrictEqual(scope.primary, scope.fallback, 'primary and fallback differ');
    });

    test('isolates scopes across projects while sharing the global fallback', function () {
      const a = resolveSearchScope('/repos/project-a');
      const b = resolveSearchScope('/repos/project-b');
      assert.notStrictEqual(a.primary, b.primary, 'project scopes must be isolated');
      assert.strictEqual(a.fallback, b.fallback, 'the global rollup is shared');
    });
  });
});
