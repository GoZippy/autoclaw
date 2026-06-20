/**
 * agentCardPublisher.ts — write A2A Agent Cards to disk for the whole fleet.
 *
 * `agent-card.ts` builds an A2A v0.2.5 card in memory; the `autoclaw.agentCard.show`
 * command renders ONE for debugging. What was missing (DESIGN.md Gap D) is a
 * publisher that writes a discoverable `agent-card.json` per registered agent
 * (plus one for the orchestrator) and records each card's path back on the
 * registry entry (`agent_card_path`), so an A2A-aware peer can find the fleet.
 *
 * Pure + IO-injected (the file writer is a parameter) so it unit-tests without
 * touching a real disk or importing `vscode`.
 */

import type { AgentRegistry, RegisteredAgent } from '../comms';
import { buildAgentCard, type AgentCard } from '../agent-card';
import { agentTypeProfile } from './agentTypes';

/** A2A convention: the card lives at `<root>/.well-known/agent-card.json`. */
export const WELL_KNOWN_DIR = '.well-known';

/** AutoClaw's historical card filename (kept for back-compat). */
export const CARD_FILENAME = 'agent-card.json';

/**
 * A2A-canonical card filename. The spec's well-known path is
 * `/.well-known/agent.json`; strict-A2A peers fetch that exact name. We publish
 * it as an alias next to `agent-card.json` (acp/1 §2.1) so both resolve.
 */
export const A2A_CARD_FILENAME = 'agent.json';

export interface PublishOptions {
  /** The fleet registry to publish cards for. */
  registry: AgentRegistry;
  /** Base A2A URL (e.g. the bridge URL + `/a2a`). Per-agent paths append `/<id>`. */
  baseUrl: string;
  /** Card `version` string (adapter/IDE version). */
  version: string;
  /**
   * Writer seam: persists one card. `relPath` is relative to the comms root
   * (e.g. `.well-known/kiro/agent-card.json`). Injected for tests.
   */
  writeCard: (relPath: string, card: AgentCard) => Promise<void>;
}

export interface PublishedCard {
  agent_id: string;
  path: string;
  url: string;
}

export interface PublishReport {
  published: PublishedCard[];
  /** The registry with `agent_card_path` populated on each agent. */
  registry: AgentRegistry;
}

/** Map a RegisteredAgent's fields into the buildAgentCard `autoclaw` block. */
function autoclawFieldsFor(agent: RegisteredAgent): Parameters<typeof buildAgentCard>[0]['autoclaw'] {
  const fields: Parameters<typeof buildAgentCard>[0]['autoclaw'] = {
    machine_id: agent.machine_id ?? `local-${agent.id}`,
  };
  if (agent.llms_available) { fields.llms_available = agent.llms_available; }
  if (typeof agent.context_window === 'number') { fields.context_window = agent.context_window; }
  if (agent.tools_supported) { fields.tools_supported = agent.tools_supported; }
  if (agent.trust_level) { fields.trust_level = agent.trust_level; }
  if (agent.cost_budget) { fields.cost_budget = agent.cost_budget; }
  if (typeof agent.max_parallel_tasks === 'number') { fields.max_parallel_tasks = agent.max_parallel_tasks; }
  if (agent.skills_loaded) { fields.skills_loaded = agent.skills_loaded; }
  if (typeof agent.human_in_loop_required === 'boolean') { fields.human_in_loop_required = agent.human_in_loop_required; }
  if (agent.capabilities) { fields.capabilities = agent.capabilities; }
  return fields;
}

/**
 * Publish a card for every agent in the registry plus a fleet-orchestrator
 * card. Returns the written paths and a registry copy with `agent_card_path`
 * set on each entry (caller persists the registry). Idempotent: re-publishing
 * overwrites the existing card files.
 */
export async function publishAgentCards(opts: PublishOptions): Promise<PublishReport> {
  const published: PublishedCard[] = [];
  const agents: RegisteredAgent[] = [];

  for (const agent of opts.registry.agents) {
    const url = `${opts.baseUrl.replace(/\/$/, '')}/${agent.id}`;
    const relPath = `${WELL_KNOWN_DIR}/${agent.id}/${CARD_FILENAME}`;
    const type = agent.agent_type ?? 'coder';
    const card = buildAgentCard({
      name: agent.name,
      description: `${agent.name} — ${agentTypeProfile(type).description}`,
      url,
      version: opts.version,
      autoclaw: autoclawFieldsFor(agent),
    });
    await opts.writeCard(relPath, card);
    // A2A-canonical alias so strict peers resolve `/.well-known/agent.json`.
    await opts.writeCard(`${WELL_KNOWN_DIR}/${agent.id}/${A2A_CARD_FILENAME}`, card);
    published.push({ agent_id: agent.id, path: relPath, url });
    agents.push({ ...agent, agent_card_path: relPath });
  }

  // Fleet orchestrator card — the supervisor entry point a peer talks to.
  const orchUrl = `${opts.baseUrl.replace(/\/$/, '')}/orchestrator`;
  const orchRel = `${WELL_KNOWN_DIR}/orchestrator/${CARD_FILENAME}`;
  const orchCard = buildAgentCard({
    name: 'AutoClaw Orchestrator',
    description: 'Fleet orchestrator — routes capability-matched work, runs consensus gates, recovers stalled agents.',
    url: orchUrl,
    version: opts.version,
    capabilities: { streaming: true },
    autoclaw: {
      machine_id: 'orchestrator',
      capabilities: ['orchestrate', 'dispatch', 'aggregate', 'route'],
    },
  });
  await opts.writeCard(orchRel, orchCard);
  await opts.writeCard(`${WELL_KNOWN_DIR}/orchestrator/${A2A_CARD_FILENAME}`, orchCard);
  published.push({ agent_id: 'orchestrator', path: orchRel, url: orchUrl });

  return {
    published,
    registry: { ...opts.registry, agents, schema_version: '2' },
  };
}
