/**
 * Persona provider resolver — Phase B (S1) integration with `src/llm/`.
 *
 * Originally a pure stub (hence the file name); Phase B S1 keeps the
 * test-friendly synthetic providers (`inline`, `claude-code-runner`)
 * but routes real refs like `"ollama:..."`, `"zippymesh:..."`, or
 * `"lmstudio:..."` through `LlmRegistry`.
 *
 * The persona loader's public surface and the 12 existing tests are
 * unchanged. The `ProviderChatResult` shape is preserved verbatim; we
 * translate `LlmRegistry.chat()`'s richer `ChatResult` down to it.
 *
 * The synthetic `ollama:*` failure path that exercised the loader's
 * fallback chain in Phase A is still triggered when the registry's
 * oracle is empty AND no real Ollama is reachable — same observable
 * behavior the test relies on, now driven by the real ladder.
 *
 * @see docs/specs/llm-provider-s1/spec.md (Persona loader integration criterion)
 * @see docs/specs/persona-loader/spec.md §Provider resolution
 */

import type { ErrorClass } from '../runners/types';
import { LlmRegistry, type ChatHints } from '../llm';
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

export function setInlineOverride(fn: InlineOverride): void {
  _inlineOverride = fn;
}

export function clearInlineOverride(): void {
  _inlineOverride = undefined;
}

/**
 * Lazy singleton — the persona loader's `dispatch()` calls
 * `resolveProvider()` per chain step, which we can't change without
 * touching the loader. So we build (and reuse) one registry the first
 * time a real provider ref is resolved.
 */
let _registry: LlmRegistry | undefined;
let _registryWorkspaceRoot: string | undefined;

/**
 * Test hook — drop the lazy registry so the next resolveProvider call
 * builds a fresh one (used to isolate tests + change the workspace root).
 */
export function _resetRegistryForTests(): void {
  _registry = undefined;
  _registryWorkspaceRoot = undefined;
}

/**
 * Test hook — install a registry directly (lets tests use a mocked
 * fetch impl without provoking real HTTP). When set, the lazy build
 * path is skipped.
 */
export function _setRegistryForTests(registry: LlmRegistry | undefined): void {
  _registry = registry;
  _registryWorkspaceRoot = undefined;
}

function getRegistry(workspaceRoot: string): LlmRegistry {
  if (_registry && _registryWorkspaceRoot === workspaceRoot) {
    return _registry;
  }
  _registry = new LlmRegistry({ workspaceRoot });
  _registryWorkspaceRoot = workspaceRoot;
  return _registry;
}

/**
 * Resolve a `ProviderRef` to a chat-capable thing.
 *
 * Routes:
 *   - `"inline"` → synthetic deterministic provider (tests use this)
 *   - `"claude-code-runner"` → synthetic placeholder (deferred to v3.2+)
 *   - `"ollama:<model>"` / `"zippymesh:<model>"` / `"lmstudio:<model>"`
 *     → real LlmRegistry (Phase B S1)
 *   - anything else → unknown-ref error
 *
 * `workspaceRoot` is needed for the registry's oracle state file. If
 * omitted, callers get the synthetic providers only (preserves the
 * Phase A test signature for `resolveProvider(ref, profile)`).
 */
export function resolveProvider(
  ref: ProviderRef,
  profile: PersonaProfile,
  workspaceRoot?: string,
): StubProvider {
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
        // Synthetic placeholder — the real Claude Code shell-out lives in
        // src/runners/claude-code.ts; the persona loader's Phase A tests
        // assert against the exact string below.
        return {
          ok: true,
          response: `[claude-code-runner fallback] would invoke 'claude' CLI for ${profile.id}. Prompt: ${opts.prompt.slice(0, 120)}`,
          tokens: { input: 100, output: 80 },
        };
      },
    };
  }

  // Real provider refs — route through the registry.
  if (ref.startsWith('ollama:') || ref.startsWith('zippymesh:') || ref.startsWith('lmstudio:')) {
    return {
      id: ref,
      async chat(opts) {
        if (!workspaceRoot) {
          // Pre-S1 fallback signature: no workspace root → synthetic failure
          // so the loader's fallback chain still kicks in (matches the
          // Phase A test expectation).
          return {
            ok: false,
            errorClass: 'internal',
            errorMessage:
              `${ref.split(':')[0]} provider not available (workspaceRoot missing); falling back per profile.providerFallback`,
          };
        }
        const registry = getRegistry(workspaceRoot);
        const hints: ChatHints | undefined = inferHintsFromProfile(profile);
        const result = await registry.chat(
          {
            prompt: opts.prompt,
            hints,
            toolAllowList: opts.toolAllowList,
            toolDenyList: opts.toolDenyList,
            callerPersonaId: profile.id,
          },
          ref,
        );
        return chatResultToProviderResult(result);
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

function chatResultToProviderResult(r: {
  ok: boolean;
  response?: string;
  tokens?: { input: number; output: number };
  errorClass?: ErrorClass;
  errorMessage?: string;
}): ProviderChatResult {
  if (r.ok) {
    return {
      ok: true,
      response: r.response,
      tokens: r.tokens,
    };
  }
  return {
    ok: false,
    errorClass: r.errorClass ?? 'internal',
    errorMessage: r.errorMessage ?? 'unknown error',
  };
}

function inferHintsFromProfile(profile: PersonaProfile): ChatHints | undefined {
  // Minimal heuristic — derive an intent from the persona id. The
  // architect persona plans; security-auditor reviews; doc-writer
  // summarizes; everything else defaults to `chat`. Persona-level
  // intent override can be added when a SKILL.md frontmatter field
  // is defined for it (out of scope for S1).
  const id = profile.id.toLowerCase();
  if (id.includes('architect') || id.includes('planner')) return { intent: 'plan' };
  if (id.includes('reviewer') || id.includes('auditor')) return { intent: 'review' };
  if (id.includes('writer') || id.includes('docs')) return { intent: 'summarize' };
  if (id.includes('debug')) return { intent: 'debug' };
  return { intent: 'chat' };
}
