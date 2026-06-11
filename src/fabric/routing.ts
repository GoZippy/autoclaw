/**
 * routing.ts — AF-3: route work + reviews by agent TYPE, not just capabilities.
 *
 * Extends the existing capability match (orchestrate.ts jaccard) with the
 * agent-type taxonomy: an agent's effective capability set is its declared
 * capabilities PLUS its type's tags, and a review request can demand a
 * specific KIND of agent (e.g. an auditor, whose verdict is unanimous).
 * Pure + `vscode`-free.
 */

import type { AgentType, ConsensusRule } from './agentTypes';
import { agentTypeProfile, consensusRuleForAgentType } from './agentTypes';

/** The minimal agent shape routing needs (a subset of `RegisteredAgent`). */
export interface RoutableAgent {
  id: string;
  agent_type?: AgentType;
  capabilities?: string[];
}

export interface AgentMatch {
  id: string;
  /** Jaccard overlap of the agent's effective tags with the required set, 0..1. */
  score: number;
  agent_type: AgentType;
}

function effectiveTags(agent: RoutableAgent): Set<string> {
  const type = agent.agent_type ?? 'coder';
  return new Set([...(agent.capabilities ?? []), ...agentTypeProfile(type).capabilityTags]);
}

/**
 * Rank agents for a required capability set. When `requiredType` is given, only
 * agents of that kind are considered. Highest jaccard score first; ties keep
 * input order (stable).
 */
export function rankAgentsForCapabilities(
  agents: readonly RoutableAgent[],
  requiredCapabilities: readonly string[],
  requiredType?: AgentType,
): AgentMatch[] {
  const req = new Set(requiredCapabilities);
  return agents
    .filter(a => !requiredType || (a.agent_type ?? 'coder') === requiredType)
    .map(a => {
      const tags = effectiveTags(a);
      const intersection = [...req].filter(t => tags.has(t)).length;
      const union = new Set([...req, ...tags]).size;
      const score = union === 0 ? 0 : intersection / union;
      return { id: a.id, score, agent_type: (a.agent_type ?? 'coder') as AgentType };
    })
    .sort((a, b) => b.score - a.score);
}

/** The agents eligible to review work of a required kind (e.g. auditors). */
export function selectReviewers(agents: readonly RoutableAgent[], requiredType: AgentType): RoutableAgent[] {
  return agents.filter(a => (a.agent_type ?? 'coder') === requiredType);
}

/** The consensus rule a review of this kind requires (auditor ⇒ unanimous). */
export function reviewConsensusRuleFor(requiredType: AgentType): ConsensusRule {
  return consensusRuleForAgentType(requiredType);
}
