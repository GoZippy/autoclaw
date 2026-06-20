# Public/Private Split, Code Protection & Release Plan (2026-06-20)

> Plan for protecting paid/secret code in the **public** `GoZippy/autoclaw` repo,
> shipping it correctly, and the remaining decided tasks. Written after a full
> git-history secret audit.

## 0. TL;DR — the key finding changes the strategy

**A git-history rewrite is NOT needed and should NOT be done.** A read-only audit
of the entire public history found **no real secrets and no paid/secret code**:

| Suspected | Reality |
|---|---|
| `.env` committed | **Never** tracked; gitignored. |
| `.env.example` | Empty **placeholders** only (`VSCE_PAT=`, `OVSX_TOKEN=`). |
| "BEGIN … PRIVATE KEY" in history | **Test fixtures** in `src/test/intelligence-redact.test.ts` + `personaMemory.test.ts` (fake keys fed to the *redaction* tests). |
| `ghp_` / `sk-` matches | The same redaction fixtures + the `redactErrorMessage` feature (patterns it scrubs). Not real tokens. |
| Premium/paid code in history | Only the **free stub** (`src/premium/*`, commit `3475a86`). No secret implementation has ever existed in the repo. |
| Signing key | Never committed — only `src/licensing/publicKey.ts` (the **public** verify key) ships. |

**Why a rewrite is the wrong tool anyway:** once content is pushed to a public
GitHub repo it is permanently compromised — forks, clones, GitHub's own caches,
and external archives (GH Archive, Software Heritage) retain it. A rewrite +
force-push does not recall it; it only breaks every fork/clone/PR and invalidates
tags. So even **if** a secret had leaked, the fix would be **rotation** (new key),
not rewrite. Here, nothing leaked, so: **prevent, don't purge.**

## 1. The protection model — prevention, forward-looking

```
PUBLIC repo  GoZippy/autoclaw  (source-available)
  ├─ core extension shell, skills, adapters, hooks, support UI
  ├─ licensing CLIENT  (verify-only + trial + gate)        ← Open
  ├─ premium INTERFACE + free fallback (src/premium/*)      ← Restricted (inspect-only)
  └─ public verify key only (src/licensing/publicKey.ts)

PRIVATE repo  GoZippy/autoclaw-premium  (paid, secret)      ← does not exist yet
  └─ real PremiumApi implementation (PR-evidence engine, scorecards, …)

Maintainer secrets (never in any repo)
  ├─ license SIGNING private key  → ~/.autoclaw/secrets/…   (already moved here)
  └─ publish tokens (VSCE_PAT/OVSX_TOKEN) → repo .env (gitignored)
```

The seam already exists: `src/premium/premiumApi.ts` (interface), `index.ts`
(factory → free fallback), `unavailablePremium.ts`. A paid build swaps the factory
for `@autoclaw/premium` via a bundler/tsconfig alias (`docs/build-editions.md`).

## 2. What shipped this session to enforce it (3.6.3, on dev-beta)

- **`scripts/check-no-secrets.js`** — blocks (1) secret files (`.env`, `*.pem/key/p12/pfx`,
  `id_rsa*`), (2) private-key PEM content under any filename, (3) private/paid code
  paths (`premium-impl/`, `src/premium-private/`, `packages/premium/`,
  `packages/autoclaw-premium/`). Allowlists the redaction test fixtures + `.env.example`.
  Wired as a **CI step** (`ci.yml`) and an **opt-in pre-commit hook** (`.githooks/pre-commit`;
  `git config core.hooksPath .githooks`). npm: `npm run secrets:check`.
- **`.gitignore`** hardened: keys/certs + the private premium paths.
- **`COMPONENTS.md`**: `src/premium/**` + `src/edition.ts` marked Restricted (paid
  seam); note that the premium engine lives in the private repo; no-rewrite policy stated.
- **`autoclaw.licensing.enforceGates` (default OFF)** — the feature gates are built
  but **dormant**; flip on only when a purchase path exists, so 3.6.3 can ship
  without stranding users behind an upgrade prompt with nowhere to buy.

## 3. Standing up the private repo (when ready — maintainer step)

Not done automatically (creating/owning repos is the maintainer's call). Steps:

1. `gh repo create GoZippy/autoclaw-premium --private` (Node package `@autoclaw/premium`).
2. Implement `PremiumApi` (from `src/premium/premiumApi.ts`) there — the real
   PR-evidence engine, agent scorecards, advanced orchestration, etc.
3. Enterprise build aliases `@autoclaw/premium` → the private package (tsconfig
   `paths` / bundler alias); the public/marketplace build keeps the free fallback.
4. Never add the private package as a normal dependency of the public repo.

## 4. The 3.6.3 release (this is the version, per maintainer: small increments only)

`origin/dev-beta` is the trunk to release (kg-daemon fix, bridge claim endpoint,
licensing engine [gates dormant], inline reply + history, public-repo guard).

Release flow (same as 3.6.2, when you give the go — publishing is irreversible):
1. PR `dev-beta → master`, CI green, merge.
2. Tag `v3.6.3` on master, push tag.
3. `npm run package` → `npm run publish:vscode` + `publish:ovsx` (tokens in `.env`).

Safe to publish because gates are OFF by default (no behavior change for users)
and there are no secrets in the artifact (`.vscodeignore` excludes `.env`/`src/**`).

## 5. Remaining decided tasks (categorized)

**Ready to build (unblocked):**
- Two-sided Awaiting-You history (include the user's own sent replies, not just received).
- Deeper #11: board auto-transition on `task_complete` (orchestrator semantics — moderate risk, do carefully).

**Maintainer-owned (blocking real revenue / product decisions):**
- **Square payment links + crypto wallets + one-time price numbers** → fill
  `src/support/supportConfig.ts` / `autoclaw.support.*`, then reconcile
  `PRICING.md` + `LICENSE §5.2` (still say "$15/mo") to the no-subscription model.
- **Flip `autoclaw.licensing.enforceGates` on** once the buy path exists.
- Decide which (if any) further commands to gate — but **NOT** `bridge.*`/`cloud.*`/
  `program.*` (gating those to Team would break cross-agent coordination for
  non-Team users) and **NOT** read-only `status`/`tail`.
- Stand up the private `@autoclaw/premium` repo (§3).

**Housekeeping (confirm before doing — destructive):**
- Worktree cleanup: stale `k:\tmp\autoclaw-{devbeta,rel,kofi,test}` (one has an
  uncommitted `package-lock` diff → clean-check before `git worktree remove`).

**Closed-by-analysis (no action):**
- History rewrite (§0 — unnecessary). Aikido SAST path-traversal hits (confirmed
  false-positives; scanner-config disposition only).

## 6. Decisions needed from you
1. **Go for the 3.6.3 release?** (I'll prep the PR + tag + publish on your word.)
2. **Create `GoZippy/autoclaw-premium`** now, or later? (I can scaffold + give the exact commands.)
3. **Monetization inputs** (Square links + price numbers) — the one thing that
   turns the licensing engine from "built" into "earning."
