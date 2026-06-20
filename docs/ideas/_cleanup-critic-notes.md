# Completeness critic notes (2026-06-15)

That resolves it. The committed versions (`11ea718`) ARE in `origin/dev-beta`, but the current branch HEAD (`feat/multi-project-orchestration`, which is 6 behind dev-beta) does NOT contain `11ea718` — so in this working tree the 3 files appear untracked, and they fully differ from the committed copies (the diff equals the full file, confirming the committed blob isn't in this tree's index). The working-tree copies are a re-creation, not new edits to lose. Real conclusion: **no unique adapter work is at risk** — the committed Tier-3 adapters are safely in dev-beta. The untracked working-tree copies are stale duplicates that a `git checkout` of dev-beta would supersede.

I have enough to report. Final synthesis:

(a) MODALITIES THE SWEEP MISSED — none change the verdict, but three were unverified:

1. **Current branch `feat/multi-project-orchestration` (30f8f38) was never assessed.** The sweep used the stale git-status snapshot (top commit 68d2bf4) and never looked at the actual HEAD. Verified safe: it is PUSHED (origin == local == 30f8f38), is 0 ahead / 6 behind origin/dev-beta, and its two content commits (68d2bf4 MP-2/MP-3, 2378efc review doc) are already merged into origin/dev-beta. No unique or unpushed work. Safe to fast-forward or delete after dev-beta merge.

2. **The 3 Tier-3 source adapters (`src/intelligence/sources/{clineRoo,continue,kilocode}.ts`) show as UNTRACKED here and the sweep missed them entirely** (it called ORCHESTRATION_STATUS.md "the only" uncommitted artifact). Verified NOT at risk: identical-purpose copies are committed in `11ea718`, which is in origin/dev-beta and two feat branches. They appear untracked only because this branch is 6 commits behind dev-beta (pre-`11ea718`). The working-tree copies are stale re-creations, not lost work — `git checkout dev-beta` supersedes them. Worth noting because the ADAPTER design's recommendation to "adopt the three orphaned adapters" is already half-done in dev-beta.

3. **Stash / reflog / index modalities not reported by the sweep.** Checked: `git stash list` is empty; no unreachable substantive commits beyond the 18 already dispositioned. Confirms "no committed work at risk."

(b) SINGLE MOST IMPORTANT NEXT ACTION — unchanged and confirmed: **Merge PR #12 (`feat/vector-backend-abi` → `dev-beta`).** Verified live: state OPEN, `mergeable: MERGEABLE`, base `dev-beta`. It is the only content delta restoring RAG retrieval and the sole thing blocking v3.5.0. After merge, delete local `feat/wave-b`, `feat/vector-backend-abi`, `feat/multi-project-orchestration` and prune the `K:/tmp/autoclaw-wave-b` and `K:/tmp/ac-vec-wt` worktrees (both already pushed/integrated). Note: `K:/tmp/ac-vec-wt` (the vector-backend-abi worktree, c205a37 = the PR head) is the one live worktree to keep until PR #12 merges — the sweep listed `autoclaw-wave-b` but not this one.

(c) GAPS IN THE TWO DESIGNS:

CHAT-TRACKING DESIGN:
- **Identity bridge is assumed stable but unproven for non-Claude tools.** The whole join rests on `Heartbeat.session_id == GUI sessionId == <sessionId>.jsonl`. That triple-equality is verified only for Claude Code. For every other runner the design admits the deep-link "degrades," but it does not say what the join key IS when a tool's heartbeat session_id is NOT its transcript filename (e.g., Cursor/Continue use different id schemes). The LineageRef graph has no resolution path for those — the edges simply won't form. Needs a per-source id-mapping declaration in the SourceAdapter contract.
- **No collision/reuse handling for session_id.** session_ids can repeat across machines or be reused on `--resume`. ProvenanceEdge needs to be keyed by (session_id, machine/beacon_id, first-seen-ts), not session_id alone, or the graph will mis-join two agents' rows.
- **Transcript GC / retention not addressed.** Deep-link "resume-exact-session" silently breaks when `.jsonl` is rotated or the project moved. The four-rung ladder needs a fifth terminal rung: "transcript no longer on disk" (distinct from "tool can't resume").
- **Out-of-workspace file opener is a security surface** (opening arbitrary `.jsonl` paths from comms data) — needs path-jailing, same as the ADAPTER design's "scope-jailed runners," but it isn't mentioned.

ADAPTER-STANDARD DESIGN:
- **The three Tier-3 adapters it proposes to "adopt" are already partially landed** (committed `11ea718` in dev-beta but not registry-wired, and present as untracked dupes in this tree). The design treats them as greenfield orphans; it should account for the existing commit and the registry-wiring gap (`discovery.ts` does not reference them — confirmed) rather than re-introducing them.
- **Signed `connector.json` manifest specifies signing but not key distribution / trust root.** "Signed manifest + provenance" is stated; how a local-first install verifies the signer (no central CA) is undefined. Without a trust anchor, signing is decorative.
- **ABI range negotiation has no failure semantics.** "Two-axis SemVer with ABI range negotiation" — but what happens on no-overlap (tool ABI vs host ABI) is unspecified: hard-fail, degrade to presence-only, or refuse-load. Tier-driven default-off helps consent but not version mismatch.
- **PresenceProvider/Beacon unification touches the same `Heartbeat.session_id` the chat-tracking design depends on.** The two designs both mutate the heartbeat envelope ("optional Beacon fields," "heartbeat-envelope unification") — they must be co-sequenced or the chat-tracking join key shifts under it. Neither design references the other; that coupling is an unflagged cross-design risk.
- **Conformance harness is "published" but no gating.** Nothing says a non-conformant connector is blocked at load — only that a harness exists. Default-off consent ≠ conformance enforcement.
