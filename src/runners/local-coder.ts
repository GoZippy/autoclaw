/**
 * `LocalCoderRunner` — worked example of the RFC §4 "thin runner +
 * local LLM" pattern.
 *
 * A `LoopServiceAdapter` subclass that uses its injected `LlmProvider`
 * to ask for a numbered plan preamble before submitting the prompt to
 * its loop service. The plan goes onto the dispatch body as `preamble`;
 * the loop service is free to include it in its prompt, log it, or
 * ignore it.
 *
 * Demonstrates two things:
 *   1. A runner can be just AutoClaw's tool surface + a local Ollama
 *      model — no cloud-CLI runner needed.
 *   2. The optional `provider?` field on `LoopServiceConfig` is enough
 *      to add LLM-aware behavior without re-implementing the dispatch
 *      lifecycle.
 *
 * @see docs/rfc/llm-provider-abstraction.md §4
 * @see docs/specs/llm-provider-s3/spec.md
 */

import type { DispatchOptions } from './types';
import { LoopServiceAdapter, type LoopServiceConfig } from './loop-service-adapter';

/** How long to wait for the planning chat before falling through. */
const DEFAULT_PLAN_TIMEOUT_MS = 20_000;

export interface LocalCoderConfig extends LoopServiceConfig {
  /**
   * Override the planning system prompt. Default asks for 3-5 numbered
   * steps and nothing else.
   */
  planPrompt?: string;
  /** Override the plan-call timeout. Default 20 s. */
  planTimeoutMs?: number;
  /**
   * Set false to disable the plan-preamble behavior at the config
   * level. Default true (plan when a provider is present).
   */
  planEnabled?: boolean;
}

const DEFAULT_PLAN_PROMPT =
  'Break the user task into 3-5 numbered steps. Output the numbered list and nothing else.';

export class LocalCoderRunner extends LoopServiceAdapter {
  private readonly planPrompt: string;
  private readonly planTimeoutMs: number;
  private readonly planEnabled: boolean;

  constructor(config: LocalCoderConfig) {
    super(config);
    this.planPrompt = config.planPrompt ?? DEFAULT_PLAN_PROMPT;
    this.planTimeoutMs = config.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
    this.planEnabled = config.planEnabled !== false;
  }

  /**
   * Override the async-body hook to ask the provider for a plan, and
   * inject it as `preamble` when the call succeeds. All failure modes
   * (no provider, provider errors, plan timeout, empty response) fall
   * through to the base body — the dispatch never fails because
   * planning did.
   */
  protected override async augmentDispatchBody(
    body: Record<string, unknown>,
    opts: DispatchOptions,
  ): Promise<Record<string, unknown>> {
    if (!this.planEnabled || !this.provider) return body;
    try {
      const plan = await this.provider.chat({
        messages: [
          { role: 'system', content: this.planPrompt },
          { role: 'user', content: opts.prompt },
        ],
        hints: { intent: 'plan', requireLocality: 'local' },
        timeoutMs: this.planTimeoutMs,
        sessionId: opts.sessionId,
      });
      if (plan.ok && typeof plan.response === 'string' && plan.response.length > 0) {
        return { ...body, preamble: plan.response };
      }
    } catch {
      // Plan failure is non-fatal. Fall through to the base body.
    }
    return body;
  }
}
