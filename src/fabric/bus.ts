/**
 * fabric.ts — Cross-agent message bus abstraction.
 *
 * Phase 2B of the Distributed Agent Fabric (see
 * `docs/DISTRIBUTED_AGENT_FABRIC.md` §3 Phase 2 and
 * `docs/specs/nats-topic-conventions.md`).
 *
 * `FabricBus` is a thin pluggable pub/sub layer that AutoClaw can use as a
 * fast-path notification channel. It does NOT replace the filesystem
 * mailbox — per the spec, FS remains the canonical durable record. The bus
 * is a fanout for ephemeral events and a future fast-path for durable
 * envelopes (callers always FS-write first, then publish to the bus).
 *
 * Three drivers:
 *   - `fs`   No-op pub/sub. comms.ts already writes to disk; the FS driver
 *            simply records stats and returns. publish/subscribe are
 *            silent — subscribers will not see published messages because
 *            FS-only deployments rely on inbox polling for delivery.
 *   - `ws`   Wraps the existing in-process `BridgeEventBus` from bridge.ts.
 *            publish() forwards to BridgeEventBus.publish(); subscribe()
 *            registers a handler. Useful for tests and SSE/WS push paths.
 *   - `nats` Lazy-loaded NATS client (the `nats` npm package). Listed under
 *            `optionalDependencies` in package.json so installs without it
 *            still succeed. If the package can't be loaded or the server
 *            can't be reached, this driver falls back gracefully to the
 *            `fs` no-op driver and emits a one-line warning.
 *
 * Important: this module MUST NOT import `vscode`. It is unit-tested in
 * plain Mocha. Anything VS Code-specific lives in extension.ts.
 */

import { BridgeEventBus } from '../bridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BusDriver = 'fs' | 'ws' | 'nats';

export interface FabricBus {
  readonly driver: BusDriver;
  publish(topic: string, data: unknown): Promise<void>;
  subscribe(
    topicPattern: string,
    handler: (topic: string, data: unknown) => void
  ): Promise<() => void>;
  close(): Promise<void>;
  stats(): { driver: BusDriver; subscribers: number; published: number };
}

/**
 * Optional override hook passed to {@link createFabricBus} for tests. When
 * provided, it replaces the dynamic `import('nats')` call so unit tests can
 * simulate "nats package missing" without touching the real module loader.
 * Internal — not part of the production contract.
 */
export type NatsImporter = () => Promise<unknown>;

export interface CreateFabricBusOptions {
  driver: BusDriver;
  /** Used by the `nats` driver. Defaults to `nats://127.0.0.1:4222`. */
  natsUrl?: string;
  /**
   * Test seam: if the `nats` driver is requested, this function is awaited
   * instead of the real `import('nats')`. A return value missing
   * `connect()` or a thrown error triggers the documented graceful fallback
   * to the `fs` driver. Production callers leave this unset.
   */
  _mockImport?: NatsImporter;
  /**
   * Optional pre-built `BridgeEventBus` used by the `ws` driver. When unset,
   * the driver creates its own bus. Production code passes the same bus
   * already shared with the HTTP bridge.
   */
  bus?: BridgeEventBus;
  /**
   * Optional logger; defaults to console. Tests pass a stub to assert on
   * warnings emitted on driver fallback.
   */
  logger?: { warn: (msg: string) => void };
}

// ---------------------------------------------------------------------------
// `fs` driver — no-op
// ---------------------------------------------------------------------------

class FsBus implements FabricBus {
  readonly driver: BusDriver = 'fs';
  private subscribers = 0;
  private published = 0;
  private closed = false;

  async publish(_topic: string, _data: unknown): Promise<void> {
    if (this.closed) { return; }
    // FS path delivers via comms.ts file IO, not via this bus.
    this.published++;
  }

  async subscribe(
    _pattern: string,
    _handler: (topic: string, data: unknown) => void
  ): Promise<() => void> {
    if (this.closed) { return () => { /* noop */ }; }
    this.subscribers++;
    let live = true;
    return () => {
      if (!live) { return; }
      live = false;
      this.subscribers = Math.max(0, this.subscribers - 1);
    };
  }

  async close(): Promise<void> {
    // Idempotent: closing twice is a no-op.
    this.closed = true;
  }

  stats(): { driver: BusDriver; subscribers: number; published: number } {
    return { driver: this.driver, subscribers: this.subscribers, published: this.published };
  }
}

// ---------------------------------------------------------------------------
// `ws` driver — wraps BridgeEventBus
// ---------------------------------------------------------------------------

/**
 * The BridgeEventBus has a fixed event-type taxonomy
 * (`message | heartbeat | consensus`), so to support arbitrary topic strings
 * here we keep our own per-topic subscriber map and use BridgeEventBus only
 * as the in-process delivery backbone via a single sentinel event type.
 *
 * That sentinel ('message') is reused so that production paths which already
 * subscribe to BridgeEventBus 'message' events keep working. Each fabric
 * publish wraps the payload as `{ __ac_topic: <topic>, data: <data> }` so
 * fabric subscribers can demultiplex by topic without colliding with the
 * regular bridge `Message` envelopes.
 */
interface WsEnvelope {
  __ac_topic: string;
  data: unknown;
}

function isWsEnvelope(v: unknown): v is WsEnvelope {
  return !!v
    && typeof v === 'object'
    && '__ac_topic' in (v as Record<string, unknown>)
    && typeof (v as WsEnvelope).__ac_topic === 'string';
}

class WsBus implements FabricBus {
  readonly driver: BusDriver = 'ws';
  private subscribers = 0;
  private published = 0;
  private unsubs: Array<() => void> = [];
  private closed = false;

  constructor(private readonly bus: BridgeEventBus) { /* nothing to do */ }

  async publish(topic: string, data: unknown): Promise<void> {
    if (this.closed) { return; }
    const envelope: WsEnvelope = { __ac_topic: topic, data };
    // BridgeEventBus 'message' takes a Message; we cast through unknown
    // because the ws fabric repurposes the channel as a generic transport.
    this.bus.publish('message', envelope as unknown as never);
    this.published++;
  }

  async subscribe(
    pattern: string,
    handler: (topic: string, data: unknown) => void
  ): Promise<() => void> {
    if (this.closed) { return () => { /* noop */ }; }
    const matcher = compileTopicMatcher(pattern);
    const wrapped = (raw: unknown): void => {
      if (!isWsEnvelope(raw)) { return; }
      if (!matcher(raw.__ac_topic)) { return; }
      try { handler(raw.__ac_topic, raw.data); }
      catch (e) { console.error('FabricBus(ws) handler error:', e); }
    };
    const unsub = this.bus.subscribe('message', wrapped as unknown as Parameters<BridgeEventBus['subscribe']>[1]);
    this.subscribers++;
    let live = true;
    const wrappedUnsub = (): void => {
      if (!live) { return; }
      live = false;
      this.subscribers = Math.max(0, this.subscribers - 1);
      try { unsub(); } catch { /* ignore */ }
      this.unsubs = this.unsubs.filter(u => u !== wrappedUnsub);
    };
    this.unsubs.push(wrappedUnsub);
    return wrappedUnsub;
  }

  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    for (const u of this.unsubs.splice(0)) {
      try { u(); } catch { /* ignore */ }
    }
  }

  stats(): { driver: BusDriver; subscribers: number; published: number } {
    return { driver: this.driver, subscribers: this.subscribers, published: this.published };
  }
}

// ---------------------------------------------------------------------------
// `nats` driver — dynamically loaded
// ---------------------------------------------------------------------------

/** Minimal subset of the `nats` package surface we use. */
interface NatsConnectionLike {
  publish(subject: string, payload: Uint8Array): void;
  subscribe(subject: string, opts?: unknown): NatsSubscriptionLike;
  close(): Promise<void>;
  /** The real `nats` lib exposes a closed promise that resolves on disconnect. */
  closed?(): Promise<void | Error>;
}

interface NatsSubscriptionLike {
  unsubscribe(): void;
  /** AsyncIterable<NatsMsg> */
  [Symbol.asyncIterator](): AsyncIterator<NatsMessageLike>;
}

interface NatsMessageLike {
  subject: string;
  data: Uint8Array;
}

interface NatsModuleLike {
  connect(opts: { servers: string | string[] }): Promise<NatsConnectionLike>;
}

class NatsBus implements FabricBus {
  readonly driver: BusDriver = 'nats';
  private subscribers = 0;
  private published = 0;
  private subs: NatsSubscriptionLike[] = [];
  private closed = false;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private readonly nc: NatsConnectionLike) { /* nothing to do */ }

  async publish(topic: string, data: unknown): Promise<void> {
    if (this.closed) { return; }
    const payload = this.encoder.encode(JSON.stringify(data ?? null));
    this.nc.publish(topic, payload);
    this.published++;
  }

  async subscribe(
    pattern: string,
    handler: (topic: string, data: unknown) => void
  ): Promise<() => void> {
    if (this.closed) { return () => { /* noop */ }; }
    const sub = this.nc.subscribe(pattern);
    this.subs.push(sub);
    this.subscribers++;
    // Drain the async iterator in the background; one consumer per sub.
    (async () => {
      try {
        for await (const m of sub) {
          let data: unknown = null;
          try { data = JSON.parse(this.decoder.decode(m.data)); } catch { data = null; }
          try { handler(m.subject, data); }
          catch (e) { console.error('FabricBus(nats) handler error:', e); }
        }
      } catch { /* unsubscribed or connection closed */ }
    })();
    let live = true;
    return () => {
      if (!live) { return; }
      live = false;
      this.subscribers = Math.max(0, this.subscribers - 1);
      try { sub.unsubscribe(); } catch { /* ignore */ }
      this.subs = this.subs.filter(s => s !== sub);
    };
  }

  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    for (const s of this.subs.splice(0)) {
      try { s.unsubscribe(); } catch { /* ignore */ }
    }
    try { await this.nc.close(); } catch { /* ignore */ }
  }

  stats(): { driver: BusDriver; subscribers: number; published: number } {
    return { driver: this.driver, subscribers: this.subscribers, published: this.published };
  }
}

// ---------------------------------------------------------------------------
// Topic matcher (used by ws driver and any future driver that needs
// client-side filtering)
// ---------------------------------------------------------------------------

/**
 * Compile a NATS-style topic pattern into a predicate. Supported wildcards:
 *   - `*` matches a single token (no dots).
 *   - `>` (terminal only) matches one or more tokens.
 *
 * Spec reference: docs/specs/nats-topic-conventions.md §2.
 */
export function compileTopicMatcher(pattern: string): (topic: string) => boolean {
  if (pattern === '>' || pattern === '*') {
    if (pattern === '>') { return () => true; }
    return (topic: string) => topic.length > 0 && !topic.includes('.');
  }
  const tokens = pattern.split('.');
  const reSrc = tokens.map((t, i) => {
    if (t === '*') { return '[^.]+'; }
    if (t === '>' && i === tokens.length - 1) { return '.+'; }
    return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('\\.');
  const re = new RegExp('^' + reSrc + '$');
  return (topic: string) => re.test(topic);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link FabricBus} for the given driver. See the module header for
 * driver semantics. Never throws on a missing optional `nats` dependency —
 * that case logs a warning and returns the `fs` driver.
 */
export async function createFabricBus(opts: CreateFabricBusOptions): Promise<FabricBus> {
  const logger = opts.logger ?? console;

  if (opts.driver === 'fs') {
    return new FsBus();
  }

  if (opts.driver === 'ws') {
    const bus = opts.bus ?? new BridgeEventBus();
    return new WsBus(bus);
  }

  // driver === 'nats'
  // The cast to `string` defeats tsc's static module resolution so this file
  // compiles cleanly when the optional `nats` package is not installed.
  const importer: NatsImporter = opts._mockImport ?? (() => import('nats' as string));
  let mod: unknown;
  try {
    mod = await importer();
  } catch (e) {
    logger.warn(`FabricBus: nats package not available (${(e as Error).message}); falling back to fs driver`);
    return new FsBus();
  }
  if (!mod || typeof (mod as NatsModuleLike).connect !== 'function') {
    logger.warn('FabricBus: nats package returned no connect() entry point; falling back to fs driver');
    return new FsBus();
  }

  const url = opts.natsUrl ?? 'nats://127.0.0.1:4222';
  try {
    const nc = await (mod as NatsModuleLike).connect({ servers: url });
    return new NatsBus(nc);
  } catch (e) {
    logger.warn(`FabricBus: could not connect to NATS at ${url} (${(e as Error).message}); falling back to fs driver`);
    return new FsBus();
  }
}
