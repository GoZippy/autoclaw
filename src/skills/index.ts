/**
 * skills/index.ts — Barrel export for the AutoClaw skill logic modules.
 *
 * Sprint 3 Workstream C: the `/dream` consolidation pipeline (C2) and the
 * `/recall` retrieval layer (C3/C4). See docs/V3_PLAN.md §2 and §6.
 *
 * C1 (the `skills/*.md` split + adapter regen) is documented in README.md in
 * this directory and is intentionally not implemented here — see that file.
 */

export * as dreamPipeline from './dream/pipeline';
export * as recallQuery from './recall/query';
export { registerMemorySkills } from './dream/register';
export type { CommandRegistrar, MemorySkillRegistration } from './dream/register';
