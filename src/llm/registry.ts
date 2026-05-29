/**
 * LlmRegistry — provider registry + getPreferred() routing algorithm.
 *
 * @see docs/rfc/llm-provider-abstraction.md §5
 * @see docs/specs/llm-provider-s1/spec.md (Registry section)
 *
 * Algorithm (3 branches):
 *   1. caller named a provider explicitly → return it.
 *   2. ZMLR healthy AND no fresh rate-limit on its previously-picked
 *      model → call `recommend_model`; return ZippyMeshProvider pinned
 *      to the result.
 *   3. otherwise → oracle.pick() → return the corresponding provider
 *      pinned to the oracle's recommendation. The oracle treats ZMLR
 *      as a rung (with its rate-limit posture honored) so a 429 on a
 *      ZMLR-routed backend may cause the ladder to land on Ollama or
 *      the failsafe instead.
 */

import type {
  ChatHints,
  ChatOptions,
  ChatResult,
  DetectionResult,
  LlmProvider,
  ModelId,
  OracleTask,
  ProviderId,
} from './types';
import { parseProviderRef } from './types';
import { ZippyMeshProvider } from './zippymesh';
import { OllamaProvider } from './ollama';
import { Oracle } from './oracle';

export interface RegistryOptions {
  workspaceRoot: string;
  /** Override providers (tests supply mock instances). */
  providers?: LlmProvider[];
  /** Override the oracle instance (tests supply mocks). */
  oracle?: Oracle;
}

export interface GetPreferredOptions {
  /** Provider id named by the caller, highest priority. */
  explicitProviderId?: ProviderId;
  /** Routing hints (intent, locality, parallel). */
  hints?: ChatHints;
  /** When caller knows the task class, the oracle uses it for scoring. */
  task?: OracleTask;
}

export interface PreferredPick {
  provider: LlmProvider;
  model: ModelId;
  /** True when the failsafe ladder rung served. */
  failsafe: boolean;
  /** Which algorithm branch produced this pick. */
  via: 'explicit' | 'zmlr-recommend' | 'oracle';
}

export class LlmRegistry {
  private readonly providers: Map<ProviderId, LlmProvider> = new Map();
  private readonly oracle: Oracle;
  private readonly workspaceRoot: string;
  /** Detection results from the last `detect()` call. */
  private detections: Map<ProviderId, DetectionResult> = new Map();

  constructor(opts: RegistryOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.oracle = opts.oracle ?? new Oracle({ workspaceRoot: opts.workspaceRoot });
    const providers = opts.providers ?? [new ZippyMeshProvider(), new OllamaProvider()];
    for (const p of providers) this.register(p);
  }

  register(p: LlmProvider): void {
    this.providers.set(p.id, p);
  }

  get(id: ProviderId): LlmProvider | undefined {
    return this.providers.get(id);
  }

  list(): LlmProvider[] {
    return [...this.providers.values()];
  }

  /** Run detect() on every registered provider; cache results. */
  async detect(): Promise<{ id: ProviderId; detection: DetectionResult }[]> {
    const out: { id: ProviderId; detection: DetectionResult }[] = [];
    for (const [id, p] of this.providers) {
      const d = await p.detect();
      this.detections.set(id, d);
      out.push({ id, detection: d });
    }
    return out;
  }

  /**
   * Resolve a ProviderRef like `"ollama:llama3.1:70b"` to a
   * (provider, model) pair. Returns undefined when the provider id is
   * unknown.
   */
  resolve(ref: string): { provider: LlmProvider; model: ModelId } | undefined {
    const parsed = parseProviderRef(ref);
    const provider = this.providers.get(parsed.providerId);
    if (!provider) return undefined;
    return {
      provider,
      model: parsed.model ?? provider.defaultModel ?? 'auto',
    };
  }

  /**
   * Pick a provider for the request per the three-branch algorithm.
   * Returns null only when the oracle finds nothing online — including
   * the failsafe — which means the persona loader should surface a
   * user-facing notice that no LLM is reachable.
   */
  async getPreferred(opts: GetPreferredOptions = {}): Promise<PreferredPick | null> {
    // Branch 1: explicit.
    if (opts.explicitProviderId) {
      const p = this.providers.get(opts.explicitProviderId);
      if (p) {
        return {
          provider: p,
          model: p.defaultModel ?? 'auto',
          failsafe: false,
          via: 'explicit',
        };
      }
    }

    // Branch 2: ZMLR-recommend.
    const zmlr = this.providers.get('zippymesh');
    if (zmlr && zmlr instanceof ZippyMeshProvider) {
      // Check ZMLR is reachable; cached if detect() ran recently.
      let det = this.detections.get('zippymesh');
      if (!det) {
        det = await zmlr.detect();
        this.detections.set('zippymesh', det);
      }
      if (det.found) {
        // Ask ZMLR for a routing decision. recommendModel returns null
        // in S1 (the ZMLR MCP HTTP route doesn't exist yet) — that's
        // the stopgap signal to fall through to the oracle.
        const intent = opts.hints?.intent ?? 'chat';
        const rec = await zmlr.recommendModel(intent, {
          preferLocal: opts.hints?.requireLocality === 'local',
        });
        if (rec) {
          // Only honor the recommendation if we don't have a fresh
          // rate-limit on this (endpoint, model) pair.
          if (!this.oracle.isRateLimited(rec.model, 'zmlr-local')) {
            return {
              provider: zmlr,
              model: rec.model,
              failsafe: false,
              via: 'zmlr-recommend',
            };
          }
        }
      }
    }

    // Branch 3: oracle.
    const task: OracleTask = opts.task ?? intentToTask(opts.hints?.intent);
    await this.oracle.refresh();
    const decision = this.oracle.pick(task, opts.hints);
    if (!decision.recommended) {
      return null;
    }
    const providerId = Oracle.endpointToProviderId(decision.recommended.endpointType);
    const provider = this.providers.get(providerId);
    if (!provider) {
      // Oracle picked a provider id we don't have an adapter for (e.g.
      // lmstudio in S1). Fall back to the next candidate that maps to
      // a known provider, if any.
      for (const alt of decision.alternatives) {
        const altId = Oracle.endpointToProviderId(alt.endpointType);
        const altProvider = this.providers.get(altId);
        if (altProvider) {
          return {
            provider: altProvider,
            model: alt.id,
            failsafe: !!decision.failsafe,
            via: 'oracle',
          };
        }
      }
      return null;
    }
    return {
      provider,
      model: decision.recommended.id,
      failsafe: !!decision.failsafe,
      via: 'oracle',
    };
  }

  /**
   * Execute a chat call with automatic 429 → rate-limit-record →
   * oracle-pick-next behavior. The persona loader uses this directly.
   */
  async chat(opts: ChatOptions, providerRef?: string): Promise<ChatResult> {
    let pick: PreferredPick | null;
    if (providerRef) {
      const resolved = this.resolve(providerRef);
      if (resolved) {
        pick = {
          provider: resolved.provider,
          model: opts.model ?? resolved.model,
          failsafe: false,
          via: 'explicit',
        };
      } else {
        pick = await this.getPreferred({ hints: opts.hints });
      }
    } else {
      pick = await this.getPreferred({ hints: opts.hints });
    }

    if (!pick) {
      return {
        ok: false,
        model: opts.model ?? 'unknown',
        servedBy: 'none',
        durationMs: 0,
        errorClass: 'internal',
        errorMessage: 'no LLM provider available (oracle exhausted incl. failsafe)',
      };
    }

    const result = await pick.provider.chat({ ...opts, model: opts.model ?? pick.model });

    // On 429, record the rate limit so subsequent calls skip this model.
    if (!result.ok && result.httpStatus === 429) {
      const endpointId = providerIdToEndpointId(pick.provider.id);
      const retryAfterSec = 60; // ChatResult doesn't carry retry-after; default 60s
      this.oracle.recordRateLimit(result.model, endpointId, retryAfterSec);
    }
    return result;
  }

  /** Expose the oracle so callers (persona loader) can record 429s themselves. */
  getOracle(): Oracle {
    return this.oracle;
  }
}

function intentToTask(intent?: ChatHints['intent']): OracleTask {
  switch (intent) {
    case 'code':
      return 'agent';
    case 'review':
      return 'thinking';
    case 'plan':
      return 'agent';
    case 'summarize':
      return 'fast';
    case 'debug':
      return 'thinking';
    case 'chat':
    default:
      return 'agent';
  }
}

function providerIdToEndpointId(providerId: ProviderId): string {
  if (providerId === 'zippymesh') return 'zmlr-local';
  if (providerId === 'ollama') return 'ollama-local';
  if (providerId === 'lmstudio') return 'lmstudio-local';
  return providerId;
}
