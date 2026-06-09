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
| SEC-2 | Consent modal in `extension.ts` (show endpoint + write `consentAckAt`) (F4) | med | open — folded into RELAY-WIRE below |
| SEC-3 | Windows ACL on `credentials.enc` / `.keyseed` via icacls (F6) | low | **done** (be80ddb) |

### RELAY-WIRE — the relay is built but DORMANT (decision needed)
**Finding (2026-06-09):** `CloudRelay.sendHeartbeats`/`sendInbox`/`flushQueue`
exist + are fully tested, but **no production code calls them** — the relay is
not wired into the extension's heartbeat/inbox loops. So the "GA" shipped as
opt-in *plumbing* that is currently never invoked. To make it actually
function (when a user opts in) needs a deliberate piece:
- [ ] call `sendHeartbeats`/`sendInbox` from the heartbeat + inbox flush path (only when `relayIsActive`)
- [ ] a `flushQueue` timer
- [ ] **SEC-2** consent modal (show the endpoint, write `consentAckAt`) — the UX that lets a user opt into GA without hand-editing JSON
This turns on cross-machine data egress, so it's a **product decision**, not
auto-bundled. Awaiting user go-ahead.

### VoidSpec integration follow-ups
Detail + acceptance criteria in
[docs/VOIDSPEC_FOLLOWUPS.md](VOIDSPEC_FOLLOWUPS.md). VoidSpec is a separate
project (github.com/GoZippy/VoidSpec); AutoClaw is the consumer.

| # | Item | Status |
|---|------|--------|
| VF-1 | Replace hand-rolled `parseVoidSpecYaml` (`sync.ts:61`) with a real YAML parser | open |
| VF-2 | Write the `tasks.yaml` contract doc + cross-link `types.ts` → VoidSpec repo | open |
| VF-3 | Implement the deferred `runner-voidspec` dispatch runner (`dispatch.ts:56`) | blocked (needs VoidSpec API) |

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
