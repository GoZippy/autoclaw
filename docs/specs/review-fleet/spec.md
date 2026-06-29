---
spec_id: review-fleet
title: AutoClaw Review Fleet — automated, learning, heterogeneous review/validation
status: draft
owner: claude-code (Phase-C coordinator)
created: 2026-06-28
updated: 2026-06-28
references:
  - ../ornith-scaffold-learning/spec.md       # the LEARNING BRAIN this rides on
  - ../recursive-workflow-lab/requirements.md  # Workflow Lab engine + gates + loops
  - ../app-completion-goal/GAP-ANALYSIS.md     # reputation/cost/kernel wiring already done
  - ../../rfc/runner-bridge-contract.md        # §5.5 dispatch — the standardized "spin up a session" command
non_goals:
  - Fine-tuning/RL-training a model (ornith's no-training rule holds)
  - Impersonating a human reviewer — automated verdicts are labeled as automated
  - Driving bridge-only hosts (Kilo/Cline) headlessly — they stay human-tapped/bridge-relayed
  - Replacing peer/human consensus — the Fleet PRODUCES votes; humans can still override
---

# Review Fleet

## One-line

The Review Fleet is the **execution/ops layer** that scans available agents +
models (local + remote), **spins up and keeps warm** the sessions a review needs,
dispatches review/validation work via the standardized runner contract, and feeds
verdicts back as votes + scores. **It does not decide *how* to review — the
ornith scaffold-learning loop does that** (which model/harness/panel/tier), and
the Fleet runs it on real heterogeneous capacity. Brain = ornith; body = Fleet.

## Why this shape (the key decision)

A "review" is a **scaffold** (`reviewer independence × tier × panel size × harness
× gates-first`). So review routing is scaffold *selection + scoring*, which ornith
already models. Building a separate static tiered router would fork the learning
substrate. Instead the Fleet is an ornith *consumer*, and we **unify**:

| Concern | Don't fork — reuse |
|---|---|
| Reward (verifier quality: false-accept/reject, override, cost) | ornith `ScaffoldScore` + reputation ledger + KG `reviewed` edges (already wired) |
| Anti-hacking boundary (no gaming the verdict) | ornith monitor + **Coordination Kernel** scope-enforced merge gate (already built) |
| Context (review *with memory*) | intelligence context pack (code RAG) + KG facts (already built) |
| Cost policy (local-first, escalate only when needed) | ornith `routerProfile` + `escalationPolicy.ts` (WL-2.4) — learned threshold |

## The review scaffold (an ornith `ScaffoldVariant` specialization)

```ts
interface ReviewScaffold /* extends ScaffoldVariant, taskIntent: 'review' */ {
  tier: 'tier1-local' | 'tier2-strong' | 'panel';
  // 4-way (codex): the reward LEARNS when cross-provider is worth the cost.
  reviewerIndependence: 'same-model' | 'different-model' | 'different-provider' | 'human';
  panelSize?: number;            // N independent reviewers (adversarial verify)
  gatesFirst: boolean;           // run deterministic gates before any model spend
  promptHarnessId?: string;      // route by model+harness (ornith harness contract)
  routerProfile: 'cheap' | 'local-only' | 'balanced' | 'quality' | 'release-critical';
}
```

Cold-start (P0) ships TWO hand-authored scaffolds; ornith learns better ones from scores:
- `quick-local-check` — tier1 local cheap model, gates-first, single reviewer.
- `cross-provider-final` — tier2, panel of N where verifier provider ≠ author provider,
  escalated only when tier1 flags OR the change is high-stakes (release/security/scope).

## Architecture (every box maps to an existing module)

```
SCAN ─▶ ROSTER ─▶ select review scaffold (ornith) ─▶ DISPATCH ─▶ VERDICT ─▶ VOTE ─▶ SCORE ─▶ feedback
```

| Stage | Reuses (built) | Gap to wire |
|---|---|---|
| **Scan** local agents | `RunnerRegistry.detect()` | — |
| **Scan** local models | LLM registry discovery + failsafe local model (BL-22) | wire failsafe so a tier1 checker always exists |
| **Scan** remote/joined | `fleet/beacons.ts`, `cloud/relay.ts`+`forwarding.ts`, `workspace-registry.ts` | merge into one roster |
| **Roster** (ranked capacity) | reputation/capabilityRouting + capabilityInventory | assemble `{host, agent|model, locality, costTier, health, rep}` |
| **Select scaffold** | ornith selection/score + `escalationPolicy.ts` + `intentRouter.ts` | ornith OSL-3 |
| **Dispatch (spin up)** | runner `dispatch({prompt,trust,workingDir})` (§5.5) for sessions; `llmRegistry.chat()` for local models; `agents/<id>/ready` flag + hooks `spawn_runner` to wake | the Fleet service loop |
| **Verdict → Vote** | `voteWriter.ts`, `peerReviewWatcher.ts`, `consensusTally.ts` | route automated verdict → vote (labeled automated) |
| **Score → feedback** | ornith `ScaffoldScore` + reputation ledger + KG edges | ornith OSL-2 |
| **Keep alive / refresh** | `src/keepalive/` (idleDetector, strategyChain, watcher), ready-flag | the Fleet keeps N strong validators warm |
| **Run as a service** | `src/daemon/watcher.ts`, orchestrator-loop | persistent, supervised, HALT+budget bounded |

## Tiered model policy (the cost saver — local-first, learned escalation)

1. **Tier-1 (free/fast):** route to the cheapest *healthy local* model — Ollama / LM
   Studio / ZippyMesh-routed / Kilo router / OpenRouter-small — via the LLM registry,
   with the failsafe guaranteeing one exists. Gates run first (zero model spend when a
   deterministic gate already decides).
2. **Tier-2 (strong, on escalation only):** Codex CLI (GPT-5.5+), Claude Code headless
   (Opus 4.8), or a LAN strong model — driven via the runner contract. Fires only when
   tier-1 flags, providers must differ from the author (cross-provider), or the change is
   high-stakes. The escalation threshold is a **learned** scaffold parameter, not a constant.

User-confirmed validators: Codex CLI (GPT-5.5+), Claude Code headless (Opus 4.8),
local strong (LAN), + small/fast on LM Studio / Ollama / ZippyMesh / Kilo router /
OpenRouter. Preference: **local for fast+free where model+runner fit.**

## Session lifecycle — spin up, keep alive, refresh

- **Standardized spin-up command already exists:** `registry.get(host).dispatch(prompt)`
  (each adapter translates to that tool's CLI/SDK). Wake via the `agents/<id>/ready` flag.
- **Keep warm:** the Fleet keeps a small pool of tier-2 validators alive (keepalive
  strategyChain + ready-flag re-dispatch) so escalations don't pay cold-start latency.
- **Runner vs bridge:** runner hosts (Claude Code, Cursor, Kiro, codex, Gemini) drive
  headlessly; bridge-only (Kilo, Cline) get a one-click human tap. Local models are
  stateless (no session to keep).

## Cross-device

A review can target a reviewer on a joined device: the relay forwards the request to
that machine's inbox/bridge; its AutoClaw spins the reviewer locally and relays the
verdict back. Local + trusted-LAN first; cross-machine *trust* wants the mesh mTLS/SVID
work (coordination-mesh T2) before un-trusted remote reviewers vote.

## Safety / consent / edition fit

- **Off by default. Consented.** It spawns processes and may call paid models, so it
  requires explicit enable + a budget cap (cost ledger, BL-6) + a HALT control.
- **Anti-hacking:** the Fleet runs reviewers under the ornith monitor + the Coordination
  Kernel scope gate — a reviewer can never edit the verdict store, hidden tests, or
  out-of-scope files; a violation → zero reward + finding + halt.
- **Automated ≠ human:** automated verdicts are labeled `reviewer: automated:<scaffold>`
  and never impersonate a human vote.
- **Edition fit:** free = "use your local Ollama as a checker + one validator"; Pro/Teams
  = "manage a review fleet across devices with policies, dashboards, and shared scores."

## Phases (RF-*; each rides the ornith milestones)

| Phase | Outcome | Depends on |
|---|---|---|
| **RF-0** | This spec + roster types + the two cold-start review scaffolds (no service) | ornith OSL-1 types |
| **RF-1** | Capability scan → ranked reviewer roster (local runners+models+remote beacons) | reuse detect/discovery/beacons |
| **RF-2** | Tiered review router: gates-first → tier1 local → escalate tier2 (cross-provider) | escalationPolicy + reputation |
| **RF-3** | Fleet service loop: watch review/consensus queue → dispatch reviewer → write vote → score | daemon/watcher + voteWriter + ornith OSL-2 |
| **RF-4** | Keepalive pool for tier-2 validators; ready-flag wake | keepalive |
| **RF-5** | Learned scaffold selection (ornith OSL-3 closes the loop) + KG-context reviews | ornith + intelligence |
| **RF-6** | Cross-device reviewers via relay (trusted-LAN); Pro/Teams dashboard | relay + mesh trust |

## Coordination with codex (ornith owner)

Codex owns ornith-scaffold-learning. The Fleet is the runtime that *executes* its
scaffolds. Proposed seam: codex builds OSL-1/2/3 (scaffold types, score, selection);
claude-code builds the Fleet roster + dispatch + service loop + keepalive, consuming
ornith's selector and emitting `ScaffoldScore` rows. Unify reward on the reputation/KG
substrate (already wired), and the anti-hacking boundary on the Coordination Kernel.
The user also wants the reviewer scaffold to be **KG/intelligence-context-aware** — that
is RF-5, fed by the context-pack + KG facts.

## Locked plan (codex-concurred, 2026-06-28)

**Contracts-first gate (codex's main caveat, and the WL-0/WL-1 collision lesson):**
the Fleet must NOT invent its own reward or routing schema. RF-2/RF-3 are *gated* on
the OSL contracts landing. RF-1 (capability scan + roster) is **contract-independent**
(it scans + ranks reviewers; it emits no `ScaffoldScore` and selects no
`ScaffoldVariant`) and may be built in parallel.

**Agreed build order:**
1. `OSL-1.1` (codex) — scaffold / review-scaffold / score / harness **types + store** (the contract).
2. `OSL-2.1` (codex) — score rows, **including false-accept / false-reject hooks**.
3. `RF-1` (claude-code) — capability scan → ranked reviewer roster. *(parallel-safe; starts now)*
4. `RF-2` (claude-code) — gates-first local checker → strong **cross-provider** escalation. *(gated on OSL-1.1)*
5. `RF-3` (claude-code) — service loop writing **labeled-automated** votes + `ScaffoldScore` rows. *(gated on OSL-2.1)*

**Validation gates (codex's additions — required before paid validators are enabled):**
- **KG/context ablation tests** — run the same review with vs without KG/context-pack
  facts; measure caught defects and false positives (proves context-awareness earns its cost).
- **Cheap-local triage benchmark** — Ollama / LM Studio / ZMLR-routed / Kilo router /
  OpenRouter-cheap on *seeded* review/security/schema tasks, to pick the default tier-1 checker.
- **Reward-falsification tests** — attempt to edit verifier / score / run-ledger / policy
  files; the anti-hacking monitor (+ Coordination Kernel scope gate) must zero the reward
  and emit a `finding_report`. Fail-closed.
- **Stale-consensus dry-run** — replay the ~80+ old review/consensus items through a
  **no-paid-model simulation** before any paid validator is enabled (validates the loop
  end-to-end on real backlog, $0).
- **reviewerIndependence is first-class** (4-way above); reward learns the cross-provider
  break-even.
