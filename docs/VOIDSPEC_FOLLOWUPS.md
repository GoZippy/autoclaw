# VoidSpec integration — tracked follow-ups

The VoidSpec sync core (`src/voidspec/{types,sync,dispatch}.ts` + the
`autoclaw.voidspec.sync` command) shipped in the v3 Sprint-3 mega-sprint.
These are the remaining, deliberately-deferred items. VoidSpec is a **separate
project** (github.com/GoZippy/VoidSpec); AutoClaw is the *consumer* of its
`tasks.yaml` specs, not a fork — keep them separate (per the cross-project
survey recommendation).

| # | Item | Status | Blocked on |
|---|------|--------|-----------|
| VF-1 | Replace hand-rolled `parseVoidSpecYaml` with a real YAML parser | open | — |
| VF-2 | Write the `tasks.yaml` contract doc | open | — |
| VF-3 | Implement the deferred `runner-voidspec` dispatch runner | blocked | VoidSpec exposing a programmatic API |

---

## VF-1 — Replace `parseVoidSpecYaml` with a real YAML parser
`src/voidspec/sync.ts:61` (`parseVoidSpecYaml` + `parseTaskEntry` /
`parseInlineList`) is a hand-rolled YAML subset — a deliberate MVP shortcut to
avoid a YAML dependency, but brittle for nested maps, quoted strings, and
multiline scalars.

**Done when:**
- [ ] `tasks.yaml` with nested maps / quoted / multiline fields parses correctly
- [ ] the `VoidSpecDocument` / `VoidSpecTask` output shape is unchanged (callers untouched)
- [ ] `src/test/voidspec.test.ts` stays green; add cases for the above
- [ ] no change to the sync conflict rule

## VF-2 — Write `docs/specs/voidspec-tasks-yaml.md`
The VoidSpec `tasks.yaml` format (stable `VS-<id>` IDs) is the canonical
"what to build" contract, but it lives only implicitly in `types.ts` + `sync.ts`.

**Done when:**
- [ ] the schema is documented field-by-field with an example `tasks.yaml`
- [ ] the bidirectional-sync conflict rule (**VoidSpec wins "what", AutoClaw wins "how far"**) and the status-synonym normalization (~12 synonyms) are written down
- [ ] `src/voidspec/types.ts` gets a cross-link comment to github.com/GoZippy/VoidSpec so the relationship survives author turnover

*(V3.1 quick-win #1.)*

## VF-3 — Implement the `runner-voidspec` dispatch runner
`src/voidspec/dispatch.ts:56` leaves a "runner-voidspec dispatch API seam".
AutoClaw can sync VoidSpec specs as tasks today, but cannot yet *drive*
VoidSpec agent services directly. Deferred pending VoidSpec exposing an API.

**Done when (once VoidSpec exposes a runner/REST API):**
- [ ] `runner-voidspec` registered in the runner registry
- [ ] round-trip: AutoClaw dispatches a VS task → VoidSpec executes → status syncs back
- [ ] tests against a mocked VoidSpec API

---

## Open coupling decision (carried from V3_PLAN §8.5)
Should AutoClaw *require* the `tasks.yaml` canonical refactor, or stay
back-compatible with `tasks.md`? **Recommendation: stay back-compat; ship
VoidSpec changes as a 3.x minor.**

## Related (separate tracking)
The cloud-relay GA security follow-ups (drop `session_id` from the heartbeat
wire; consent modal in `extension.ts`; Windows ACL on `credentials.enc`) are
tracked in the audit's Resolution section:
[reviews/cloud-relay-security-audit.md](../reviews/cloud-relay-security-audit.md).
