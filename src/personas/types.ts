/**
 * Specialized agent persona — type contract.
 *
 * Implements the `PersonaProfile` shape from
 * `docs/rfc/specialized-agents.md` §2. Types only; no runtime logic.
 *
 * A persona is a long-lived role (architect, security-auditor,
 * doc-writer, …) the orchestrator can instantiate per project. Personas
 * accumulate bi-temporal memory across sessions under
 * `.autoclaw/memory/personas/<id>/` (project-scoped) and
 * `~/.autoclaw/personas/<id>/` (cross-project, privacy-gated).
 *
 * Defaults baked from v3.1 user directives (2026-05-23):
 *   - preferredProvider defaults to "ollama:llama3.1:70b" (local-first).
 *   - cloudFallback = the workspace's configured runner.
 *   - memoryShape = "sharded-per-persona" (MEMORY.md becomes an index).
 *
 * @see docs/rfc/specialized-agents.md
 * @see docs/rfc/llm-provider-abstraction.md
 * @see docs/V3_1_ROADMAP.md
 */

import type { TrustPreset } from '../runners/types';

/** Stable persona id, lowercase-hyphen, e.g. `"architect"`, `"security-auditor"`. */
export type PersonaId = string;

/**
 * Provider identifier of the shape `<provider-id>:<model-id?>`.
 * Examples: `"ollama:llama3.1:70b"`, `"lmstudio:qwen2.5-coder"`,
 * `"zippymesh:auto"`, `"claude-code-runner"` (delegates to whichever
 * cloud agent CLI is invoking the persona).
 */
export type ProviderRef = string;

/**
 * Persona profile loaded from `skills/<persona>/SKILL.md` frontmatter
 * + the persona's seeded memory.
 */
export interface PersonaProfile {
  /** Stable id; matches the directory under `skills/`. */
  id: PersonaId;
  /** Human-readable name for fleet view / status bar. */
  displayName: string;
  /**
   * One-paragraph mission. Loaded into the persona's system prompt at
   * dispatch. Edit `SKILL.md`'s `## Mission` section to change this.
   */
  mission: string;
  /**
   * Strings the orchestrator matches against to auto-invoke the persona
   * (slash command tail, manifest brief keywords, etc.).
   */
  triggers: string[];
  /**
   * Tool categories the persona may invoke. Translated per-runner by
   * `translateTrust()` (see runners/registry.ts).
   */
  toolAllowList?: string[];
  /** Tool categories denied; takes precedence over the allow list. */
  toolDenyList?: string[];
  /** Trust preset applied at dispatch (off | auto | turbo). */
  trust: TrustPreset;
  /**
   * Preferred LLM provider. Resolved by the registry from
   * `docs/rfc/llm-provider-abstraction.md`. Defaults to local-first per
   * v3.1 directive.
   */
  preferredProvider: ProviderRef;
  /** Fallback provider when the preferred one is unreachable. */
  providerFallback?: ProviderRef;
  /** Files/directories the persona MUST load before producing output. */
  requiredInputs: string[];
  /** Output artifacts the persona is allowed (and only allowed) to produce. */
  outputArtifacts: string[];
  /**
   * Acceptance criteria a Verifier persona checks against. Each item is
   * a Given/When/Then triple.
   */
  successCriteria: { given: string; when: string; then: string }[];
  /**
   * "What good looks like" exemplars — paths to prior accepted outputs
   * the persona should mimic in style + structure.
   */
  exemplars: string[];
  /** Where this persona's project-scoped memory lives. */
  memoryRoot: string; // ".autoclaw/memory/personas/<id>/"
  /** Where this persona's cross-project (global) memory lives. */
  globalMemoryRoot: string; // "~/.autoclaw/personas/<id>/"
}

/**
 * A single bi-temporal "lesson" learned by a persona — promoted from
 * `lessons.md` into the fact store after `/dream`.
 *
 * Wire-compatible with `BitemporalFact` from `src/memory/`; this is a
 * persona-namespaced view.
 */
export interface PersonaLesson {
  /** `persona.<id>.lesson.<slug>` — the bi-temporal fact subject. */
  subject: string;
  persona: PersonaId;
  /** The lesson itself, one sentence. */
  content: string;
  /** When the lesson became true (valid time). */
  valid_from: string;
  /** When the lesson was recorded in memory (transaction time). */
  recorded_at: string;
  /** Optional supersession chain. */
  superseded_by?: string;
  /** Sources the persona cites for this lesson. */
  citations: string[];
}

/**
 * Privacy classification for a persona memory entry. Controls promotion
 * from project-scoped to global memory (per v3.1 governance + survey
 * §4 don't-do #4).
 *
 * - `project` — never leaves `.autoclaw/memory/personas/<id>/`.
 * - `global-candidate` — eligible for promotion if it survives a
 *   subsequent project's review (default for new lessons; needs an
 *   architect-persona pass to promote).
 * - `global` — already promoted to `~/.autoclaw/personas/<id>/`.
 *
 * Items containing secrets, tokens, internal endpoints, or
 * customer/proprietary names MUST be `project` and never promoted.
 */
export type PersonaPrivacy = 'project' | 'global-candidate' | 'global';

/** Memory record with privacy gating. */
export interface PersonaMemoryEntry extends PersonaLesson {
  privacy: PersonaPrivacy;
}

/**
 * The default provider chain applied to every new persona unless its
 * `SKILL.md` overrides it. Local-first per the 2026-05-23 directive.
 */
export const DEFAULT_PROVIDER_CHAIN: { preferred: ProviderRef; fallback: ProviderRef } = {
  preferred: 'ollama:llama3.1:70b',
  fallback: 'claude-code-runner',
};
