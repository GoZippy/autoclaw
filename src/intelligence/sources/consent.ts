/**
 * sources/consent.ts — enabled-state + first-run opt-in gate (R3.4, R5.1 / D13).
 *
 * Privacy-at-scale: the AutoClaw-native source is on by default; every
 * third-party source stays DISABLED until the user explicitly opts in. This
 * module owns that policy and persists decisions to `config.sources`:
 *
 *   - `isEnabled(cfg, sourceId)` — explicit `config.sources[id].enabled` wins;
 *     otherwise the native default (on) / third-party default (off) applies.
 *   - `ensureFirstRunConsent(discovered, cfg)` — returns the available
 *     third-party sources that have no recorded decision yet, so the UI/command
 *     layer can present them for opt-in before any third-party extraction.
 *   - `recordConsent(workspaceRoot, sourceId, enabled)` — lock-protected
 *     read-modify-write of `config.sources` in `.autoclaw/vector/config.json`,
 *     touching only the `sources` key.
 *
 * No `vscode` import; no native modules; no work at import time.
 */

import * as fs from 'fs';

import type { LogFn } from '../config';
import { loadConfig } from '../config';
import { acquireLock } from '../fileLock';
import { ensureDir, intelligencePaths } from '../paths';
import type { IntelligenceConfig } from '../types';

/** The only source enabled by default — everything else is opt-in (D13). */
export const NATIVE_SOURCE_ID = 'autoclaw-native';

/** The default enabled-state for a source with no explicit toggle. */
export function defaultEnabledFor(sourceId: string): boolean {
  return sourceId === NATIVE_SOURCE_ID;
}

/**
 * Whether `sourceId` should run. An explicit `config.sources[id].enabled` toggle
 * always wins; otherwise the default applies (native on, third-party off).
 */
export function isEnabled(cfg: Pick<IntelligenceConfig, 'sources'>, sourceId: string): boolean {
  const toggle = cfg.sources ? cfg.sources[sourceId] : undefined;
  if (toggle && typeof toggle.enabled === 'boolean') {
    return toggle.enabled;
  }
  return defaultEnabledFor(sourceId);
}

/** A minimal discovered-source shape `ensureFirstRunConsent` reasons over. */
export interface ConsentCandidate {
  /** Source Adapter id. */
  id: string;
  /** Whether the source was found available on this machine. */
  available: boolean;
}

/** The outcome of the first-run consent computation. */
export interface ConsentDecision {
  /**
   * Available third-party sources with no recorded decision — present these for
   * explicit opt-in BEFORE any third-party extraction (R3.4).
   */
  toPrompt: string[];
  /** Sources already governed by an explicit `config.sources` toggle. */
  alreadyDecided: string[];
  /** Sources that are on by default and need no prompt (the native source). */
  autoEnabled: string[];
}

/**
 * Compute the first-run consent decision: which available third-party sources
 * still need an explicit opt-in. A source with any explicit `config.sources`
 * toggle (enabled OR disabled) is considered decided and is never re-prompted.
 */
export function ensureFirstRunConsent(
  discovered: ConsentCandidate[],
  cfg: Pick<IntelligenceConfig, 'sources'>,
): ConsentDecision {
  const toPrompt: string[] = [];
  const alreadyDecided: string[] = [];
  const autoEnabled: string[] = [];

  for (const d of discovered) {
    const hasExplicit =
      cfg.sources && cfg.sources[d.id] && typeof cfg.sources[d.id].enabled === 'boolean';
    if (d.id === NATIVE_SOURCE_ID) {
      if (!hasExplicit) {
        autoEnabled.push(d.id);
      } else {
        alreadyDecided.push(d.id);
      }
      continue;
    }
    if (hasExplicit) {
      alreadyDecided.push(d.id);
      continue;
    }
    if (d.available) {
      toPrompt.push(d.id);
    }
  }

  return { toPrompt, alreadyDecided, autoEnabled };
}

/**
 * Persist a consent decision to `config.sources` (R3.4 / D13). Lock-protected
 * read-modify-write that touches ONLY the `sources` key — every other config
 * field is preserved from disk (or left to defaults when the file is absent).
 * Best-effort: a write failure is logged, never thrown.
 */
export async function recordConsent(
  workspaceRoot: string,
  sourceId: string,
  enabled: boolean,
  log?: LogFn,
): Promise<void> {
  const warn: LogFn = log ?? (() => undefined);
  const { vectorDir, configPath } = intelligencePaths(workspaceRoot);

  try {
    await ensureDir(vectorDir);
  } catch (err) {
    warn(`consent: could not create ${vectorDir} (${(err as Error).message})`);
    return;
  }

  const release = await acquireLock(configPath);
  try {
    // Read only the raw on-disk object so we preserve unknown/other fields
    // exactly; fall back to an empty object when absent or malformed.
    let onDisk: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          onDisk = parsed as Record<string, unknown>;
        }
      }
    } catch (err) {
      warn(`consent: ${configPath} unreadable (${(err as Error).message}); rewriting sources only`);
      onDisk = {};
    }

    const sources =
      onDisk.sources && typeof onDisk.sources === 'object' && !Array.isArray(onDisk.sources)
        ? (onDisk.sources as Record<string, { enabled: boolean }>)
        : {};
    sources[sourceId] = { enabled };
    onDisk.sources = sources;

    fs.writeFileSync(configPath, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
  } catch (err) {
    warn(`consent: could not write ${configPath} (${(err as Error).message})`);
  } finally {
    release();
  }
}

/**
 * Reload the effective config after a consent change. Thin convenience wrapper
 * over {@link loadConfig} so callers don't import two modules.
 */
export function reloadConfig(workspaceRoot: string, log?: LogFn): IntelligenceConfig {
  return loadConfig(workspaceRoot, log);
}
