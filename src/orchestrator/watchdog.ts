/**
 * watchdog.ts — 5-minute stall detection ticker.
 *
 * Checks `comms/heartbeats/<agent>.json` mtime every 5 minutes.
 * When an agent has not heartbeated within the configured threshold, emits a
 * 'stall' event so higher-level code (e.g. LMD) can escalate.
 *
 * This module contains NO chokidar usage — it runs on a pure setInterval timer
 * because heartbeats are periodic signals, not inbox events.
 *
 * A3 — Part of Sprint-1 / WA-2 (Watchdog & Reconciliation).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** Absolute path to the comms directory (contains `heartbeats/`). */
  commsDir: string;
  /** Stall threshold in milliseconds. Default 300 000 (5 min). */
  stallThresholdMs?: number;
  /** Tick interval in milliseconds. Default 300 000 (5 min). */
  tickIntervalMs?: number;
  /**
   * Called when an agent is detected as stalled.
   * @param agentId   Agent identifier (filename without .json extension).
   * @param lastSeen  ISO timestamp of the last heartbeat (or null if none).
   * @param ageMs     Milliseconds since the last heartbeat.
   */
  onStall?: (agentId: string, lastSeen: string | null, ageMs: number) => void;
}

export interface StallEvent {
  agentId: string;
  lastSeen: string | null;
  ageMs: number;
  detectedAt: string;
}

export interface Watchdog {
  /** Start the 5-minute stall detection loop. */
  start(): void;
  /** Stop the tick loop and release the timer. */
  stop(): void;
  /** Force an immediate check (useful for testing). */
  tick(): Promise<void>;
  /** EventEmitter: 'stall' (StallEvent), 'tick' (void), 'stopped' (void). */
  readonly events: EventEmitter;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const {
    commsDir,
    stallThresholdMs = 5 * 60 * 1000,
    tickIntervalMs = 5 * 60 * 1000,
    onStall,
  } = opts;

  const heartbeatsDir = path.join(commsDir, 'heartbeats');
  const emitter = new EventEmitter();
  let _timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    emitter.emit('tick');
    const now = Date.now();
    let files: string[];
    try {
      files = (await fsPromises.readdir(heartbeatsDir)).filter(f => f.endsWith('.json'));
    } catch {
      // heartbeats dir may not exist yet — silently skip.
      return;
    }

    for (const file of files) {
      const agentId = file.slice(0, -5); // strip ".json"
      const filePath = path.join(heartbeatsDir, file);
      try {
        const stat = await fsPromises.stat(filePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs >= stallThresholdMs) {
          // Read last heartbeat timestamp for context.
          let lastSeen: string | null = null;
          try {
            const raw = await fsPromises.readFile(filePath, 'utf8');
            const hb = JSON.parse(raw.replace(/^﻿/, '')) as { timestamp?: string };
            lastSeen = hb.timestamp ?? null;
          } catch { /* use null */ }

          const event: StallEvent = {
            agentId,
            lastSeen,
            ageMs,
            detectedAt: new Date().toISOString(),
          };
          emitter.emit('stall', event);
          if (onStall) {
            onStall(agentId, lastSeen, ageMs);
          }
        }
      } catch { /* file disappeared between readdir and stat — skip */ }
    }
  }

  function start(): void {
    if (_timer !== null) { return; } // already running
    // Immediately run one tick, then repeat on the interval.
    tick().catch(err => emitter.emit('error', err));
    _timer = setInterval(() => {
      tick().catch(err => emitter.emit('error', err));
    }, tickIntervalMs);
  }

  function stop(): void {
    if (_timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
    emitter.emit('stopped');
  }

  return {
    start,
    stop,
    tick,
    get events() { return emitter; },
  };
}
