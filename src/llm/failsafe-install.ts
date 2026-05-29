/**
 * Failsafe install — pull `qwen3:0.6b` and start a dedicated `:11435`
 * Ollama instance so the oracle ladder's bottom rung always exists.
 *
 * Idempotent and non-blocking on failure:
 *   - If Ollama isn't installed at all → return `{ installed: false,
 *     reason: 'ollama-missing' }`. The oracle reports `failsafe: null`
 *     and the persona loader surfaces a fleet-panel notice.
 *   - If the model is already pulled and `:11435` is responding → no-op.
 *   - If the pull fails → return `{ installed: false, reason: 'pull-failed' }`.
 *
 * Called from `src/llm/registry.ts` on first `getPreferred()` invocation
 * (cached for the lifetime of the process).
 *
 * @see docs/rfc/llm-provider-abstraction.md §8 open question 6
 * @see docs/specs/llm-provider-s1/spec.md (Failsafe install criterion)
 */

import { spawn } from 'child_process';

const FAILSAFE_MODEL = 'qwen3:0.6b';
const FAILSAFE_PORT = 11435;
const FAILSAFE_HOST = `http://127.0.0.1:${FAILSAFE_PORT}`;

export type FailsafeInstallResult =
  | { installed: true; alreadyPresent: boolean; endpoint: string }
  | { installed: false; reason: 'ollama-missing' | 'pull-failed' | 'disabled'; detail?: string };

export interface FailsafeInstallOptions {
  /** Set false to skip the installer entirely (config opt-out). */
  enabled?: boolean;
  /** Override the model id (mostly for testing). */
  model?: string;
  /** Override the port (mostly for testing). */
  port?: number;
  /** Test hook for the probe — replace global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Test hook for the spawn step — replace with a stub that returns the
   * exit code without actually running `ollama`.
   */
  pullImpl?: (model: string) => Promise<{ ok: boolean; detail?: string }>;
}

let cached: Promise<FailsafeInstallResult> | undefined;

/**
 * Install the failsafe (idempotent). Caches the result for the process
 * lifetime — registry calls this on first use and subsequent calls
 * return the cached result without re-probing.
 */
export function installFailsafe(
  opts: FailsafeInstallOptions = {},
): Promise<FailsafeInstallResult> {
  if (cached) return cached;
  cached = doInstall(opts);
  return cached;
}

/** Test helper — drop the memoized result so a fresh install runs. */
export function _resetFailsafeCacheForTests(): void {
  cached = undefined;
}

async function doInstall(opts: FailsafeInstallOptions): Promise<FailsafeInstallResult> {
  if (opts.enabled === false) {
    return { installed: false, reason: 'disabled' };
  }
  const model = opts.model ?? FAILSAFE_MODEL;
  const port = opts.port ?? FAILSAFE_PORT;
  const host = `http://127.0.0.1:${port}`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Step 1: is the failsafe already up?
  if (await isReachable(host, fetchImpl)) {
    return { installed: true, alreadyPresent: true, endpoint: host };
  }

  // Step 2: is the main Ollama on :11434 up? If not, Ollama probably
  // isn't installed — bail out.
  const mainOk = await isReachable('http://127.0.0.1:11434', fetchImpl);
  if (!mainOk) {
    return { installed: false, reason: 'ollama-missing' };
  }

  // Step 3: pull the model (idempotent — Ollama no-ops if already present).
  const pull = opts.pullImpl ?? defaultPullImpl;
  const pullResult = await pull(model);
  if (!pullResult.ok) {
    return { installed: false, reason: 'pull-failed', detail: pullResult.detail };
  }

  // Step 4: start a dedicated :11435 instance.
  // NOTE: starting a long-lived Ollama instance is a heavy side-effect.
  // S1 ships the pull + detection only; the actual `:11435` instance is
  // started by the user (the install command prints the instructions).
  // The oracle will pick it up automatically once it's reachable.
  const reachable = await isReachable(host, fetchImpl);
  if (reachable) {
    return { installed: true, alreadyPresent: false, endpoint: host };
  }
  // Pull succeeded but :11435 isn't up. Report success on the model
  // (it's now available via the main :11434) but flag that the dedicated
  // failsafe instance still needs to be started.
  return {
    installed: false,
    reason: 'pull-failed',
    detail: `Pulled ${model} via :11434 but the failsafe :${port} instance is not running. Start it with: OLLAMA_HOST=${host} ollama serve`,
  };
}

async function isReachable(host: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${host}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function defaultPullImpl(model: string): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn('ollama', ['pull', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (err) => {
        resolve({ ok: false, detail: `ollama spawn failed: ${err.message}` });
      });
      child.on('exit', (code) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, detail: `ollama exit ${code}: ${stderr.slice(-200)}` });
        }
      });
    } catch (err) {
      resolve({ ok: false, detail: (err as Error).message });
    }
  });
}
