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
| SEC-1 | Drop `session_id` from the `RelayHeartbeat` wire shape (F3 minimization) | low | open |
| SEC-2 | Consent modal in `extension.ts` that shows the endpoint + writes `consentAckAt` (F4) | med | open |
| SEC-3 | Windows ACL on `credentials.enc` / `.keyseed` (chmod 0600 is POSIX-only) (F6) | low | open |

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
| REL-1 | Promote `dev-beta` → `master`. v3.2 is merged into `dev-beta` (clean, 874 tests green, pushed); **awaiting user testing + final approval** before the `master` merge. | awaiting-approval |

---

## Inbound (user-reported issues)
Checked `gh issue list --repo GoZippy/autoclaw` — **none open** as of 2026-06-07.
When a user files one, copy it here, triage, and respond on the repo.

---

## Done log
- 2026-06-08 — Closed the `activate()` coverage gap: `src/test/extensionActivate.test.ts`
  drives the real entry point in node (stubbed `vscode`, timers neutralized),
  asserting all 35 commands register without throwing. Full suite 877 green.
