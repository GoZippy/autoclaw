/**
 * intelligence-discovery.test.ts — unit tests for runner-registry-backed source
 * discovery (intelligence-universal-ingestion, task 1.3).
 *
 * Verifies `discoverInstalledTools` against a STUBBED runner registry (no real
 * runners, no subprocesses):
 *   - an installed runner with on-disk data → installed + dataLocations mapped
 *     to its Source Adapter id (R1.1, R1.2)
 *   - a not-found runner → unavailable carrying the detection hint (R1.4)
 *   - a runner-uncovered location is probed per-OS via the adapter map (R1.3)
 *   - a registry whose detect() throws never aborts discovery (R1.4)
 *
 * Pure-logic tests — no vscode, no extension host. Temp dirs live under a single
 * enclosing suite so teardown never races sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  discoverInstalledTools,
  runnerDataLocations,
  RUNNER_TO_ADAPTER,
  RunnerDetector,
} from '../intelligence/sources/discovery';
import { AdapterEnv } from '../intelligence/types';

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function envFor(home: string, workspaceRoot?: string): AdapterEnv {
  return {
    homeDir: home,
    workspaceRoot,
    platform: process.platform,
    env: {},
  };
}

/** Build a stub RegisteredRunner with only the fields discovery reads. */
function registered(id: string, detection: unknown, enabled: boolean): any {
  return { runner: { id }, enabled, detection };
}

/** A stub detector returning a fixed RegisteredRunner list. */
function detector(list: unknown[]): RunnerDetector {
  return { detect: async () => list as any };
}

suite('intelligence-discovery', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-discovery-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('maps an installed runner to its adapter id + on-disk data location', async function () {
    const home = freshDir('home');
    // Claude Code keeps transcripts under ~/.claude/projects.
    mkdirp(path.join(home, '.claude', 'projects'));

    const reg = detector([
      registered('claude-code', { found: true, version: '1.2.3', path: 'claude' }, true),
    ]);
    const tools = await discoverInstalledTools({ env: envFor(home), registry: reg });

    assert.strictEqual(tools.length, 1);
    const cc = tools[0];
    assert.strictEqual(cc.id, 'claude-code');
    assert.strictEqual(cc.adapterId, RUNNER_TO_ADAPTER['claude-code']);
    assert.strictEqual(cc.installed, true);
    assert.strictEqual(cc.version, '1.2.3');
    assert.ok(
      cc.dataLocations.some((l) => l.endsWith('.claude/projects')),
      `expected the claude projects dir in ${JSON.stringify(cc.dataLocations)}`,
    );
  });

  test('a not-found runner is unavailable and carries the detection hint', async function () {
    const home = freshDir('home-empty');
    const reg = detector([
      registered(
        'gemini-cli',
        { found: false, reason: 'not_installed', hint: 'gemini not on PATH' },
        false,
      ),
    ]);
    const tools = await discoverInstalledTools({ env: envFor(home), registry: reg });

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].id, 'gemini-cli');
    assert.strictEqual(tools[0].installed, false);
    assert.strictEqual(tools[0].hint, 'gemini not on PATH');
    assert.deepStrictEqual(tools[0].dataLocations, []);
  });

  test('detected-but-no-data yields installed=true with a "no data yet" hint', async function () {
    const home = freshDir('home-nodata'); // no ~/.gemini created
    const reg = detector([
      registered('gemini-cli', { found: true, version: '0.1.0', path: 'gemini' }, true),
    ]);
    const tools = await discoverInstalledTools({ env: envFor(home), registry: reg });
    assert.strictEqual(tools[0].installed, true);
    assert.deepStrictEqual(tools[0].dataLocations, []);
    assert.ok(tools[0].hint && /no session data/i.test(tools[0].hint));
  });

  test('registry detect() throwing never aborts discovery — falls back to probes', async function () {
    const home = freshDir('home-fallback');
    mkdirp(path.join(home, '.gemini'));
    const reg: RunnerDetector = {
      detect: async () => {
        throw new Error('registry boom');
      },
    };
    const tools = await discoverInstalledTools({ env: envFor(home), registry: reg });
    // Fallback probes the known adapter-mapped tool ids.
    const ids = tools.map((t) => t.id).sort();
    assert.deepStrictEqual(ids, Object.keys(RUNNER_TO_ADAPTER).sort());
    const gemini = tools.find((t) => t.id === 'gemini-cli');
    assert.ok(gemini && gemini.installed, 'gemini probed as installed via ~/.gemini');
  });

  test('runnerDataLocations is cross-OS (derives from env.homeDir, never hardcoded)', function () {
    const env = envFor('/custom/home', '/ws');
    const cc = runnerDataLocations('claude-code', env);
    assert.ok(cc.some((p) => p.replace(/\\/g, '/').startsWith('/custom/home/.claude')));
    const kiro = runnerDataLocations('kiro', env);
    assert.ok(kiro.some((p) => p.replace(/\\/g, '/').includes('/ws/.kiro/specs')));
  });
});
