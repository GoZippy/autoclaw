/**
 * gossip.ts — LMD gossip ring: multi-machine health broadcast (E4).
 *
 * Each machine runs its own LMD watching its own local agents. The gossip ring
 * lets those LMDs share one health picture so that — for example — a stall on
 * machine A is visible to an operator looking at machine B, all without any
 * LLM routing.
 *
 * Two transports satisfy the {@link GossipTransport} interface from
 * `natsGossip.ts`:
 *
 *   • {@link FilesystemGossipTransport} — beats are written as JSON files into
 *     a shared gossip directory (`.autoclaw/orchestrator/comms/gossip/`).
 *     Works on any shared filesystem; zero dependencies; the default.
 *
 *   • {@link NatsGossipTransport} (from `natsGossip.ts`) — NATS pub/sub on
 *     `ac.hb.<agent>`. Used when the optional `nats` package + server are
 *     present; otherwise the ring transparently falls back to the filesystem
 *     transport.
 *
 * The {@link GossipRing} ties it together: it publishes the local LMD's health
 * snapshot on a timer, ingests peer beats, merges them into a
 * {@link RemoteHealthTracker}, and runs cross-machine stall detection.
 *
 * *** NO LLM CALLS. NO LLM ROUTING. Pure file/transport I/O + timers. ***
 *
 * E4 — Sprint-3 / WA-4 (LMD gossip).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { HealthState, AgentHealth } from './types';
import {
  GossipBeat,
  GossipTransport,
  NatsGossipTransport,
  NatsGossipOptions,
} from './natsGossip';

// ---------------------------------------------------------------------------
// Filesystem gossip transport
// ---------------------------------------------------------------------------

/** Options for {@link FilesystemGossipTransport}. */
export interface FilesystemGossipOptions {
  /**
   * Absolute path to the shared gossip directory. Each beat is one JSON file
   * named `<origin>__<agentId>.json` so concurrent LMDs never collide.
   */
  gossipDir: string;
  /** Poll interval (ms) for reading peer beats. Default 5000. */
  pollIntervalMs?: number;
  /**
   * Treat a peer beat as stale and ignore it once it is older than this many
   * milliseconds. Default 120000 (2 min).
   */
  staleMs?: number;
  /** Logger seam. Defaults to `console`. */
  logger?: { warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Filesystem-backed {@link GossipTransport}.
 *
 * Publishing writes one JSON file per (origin, agent). Subscribing polls the
 * directory, parses every fresh beat, and fans out beats from *other* origins
 * to registered handlers (a transport never echoes its own beats back).
 */
export class FilesystemGossipTransport implements GossipTransport {
  readonly name = 'filesystem';
  readonly available = true; // the filesystem is always available

  private readonly gossipDir: string;
  private readonly pollIntervalMs: number;
  private readonly staleMs: number;
  private readonly logger: { warn: (m: string) => void; error: (m: string) => void };

  private readonly handlers: Set<(beat: GossipBeat) => void> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Beats already delivered, keyed by `<file>@<emittedAt>` to dedupe. */
  private readonly seen: Set<string> = new Set();
  /** Origin id of this LMD — used to skip our own beats when polling. */
  private selfOrigin = '';

  constructor(opts: FilesystemGossipOptions) {
    this.gossipDir = opts.gossipDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.staleMs = opts.staleMs ?? 120_000;
    this.logger = opts.logger ?? console;
  }

  /** Record which origin id is "us" so polling skips our own beats. */
  setSelfOrigin(origin: string): void {
    this.selfOrigin = origin;
  }

  async connect(): Promise<boolean> {
    try {
      fs.mkdirSync(this.gossipDir, { recursive: true });
    } catch (err) {
      this.logger.error(
        `LMD gossip: cannot create gossip dir "${this.gossipDir}": ${String(err)}`,
      );
    }
    return true;
  }

  /** Write the beat as `<origin>__<agentId>.json`. */
  async publish(beat: GossipBeat): Promise<void> {
    const file = path.join(
      this.gossipDir,
      `${sanitise(beat.origin)}__${sanitise(beat.agentId)}.json`,
    );
    try {
      // Atomic-ish write: temp file then rename, so a polling peer never reads
      // a half-written beat.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(beat), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn(`LMD gossip: failed to publish beat: ${String(err)}`);
    }
  }

  /** Begin polling the gossip dir; returns an unsubscribe function. */
  subscribe(onBeat: (beat: GossipBeat) => void): () => void {
    this.handlers.add(onBeat);
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
      // Poll once immediately so callers see existing beats without waiting.
      this._poll();
    }
    return () => {
      this.handlers.delete(onBeat);
      if (this.handlers.size === 0 && this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  async close(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.handlers.clear();
    this.seen.clear();
  }

  /** Read every beat file, fan out fresh peer beats to handlers. */
  private _poll(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.gossipDir);
    } catch {
      return; // directory may not exist yet — tolerated
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) { continue; }
      const filePath = path.join(this.gossipDir, entry);
      let beat: GossipBeat;
      try {
        beat = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GossipBeat;
      } catch {
        continue; // skip malformed / partially-written beats
      }
      // Never deliver our own beats back to ourselves.
      if (this.selfOrigin && beat.origin === this.selfOrigin) { continue; }
      // Skip stale beats.
      const emitted = new Date(beat.emittedAt).getTime();
      if (isNaN(emitted) || now - emitted > this.staleMs) { continue; }
      // Dedupe: a beat is delivered once per (file, emittedAt).
      const key = `${entry}@${beat.emittedAt}`;
      if (this.seen.has(key)) { continue; }
      this.seen.add(key);
      for (const h of this.handlers) {
        try { h(beat); } catch { /* handler error is non-fatal */ }
      }
    }
    // Bound the dedupe set so it does not grow without limit.
    if (this.seen.size > 4096) { this.seen.clear(); }
  }
}

/** Replace path-hostile characters so ids are safe as filename components. */
function sanitise(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// Remote health tracker — merged view of peer agents
// ---------------------------------------------------------------------------

/** A peer agent's health as last gossiped, plus bookkeeping. */
export interface RemoteAgentHealth {
  agentId: string;
  state: HealthState;
  lastHeartbeatAt: string;
  missedHeartbeats: number;
  /** Origin (machine/LMD) that reported this. */
  origin: string;
  /** When we received the most recent beat for this agent. */
  receivedAt: string;
}

/**
 * Merges gossiped peer beats into a single health view. Local agents (tracked
 * by the LMD's own {@link HealthStateMachine}) are *not* stored here — only
 * agents belonging to *other* origins.
 *
 * Merge rule: the most recently-emitted beat wins. A beat older than the one
 * already stored for an agent is dropped (out-of-order delivery protection).
 */
export class RemoteHealthTracker {
  private readonly agents: Map<string, RemoteAgentHealth> = new Map();

  /**
   * Merge one peer beat. Returns the merged record, or `undefined` if the
   * beat was stale relative to what we already had.
   */
  merge(beat: GossipBeat): RemoteAgentHealth | undefined {
    const existing = this.agents.get(beat.agentId);
    if (existing) {
      const prevAt = new Date(existing.lastHeartbeatAt).getTime();
      const newAt = new Date(beat.lastHeartbeatAt).getTime();
      // Keep the freshest heartbeat. Equal timestamps still update missed
      // counts / state, since a peer may have re-evaluated the same beat.
      if (!isNaN(prevAt) && !isNaN(newAt) && newAt < prevAt) {
        return undefined;
      }
    }
    const record: RemoteAgentHealth = {
      agentId: beat.agentId,
      state: beat.state,
      lastHeartbeatAt: beat.lastHeartbeatAt,
      missedHeartbeats: beat.missedHeartbeats,
      origin: beat.origin,
      receivedAt: new Date().toISOString(),
    };
    this.agents.set(beat.agentId, record);
    return record;
  }

  /** Health of a single remote agent. */
  get(agentId: string): RemoteAgentHealth | undefined {
    return this.agents.get(agentId);
  }

  /** All remote agents currently tracked. */
  getAll(): RemoteAgentHealth[] {
    return Array.from(this.agents.values());
  }

  /**
   * Remote agents whose state is `stalled` or `dead` — i.e. cross-machine
   * stall detection. Computed purely from gossiped state, no LLM routing.
   */
  getStalled(): RemoteAgentHealth[] {
    return this.getAll().filter(
      (a) => a.state === 'stalled' || a.state === 'dead',
    );
  }

  /**
   * Drop remote agents we have not heard about for `maxAgeMs` — their origin
   * LMD has likely gone away. Returns the ids that were evicted.
   */
  evictStale(maxAgeMs: number): string[] {
    const now = Date.now();
    const evicted: string[] = [];
    for (const [id, rec] of this.agents) {
      const age = now - new Date(rec.receivedAt).getTime();
      if (age > maxAgeMs) {
        this.agents.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }
}

// ---------------------------------------------------------------------------
// Gossip ring
// ---------------------------------------------------------------------------

/** Options for {@link GossipRing}. */
export interface GossipRingOptions {
  /** Workspace root — used to derive the default filesystem gossip dir. */
  workspaceRoot: string;
  /**
   * Identifier of this machine / LMD. Beats carry it as `origin`; peers use it
   * to attribute health. Defaults to the OS hostname.
   */
  origin?: string;
  /**
   * Supplies the local LMD's current health snapshot. Called on every publish
   * tick. Typically `() => heartbeatReader.getHealthGrid()`.
   */
  localHealth: () => AgentHealth[];
  /**
   * Optional NATS transport options. When provided the ring attempts NATS
   * first and falls back to the filesystem transport if NATS is unavailable.
   * When omitted the filesystem transport is used directly.
   */
  nats?: NatsGossipOptions;
  /** Override the filesystem gossip directory. */
  gossipDir?: string;
  /** How often (ms) to broadcast the local health snapshot. Default 15000. */
  publishIntervalMs?: number;
  /**
   * Drop remote agents not heard from within this many ms. Default 180000
   * (3 min).
   */
  remoteEvictMs?: number;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Cross-machine LMD gossip ring.
 *
 * Events (via {@link GossipRing.events}):
 *   `peer_health`   — a {@link RemoteAgentHealth} whenever a peer beat merges.
 *   `remote_stall`  — a {@link RemoteAgentHealth} when a peer agent is first
 *                     observed `stalled`/`dead` (cross-machine stall alert).
 */
export class GossipRing {
  readonly events = new EventEmitter();
  readonly tracker = new RemoteHealthTracker();

  private readonly origin: string;
  private readonly localHealth: () => AgentHealth[];
  private readonly publishIntervalMs: number;
  private readonly remoteEvictMs: number;
  private readonly logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  private readonly natsOpts?: NatsGossipOptions;
  private readonly fsTransport: FilesystemGossipTransport;

  /** The transport actually in use after `start()` resolves. */
  private transport: GossipTransport;
  private natsTransport: NatsGossipTransport | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  /** Remote agents already alerted as stalled, so we alert only once. */
  private readonly alertedStalls: Set<string> = new Set();

  constructor(opts: GossipRingOptions) {
    this.origin = opts.origin ?? safeHostname();
    this.localHealth = opts.localHealth;
    this.publishIntervalMs = opts.publishIntervalMs ?? 15_000;
    this.remoteEvictMs = opts.remoteEvictMs ?? 180_000;
    this.logger = opts.logger ?? console;
    this.natsOpts = opts.nats;

    const gossipDir =
      opts.gossipDir ??
      path.join(
        opts.workspaceRoot,
        '.autoclaw', 'orchestrator', 'comms', 'gossip',
      );
    this.fsTransport = new FilesystemGossipTransport({
      gossipDir,
      logger: this.logger,
    });
    this.fsTransport.setSelfOrigin(this.origin);
    // Default until start() decides between NATS and filesystem.
    this.transport = this.fsTransport;
  }

  /** Which transport name is active (`"nats"` or `"filesystem"`). */
  get transportName(): string {
    return this.transport.name;
  }

  /**
   * Start the ring: pick a transport, subscribe for peer beats, and begin
   * broadcasting the local health snapshot. Idempotent.
   *
   * Transport selection: if NATS options were supplied, NATS is attempted
   * first; whenever it is unavailable (package missing or server unreachable)
   * the ring transparently falls back to the filesystem transport.
   */
  async start(): Promise<void> {
    if (this.started) { return; }
    this.started = true;

    // ---- Transport selection: NATS first, filesystem fallback -------------
    let chosen: GossipTransport = this.fsTransport;
    if (this.natsOpts) {
      this.natsTransport = new NatsGossipTransport({
        ...this.natsOpts,
        logger: this.logger,
      });
      const ok = await this.natsTransport.connect();
      if (ok && this.natsTransport.available) {
        chosen = this.natsTransport;
        this.logger.info('LMD gossip: using NATS transport.');
      } else {
        this.logger.info(
          'LMD gossip: NATS unavailable — falling back to filesystem ring.',
        );
      }
    }
    this.transport = chosen;
    await this.transport.connect();

    // ---- Subscribe for peer beats -----------------------------------------
    this.unsubscribe = this.transport.subscribe((beat) => {
      this._onPeerBeat(beat);
    });

    // ---- Begin broadcasting local health ----------------------------------
    void this._publishOnce();
    this.publishTimer = setInterval(() => {
      void this._publishOnce();
    }, this.publishIntervalMs);
  }

  /** Stop the ring and release all resources. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) { return; }
    this.started = false;
    if (this.publishTimer !== null) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    await this.fsTransport.close();
    if (this.natsTransport) { await this.natsTransport.close(); }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Broadcast the current local health snapshot, one beat per agent. */
  private async _publishOnce(): Promise<void> {
    let snapshot: AgentHealth[];
    try {
      snapshot = this.localHealth();
    } catch (err) {
      this.logger.warn(`LMD gossip: localHealth() threw: ${String(err)}`);
      return;
    }
    const emittedAt = new Date().toISOString();
    for (const a of snapshot) {
      const beat: GossipBeat = {
        agentId: a.agentId,
        state: a.state,
        lastHeartbeatAt: a.lastHeartbeatAt,
        missedHeartbeats: a.missedHeartbeats,
        origin: this.origin,
        emittedAt,
      };
      try {
        await this.transport.publish(beat);
      } catch (err) {
        this.logger.warn(`LMD gossip: publish failed: ${String(err)}`);
      }
    }
    // Opportunistically evict remote agents whose origin LMD has gone quiet.
    const evicted = this.tracker.evictStale(this.remoteEvictMs);
    for (const id of evicted) { this.alertedStalls.delete(id); }
  }

  /** Merge an incoming peer beat and run cross-machine stall detection. */
  private _onPeerBeat(beat: GossipBeat): void {
    const merged = this.tracker.merge(beat);
    if (!merged) { return; } // stale / out-of-order beat

    this.events.emit('peer_health', merged);

    const isStall = merged.state === 'stalled' || merged.state === 'dead';
    if (isStall && !this.alertedStalls.has(merged.agentId)) {
      this.alertedStalls.add(merged.agentId);
      this.logger.warn(
        `LMD gossip: cross-machine stall — agent "${merged.agentId}" is ` +
          `${merged.state} on "${merged.origin}".`,
      );
      this.events.emit('remote_stall', merged);
    } else if (!isStall) {
      // Recovered — allow a future stall to alert again.
      this.alertedStalls.delete(merged.agentId);
    }
  }
}

/** OS hostname, or a stable fallback when `os.hostname()` is unavailable. */
function safeHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os');
    return os.hostname() || 'lmd-unknown-host';
  } catch {
    return 'lmd-unknown-host';
  }
}
