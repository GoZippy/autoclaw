# AutoClaw — Local Backlog

The **single local place** for tracked work. Planning stays local (per the
local-first policy) — this is not mirrored to GitHub Issues. Inbound issues
that *users* file on the public repo are watched separately and triaged here
when they arrive.

Status keys: `open` · `blocked` · `in-progress` · `done` (move to the bottom log).

---

## Open

### Cloud relay GA — security follow-ups (from the PA-2 audit)
Accepted-risk residuals; tracked in
[reviews/cloud-relay-security-audit.md](../reviews/cloud-relay-security-audit.md).

| # | Item | Sev | Status |
|---|------|-----|--------|
| SEC-1 | Drop `session_id` from the `RelayHeartbeat` wire shape (F3 minimization) | low | **done** (be80ddb) |
| SEC-2 | Consent modal in `extension.ts` (show endpoint + write `consentAckAt`) (F4) | med | **done** — `autoclaw.cloud.enableRelay` |
| SEC-3 | Windows ACL on `credentials.enc` / `.keyseed` via icacls (F6) | low | **done** (be80ddb) |

### RELAY-WIRE — make the relay live (in progress)
The relay was built but dormant. Now wired:
- [x] forward heartbeats from the heartbeat tick (`src/cloud/forwarding.ts` → `forwardHeartbeats`), inert unless `relayIsActive` + token
- [x] `flushQueue` drained on the same tick
- [x] **SEC-2** consent modal — `autoclaw.cloud.enableRelay` / `disableRelay` (validates https, names what's forwarded, writes `tier:ga` + `consentAckAt`)
- [ ] **inbox forwarding** — hook `relay.sendInbox` at the inbox-write site (more invasive; the next RELAY-WIRE step)
- [ ] stand up the hosted relay + entitlement (see [specs/relay-entitlement.spec.md](specs/relay-entitlement.spec.md)) — only after demand is validated

### Monetization / strategy (planning, local)
- [docs/MONETIZATION.md](MONETIZATION.md) — open-core + hosted-relay subscription (Tailscale model) + enterprise.
- [docs/COMPETITIVE_BRIEF.md](COMPETITIVE_BRIEF.md) — positioning vs Cline/Roo/Continue/Cursor/etc.; the multi-agent-conductor niche is unclaimed.
- [docs/specs/relay-entitlement.spec.md](specs/relay-entitlement.spec.md) — server-side paywall design (client stays open).

### VoidSpec integration follow-ups
Detail + acceptance criteria in
[docs/VOIDSPEC_FOLLOWUPS.md](VOIDSPEC_FOLLOWUPS.md). VoidSpec is a separate
project (github.com/GoZippy/VoidSpec); AutoClaw is the consumer.

| # | Item | Status |
|---|------|--------|
| VF-1 | Replace hand-rolled `parseVoidSpecYaml` (`sync.ts:61`) with a real YAML parser | open |
| VF-2 | Write the `tasks.yaml` contract doc + cross-link `types.ts` → VoidSpec repo | open |
| VF-3 | Implement the deferred `runner-voidspec` dispatch runner (`dispatch.ts:56`) | blocked (needs VoidSpec API) |

### Multi-Platform Agent Fabric (the big initiative)
Extends [docs/DISTRIBUTED_AGENT_FABRIC.md](DISTRIBUTED_AGENT_FABRIC.md); design
in [docs/rfc/agent-fabric-platforms.md](rfc/agent-fabric-platforms.md).
**Survey finding:** the per-platform runners already exist (`src/runners/`:
claude-code/desktop, codex, cursor, kiro, gemini, hermes, openclaw, autogpt) +
capability routing exists — so this is wire+extend.

**The fabric LOGIC layer is built + tested** (taxonomy, schema, onboarding,
routing, governance). What remains is wiring that logic into the live planner
+ message paths (AF-8) and content/skill packs (AF-6) + cross-machine (AF-7).

| # | Item | Status |
|---|------|--------|
| AF-1 | Agent-type taxonomy (`src/fabric/agentTypes.ts`) — coder/runner/auditor/supervisor/assistant/governance + per-type controls | **done** (7af9d3a) |
| AF-2 | Tag `RegisteredAgent` with `agent_type` + `can_orchestrate`; `taskType` discriminant on `DispatchOptions` | **done** (1f25012) |
| AF-3 | Route by type — `rankAgentsForCapabilities` (caps + type tags), `selectReviewers(type)`, `reviewConsensusRuleFor(type)` (`src/fabric/routing.ts`) | **done (logic)** (aa092bc) |
| AF-4a | Onboarding core `onboardPlatform()` — detect → health → register a typed agent; idempotent | **done** (4eede7b) |
| AF-4b | `createDefaultRunnerRegistry()` (wires the 9 runners) + `autoclaw.fabric.onboard` command | **done** (4266f01) |
| AF-5 | Governance — `gateDispatch(type, controlLevel)` approval gate + append-only audit log (`src/fabric/governance.ts`) | **done (logic)** (aa092bc) |
| AF-6 | OpenClaw + Hermes skill packs (typed fabric workers) — `skills/openclaw`, `skills/hermes` (mateam Fable coder) | **done** (555012f) |
| AF-7 | Live inbox forwarding to the relay + per-message `forwarded_at` dedup (`gatherInboxForRelay`/`forwardInbox`, wired into the tick). **Cross-machine `fetchInbox` (Phase 2) + A2A still open.** | **done (phase 1)** (8ef5317) |
| AF-8 §1 | Live review path derives consensus rule by persona — security reviews now UNANIMOUS for real (was dormant) | **done** (e911740) |
| AF-8 §2 | Security reviews routed to live auditors (full-pool fallback) | **done** (e911740) |
| AF-8 §3 | Governance gate + audit log on the live `dispatchWork` path (human-in-loop types held) | **done** (ee478bb) |
| AF-8 §4 | Planner capability scoring is agent-type-aware (boost-only, non-regressive) | **done** (cb02499, awaiting push) |
| AF-7b | Cross-machine `CloudRelay.fetchInbox` (pull remote messages) + external A2A agents via the bridge | open |
| AF-9 | Consolidate the `fabric.ts` (message-bus) vs `fabric/` (taxonomy) naming collision | open |

### Release / process
| # | Item | Status |
|---|------|--------|
| _(all clear)_ | — | — |

---

## Inbound (user-reported issues)
Checked `gh issue list --repo GoZippy/autoclaw` — **none open** as of 2026-06-07.
When a user files one, copy it here, triage, and respond on the repo.

---

## Done log
- 2026-06-09 — **REL-2 done**: released **v3.2.0** — bumped `package.json` 3.1.4→3.2.0,
  CHANGELOG entry, tagged `v3.2.0`, **published to both the VS Code Marketplace and
  Open VSX** (ZippyTechnologiesLLC.autoclaw v3.2.0). Publish needs `NODE_OPTIONS=--use-system-ca`
  in this TLS-intercepted environment.
- 2026-06-09 — **REL-1 done**: promoted `integrate-automate-v3.2` `dev-beta` → `master`
  (merge `549cbca`, pushed). Full suite 877 green on the merged master.
- 2026-06-08 — Closed the `activate()` coverage gap: `src/test/extensionActivate.test.ts`
  drives the real entry point in node (stubbed `vscode`, timers neutralized),
  asserting all 35 commands register without throwing. Full suite 877 green.
