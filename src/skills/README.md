# `src/skills/` — Skill logic modules (Sprint 3, Workstream C)

This directory holds the **pure TypeScript logic** behind AutoClaw's v3.0
skills. The user-facing skill *packages* (the `SKILL.md` files plus their
generated host adapters) still live under the top-level `skills/` directory —
they are intentionally **not** touched by Sprint 3 WA-1.

## What's here

| Module | Task | Role |
|---|---|---|
| `dream/pipeline.ts` | C2 | The `/dream` consolidation pipeline as independently-testable pure stages: extract → dedupe → conflict-resolve → drift-check → spider → pre-summarize, plus the opt-in micro-PR selector. |
| `recall/query.ts` | C3/C4 | The `/recall` retrieval layer — token-overlap text recall scoped by memory tier, plus bi-temporal time-travel queries (`recallAsOf`, `recallTimeline`, `recallChain`). |
| `index.ts` | — | Barrel export. |

The memory primitives these depend on live in `src/memory/`
(`bitemporalFact.ts`, `tiers.ts`).

## C1 — Skill split & rename (DEFERRED, intentionally)

V3_PLAN.md §1 renames the skills to short verbs and splits the monolithic
`kdream` skill:

| Old | New | Role |
|---|---|---|
| `kdream dream` | **`/dream`** | Asleep-side consolidation cycle |
| _(new)_ | **`/recall`** | Awake-side memory retrieval, incl. time-travel queries |
| `kdream work` | **`/work`** | Autonomous pickup of a single TODO / follow-up |
| `kdream todo` | **`/todo`** | Workspace TODO / `AI:` spider + classification |
| `kdream add` | **`/note "<x>"`** | Quick capture; `/dream` later promotes to facts |
| `autobuild` | **`/build`** | Scheduled workflows (behaviour unchanged) |
| `mateam` | **`/team`** | Multi-role dispatch (behaviour unchanged) |
| `orchestrate` | **`/sprint`** | DAG-based parallel planning (behaviour unchanged) |

### Why C1 is not done in this PR

Restructuring `skills/kdream/SKILL.md` into five separate skill packages and
**regenerating every host adapter** (`npm run adapters:check` / the
`adapters/` tree across 8+ hosts) is a drift-prone step that mixes
mechanical regeneration with human review. Doing it inside this scoped
WA-1 slice would:

- collide with the `skills.test.ts` gate, which currently asserts on
  `skills/kdream/SKILL.md` and `skills/mateam/SKILL.md` wording;
- produce a large generated-file diff that obscures the C2/C3/C4 logic;
- require regenerating adapters, which the WA-1 brief explicitly excludes.

### TODO — follow-up for a human / a dedicated C1 pass

- [ ] **C1.1** Split `skills/kdream/SKILL.md` into `skills/dream/SKILL.md`,
      `skills/recall/SKILL.md`, `skills/work/SKILL.md`,
      `skills/todo/SKILL.md`, `skills/note/SKILL.md`. Each new skill should
      delegate its logic to the modules in this directory.
- [ ] **C1.2** Rename `skills/autobuild` → `/build`, `skills/mateam` →
      `/team`, `skills/orchestrate` → `/sprint` (behaviour unchanged).
- [ ] **C1.3** Keep `kdream` (and the other old verbs) as **deprecated
      aliases** for one minor release — emit a one-line deprecation notice
      *once per workspace per session* (V3_PLAN.md §8 Q2).
- [ ] **C1.4** Run `npm run adapters:check` to regenerate every host adapter
      from the new `SKILL.md` files; the existing CI gate guards drift.
- [ ] **C1.5** Update `skills.test.ts` (a *new* test file — do not edit the
      existing one) to assert dispatch wording in the new split skills.
- [ ] **C1.6** Doctor: add a "v3.0 migration" section surfacing stale
      `.autoclaw/kdream/` paths and remaining aliases.
