/**
 * src/personas/ — Specialized agent personas runtime.
 *
 * Types-only barrel for now (Phase A scaffolding). The persona loader,
 * memory engine, and `/persona` slash command land in Phase A+C per
 * `docs/V3_1_ROADMAP.md`.
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
