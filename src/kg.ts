/**
 * kg.ts — AutoClaw Knowledge Graph daemon lifecycle.
 *
 * Spawns the `@autoclaw/kg-daemon` Node child process on extension
 * activation when `autoclaw.kg.enabled === true` and tears it down on
 * deactivation. The daemon itself lives in `packages/kg-daemon/` and is
 * a maintainer-installed peer (we deliberately do NOT auto-`npm install`
 * its dependencies — better-sqlite3 has native bindings).
 *
 * No `vscode` import here; the extension passes in an OutputChannel
 * shim and reads settings on its side. Keeps this module unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';

/**
 * Logger contract that mimics the subset of `vscode.OutputChannel` we use.
 * Tests can supply a synthetic recorder; the extension wires the real
 * `AutoClaw KG` channel.
 */
export interface KgLogger {
  appendLine(line: string): void;
}

export interface KgSpawnConfig {
  /** Absolute path to the extension root (where `packages/kg-daemon/` lives). */
  extensionPath: string;
  /** TCP port for the daemon's HTTP server. */
  port: number;
  /** Optional override for the SQLite file path. Empty string ⇒ daemon default. */
  dbPath: string;
  /** Logger to receive stdout/stderr lines from the daemon. */
  logger: KgLogger;
}

export interface KgState {
  child: ChildProcess | null;
  config: KgSpawnConfig;
  startedAt: string | null;
  /** Last exit code observed (null while the child is alive or never started). */
  exitCode: number | null;
}

export type KgStartResult =
  | { ok: true; state: KgState }
  | { ok: false; reason: 'disabled' | 'deps_missing' | 'entry_missing'; message: string };

/**
 * Resolves the path to the kg-daemon entrypoint script. Prefers the
 * compiled `dist/server.js` shipped after `npm run build`; falls back
 * to a not-found error so callers can surface a clear message.
 */
export function resolveKgEntry(extensionPath: string): { path: string; exists: boolean } {
  const dist = path.join(extensionPath, 'packages', 'kg-daemon', 'dist', 'server.js');
  return { path: dist, exists: fs.existsSync(dist) };
}

/**
 * `true` when `packages/kg-daemon/node_modules/` is populated. We treat
 * presence-of-the-directory as "deps installed" — same heuristic the
 * Doctor section reports.
 */
export function kgDepsInstalled(extensionPath: string): boolean {
  const nm = path.join(extensionPath, 'packages', 'kg-daemon', 'node_modules');
  try {
    return fs.statSync(nm).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Spawn the kg-daemon child. Returns a tagged result: `disabled` is
 * never produced here (the caller short-circuits before invoking); we
 * still model it in the union so the extension can pattern-match
 * uniformly across enabled/disabled paths if it wants.
 */
export function startKgDaemon(config: KgSpawnConfig): KgStartResult {
  if (!kgDepsInstalled(config.extensionPath)) {
    return {
      ok: false,
      reason: 'deps_missing',
      message: 'kg-daemon dependencies not installed; run `cd packages/kg-daemon && npm install`',
    };
  }
  const entry = resolveKgEntry(config.extensionPath);
  if (!entry.exists) {
    return {
      ok: false,
      reason: 'entry_missing',
      message: `kg-daemon entry not found at ${entry.path.replace(/\\/g, '/')}; run \`cd packages/kg-daemon && npm run build\``,
    };
  }

  const env: NodeJS.ProcessEnv = { ...process.env, KG_PORT: String(config.port) };
  if (config.dbPath && config.dbPath.trim()) {
    env.KG_DB_PATH = config.dbPath;
  }

  const child = spawn(process.execPath, [entry.path], {
    cwd: path.join(config.extensionPath, 'packages', 'kg-daemon'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const state: KgState = {
    child,
    config,
    startedAt: new Date().toISOString(),
    exitCode: null,
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line) { config.logger.appendLine(`[kg] ${line}`); }
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line) { config.logger.appendLine(`[kg!] ${line}`); }
    }
  });
  child.on('exit', (code, signal) => {
    state.exitCode = code;
    config.logger.appendLine(
      `[kg] daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    );
  });
  child.on('error', (err) => {
    config.logger.appendLine(`[kg!] spawn error: ${err.message}`);
  });

  config.logger.appendLine(
    `[kg] started pid=${child.pid ?? '?'} port=${config.port} entry=${entry.path.replace(/\\/g, '/')}`
  );
  return { ok: true, state };
}

/**
 * Gracefully terminate the daemon: SIGTERM, then SIGKILL after `timeoutMs`
 * if still alive. Resolves once the child reports `exit` or after the
 * kill window elapses (whichever comes first).
 */
export function stopKgDaemon(state: KgState, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const onExit = (): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);

    const timer = setTimeout(() => {
      if (settled) { return; }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Force-resolve after sending SIGKILL even if 'exit' is delayed.
      setTimeout(onExit, 250);
    }, timeoutMs);

    try { child.kill('SIGTERM'); } catch {
      // If even SIGTERM throws (already gone) treat as resolved.
      onExit();
    }
  });
}

/** Best-effort GET against the daemon's `/api/v1/health`. */
export interface KgHealthResult {
  ok: boolean;
  status: number | null;
  body: unknown;
  error?: string;
}

export function fetchKgHealth(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<KgHealthResult> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/api/v1/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? null,
            body: parsed,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: null, body: null, error: err.message });
    });
    req.end();
  });
}

export const DEFAULT_KG_PORT = 9877;
