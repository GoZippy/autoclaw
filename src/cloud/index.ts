/**
 * index.ts — Public API surface for the AutoClaw cloud relay (Workstream D).
 *
 * The cloud relay is an OPT-IN, Pro-tier preview. Local stays first-class.
 * Nothing in this module transmits until the user (a) runs `cloud login`
 * (`auth.ts`) AND (b) configures a non-empty relay endpoint with `enabled:
 * true` in `.autoclaw/cloud/relay-config.json` (`relay.ts`). With either
 * missing, every relay call is a safe no-op.
 *
 * Sprint 4 — D1/D2 (WA-4).
 */

// Auth (D1)
export {
  cloudLogin,
  cloudLogout,
  rotateToken,
  getCloudToken,
  isTokenExpired,
  resolveInstallationId,
  resolveSecretStore,
  redactToken,
} from './auth';
export type {
  CloudTokenRecord,
  SecretStore,
  CloudLoginOptions,
  CloudLoginResult,
} from './auth';

// Relay (D2)
export {
  CloudRelay,
  CLOUD_HEARTBEAT_INTERVAL_MS,
  defaultRelayConfig,
  readRelayConfig,
  writeRelayConfig,
  relayIsActive,
  endpointIsSecure,
  cloudDir,
  queueDepth,
  encryptPayload,
  decryptPayload,
} from './relay';
export type {
  RelayConfig,
  RelayHeartbeat,
  RelayInboxMessage,
  RelaySendResult,
  RelayFetchResult,
  EncryptedEnvelope,
  CloudRelayOptions,
} from './relay';

// Live forwarding (RELAY-WIRE / AF-7) + cross-machine pull (AF-7b/AF-10c)
export {
  gatherHeartbeatsForRelay, forwardHeartbeats, gatherInboxForRelay, forwardInbox,
  applyFetchedToInboxes, type FetchedMessage,
  applyFetchedHeartbeats, readRemoteHeartbeats, fetchAndCacheHeartbeats, type RemoteFleetHeartbeat,
} from './forwarding';
export type { FleetHeartbeatRow, RelayHeartbeatFetchResult } from './relay';
