/**
 * onboarding.ts — AF-4: make an existing platform runner a usable fabric worker.
 *
 * The per-platform runners already exist (`src/runners/`). Onboarding wires one
 * into the live fabric: detect it, health-check it, and register it in the
 * agent registry **with its agent type** so the orchestrator can direct work +
 * route reviews to it by kind. `vscode`-free + IO-injected so it unit-tests.
 *
 * Priority platforms: OpenClaw + Hermes (personal-assistant / service tier).
 */

import type { RegisteredAgent, AgentRegistry } from '../comms';
import type { AgentType } from './agentTypes';
import { defaultAgentTypeForRunner, agentTypeProfile } from './agentTypes';

/**
 * The minimal runner surface onboarding needs. A full `Runner`
 * (`src/runners/types.ts`) satisfies this structurally; tests can supply a
 * lightweight fake.
 */
export interface OnboardableRunner {
  id: string;
  detect(): Promise<{ found: boolean; reason?: string }>;
  health(): Promise<{ ok: boolean }>;
}

export interface OnboardReport {
  platform: string;
  detected: boolean;
  healthy: boolean;
  agent_type: AgentType;
  registered: boolean;
  detail: string;
}

export interface OnboardOptions {
  /** The platform runner to onboard (only detect/health/id are used). */
  runner: OnboardableRunner;
  /** Override the agent type; defaults to {@link defaultAgentTypeForRunner}. */
  agentType?: AgentType;
  /** Read the current agent registry (null when none yet). Injected for tests. */
  readRegistry: () => Promise<AgentRegistry | null>;
  /** Persist the agent registry. Injected for tests. */
  writeRegistry: (reg: AgentRegistry) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => Date;
}

/**
 * Onboard one platform. A not-detected platform is reported but NOT registered
 * (so the registry never advertises an absent worker). A detected-but-unhealthy
 * platform is still registered (it exists; health is transient) with the
 * failure noted. Idempotent: re-onboarding updates the existing entry in place.
 */
export async function onboardPlatform(opts: OnboardOptions): Promise<OnboardReport> {
  const now = opts.now ?? (() => new Date());
  const platform = opts.runner.id;
  const agent_type = opts.agentType ?? defaultAgentTypeForRunner(platform);

  const detection = await opts.runner.detect();
  if (!detection.found) {
    return {
      platform, detected: false, healthy: false, agent_type, registered: false,
      detail: `not detected${'reason' in detection && detection.reason ? `: ${detection.reason}` : ''}`,
    };
  }

  let healthy = false;
  try {
    const h = await opts.runner.health();
    healthy = h.ok === true;
  } catch {
    healthy = false;
  }

  const reg: AgentRegistry = (await opts.readRegistry()) ?? {
    agents: [], ide: 'fabric', provisioned_at: now().toISOString(), schema_version: '2',
  };
  const agents = Array.isArray(reg.agents) ? reg.agents.slice() : [];
  const idx = agents.findIndex(a => a.id === platform);
  const base: RegisteredAgent = idx >= 0 ? agents[idx] : {
    id: platform, name: platform, extension_id: platform, detected: true,
    inbox_path: '', hooks_supported: false, last_heartbeat: now().toISOString(), status: 'active',
  };
  const entry: RegisteredAgent = {
    ...base,
    detected: true,
    agent_type,
    can_orchestrate: agentTypeProfile(agent_type).canOrchestrate,
    last_detected_at: now().toISOString(),
  };
  if (idx >= 0) { agents[idx] = entry; } else { agents.push(entry); }
  await opts.writeRegistry({ ...reg, agents, schema_version: '2' });

  return {
    platform, detected: true, healthy, agent_type, registered: true,
    detail: `onboarded ${platform} as ${agent_type}${healthy ? '' : ' (detected; health check failed — will retry on heartbeat)'}`,
  };
}
