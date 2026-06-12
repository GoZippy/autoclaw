/**
 * fabric/index.ts — the multi-platform agent fabric layer.
 *
 * Extends the Distributed Agent Fabric initiative
 * (docs/DISTRIBUTED_AGENT_FABRIC.md) with the agent-type taxonomy that lets the
 * orchestrator direct work + route reviews by what an agent *does*, across the
 * existing per-platform runners. See docs/rfc/agent-fabric-platforms.md.
 */

export * from './agentTypes';
export * from './onboarding';
export * from './routing';
export * from './governance';
// The cross-agent message bus (Phase 2B) — moved here from src/fabric.ts (AF-9)
// so `./fabric` is a single namespace (no more file-vs-dir collision).
export * from './bus';
