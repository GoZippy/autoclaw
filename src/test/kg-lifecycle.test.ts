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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  resolveKgEntry,
  kgDepsInstalled,
  startKgDaemon,
  stopKgDaemon,
  fetchKgHealth,
  isPortAvailable,
  findAvailablePort,
  KG_PORT_FALLBACK_COUNT,
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

  test('returns deps_missing when node_modules is absent', async function () {
    const { logger, lines } = makeLogger();
    const result = await startKgDaemon({ extensionPath: extRoot, port: 9877, dbPath: '', logger });
    assert.strictEqual(result.ok, false);
    if (result.ok === false) {
      assert.strictEqual(result.reason, 'deps_missing');
      assert.match(result.message, /npm install/);
    }
    assert.strictEqual(lines.length, 0, 'logger only appended on success');
  });

  test('returns entry_missing when deps installed but dist/server.js absent', async function () {
    fs.mkdirSync(path.join(extRoot, 'packages', 'kg-daemon', 'node_modules'), { recursive: true });
    const { logger } = makeLogger();
    const result = await startKgDaemon({ extensionPath: extRoot, port: 9877, dbPath: '', logger });
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
    const result = await startKgDaemon({ extensionPath: extRoot, port: 19877, dbPath: '', logger });
    assert.strictEqual(result.ok, true);
    if (result.ok !== true) { return; }
    const state = result.state;
    assert.ok(state.child, 'child created');
    assert.ok(typeof state.child!.pid === 'number', 'has a pid');
    assert.ok(state.startedAt, 'startedAt set');
    assert.strictEqual(state.port, 19877, 'records the actual port used');

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
    const result = await startKgDaemon({ extensionPath: extRoot, port: 19878, dbPath: '', logger });
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
    assert.strictEqual(props['autoclaw.kg.port'].default, 0);
    assert.ok('autoclaw.kg.dbPath' in props);
    assert.strictEqual(props['autoclaw.kg.dbPath'].default, '');
  });
});

// ---------------------------------------------------------------------------
// Port-fallback (Phase 1 hardening — mirror of bridge port fallback)
// ---------------------------------------------------------------------------

/** Bind a no-op TCP server on (host, port). Resolves once listening. */
function occupyPort(port: number, host = '127.0.0.1'): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });
}

function closeServer(s: net.Server): Promise<void> {
  return new Promise(resolve => s.close(() => resolve()));
}

suite('KG: isPortAvailable / findAvailablePort', function () {
  this.timeout(8000);

  test('isPortAvailable returns true for an unbound port', async function () {
    // Try a high port that's almost certainly free; a probe-then-close
    // round-trip should succeed.
    const ok = await isPortAvailable(45123, '127.0.0.1');
    assert.strictEqual(ok, true);
  });

  test('isPortAvailable returns false when something is bound', async function () {
    const occupied = await occupyPort(45124);
    try {
      const ok = await isPortAvailable(45124, '127.0.0.1');
      assert.strictEqual(ok, false);
    } finally {
      await closeServer(occupied);
    }
  });

  test('findAvailablePort skips occupied ports and returns the next free one', async function () {
    const start = 45200;
    const occ = await occupyPort(start);
    try {
      const port = await findAvailablePort(start, KG_PORT_FALLBACK_COUNT, '127.0.0.1');
      assert.ok(port !== null, 'expected a fallback port');
      assert.notStrictEqual(port, start, 'should not pick the occupied port');
      assert.ok(port! > start && port! <= start + KG_PORT_FALLBACK_COUNT,
        `port should be in (${start}, ${start + KG_PORT_FALLBACK_COUNT}], got ${port}`);
    } finally {
      await closeServer(occ);
    }
  });

  test('findAvailablePort returns null when every probed port is busy', async function () {
    const start = 45300;
    const servers: net.Server[] = [];
    try {
      for (let i = 0; i <= KG_PORT_FALLBACK_COUNT; i++) {
        servers.push(await occupyPort(start + i));
      }
      const port = await findAvailablePort(start, KG_PORT_FALLBACK_COUNT, '127.0.0.1');
      assert.strictEqual(port, null);
    } finally {
      for (const s of servers) { await closeServer(s); }
    }
  });
});

suite('KG: startKgDaemon — port fallback', function () {
  this.timeout(15000);
  let extRoot: string;

  setup(function () {
    extRoot = tempDir('autoclaw-kg-fallback-');
    const dist = path.join(extRoot, 'packages', 'kg-daemon', 'dist');
    fs.mkdirSync(path.join(extRoot, 'packages', 'kg-daemon', 'node_modules'), { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    // Same self-contained stub as the spawn test: prints a banner + KG_PORT
    // and sits in a setInterval until SIGTERM.
    fs.writeFileSync(path.join(dist, 'server.js'),
      `console.log('fake-kg port=' + process.env.KG_PORT);\n` +
      `setInterval(() => {}, 1000);\n` +
      `process.on('SIGTERM', () => process.exit(0));\n`
    );
  });

  teardown(function () {
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('falls back to the next available port when configured port is busy', async function () {
    const startPort = 45400;
    const occ = await occupyPort(startPort);
    try {
      const { logger, lines } = makeLogger();
      const result = await startKgDaemon({ extensionPath: extRoot, port: startPort, dbPath: '', logger });
      assert.strictEqual(result.ok, true);
      if (result.ok !== true) { return; }
      try {
        // The daemon should report a port one above the occupied one, and
        // certainly within the fallback window.
        assert.notStrictEqual(result.state.port, startPort,
          'expected fallback off the occupied port');
        assert.ok(
          result.state.port > startPort && result.state.port <= startPort + KG_PORT_FALLBACK_COUNT,
          `port should be in (${startPort}, ${startPort + KG_PORT_FALLBACK_COUNT}], got ${result.state.port}`
        );

        const all = lines.join('\n');
        // The fallback log line is emitted before spawn.
        assert.match(all, new RegExp(`configured port ${startPort} in use`));
        assert.match(all, new RegExp(`port=${result.state.port}`));
      } finally {
        await stopKgDaemon(result.state, 2000);
      }
    } finally {
      await closeServer(occ);
    }
  });

  test('returns no_port_available when every probed port is busy', async function () {
    const startPort = 45500;
    const servers: net.Server[] = [];
    try {
      for (let i = 0; i <= KG_PORT_FALLBACK_COUNT; i++) {
        servers.push(await occupyPort(startPort + i));
      }
      const { logger, lines } = makeLogger();
      const result = await startKgDaemon({ extensionPath: extRoot, port: startPort, dbPath: '', logger });
      assert.strictEqual(result.ok, false);
      if (result.ok === false) {
        assert.strictEqual(result.reason, 'no_port_available');
        assert.match(result.message,
          new RegExp(`no port available in ${startPort}\\.\\.${startPort + KG_PORT_FALLBACK_COUNT}`));
      }
      // Logger should also have a record of the failure.
      assert.ok(lines.some(l => /no port available/.test(l)),
        `expected logger to record the no_port_available failure: ${JSON.stringify(lines)}`);
    } finally {
      for (const s of servers) { await closeServer(s); }
    }
  });
});
