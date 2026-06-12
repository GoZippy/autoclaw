---
spec_id: orchestrate-gates-and-routing
title: Evidence-grounded review gates + tier/phase-aware routing for orchestrate
status: pilot  # draft | review | pilot | implement | verify | done — step 1 (A) landed + verified
owner: claude-code
created: 2026-06-12
updated: 2026-06-12
supersedes: []
superseded_by: null
references:
  - ../research/2026-06-11-fable-5-agent-patterns.md
  - ../research/2026-06-11-loss-function-development.md
acceptance:
  - given: a task authored by agent A
    when: A submits an 'approved' vote alongside reviewers B and C
    then: A's vote is excluded from the consensus tally; consensus is computed over B,C only
  - given: a task with acceptance check `{command:"npm test", expect:"exit_zero"}`
    when: the command exits non-zero
    then: consensus returns final_verdict 'needs_changes' with a non-overridable critical finding, even if every human vote is 'approved'
  - given: a 'grade' phase task and two candidate agents (one advertising haiku-only, one advertising opus)
    when: scoreAgent runs with the phase set
    then: the cheap-tier agent is preferred for 'grade'; with phase unset OR llms_available absent, scores are byte-identical to today
non_goals:
  - The outer goal/outcome-metric loop and the 4-part loss-function harness (separate spec)
  - Per-task WORK-state checkpoint/resume (separate spec)
  - Fleet kill switch + runtime cycle-ceiling enforcement (separate spec)
---

# Evidence-grounded review gates + tier/phase-aware routing for orchestrate

## Summary

Three small, additive hardenings to `orchestrate` that convert its review gate
from *opinion* to *fenced evidence*, and its router from *cost-aware* to
*tier-and-phase-aware* — without changing behavior for any manifest/agent that
doesn't opt in. Each maps to a verified gap (see Read first) and a pattern from
the 2026-06-11 Fable-5 / loss-function research:

- **(A) Reviewer ≠ author** — exclude an author's self-vote from consensus
  (fresh-context verifier; Anthropic-measured to beat self-critique).
- **(B) Tier × phase routing** — let the existing scorer prefer the right model
  tier per phase (strong for plan/review, mid for execute, cheap for grade).
- **(C) Acceptance command gate** — run a declared checkable command and make a
  failure a non-overridable block, so a failing test can't be voted green
  ("a constraint without an instrument is a vibe").

All three are **opt-in and backward-compatible**: absent the new fields,
scoring and consensus are byte-identical to today.

## Read first

- `src/orchestrate.ts:38-57` — `ManifestTask` (where `acceptance` and `phase` attach)
- `src/orchestrate.ts:420-444` — `ScorableAgent` (no `llms_available` today)
- `src/orchestrate.ts:468-520` — `scoreAgent` (the formula to extend)
- `src/orchestrate.ts:1304-1392` — `ValidationVote` / `ConsensusConfig` / `consensusConfigForTask`
- `src/orchestrate.ts:1394-1525` — `evaluateConsensus` (never sees the author today)
- `src/agent-card.ts` + `docs/specs/agent-card-schema.md §2` — agents already advertise `x-autoclaw.llms_available`
- `skills/orchestrate/SKILL.md` (review step) — where the gate is rendered/run

## Design

### (A) Reviewer ≠ author

**Inputs.** The task's author/claimant agent id (available from the claim file
`comms/claims/<task-id>.json`), plus the existing `ValidationVote[]`.

**Contract.** Add an optional `author_agent_id` to the consensus evaluation
input and drop self-votes before tallying:

```ts
// new optional field on the round context passed to evaluateConsensus
export function evaluateConsensus(
  votes: ValidationVote[],
  round: number,
  config: ConsensusConfig = DEFAULT_CONSENSUS_CONFIG,
  ctx?: { author_agent_id?: string },   // NEW — optional, backward-compatible
): ConsensusResult
```

- When `ctx.author_agent_id` is set, votes where `vote.agent_id ===
  author_agent_id` are filtered out **before** the `min_voters`, veto,
  unanimous, and threshold checks. `min_voters` then counts independent voters.
- The excluded self-vote is preserved on the result (`ConsensusResult.votes`
  unchanged) but recorded as `excluded_self_review: string[]` for audit.
- **Enforced one layer up too:** the orchestrator's review-request step
  (`skills/orchestrate/SKILL.md`) must address `review_request` to agents other
  than the author, so an author can't be the only available reviewer.

**Backward-compat.** `ctx` omitted ⇒ no filtering ⇒ identical to today.

### (B) Tier × phase routing

**Inputs.** `ScorableAgent.llms_available?: string[]` (mirror the field agents
already advertise on the agent card) + a phase for the task.

**Contract.**

```ts
// add to ScorableAgent
llms_available?: string[];                 // e.g. ["claude-opus-4-8","claude-sonnet-4-6"]

// add to PlannedTask (or pass via scoreAgent context)
phase?: 'plan' | 'execute' | 'review' | 'grade';

// tier ranks (higher = stronger). Unknown models → 0 (neutral, never penalized).
const MODEL_TIER: Record<string, number> = {
  'claude-fable-5': 4, 'claude-opus-4-8': 3, 'claude-opus-4-7': 3,
  'claude-sonnet-4-6': 2, 'claude-haiku-4-5': 1,
};
// preferred tier band per phase
const PHASE_PREF: Record<NonNullable<PlannedTask['phase']>, number> = {
  plan: 3, review: 3, execute: 2, grade: 1,
};
```

`scoreAgent` gains a **soft** multiplier `tierFactor ∈ (0,1]`:

```
bestTier   = max(MODEL_TIER[m] for m in agent.llms_available, default 0)
tierFactor = (phase set AND agent has a known model)
             ? 1 - PENALTY * abs(bestTier - PHASE_PREF[phase]) / 3
             : 1.0
score      = capabilityMatch * trustScore * idleFactor * tierFactor / estimatedCost
```

with `PENALTY` defaulting to ~0.5 (tunable; never drives the factor to 0 — a
single-tier fleet still gets work). This mirrors how `agent_type` was added as a
non-lowering adjustment: **absent `phase` or `llms_available`, `tierFactor = 1.0`
and scoring is byte-identical.** Tier preference (right brain for the phase) and
`estimatedCost` (don't overspend) are orthogonal and both multiply in.

**Phase source.** Either an explicit `task.phase`, or derived from the sprint
role (a review/validation slot ⇒ `review`; a grader sub-agent ⇒ `grade`). Start
explicit; deriving from role is an open question.

### (C) Acceptance command gate

**Inputs.** A declared, manifest-level check list on the task:

```ts
export interface AcceptanceCheck {
  command: string;                 // e.g. "npm test", "go vet ./...", "ruff check"
  expect:                           // pass condition
    | 'exit_zero'
    | { exit_code: number }
    | { stdout_matches: string };   // regex
  timeout_seconds?: number;        // default from config; SIGKILL on overrun (cf. autobuild.ts)
}
// add to ManifestTask
acceptance?: AcceptanceCheck[];
```

**Contract.**

- At the REPORT/review step, the **orchestrator** (not the authoring agent) runs
  each `acceptance.command` in the task's checkout and records
  `{command, exit_code, passed, duration_ms}` into a new `gate_checks` field on
  `ConsensusResult`.
- A failing check is a **non-overridable precondition**: `evaluateConsensus`
  (or a thin wrapper around it) short-circuits to `final_verdict:
  'needs_changes'` (or `'blocked'` for `criticality: 1`) and injects a synthetic
  finding `{category:'test_gap', severity:'critical', description:"acceptance:
  <command> failed (exit N)"}`. **Votes cannot approve over a red check.**
- The check command set lives in the **manifest** — the fenced target. The
  authoring agent can't add a trivially-passing command at review time, and
  doesn't run the checks itself (reward-hacking fence from the LFD piece).

**Backward-compat.** `acceptance` omitted ⇒ gate is votes-only, exactly as
today.

### Outputs

- `ConsensusResult` gains `excluded_self_review?: string[]` (A) and
  `gate_checks?: Array<{command; exit_code; passed; duration_ms}>` (C).
- `ScorableAgent` gains `llms_available?` and `PlannedTask` gains `phase?` (B).
- No change to the comms tree, claim format, or message envelopes.

## Acceptance criteria

1. **Self-vote excluded (A).** Manifest task `T` authored by `A`. Votes:
   A=approved(0.9), B=approved(0.9), C=needs_changes(0.8), `min_voters:2`,
   threshold 0.66. With `author_agent_id:"A"`, the tally runs over {B,C} →
   approval rate 0.5 → `needs_changes`. Without the author ctx (today), {A,B,C}
   → 0.67 → `approved`. The behavioral difference proves the fence works.
2. **Red check blocks green votes (C).** Task with `acceptance:[{command:"npm
   test", expect:"exit_zero"}]`; command exits 1; all of A/B/C vote approved.
   Result: `final_verdict:'needs_changes'`, a critical `test_gap` finding,
   `gate_checks[0].passed === false`.
3. **Tier preference, opt-in only (B).** Two agents, equal capability/trust/idle:
   X advertises `["claude-haiku-4-5"]`, Y advertises `["claude-opus-4-8"]`.
   For `phase:'grade'`, `score(X) > score(Y)`; for `phase:'review'`, `score(Y) >
   score(X)`. With `phase` unset, `score(X) === score(Y)` (byte-identical to
   pre-change).
4. **Zero-config no-op.** A manifest with no `acceptance`, no `phase`, and agents
   with no `llms_available` produces identical sprint plans and identical
   `evaluateConsensus` results to the current build (golden-file test).

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | (A) `author_agent_id` filter in `evaluateConsensus` + `excluded_self_review` + unit tests | claude-code | ✅ **DONE 2026-06-12** — Acceptance #1 + #4 pass; +4 tests, 106 orchestrate tests green, typecheck clean |
| 2 | (A) live: call sites pass `author_agent_id` + review-request excludes author | claude-code | ✅ **DONE 2026-06-12** — `readClaimAuthor` in comms.ts; `bridge.ts`+`extension.ts` wired; `computeReviewers` (peerReview.ts) already excludes the author |
| 3 | (C) `AcceptanceCheck`/`GateCheckResult`, `runAcceptanceChecks`/`acceptanceMet`/`applyAcceptanceGate`, `gate_checks` | claude-code | ✅ **DONE 2026-06-12 (lib + live)** — review command loads gate fields via `readManifestTaskGates`, runs checks (cwd=workspace root), logs per-check, uses `consensusConfigForTask(criticality)`, applies the gate; `gate_checks` rides the `consensus_result` broadcast. Missing manifest/task ⇒ today's behavior. |
| 4 | (B) `MODEL_TIER`/`PHASE_PREF`/`tierFactor` in `scoreAgent` + `llms_available`/`phase` fields | claude-code | ✅ **DONE 2026-06-12 (lib + live)** — `AgentRegistryEntry.llms_available` threaded into `planSprints`' ScorableAgent mapping; assign command mirrors `llms_available` from the comms registry onto WA-N rows. +6 tests incl. grade-task→haiku-slot routing. 256 tests green. |
| 4b | Scoped manifest gate reader | claude-code | ✅ **DONE 2026-06-12** — `parseManifestGateFields`/`readManifestTaskGates` (orchestrate.ts): parses `id`/`criticality`/`phase`/`acceptance` only, validates, warns + drops invalid, never throws (no full YAML parser exists code-side; the skill constructs the Manifest). |
| 4c | **Follow-up:** bridge `/consensus/{tid}/evaluate` gating | claude-code | ⏳ **OPEN** — deliberately NOT wired: `BridgeConfig` lacks `workspaceRoot`, and running manifest-declared shell commands from a remote-triggered endpoint on a guessed root is unsafe. Add optional `workspaceRoot` to `BridgeConfig` (threaded from extension/CLI), then reuse the same helpers. |
| 5 | Docs: update `skills/orchestrate/SKILL.md` review step + manifest schema | claude-code | examples run clean |

## Non-goals

- The **outer goal/outcome loop** and the **4-part loss function** harness
  (target/constraints/instruments/forced-entropy) — covered by a future
  `orchestrate-goal-loop.spec.md`. This spec only adds the *instrument* half
  (the acceptance command) at the gate.
- **Work-state checkpoint/resume** for killed agents — future spec.
- **Fleet kill switch** + runtime enforcement of the `max_cycles` HALT ceiling —
  future spec (today it's documented in the protocol but not machine-enforced).
- **Budget instruments** (queryable token/$/time) — the `heartbeat-v2.md`
  fields exist but are unimplemented; tracked there, not here.

## Open questions

- (B) Derive `phase` from the sprint role automatically, or require it explicit
  on the task? Auto-derivation is lower-friction but couples the scorer to the
  planner's role taxonomy.
- (C) Where do acceptance commands execute — the orchestrator host, or the
  claiming agent's worktree via a trusted runner? The fence requires the author
  not to be the one reporting the result; pick the host that preserves that.
- (B) `PENALTY` weight and whether unknown models should be neutral (current
  proposal) or treated as mid-tier.

## Don't-do

- **Don't let the authoring agent run its own acceptance checks** — that removes
  the fence (the whole point of C). The orchestrator/runner reports the result.
- **Don't hard-zero a score on tier mismatch** — a single-tier fleet must still
  get work; `tierFactor` is a soft multiplier, never 0.
- **Don't block tasks that declare no `acceptance`** — opt-in only; silence ⇒
  votes-only, as today.
- **Don't widen the consensus contract for non-opt-in callers** — every new
  field is optional and defaulted so existing consumers and golden tests are
  unaffected.
