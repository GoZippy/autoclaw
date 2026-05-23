/**
 * Minimal provider resolver — stand-in for the real LLM provider
 * registry (Phase B / `docs/rfc/llm-provider-abstraction.md`).
 *
 * The persona loader calls `resolveProvider(ref, profile)` and gets
 * back something it can `chat()` against. Today's stubs:
 *
 *   - `inline`             — deterministic synthetic answer; tests use this.
 *   - `claude-code-runner` — would shell out to the parent `claude` CLI;
 *                            stub returns a placeholder so end-to-end
 *                            flows are exercised before Phase B lands.
 *   - `ollama:*`           — intentionally returns `{ ok: false, errorClass: 'internal' }`
 *                            so the loader's fallback path is exercised.
 *
 * Phase B replaces this whole file with `src/llm/registry.ts` imports.
 * The loader's public surface does not change.
 *
 * @see docs/specs/persona-loader/spec.md §Provider resolution
 * @see docs/specs/llm-provider-s1/spec.md
 */

import type { ErrorClass } from '../runners/types';
import type { PersonaProfile, ProviderRef } from './types';

export interface ProviderChatOptions {
  prompt: string;
  toolAllowList?: string[];
  toolDenyList?: string[];
}

export interface ProviderChatResult {
  ok: boolean;
  response?: string;
  tokens?: { input: number; output: number };
  errorClass?: ErrorClass;
  errorMessage?: string;
}

export interface StubProvider {
  id: string;
  chat(opts: ProviderChatOptions): Promise<ProviderChatResult>;
}

/** Test hook — override the inline provider's behavior for a single test. */
export type InlineOverride = (opts: ProviderChatOptions, profile: PersonaProfile) => ProviderChatResult;

let _inlineOverride: InlineOverride | undefined;

/** Installed in tests via `setInlineOverride(...)`; cleared with `clearInlineOverride()`. */
export function setInlineOverride(fn: InlineOverride): void {
  _inlineOverride = fn;
}

export function clearInlineOverride(): void {
  _inlineOverride = undefined;
}

export function resolveProvider(ref: ProviderRef, profile: PersonaProfile): StubProvider {
  if (ref === 'inline') {
    return {
      id: 'inline',
      async chat(opts) {
        if (_inlineOverride) {
          return _inlineOverride(opts, profile);
        }
        // Convention: a prompt containing `[deny-test]` triggers the
        // tool_denied path so tests don't need a custom override for it.
        if (opts.prompt.includes('[deny-test]')) {
          return {
            ok: false,
            errorClass: 'tool_denied',
            errorMessage: `tool denied for persona ${profile.id} (test trigger)`,
          };
        }
        return {
          ok: true,
          response: `[inline stub] ${profile.displayName} would answer: ${opts.prompt.slice(0, 200)}`,
          tokens: { input: Math.max(1, Math.floor(opts.prompt.length / 4)), output: 50 },
        };
      },
    };
  }

  if (ref === 'claude-code-runner') {
    return {
      id: 'claude-code-runner',
      async chat(opts) {
        // Real impl shells to `claude --print --output-format stream-json`
        // (see src/runners/claude-code.ts); stub returns a deterministic
        // placeholder so fallback paths are exercised end-to-end.
        return {
          ok: true,
          response: `[claude-code-runner fallback] would invoke 'claude' CLI for ${profile.id}. Prompt: ${opts.prompt.slice(0, 120)}`,
          tokens: { input: 100, output: 80 },
        };
      },
    };
  }

  if (ref.startsWith('ollama:')) {
    return {
      id: ref,
      async chat(_opts) {
        return {
          ok: false,
          errorClass: 'internal',
          errorMessage:
            'Ollama provider not yet available (Phase B); falling back per profile.providerFallback',
        };
      },
    };
  }

  if (ref.startsWith('lmstudio:') || ref.startsWith('zippymesh:')) {
    return {
      id: ref,
      async chat(_opts) {
        return {
          ok: false,
          errorClass: 'internal',
          errorMessage: `${ref.split(':')[0]} provider not yet available (Phase B S2); falling back`,
        };
      },
    };
  }

  return {
    id: ref,
    async chat(_opts) {
      return {
        ok: false,
        errorClass: 'internal',
        errorMessage: `unknown provider ref: ${ref}`,
      };
    },
  };
}
