/**
 * clusterMapGossip.ts — cross-window cluster-map gossip (E3a, ELECTION track).
 *
 * The FIRST real gossip layer: a window publishes its current versioned
 * ClusterMap as a beat to a file bus (comms/gossip/cluster-map/<origin>.json),
 * and peers MERGE received beats by integer (epoch, term) via mergeClusterMap.
 * This lets a window learn of a remote takeover (a peer at a higher term naming a
 * different active) promptly — its next acquire reads the gossiped map and stands
 * down — instead of waiting to re-discover it on a ~30s FS poll.
 *
 * Single-FS only — NO sockets (LAN discovery/relay is the T-track). This reuses
 * the EXACT discipline of lmd/FilesystemGossipTransport (atomic temp+rename,
 * self-origin skip, stale-drop) but carries a whole ClusterMap (not a health
 * beat) and merges by integer (epoch, term) — NOT by lastHeartbeatAt timestamp,
 * which clock skew can reorder (see clusterMap.ts header).
 *
 * GUARDRAILS this layer holds by construction:
 *  - Gossip NEVER writes cluster-map.json. It only INFORMS the read (an in-memory
 *    best-seen map). The wx-lock + lease in supervisorLease.ts stay the SOLE
 *    authority — a beat accelerates convergence, it never elects.
 *  - NO epoch churn: a received beat updates the in-memory view via mergeClusterMap,
 *    which is a no-op for an equal (epoch, term). `emittedAt` is transport
 *    dedupe/stale metadata ONLY — it is never merged into the map.
 *  - NO board-watch loop: comms/gossip/ is default-denied by makeShouldRefreshBoard.
 *  - Driven ONE-SHOT per tick (no background timer) — see E3b runTick wiring.
 *
 * The bus satisfies the same conceptual seam as lmd/natsGossip.GossipTransport, so
 * the T-track (T1) can retarget it at a relay/NATS transport with no caller change.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type ClusterMap,
  mergeClusterMap,
  coerceClusterMap,
} from '../orchestrator/clusterMap';

const fsp = fs.promises;
const COMMS_REL = path.join('.autoclaw', 'orchestrator', 'comms');

/** A beat older than this (by `emittedAt`) is dropped on read — a dead window's last beat. */
export const CLUSTER_MAP_BEAT_STALE_MS = 90_000;

/**
 * A gossip beat carrying a whole versioned ClusterMap. `origin` is the publishing
 * loop-instance id; `emittedAt` is transport dedupe/staleness metadata that is
 * NEVER merged into the map (the map's own (epoch, term) is the merge key).
 */
export interface ClusterMapBeat {
  /**
   * The publishing loop-instance id (LOOP_INSTANCE_ID = `orchestrator-loop-<hex>`).
   * MUST stay within the safeFrag-injective keyspace [A-Za-z0-9_-] — the hex id is —
   * since publish keys one file per safeFrag(origin); a punctuation-only difference
   * would collide two origins onto one file (last-writer-wins).
   */
  origin: string;
  emittedAt: string;
  map: ClusterMap;
}

/** The cluster-map gossip directory (a sibling of the health-gossip dir). */
export function clusterMapGossipDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'gossip', 'cluster-map');
}

function safeFrag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function isBeatShape(o: unknown): o is { origin: string; emittedAt: string; map: unknown } {
  if (!o || typeof o !== 'object') { return false; }
  const b = o as Record<string, unknown>;
  return typeof b.origin === 'string' && b.origin.length > 0
    && typeof b.emittedAt === 'string' && b.emittedAt.length > 0
    && !!b.map && typeof b.map === 'object';
}

let writeSeq = 0;

/**
 * The file-bus for cluster-map gossip beats — one file per origin (overwrite, not
 * append), atomic temp+rename publish, one-shot tolerant read. fs-only, `now`
 * injected on read. No background timer: the caller (runTick) drives publish/read.
 */
export class ClusterMapGossipBus {
  constructor(
    private readonly workspaceRoot: string,
    private readonly opts: { selfOrigin?: string; staleMs?: number } = {},
  ) {}

  dir(): string {
    return clusterMapGossipDir(this.workspaceRoot);
  }

  /** Publish this host's current map atomically (temp+rename). Returns the path. */
  async publish(beat: ClusterMapBeat): Promise<string> {
    const dir = this.dir();
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeFrag(beat.origin)}.json`);
    const tmp = `${file}.tmp-${process.pid}-${++writeSeq}`;
    await fsp.writeFile(tmp, JSON.stringify(beat, null, 2) + '\n', 'utf8');
    try {
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
    return file;
  }

  /**
   * Read all FRESH peer beats ONCE: skip own origin (no self-echo), drop stale
   * (emittedAt older than staleMs), skip malformed (coerceClusterMap validates the
   * embedded map). Missing dir → []. Never throws on a bad file.
   */
  async readBeats(now: number): Promise<ClusterMapBeat[]> {
    const dir = this.dir();
    const staleMs = this.opts.staleMs ?? CLUSTER_MAP_BEAT_STALE_MS;
    let files: string[];
    try { files = await fsp.readdir(dir); } catch { return []; }
    const out: ClusterMapBeat[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) { continue; }
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8');
        const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
        if (!isBeatShape(parsed)) { continue; }
        if (this.opts.selfOrigin && parsed.origin === this.opts.selfOrigin) { continue; }
        const emitted = Date.parse(parsed.emittedAt);
        // Fail CLOSED (drop) on an unparseable timestamp, exactly like the
        // FilesystemGossipTransport seam — else a corrupt-timestamp beat would
        // never age out of the staleness window.
        if (!Number.isFinite(emitted) || now - emitted > staleMs) { continue; }
        const map = coerceClusterMap(parsed.map);
        if (!map) { continue; }
        out.push({ origin: parsed.origin, emittedAt: parsed.emittedAt, map });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  /**
   * Best-effort GC of long-dead beat files. A crashed window leaves an orphan beat
   * under a now-defunct LOOP_INSTANCE_ID (regenerated per process), so per-origin
   * overwrite never reclaims it. Reaps only beats whose emittedAt is older than a
   * generous multiple of the stale TTL (10×), so a merely-slow live publisher is
   * never reaped. Returns the count removed. Missing dir / malformed → left alone.
   */
  async pruneStale(now: number): Promise<number> {
    const dir = this.dir();
    const deadMs = (this.opts.staleMs ?? CLUSTER_MAP_BEAT_STALE_MS) * 10;
    let files: string[];
    try { files = await fsp.readdir(dir); } catch { return 0; }
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) { continue; }
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8');
        const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
        if (!isBeatShape(parsed)) { continue; } // leave malformed (transient) alone
        const emitted = Date.parse(parsed.emittedAt);
        if (Number.isFinite(emitted) && now - emitted > deadMs) {
          await fsp.unlink(path.join(dir, f)).catch(() => undefined);
          removed++;
        }
      } catch {
        /* skip on read error */
      }
    }
    return removed;
  }
}

/**
 * In-memory "best peer map seen" — merges incoming beats by integer (epoch, term)
 * via mergeClusterMap (equal/older is a no-op → no churn). NEVER writes to disk.
 *
 * SAFE-CONSUMPTION CONTRACT (load-bearing — the consumer in E3b MUST honor it):
 * the best-seen map is an ADVISORY CONVERGENCE/WAKE signal ONLY. It must be used
 * solely to make a host MORE conservative — i.e. to stand down / re-read the disk
 * sooner when a peer reports a strictly-newer map. It must NEVER be:
 *   - merged into the acquire's base map (mergeClusterMap orders epoch-FIRST and
 *     replaces the map WHOLE, so a STALE higher-epoch beat could override a
 *     lower-epoch/higher-term disk steal, DROP the disk fence[], and let a deposed
 *     active renew itself back into power — split-brain, the exact thing E1c fences);
 *   - used for a steal/renew decision, or trusted for LIVENESS (the equal-version
 *     no-op freezes the gossiped active's lease_heartbeat, so it only ever ages).
 * The durable cluster-map.json under the wx-lock stays the SOLE election authority;
 * gossip only accelerates convergence, it never elects. Take staleness/steal
 * decisions from the DISK active, never from a gossiped one.
 */
export class RemoteClusterMapTracker {
  private bestSeen: ClusterMap | null = null;

  /** Merge one beat. Returns whether the best-seen view ADVANCED (strictly newer). */
  merge(beat: ClusterMapBeat): { changed: boolean } {
    const next = this.bestSeen ? mergeClusterMap(this.bestSeen, beat.map) : beat.map;
    const changed = next !== this.bestSeen;
    this.bestSeen = next;
    return { changed };
  }

  /** Merge many beats; returns whether the best-seen advanced for any of them. */
  mergeAll(beats: ClusterMapBeat[]): { changed: boolean } {
    let changed = false;
    for (const b of beats) {
      if (this.merge(b).changed) { changed = true; }
    }
    return { changed };
  }

  /** The freshest map seen over the bus, or null if none yet. Read-only (never written to disk). */
  best(): ClusterMap | null {
    return this.bestSeen;
  }
}
