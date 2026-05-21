/**
 * natsGossip.ts — NATS transport for the LMD gossip ring (E4).
 *
 * The LMD gossip ring (see `gossip.ts`) broadcasts per-agent health beats so
 * multiple machines share one health picture. This module provides the NATS
 * transport: health beats are published to / subscribed from the subject
 * `ac.hb.<agent>`.
 *
 * ── IMPORTANT: `nats` is NOT a hard dependency. ────────────────────────────
 *   `nats` appears only in `optionalDependencies` of package.json. This module
 *   MUST NOT `import 'nats'` at module scope, or a workspace without the
 *   package installed would fail to load the LMD entirely.
 *
 *   Instead this file:
 *     • defines a thin, typed {@link GossipTransport} interface,
 *     • implements {@link NatsGossipTransport} which lazily `require()`s
 *       `nats` only inside `connect()`,
 *     • reports `available === false` (so `gossip.ts` falls back to the
 *       filesystem ring) whenever the package or server is unreachable.
 *
 *   The actual NATS wire protocol calls are stubbed behind a `// TODO(nats)`
 *   so a follow-up sprint can complete them once `nats` is a real dependency.
 *
 * Pure transport plumbing. *** NO LLM CALLS. ***
 *
 * E4 — Sprint-3 / WA-4 (LMD gossip).
 */

import type { HealthState } from './types';

// ---------------------------------------------------------------------------
// Wire model — what a single gossip beat carries
// ---------------------------------------------------------------------------

/**
 * One health beat broadcast on the gossip ring. Deliberately tiny: enough for
 * remote LMDs to merge a peer agent into their local tracker without any LLM
 * routing.
 */
export interface GossipBeat {
  /** The agent this beat describes. */
  agentId: string;
  /** The agent's health state as seen by the originating LMD. */
  state: HealthState;
  /** ISO timestamp of the agent's most recent local heartbeat. */
  lastHeartbeatAt: string;
  /** Consecutive missed beats seen by the originating LMD. */
  missedHeartbeats: number;
  /** Identifier of the machine/LMD that produced this beat. */
  origin: string;
  /** ISO timestamp at which this beat was emitted. */
  emittedAt: string;
}

/** The NATS subject prefix for health beats. Full subject: `ac.hb.<agent>`. */
export const HB_SUBJECT_PREFIX = 'ac.hb.';

/** Build the NATS subject for a given agent's health beats. */
export function hbSubject(agentId: string): string {
  return HB_SUBJECT_PREFIX + agentId;
}

/** Wildcard subscription subject covering every agent's health beats. */
export const HB_SUBJECT_WILDCARD = HB_SUBJECT_PREFIX + '*';

// ---------------------------------------------------------------------------
// Transport interface — gossip.ts depends only on this
// ---------------------------------------------------------------------------

/**
 * A thin, typed transport the gossip ring publishes beats to and subscribes
 * for peer beats from. The filesystem ring and the NATS ring both satisfy it,
 * so `gossip.ts` is transport-agnostic.
 */
export interface GossipTransport {
  /** Human-readable transport name (`"nats"`, `"filesystem"`). */
  readonly name: string;
  /**
   * True once the transport is connected and usable. When false, `gossip.ts`
   * falls back to (or stays on) the filesystem ring.
   */
  readonly available: boolean;
  /** Establish the transport. Resolves to `available`. Never throws. */
  connect(): Promise<boolean>;
  /** Publish one health beat. No-op when `available` is false. */
  publish(beat: GossipBeat): Promise<void>;
  /**
   * Register a handler for incoming peer beats. The returned function
   * unsubscribes. No-op (returns a no-op unsubscribe) when unavailable.
   */
  subscribe(onBeat: (beat: GossipBeat) => void): () => void;
  /** Tear down the transport. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// NATS transport implementation
// ---------------------------------------------------------------------------

/** Options for {@link NatsGossipTransport}. */
export interface NatsGossipOptions {
  /** NATS server URL. Defaults to `nats://127.0.0.1:4222`. */
  servers?: string;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /** Connection timeout in ms. Defaults to 2000. */
  connectTimeoutMs?: number;
}

/**
 * NATS-backed {@link GossipTransport}.
 *
 * `connect()` lazily `require()`s the optional `nats` package. If the package
 * is absent, or the server is unreachable, `available` stays `false` and the
 * gossip ring transparently falls back to the filesystem transport.
 */
export class NatsGossipTransport implements GossipTransport {
  readonly name = 'nats';

  private readonly servers: string;
  private readonly logger: { info: (m: string) => void; warn: (m: string) => void };
  private readonly connectTimeoutMs: number;

  private _available = false;
  // The live NATS connection — `unknown` because `nats` types are not
  // importable at module scope (optional dependency).
  private _connection: unknown = null;
  // Registered local subscribers, kept so we can fan out incoming beats.
  private readonly _handlers: Set<(beat: GossipBeat) => void> = new Set();

  constructor(opts: NatsGossipOptions = {}) {
    this.servers = opts.servers ?? 'nats://127.0.0.1:4222';
    this.logger = opts.logger ?? console;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 2000;
  }

  get available(): boolean {
    return this._available;
  }

  /**
   * Attempt to connect to NATS. Returns `available`. Never throws — any
   * failure (missing package, unreachable server) resolves to `false` so the
   * caller can fall back to the filesystem ring.
   */
  async connect(): Promise<boolean> {
    let nats: unknown;
    try {
      // Lazy require — `nats` is an optionalDependency. A module-scope
      // `import` would break the LMD on workspaces without the package.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nats = require('nats');
    } catch {
      this.logger.warn(
        'LMD gossip: "nats" package not installed — using filesystem ring.',
      );
      this._available = false;
      return false;
    }

    // TODO(nats): complete the real connection + subscription wiring once
    // `nats` is promoted from optionalDependencies to a hard dependency.
    // The intended implementation:
    //
    //   const { connect, StringCodec } = nats as typeof import('nats');
    //   this._connection = await connect({
    //     servers: this.servers,
    //     timeout: this.connectTimeoutMs,
    //   });
    //   const sc = StringCodec();
    //   const sub = this._connection.subscribe(HB_SUBJECT_WILDCARD);
    //   (async () => {
    //     for await (const msg of sub) {
    //       try {
    //         const beat = JSON.parse(sc.decode(msg.data)) as GossipBeat;
    //         for (const h of this._handlers) { h(beat); }
    //       } catch { /* ignore malformed beat */ }
    //     }
    //   })();
    //
    // Until that lands, we treat NATS as unavailable so the filesystem ring
    // is always used. The lazy-require above still proves the package can be
    // resolved when present, which is the seam follow-up work builds on.
    void nats;
    this.logger.info(
      'LMD gossip: NATS transport is stubbed (TODO(nats)) — using filesystem ring.',
    );
    this._available = false;
    return false;
  }

  /** Publish a beat to `ac.hb.<agent>`. No-op while unavailable. */
  async publish(beat: GossipBeat): Promise<void> {
    if (!this._available || this._connection === null) {
      return; // filesystem ring handles delivery instead
    }
    // TODO(nats): publish the encoded beat:
    //   const { StringCodec } = require('nats');
    //   const sc = StringCodec();
    //   (this._connection as import('nats').NatsConnection)
    //     .publish(hbSubject(beat.agentId), sc.encode(JSON.stringify(beat)));
    void beat;
  }

  /**
   * Register a handler for incoming peer beats. Returns an unsubscribe fn.
   * While the transport is unavailable this still records the handler so it
   * activates automatically if a real connection is established later.
   */
  subscribe(onBeat: (beat: GossipBeat) => void): () => void {
    this._handlers.add(onBeat);
    return () => {
      this._handlers.delete(onBeat);
    };
  }

  /** Close the NATS connection. Idempotent. */
  async close(): Promise<void> {
    this._handlers.clear();
    if (this._connection !== null) {
      // TODO(nats): await (this._connection as import('nats').NatsConnection).drain();
      this._connection = null;
    }
    this._available = false;
  }
}

/**
 * Convenience factory: build a NATS transport and attempt to connect. The
 * returned transport always reports `available` honestly, so the gossip ring
 * can decide whether to use it.
 */
export async function createNatsTransport(
  opts: NatsGossipOptions = {},
): Promise<NatsGossipTransport> {
  const transport = new NatsGossipTransport(opts);
  await transport.connect();
  return transport;
}
