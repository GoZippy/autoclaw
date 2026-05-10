/**
 * agent-card.ts — A2A Agent Card builder for AutoClaw (Phase 1).
 *
 * Spec sources:
 *   - docs/specs/agent-card-schema.md (AutoClaw mapping, including the
 *     `capabilities.extensions[]` mirroring rule)
 *   - A2A v0.2.5 specification
 *     (https://github.com/a2aproject/A2A/tree/v0.2.5)
 *
 * The function input is the AutoClaw side's view (machine info, llms,
 * capabilities, etc.) per `docs/specs/agent-card-schema.md`. The output
 * conforms to the A2A v0.2.5 AgentCard shape (we use the canonical field
 * names: `protocolVersion`, `url`, `defaultInputModes`, `defaultOutputModes`,
 * etc.).
 *
 * IMPORTANT — `x-autoclaw.*` mirroring:
 * The canonical A2A extension surface is `capabilities.extensions[]` keyed
 * by URI (per A2A v0.2.5 §5.5.2.1), NOT arbitrary `x-` prefixed top-level
 * keys. {@link buildAgentCard} therefore mirrors every populated
 * `x-autoclaw.*` field into a single
 *   `capabilities.extensions[{ uri, required: false, description, params }]`
 * entry so strict A2A consumers see the canonical form. The top-level
 * `x-autoclaw` block is also kept for backwards compatibility with existing
 * AutoClaw tooling — this is transitional and may be dropped in a future
 * phase once all known consumers read the canonical extension.
 *
 * This module MUST NOT import `vscode` — it is unit-tested in plain Mocha.
 */

import type { CapabilityTag, CostBudget, ToolTag, TrustLevel } from './comms';

// ---------------------------------------------------------------------------
// AutoClaw extension URI
// ---------------------------------------------------------------------------

/** Canonical URI used to key the AutoClaw extension entry inside
 *  `capabilities.extensions[]`. */
export const AUTOCLAW_EXTENSION_URI =
  'https://github.com/GoZippy/autoclaw/extensions/v1';

/** Pinned A2A protocol version for Phase 1. */
export const A2A_PROTOCOL_VERSION = '0.2.5';

// ---------------------------------------------------------------------------
// AutoClaw extension fields (the `x-autoclaw` block)
// ---------------------------------------------------------------------------

/** AutoClaw-side view of the agent. Only `machine_id` is required; every
 *  other field is optional and only emitted when populated. */
export interface AutoClawExtensionFields {
  machine_id: string;
  /** PII-bearing — only included in authenticated extended cards. */
  machine_ip?: string;
  llms_available?: string[];
  context_window?: number;
  tools_supported?: ToolTag[];
  trust_level?: TrustLevel;
  cost_budget?: CostBudget;
  max_parallel_tasks?: number;
  skills_loaded?: string[];
  human_in_loop_required?: boolean;
  capabilities?: CapabilityTag[];
}

// ---------------------------------------------------------------------------
// A2A v0.2.5 AgentCard shape (subset we emit)
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentExtension {
  uri: string;
  required: boolean;
  description?: string;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  /** A2A v0.2.5 §5.5.2.1 — the canonical extension array. */
  extensions: AgentExtension[];
}

/**
 * A2A v0.2.5 AgentCard subset emitted by AutoClaw. Field names match the
 * canonical spec (verified against A2A v0.2.5 specification §5.5).
 *
 * The `endpoints` field in the prompt aligns with what we render: a small
 * object with at least an `http` URL. We expose both the legacy A2A `url`
 * (canonical for v0.2.5) AND an `endpoints` shape so AutoClaw tooling that
 * inspects `endpoints.http` keeps working as the spec evolves.
 */
export interface AgentCard {
  /** Canonical A2A field; pinned to `"0.2.5"` for Phase 1. */
  protocolVersion: string;
  name: string;
  description: string;
  /** Canonical A2A v0.2.5 base URL. */
  url: string;
  /** AutoClaw-side endpoint map; `http` mirrors `url`. */
  endpoints: { http: string; ws?: string; nats?: string };
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** AutoClaw-side aliases for callers that prefer the shorter names. */
  inputModes: string[];
  outputModes: string[];
  skills: AgentSkill[];
  supportsAuthenticatedExtendedCard?: boolean;
  /**
   * Transitional top-level mirror of {@link AutoClawExtensionFields}. The
   * canonical extension surface is `capabilities.extensions[].params` —
   * see the module header. New consumers should read the canonical form.
   */
  ['x-autoclaw']?: AutoClawExtensionFields;
}

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export interface BuildAgentCardOpts {
  /** Human-readable agent name. */
  name: string;
  /** One-paragraph capability summary. */
  description: string;
  /** Base URL for the agent's A2A service (e.g. bridge URL + `/a2a`). */
  url: string;
  /** Adapter / IDE version string. */
  version: string;
  /** Optional richer endpoint map. `http` defaults to `url`. */
  endpoints?: { http?: string; ws?: string; nats?: string };
  /** A2A capability flags. `extensions[]` is filled from `autoclaw`. */
  capabilities?: Omit<AgentCapabilities, 'extensions'> & { extensions?: AgentExtension[] };
  /** MIME types accepted. Defaults to `["text/plain", "application/json"]`. */
  inputModes?: string[];
  /** MIME types emitted. Defaults to `["text/plain", "application/json"]`. */
  outputModes?: string[];
  /** A2A skill descriptors. Defaults to `[]`. */
  skills?: AgentSkill[];
  /** When true, an authenticated `…/agent/authenticatedExtendedCard` returns
   *  a richer card (e.g. with `machine_ip`). Defaults to `false`. */
  supportsAuthenticatedExtendedCard?: boolean;
  /** AutoClaw extension fields. `machine_id` is required. */
  autoclaw: AutoClawExtensionFields;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical A2A v0.2.5 Agent Card from AutoClaw inputs.
 *
 * The returned card always:
 *   - Pins `protocolVersion` to `"0.2.5"`.
 *   - Carries an `endpoints.http` URL.
 *   - Carries a `capabilities.extensions[]` array containing exactly one
 *     entry whose `uri` is {@link AUTOCLAW_EXTENSION_URI}, mirroring the
 *     `x-autoclaw.*` fields into `params`.
 *   - Carries the legacy top-level `x-autoclaw` block too — see the module
 *     header for the deprecation rationale.
 */
export function buildAgentCard(opts: BuildAgentCardOpts): AgentCard {
  const inputModes = opts.inputModes ?? ['text/plain', 'application/json'];
  const outputModes = opts.outputModes ?? ['text/plain', 'application/json'];

  // Mirror x-autoclaw fields into capabilities.extensions[].params. We strip
  // undefined entries so consumers don't see noise from unset optional
  // fields.
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts.autoclaw)) {
    if (v !== undefined) { params[k] = v; }
  }

  const autoclawExt: AgentExtension = {
    uri: AUTOCLAW_EXTENSION_URI,
    required: false,
    description: 'AutoClaw extension fields',
    params,
  };

  // Caller-supplied extensions are preserved and the AutoClaw extension is
  // appended (or replaces a pre-existing entry with the same URI).
  const extraExtensions = (opts.capabilities?.extensions ?? [])
    .filter(e => e.uri !== AUTOCLAW_EXTENSION_URI);
  const extensions: AgentExtension[] = [...extraExtensions, autoclawExt];

  const capabilities: AgentCapabilities = {
    streaming: opts.capabilities?.streaming,
    pushNotifications: opts.capabilities?.pushNotifications,
    stateTransitionHistory: opts.capabilities?.stateTransitionHistory,
    extensions,
  };

  const httpEndpoint = opts.endpoints?.http ?? opts.url;
  const endpoints: AgentCard['endpoints'] = { http: httpEndpoint };
  if (opts.endpoints?.ws !== undefined) { endpoints.ws = opts.endpoints.ws; }
  if (opts.endpoints?.nats !== undefined) { endpoints.nats = opts.endpoints.nats; }

  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: opts.name,
    description: opts.description,
    url: opts.url,
    endpoints,
    version: opts.version,
    capabilities,
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    inputModes,
    outputModes,
    skills: opts.skills ?? [],
    supportsAuthenticatedExtendedCard: opts.supportsAuthenticatedExtendedCard ?? false,
    'x-autoclaw': { ...opts.autoclaw },
  };

  return card;
}
