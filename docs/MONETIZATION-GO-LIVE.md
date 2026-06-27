# Monetization — Go-Live Runbook (maintainer-only)

_Internal ops doc. Excluded from the published VSIX (see `.vscodeignore`). Not a
secrecy boundary — the VSIX is inspectable — just not end-user content._

This is the **minimal real money path** for 3.6.6, chosen deliberately to avoid
slipping the release:

- **Feature gates stay OFF.** `autoclaw.licensing.enforceGates` defaults `false`
  ([src/licensing/gateService.ts](../src/licensing/gateService.ts)), so the three
  Pro features (PR-evidence reports, agent scorecards, advanced orchestration)
  remain free for everyone. No free user loses anything. Flip this on later only
  once a purchase→key path is proven (see §5).
- **Money comes from** donations (Ko-fi is already live) + **commercial-license
  purchases delivered as manually-minted signed keys.** No license server.
- The licensing *client* (offline Ed25519 verification, trial, entitlement cache)
  already ships and works; only the commercial inputs below are missing.

## 1. Wire the real payment links

Edit the `DEFAULTS` in [src/support/supportConfig.ts](../src/support/supportConfig.ts)
(or set the hidden `autoclaw.support.*` settings — settings win over DEFAULTS):

| Field | What to paste |
|---|---|
| `donationUrl` | Square "thank you" / fixed-amount checkout link |
| `customAmountUrl` | Square custom-amount checkout link |
| `proUrl` | Square **commercial-license** checkout link (the buy button) |
| `cryptoWallets` | Real BTC / ETH / SOL / USDC addresses — **or delete the entries** if you don't want crypto (don't ship `REPLACE_ME`) |
| `koFiUrl` | Already real (`ko-fi.com/gozippy`) |

`isPlaceholder()` already routes around any field left as `REPLACE_ME` (donate
falls back to Ko-fi, then the support panel), so a partial fill degrades safely —
but anything you want **live** must be a real URL before publish.

## 2. Set prices + reconcile the docs

- Decide the commercial-license price(s) per tier (`pro` / `teams` / `enterprise`)
  and the term (perpetual vs N-day — the key supports both, see §4).
- **Reconcile the stale "$15/mo" language** in `PRICING.md` and `LICENSE` §5.2 to
  match the chosen no-subscription model. (Left unedited here on purpose — it
  needs your real numbers.)

## 3. Signing-key custody (one-time)

- Generate an Ed25519 keypair **offline**; keep the **private** key off this repo
  and out of CI (a password manager / HSM / offline file).
- Ensure the matching **public** key is the one embedded in
  [src/licensing/publicKey.ts](../src/licensing/publicKey.ts) — issued keys only
  verify against it. The public key is safe to ship (verify-only) and already does.
- Never commit the private key. `scripts/check-no-secrets.js` blocks `*.pem` /
  `BEGIN … PRIVATE KEY`, but keep it nowhere near the tree regardless.

## 4. Mint + deliver a key after each purchase (manual)

When Square notifies you of a commercial-license purchase:

```bash
AUTOCLAW_LICENSE_PRIVATE_KEY=/secure/path/private-key.pem \
  node scripts/sign-license.js --tier pro --email buyer@example.com --days 365
# tiers: pro | teams | enterprise ; --days 0 (or "perpetual") = no expiry ; --seats N
```

It prints `AUTOCLAW-<payload>.<sig>`. **Email that to the customer.** They paste it
via the in-product "Enter license key" flow; it verifies fully offline.

## 5. Later (NOT in 3.6.6) — automate + enforce

Only after the buy→key path is proven manually:

1. **Automate delivery** — tag AutoClaw onto the existing `license.gozippy.com`
   (DRK) server: Square webhook → sign (server holds the private key) → email.
   See `docs/ideas` for the unified-license-server notes (~5 known gaps).
2. **Flip enforcement** — set `autoclaw.licensing.enforceGates: true` once buyers
   can actually get keys. Until then it stays off so nothing is gated.
3. **AutoClaw Control** (the Tauri standalone) is the real flagship paid surface —
   separate track, designed in `docs/ideas/AUTOCLAW-CONTROL-TAURI-PLAN.md`.

## Pre-publish checklist (this release)

- [ ] Real Square links pasted (`donationUrl`, `customAmountUrl`, `proUrl`).
- [ ] Crypto wallets real, or removed (no `REPLACE_ME`).
- [ ] Prices set; `PRICING.md` + `LICENSE` §5.2 reconciled.
- [ ] Public key in `publicKey.ts` matches your offline private key; minted a test
      key and confirmed it verifies in-product.
- [ ] `enforceGates` left **off** (default) — confirmed.
