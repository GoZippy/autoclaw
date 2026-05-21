/**
 * idleDetector.ts — Human-idle detection for the computer-use safety gate.
 *
 * The `computer_use` strategy is only permitted to drive the IDE GUI when the
 * human operator is idle (no recent keyboard/mouse input). Hijacking the
 * cursor while a human is actively typing would be hostile, so this gate is
 * mandatory and enforced in {@link computerUseStrategy}.
 *
 * Idle time is queried per-OS:
 *   - Windows : `GetLastInputInfo` via a tiny inline PowerShell snippet.
 *   - macOS   : `ioreg` HIDIdleTime.
 *   - Linux   : `xprintidle` when installed; otherwise unknown.
 *
 * When idle time cannot be determined the detector returns `unknown`, and the
 * caller treats `unknown` as "NOT idle" — fail-safe: never act when unsure.
 *
 * *** NO LLM CALLS. Pure child-process probes. ***
 */

import { execFile } from 'child_process';

/** Result of an idle probe. */
export interface IdleStatus {
  /** Milliseconds since the last human input, or `null` when undeterminable. */
  idleMs: number | null;
  /** True only when `idleMs` is known AND ≥ the configured threshold. */
  isIdle: boolean;
  /** How the value was obtained, for logging. */
  source: 'windows' | 'macos' | 'linux' | 'unknown';
}

/** Default: a human is "idle" after 3 minutes of no input. */
export const DEFAULT_IDLE_THRESHOLD_MS = 3 * 60 * 1000;

/** Run a short-lived command and resolve its stdout, or `null` on any error. */
function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.toString());
    });
  });
}

/** Windows: GetLastInputInfo via inline C# compiled by PowerShell Add-Type. */
async function probeWindows(): Promise<number | null> {
  const ps = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class AC_Idle{',
    '[StructLayout(LayoutKind.Sequential)]struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}',
    '[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LASTINPUTINFO p);',
    'public static uint Get(){LASTINPUTINFO i=new LASTINPUTINFO();i.cbSize=(uint)Marshal.SizeOf(i);',
    'GetLastInputInfo(ref i);return ((uint)Environment.TickCount - i.dwTime);}}',
    '"@;[AC_Idle]::Get()',
  ].join('\n');
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (out === null) { return null; }
  const ms = parseInt(out.trim(), 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** macOS: ioreg HIDIdleTime is in nanoseconds. */
async function probeMacos(): Promise<number | null> {
  const out = await run('sh', ['-c',
    "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'"]);
  if (out === null) { return null; }
  const ns = parseInt(out.trim(), 10);
  return Number.isFinite(ns) && ns >= 0 ? Math.floor(ns / 1_000_000) : null;
}

/** Linux: xprintidle reports milliseconds; absent on minimal installs. */
async function probeLinux(): Promise<number | null> {
  const out = await run('xprintidle', []);
  if (out === null) { return null; }
  const ms = parseInt(out.trim(), 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Probe how long the human operator has been idle.
 *
 * @param thresholdMs - Idle threshold; defaults to {@link DEFAULT_IDLE_THRESHOLD_MS}.
 * @param platform    - Override `process.platform` (tests).
 * @returns An {@link IdleStatus}. `isIdle` is `false` whenever `idleMs` is
 *          `null` — the gate fails safe when idleness cannot be confirmed.
 */
export async function detectIdle(
  thresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
  platform: NodeJS.Platform = process.platform,
): Promise<IdleStatus> {
  let idleMs: number | null = null;
  let source: IdleStatus['source'] = 'unknown';

  if (platform === 'win32') {
    source = 'windows';
    idleMs = await probeWindows();
  } else if (platform === 'darwin') {
    source = 'macos';
    idleMs = await probeMacos();
  } else if (platform === 'linux') {
    source = 'linux';
    idleMs = await probeLinux();
  }

  return {
    idleMs,
    isIdle: idleMs !== null && idleMs >= thresholdMs,
    source,
  };
}
