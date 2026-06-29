/**
 * modelNode.ts — Model/agent node executor for the WL-1 headless runner.
 *
 * A model node asks a ModelProvider for a completion. The provider is a SEAM:
 * the default is a deterministic, offline, zero-cost mock (see
 * `defaultMockModelProvider` in state.ts). Concrete providers (Ollama, LM
 * Studio, ZippyMesh, AutoClaw peer servers, premium cloud) are wired in WL-2
 * via RunnerDeps.modelProvider. The runner NEVER calls an external or paid
 * model on its own (WL-1 requirements 4 & 6).
 *
 * The node records a content-free decision summary (provider/model/locality/
 * selectionReason) and cost into the run event — never the prompt or response
 * text (privacy: prompts/responses must not land in cost-oriented ledgers).
 */

import type { NodeContext, NodeExecResult } from '../state';

export interface ModelNodeConfig {
  /** Intent tag for routing, e.g. 'code', 'debug', 'review'. */
  intent?: string;
  /** Routing profile: cheap | balanced | quality | local-only | air-gapped. */
  profile?: string;
  /** Prompt template; in this slice it is passed through verbatim to the seam. */
  prompt?: string;
  /** A mock response to short-circuit the provider (fixtures/tests). */
  mockResponseText?: string;
}

export async function runModelNode(ctx: NodeContext): Promise<NodeExecResult> {
  const cfg = (ctx.node.config ?? {}) as ModelNodeConfig;
  const iteration = ctx.iteration ?? 0;

  const resp = await ctx.deps.modelProvider.complete({
    intent: cfg.intent,
    profile: cfg.profile,
    prompt: cfg.prompt ?? cfg.mockResponseText ?? '',
    iteration,
  });

  const costCents = resp.tokens?.costCents ?? 0;

  return {
    status: 'completed',
    // Downstream nodes (a tool that applies a patch, a gate that checks it)
    // receive only the produced text and routing metadata — no secrets.
    output: {
      text: cfg.mockResponseText ?? resp.text,
      provider: resp.provider,
      model: resp.model,
      locality: resp.locality,
    },
    costCents,
    model: {
      provider: resp.provider,
      model: resp.model,
      locality: resp.locality,
      selectionReason: resp.selectionReason,
    },
    summary: `model node via ${resp.provider}/${resp.model} (${resp.locality})`,
  };
}
