/**
 * src/personas/ — Specialized agent personas runtime.
 *
 * Phase A v3.1 — types + loader + minimal provider stub + VS Code
 * command registration. Phase B swaps the provider stub for the real
 * src/llm/ registry; the public surface here stays stable.
 */

export type {
  PersonaId,
  ProviderRef,
  PersonaProfile,
  PersonaLesson,
  PersonaPrivacy,
  PersonaMemoryEntry,
} from './types';

export { DEFAULT_PROVIDER_CHAIN } from './types';

export { parseFrontmatter } from './frontmatter';

export {
  PersonaLoader,
  buildProfile,
  type LoaderOptions,
  type DispatchOptions,
  type DispatchResult,
} from './loader';

export {
  resolveProvider,
  setInlineOverride,
  clearInlineOverride,
  type StubProvider,
  type ProviderChatOptions,
  type ProviderChatResult,
  type InlineOverride,
} from './provider-stub';

export { registerPersonaCommand } from './command';
