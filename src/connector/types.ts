/**
 * types.ts — AutoClaw Connector Protocol (acp/1) contract surface.
 *
 * Phase 0 of docs/ideas/STANDARDIZED-ADAPTER-A2A-PLATFORM.md: define the unified
 * connector contract so any external tool becomes a first-class citizen via ONE
 * signed manifest + ONE shared identity + up to three optional faces — runner
 * (act), source (ingest), presence (be visible) — without forking AutoClaw.
 *
 * The two heavy faces are the EXISTING contracts, unchanged (imported type-only
 * so this module stays runtime-decoupled): `Runner` (src/runners/types.ts) and
 * `SourceAdapter` (src/intelligence/types.ts). `PresenceProvider` is the only new
 * face and it is tiny. The host — never the connector — holds trust enforcement.
 *
 * This is the in-tree home of what will later be re-exported as the
 * `@autoclaw/connector-sdk` package; no behavior change ships with it.
 */

import type { Runner } from '../runners/types';
import type { SourceAdapter } from '../intelligence/types';
import type { Beacon } from '../fleet/beacons';

/** The protocol tag this host speaks. */
export const ACP_VERSION = 'acp/1' as const;

/**
 * The ABI baseline this host implements (the Runner/SourceAdapter contract
 * generation). Connectors declare an `abiRange`; the host refuses to load
 * outside it rather than crashing on a missing method. Kept as major.minor.
 */
export const HOST_ABI = '2.0' as const;

/** Which capability faces a connector provides. */
export type ConnectorFace = 'runner' | 'source' | 'presence';

/** Trust/risk tier: 1 native · 2 first-party · 3 third-party (most restricted). */
export type ConnectorTier = 1 | 2 | 3;

/** The only NEW face: a tiny presence provider that standardizes the beacon write. */
export interface PresenceProvider {
  /**
   * Build the beacon body; the host stamps `host = manifest.id`, fills
   * origin/workspace, and persists via writeBeacon() on the connector's behalf.
   */
  beacon(ctx: PresenceContext): Beacon | Promise<Beacon>;
  /** Host refresh cadence (ms). Default = BEACON_TTL_MS / 2 = 150s. */
  heartbeatIntervalMs?: number;
  /** Optional HTTP endpoint for runner-style remote agents → Beacon.endpoint. */
  endpoint?: string;
}

/** Context the host hands a PresenceProvider when refreshing its beacon. */
export interface PresenceContext {
  workspaceRoot: string;
  /** Resolved session id for this connector instance, if any. */
  sessionId?: string;
}

/** Declared, capability-bounded permissions (host-enforced at runtime, §3.3). */
export interface ConnectorPermissions {
  /** Globs a source connector may read (sandboxed to these). */
  reads?: string[];
  /** Network egress policy; default 'none'. */
  network?: 'none' | 'declared' | 'any';
  /** Whether a runner may write the workspace. */
  writesWorkspace?: boolean;
  /** Whether a runner spawns processes. */
  spawnsProcess?: boolean;
}

/** Provenance recorded (not merely trusted) for audit + revocation. */
export interface ConnectorProvenance {
  repo?: string;
  commit?: string;
  sbom?: string;
}

/** The signed `connector.json` manifest (validated fail-closed; see manifest.ts). */
export interface ConnectorManifest {
  /** Protocol tag the connector targets (host shelves a major it does not speak). */
  acp: string;
  /** THE shared identity — one string for the runner, source, and presence faces. */
  id: string;
  /** Primary kind, for the marketplace listing/badge. */
  kind?: ConnectorFace;
  displayName?: string;
  vendor?: string;
  /** The connector's own SemVer (independent of the ABI axis). */
  version?: string;
  tier: ConnectorTier;
  /** ABI compatibility range, e.g. ">=2.0 <3.0". */
  abiRange?: string;
  /** Which faces this connector implements. */
  provides: ConnectorFace[];
  homepage?: string;
  permissions?: ConnectorPermissions;
  provenance?: ConnectorProvenance;
  /** Detached signature over the canonicalized manifest + bundle hash. */
  signature?: string;
  /** Unknown future fields are preserved on round-trip (forward-compat). */
  [extra: string]: unknown;
}

/** A loaded connector: a manifest + only the faces it declares in `provides`. */
export interface Connector {
  manifest: ConnectorManifest;
  /** Present iff provides includes 'runner' → the EXISTING Runner contract. */
  runner?: Runner;
  /** Present iff provides includes 'source' → the EXISTING SourceAdapter. */
  source?: SourceAdapter;
  /** Present iff provides includes 'presence' → the only new face. */
  presence?: PresenceProvider;
}

/** Context passed to a connector factory at RESOLVE (no I/O at module load). */
export interface ConnectorContext {
  workspaceRoot: string;
  commsDir: string;
  beaconDir: string;
  /** Host extension version, for the connector to reason about. */
  hostVersion?: string;
  hostAbi: string;
}

/** A connector package default-exports a factory returning one Connector. */
export type ConnectorFactory = (ctx: ConnectorContext) => Connector | Promise<Connector>;
