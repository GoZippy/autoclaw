/**
 * KG-daemon lifecycle unit tests.
 *
 * No real `vscode` host involved; we exercise the pure helpers in
 * `src/kg.ts` against a temp extension root and confirm:
 *   - dependency / entry probes detect missing files
 *   - startKgDaemon short-circuits when deps or entry are missing
 *   - fetchKgHealth fails fast against a closed port
 *
 * We deliberately do NOT spawn a real Node child running the actual
 * daemon — that would require better-sqlite3 native bindings. The one
 * test that exercises an actual `spawn` runs `process.execPath` against
 * a tiny self-contained inline script that prints + exits, just to
 * cover the spawn/teardown wiring.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveKgEntry,
  kgDepsInstalled,
  startKgDaemon,
  stopKgDaemon,
  fetchKgHealth,
  type KgLogger,
} from '../kg';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeLogger(): { logger: KgLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    logger: { appendLine: (l: string) => lines.push(l) },
    lines,
  };
}

suite('KG: resolveKgEntry / kgDepsInstalled', function () {
  let extRoot: string;

  setup(function () {
    extRoot = tempDir('autoclaw-kg-ext-');
  });

  teardown(function () {
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('reports entry missing in a fresh extension root', function () {
    const r = resolveKgEntry(extRoot);
    assert.strictEqual(r.exists, false);
    assert.ok(r.path.endsWith('server.js'), 'points at server.js');
  });

  test('reports deps missing when node_modules absent', function () {
    assert.strictEqual(kgDepsInstalled(extRoot), false);
  });

  test('reports deps installed when node_modules dir exists', function () {
    fs.mkdirSync(path.join(extRoot, 'packages', 'kg-daemon', 'node_modules'), { recursive: true });
    assert.strictEqual(kgDepsInstalled(extRoot), true);
  });

  test('reports entry exists when dist/server.js is present', function () {
    const dist = path.join(extRoot, 'packages', 'kg-daemon', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'server.js'), '// stub');
    const r = resolveKgEntry(extRoot);
    assert.strictEqual(r.exists, true);
  });
});

suite('KG: startKgDaemon — short-circuit paths', function () {
  let extRoot: string;

  setup(function () {
    extRoot = tempDir('autoclaw-kg-start-');
  });

  teardown(function () {
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('returns deps_missing when node_modules is absent', function () {
    const { logger, lines } = makeLogger();
    const result = startKgDaemon({ extensionPath: extRoot, port: 9877, dbPath: '', logger });
    assert.strictEqual(result.ok, false);
    if (result.ok === false) {
      assert.strictEqual(result.reason, 'deps_missing');
      assert.match(result.message, /npm install/);
    }
    assert.strictEqual(lines.length, 0, 'logger only appended on success');
  });

  test('returns entry_missing when deps installed but dist/server.js absent', function () {
    fs.mkdirSync(path.join(extRoot, 'packages', 'kg-daemon', 'node_modules'), { recursive: true });
    const { logger } = makeLogger();
    const result = startKgDaemon({ extensionPath: extRoot, port: 9877, dbPath: '', logger });
    assert.strictEqual(result.ok, false);
    if (result.ok === false) {
      assert.strictEqual(result.reason, 'entry_missing');
      assert.match(result.message, /npm run build/);
    }
  });
});

suite('KG: spawn + stop with a fake daemon script', function () {
  this.timeout(15000);
  let extRoot: string;

  setup(function () {
    extRoot = tempDir('autoclaw-kg-fake-');
    // Pretend deps are installed and the entry is a tiny stub that
    // echoes its env, prints a banner, then sits in a setInterval so
    // we can verify SIGTERM teardown.
    const dist = path.join(extRoot, 'packages', 'kg-daemon', 'dist');
    fs.mkdirSync(path.join(extRoot, 'packages', 'kg-daemon', 'node_modules'), { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'server.js'),
      `console.log('fake-kg port=' + process.env.KG_PORT);\n` +
      `setInterval(() => {}, 1000);\n` +
      `process.on('SIGTERM', () => process.exit(0));\n`
    );
  });

  teardown(function () {
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('startKgDaemon returns a live child; stopKgDaemon shuts it down', async function () {
    const { logger, lines } = makeLogger();
    const result = startKgDaemon({ extensionPath: extRoot, port: 19877, dbPath: '', logger });
    assert.strictEqual(result.ok, true);
    if (result.ok !== true) { return; }
    const state = result.state;
    assert.ok(state.child, 'child created');
    assert.ok(typeof state.child!.pid === 'number', 'has a pid');
    assert.ok(state.startedAt, 'startedAt set');

    // Wait briefly so the stub's console.log has time to flush.
    await new Promise(r => setTimeout(r, 300));
    await stopKgDaemon(state, 2000);
    assert.strictEqual(state.child!.exitCode !== null || state.child!.signalCode !== null, true,
      'child has exited after stop');

    const all = lines.join('\n');
    assert.match(all, /\[kg\] started pid=/);
    assert.match(all, /port=19877/);
  });

  test('stopKgDaemon is a no-op for an already-exited child', async function () {
    const { logger } = makeLogger();
    const result = startKgDaemon({ extensionPath: extRoot, port: 19878, dbPath: '', logger });
    assert.strictEqual(result.ok, true);
    if (result.ok !== true) { return; }
    await stopKgDaemon(result.state, 2000);
    // Calling again should resolve immediately.
    await stopKgDaemon(result.state, 2000);
  });
});

suite('KG: fetchKgHealth', function () {
  this.timeout(8000);

  test('returns ok=false against a guaranteed-closed port', async function () {
    // Port 1 is privileged + closed → fast ECONNREFUSED on most OSes.
    const r = await fetchKgHealth(1, '127.0.0.1', 800);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error || r.status !== null,
      'either an error message or a non-2xx status is reported');
  });
});

suite('KG: package.json contributions', function () {
  // Verifies the extension manifest exposes the new opt-in surface so
  // VS Code can register the commands and surface the settings UI.
  // (We can't probe vscode.commands at unit-test time without an
  // extension host — this is the next-best static check.)
  // Tests run from out/test/ so package.json is two levels up.
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');

  test('declares autoclaw.kg.openOutput and autoclaw.kg.healthCheck commands', function () {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const cmds = (pkg.contributes?.commands ?? []) as Array<{ command: string }>;
    const ids = new Set(cmds.map(c => c.command));
    assert.ok(ids.has('autoclaw.kg.openOutput'), 'autoclaw.kg.openOutput command registered');
    assert.ok(ids.has('autoclaw.kg.healthCheck'), 'autoclaw.kg.healthCheck command registered');
  });

  test('declares autoclaw.kg.* configuration with enabled defaulting to false', function () {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const props = pkg.contributes?.configuration?.properties ?? {};
    assert.ok('autoclaw.kg.enabled' in props, 'autoclaw.kg.enabled defined');
    assert.strictEqual(props['autoclaw.kg.enabled'].default, false,
      'kg.enabled defaults to false (opt-in)');
    assert.ok('autoclaw.kg.port' in props);
    assert.strictEqual(props['autoclaw.kg.port'].default, 9877);
    assert.ok('autoclaw.kg.dbPath' in props);
    assert.strictEqual(props['autoclaw.kg.dbPath'].default, '');
  });
});
