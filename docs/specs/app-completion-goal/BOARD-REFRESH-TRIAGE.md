# Board Refresh — Stale-Item Triage (2026-06-29)

Triage of the coordination board's stale residue: **92 distinct stale consensus
votes** (97 vote files) + **56 task claims**, validated item-by-item before any
discard. Driven by the maintainer directive: *"stale votes and stale board items
along with expired items all need to be reviewed and validated indeed to be
discardable or if it needs to be worked on and in what priority order."*

**Method:** each stale task was cross-referenced against (a) the v3.x sprint
status in `state.json` (`sprint_statuses`), (b) presence of landed tests in
`src/test/`, (c) live code in `src/`, (d) the canonical `FEATURE-STATUS.csv`,
and (e) open git branches. Nothing is discarded on age alone.

**Key finding — validation mattered:** one item that *looked* like dead residue,
`BL-7-reputation-dispatch`, is in fact the **flagship reputation-aware dispatch,
built but never wired** (`dispatchPreferredByReputation` is called nowhere outside
its own module). A blind age-based archive would have buried the single most
valuable unfinished feature. It is classified **REWORK / HIGH**, not discard.

> Archiving a stale *vote* never closes a *task*. REWORK tasks below are tracked
> in the backlog regardless of their dead vote being archived.

---

## REWORK — validated as unfinished, re-prioritized for the board

| Priority | Item | Evidence | Action |
|---|---|---|---|
| **HIGH** | `BL-7-reputation-dispatch` | Engine exists (`src/runners/reputationPreference.ts`, `capabilityRouting.ts`) but `dispatchPreferredByReputation`/`dispatchPreferredForCapability` are **called nowhere** outside their module + tests. The flagship "reputation routing" of the v4 vision is **inert**. | Wire reputation-preferred dispatch into the live runner-selection path (extension/bridge dispatch). New backlog item. |
| **MED** | `panel-fleet-visibility`, `land-panel-and-release` | Map to open branches `feat/fleet-presence-union` (also on origin) and `feat/panel-responsive-command-center`; the latter carries recent panel-install / unified-KG-search commits. Actively owned by the **peer claude-code session** landing 3.6.x panel work. | Coordinate with peer session; verify merge state, then merge or close. Not this session's scope. |
| **LOW** | `KGC-PR` | KG convergence store landed (`src/intelligence/kg/store.ts`, PR #24) but a "KGC-PR" vote lingers. | Verify nothing is unmerged; likely discard after peer confirm. |

---

## DISCARD — validated complete/shipped/superseded → archived (reversible)

| Cluster | Count | Evidence of completion |
|---|---|---|
| **V3X sprint tasks** (A1–A7, B1–B5, C1–C14, D1–D3, E*, F1–F5, G1–G2, H1–H3, I1–I3, GR-*, HKS-*) | 43 | `state.json` `sprint_statuses` shows sprints **s2/s3/s4 = merged**; v3.0/v3.1 complete. |
| **Coordination layer** (BP1–BP3, CL-3/4/runtime, HB-FIX, UI-1/2/4/5) | 12 | CL-1..5 merged (PRs #45–50, memory); UI/BP from merged sprint s2. |
| **Backlog (done)** (BL-6 cost-ledger, BL-14 loopservice, BL-20 voidspec) | 3 | Landed tests: `llm-costwrite`, `runner-loopservice-wiring`, `voidspec-yaml`. |
| **Done/superseded OTHER** (recordOutcome-fanout, KGC-1/3..6, phase-b-s3, heal-owner-healthy, REP-1/MEM-1, release-3.3.0 [now 3.6.10], distributed-agent-fabric-research, sprint-1-WA-3) | ~13 | Code/tests present or version-superseded. |
| **Untraceable** (unknown-26-05-21, unknown-aa4772f0, unknown-f1ae5ad0) | 3 | No task/owner/timestamp — unrecoverable residue. |
| **Current-initiative DONE** (RF-1/2/3/4a, RF-validation-gate, WL-0/0.6/0.7/1/1.1-1.3/1.2/1.6/2.3) | ~13 | Completed this + recent sessions (F-332..337); votes are resolved residue. |

Plus **45 stale claims** (≥2 days old or no timestamp) for the same completed work.

---

## KEEP — active / recent (not touched)

- **Consensus votes (<2 days):** `OSL-1.1`, `OSL-2.1` (resolved, recent), `WL-2.4-premium-escalation-policy`.
- **Fresh claims (<2 days, 11):** the live `WL-*` workflow-lab + `ORNITH-SCAFFOLD-PLAN` claims.

---

## Archive action

Discarded votes + stale claims moved (not deleted) to:
- `.autoclaw/orchestrator/comms/consensus/_archive/2026-06-29/`
- `.autoclaw/orchestrator/comms/claims/_archive/2026-06-29/`

Each archive dir carries a `manifest.json` listing every moved file with its
original task id, age, and triage class — fully reversible. See the manifest for
the exact file list.
