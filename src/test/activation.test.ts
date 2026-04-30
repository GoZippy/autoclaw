/**
 * Activation smoke test.
 *
 * Confirms that the extension's `activate` function is exported and the
 * public surface (helpers re-exported for external consumers) has the
 * expected shape. We deliberately avoid driving `activate(context)`
 * directly here: the `@vscode/test-cli` runner already loads the
 * extension into a real Extension Host before tests start, so reaching
 * this file at all means activation succeeded.
 */

import * as assert from 'assert';

import * as ext from '../extension';

suite('Activation smoke test', function () {
  test('exports activate() and deactivate()', function () {
    assert.strictEqual(typeof ext.activate, 'function');
    assert.strictEqual(typeof ext.deactivate, 'function');
  });

  test('re-exports kdream-helpers public surface', function () {
    const expectedFns: Array<keyof typeof ext> = [
      'parseMemoryTasks',
      'addTaskToContent',
      'createInitialMemoryContent',
      'isAutoclawInGitignore',
      'addAutoclawToGitignore',
      'parseLogEntries',
      'parseTodosFromContent',
      'getAdapterHealthEntry',
      'generateNonce',
      'shouldShowNotificationHelper',
      'getTodayDate',
      'getMemoryPath',
      'getStatePath',
      'getTodayLogPath',
      'checkZippyMeshHealth'
    ];
    for (const name of expectedFns) {
      assert.strictEqual(typeof (ext as any)[name], 'function',
        `expected ext.${String(name)} to be a function`);
    }
    assert.ok(Array.isArray((ext as any).DEFAULT_ADAPTERS));
  });

  test('exports analytics functions', function () {
    assert.strictEqual(typeof ext.getCodeChurnMetrics, 'function');
    assert.strictEqual(typeof ext.getProductivityInsights, 'function');
    assert.strictEqual(typeof ext.getProjectHealthIndicators, 'function');
    assert.strictEqual(typeof ext.refreshDashboardData, 'function');
  });

  test('getZippyMeshCandidatePaths does not include developer drive paths', function () {
    const paths = (ext as any).getZippyMeshCandidatePaths(
      '/tmp/workspace',
      '/home/user',
      []
    );
    assert.ok(Array.isArray(paths));
    for (const p of paths) {
      assert.ok(!/^[KS]:\//i.test(p),
        `default candidate list must not include K:/ or S:/ paths, got: ${p}`);
    }
    // Should still include workspace-relative and home-relative candidates.
    assert.ok(paths.some((p: string) => p.includes('workspace')),
      'expected at least one workspace-relative candidate');
    assert.ok(paths.some((p: string) => p.includes('user')),
      'expected at least one home-relative candidate');
  });

  suite('computeKiloModesContent()', function () {
    const NEW_MODES = 'modes:\n  - slug: kdream\n  - slug: autobuild\n  - slug: mateam\n';

    test('returns new content verbatim when no existing file', function () {
      const merged = (ext as any).computeKiloModesContent(null, NEW_MODES);
      assert.strictEqual(merged, NEW_MODES);
    });

    test('appends marker block when existing file has no AutoClaw slugs', function () {
      const existing = 'modes:\n  - slug: user-mode\n';
      const merged = (ext as any).computeKiloModesContent(existing, NEW_MODES);
      assert.ok(merged.startsWith(existing), 'should preserve user content');
      assert.ok(merged.includes('# AutoClaw modes'), 'should include marker');
      assert.ok(merged.includes('slug: kdream'));
    });

    test('replaces from marker to EOF when marker is present (upgrade path)', function () {
      const stale = 'modes:\n  - slug: user-mode\n\n# AutoClaw modes\nmodes:\n  - slug: kdream-OLD\n';
      const merged = (ext as any).computeKiloModesContent(stale, NEW_MODES);
      assert.ok(!merged.includes('kdream-OLD'),
        'stale AutoClaw block must be replaced');
      assert.ok(merged.includes('user-mode'),
        'user content above marker must be preserved');
      assert.ok(merged.includes('# AutoClaw modes'));
      // Only one AutoClaw modes marker in the merged output
      const occurrences = merged.split('# AutoClaw modes').length - 1;
      assert.strictEqual(occurrences, 1, 'should have exactly one marker block');
    });

    test('warns and appends when slugs are present without a marker', function () {
      const existing = 'modes:\n  - slug: kdream\n  - slug: user-mode\n';
      const merged = (ext as any).computeKiloModesContent(existing, NEW_MODES);
      assert.ok(merged.includes('WARNING'),
        'should include a warning comment');
      assert.ok(merged.includes('user-mode'),
        'must not destroy existing user data');
      assert.ok(merged.includes('# AutoClaw modes'));
    });
  });

  suite('getCachedZippyMeshHealth()', function () {
    test('caches a probe result for ~60 s and skips re-probing', async function () {
      (ext as any)._resetZmlrHealthCache();
      let probeCalls = 0;
      const fakeProbe = async (_url: string) => {
        probeCalls++;
        return {
          name: 'ZippyMesh LLM Router',
          status: 'healthy' as const,
          details: 'Running'
        };
      };

      const t0 = 1_000_000;
      const r1 = await (ext as any).getCachedZippyMeshHealth('http://localhost:20128', t0, fakeProbe);
      assert.strictEqual(probeCalls, 1, 'first call should probe');
      assert.strictEqual(r1.status, 'healthy');

      // Second call within 30 s — should hit cache.
      const r2 = await (ext as any).getCachedZippyMeshHealth('http://localhost:20128', t0 + 30_000, fakeProbe);
      assert.strictEqual(probeCalls, 1, 'second call within TTL should NOT probe');
      assert.strictEqual(r2.status, 'healthy');

      // Far in the future — cache expired, must probe again.
      const r3 = await (ext as any).getCachedZippyMeshHealth('http://localhost:20128', t0 + 120_000, fakeProbe);
      assert.strictEqual(probeCalls, 2, 'expired cache should re-probe');
      assert.strictEqual(r3.status, 'healthy');
    });

    test('different URLs do not share a cache entry', async function () {
      (ext as any)._resetZmlrHealthCache();
      let probeCalls = 0;
      const fakeProbe = async (url: string) => {
        probeCalls++;
        return {
          name: 'ZippyMesh LLM Router',
          status: 'healthy' as const,
          details: url
        };
      };

      const t0 = 2_000_000;
      await (ext as any).getCachedZippyMeshHealth('http://localhost:20128', t0, fakeProbe);
      await (ext as any).getCachedZippyMeshHealth('http://localhost:20129', t0 + 1000, fakeProbe);
      assert.strictEqual(probeCalls, 2, 'distinct URLs must each be probed');
    });
  });

  test('getZippyMeshCandidatePaths appends user-supplied paths in order', function () {
    const paths = (ext as any).getZippyMeshCandidatePaths(
      undefined,
      '/home/user',
      ['/opt/zmlr', '/srv/zmlr']
    );
    const optIdx = paths.indexOf('/opt/zmlr');
    const srvIdx = paths.indexOf('/srv/zmlr');
    assert.ok(optIdx > -1 && srvIdx > -1, 'user paths should be present');
    assert.ok(optIdx < srvIdx, 'user paths should preserve order');
  });
});
