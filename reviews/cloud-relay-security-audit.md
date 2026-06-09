# Cloud Relay Security Audit — `src/cloud/`

**Task:** PA-2 (integrate-automate-v3.2, Lane C) · the unanimous security gate for ia-3 (cloud relay GA, CF-3/CF-4).
**Auditor:** claude-code (security-auditor pass; Lane C reassigned from kilocode 2026-06-05).
**Scope:** `src/cloud/relay.ts`, `src/cloud/auth.ts`, `src/cloud/index.ts`.
**Verdict:** Relay is sound *inert*; **must-fix F1 + F2 before GA**, F3–F7 accept-with-documentation.

---

## Method
Read every send path, the token store, the encryption, and the offline queue.
Threat model: (a) network attacker on the wire, (b) local attacker with read
access to `.autoclaw/`, (c) accidental disclosure (logs, synced dotfiles, git).

## Findings

### F1 — No HTTPS enforcement on the relay endpoint — **HIGH** — must-fix
`postJson` ([relay.ts](../src/cloud/relay.ts) `url = endpoint.replace(/\/+$/,'') + pathSuffix`)
sends the bearer token in the `Authorization` header to whatever `endpoint`
the config holds. `readRelayConfig`/`relayIsActive` accept **any scheme** —
a `http://…` endpoint sends the token + routing metadata in **cleartext**.
**Fix (CF-3):** reject a non-`https:` endpoint in `relayIsActive`/config load
(allow `http://localhost`|`127.0.0.1` for dev only). Without this, GA can leak
the bearer token to a passive network observer.

### F2 — Expired tokens are not rejected — **MEDIUM** — must-fix
`isTokenExpired()` exists ([auth.ts:486](../src/cloud/auth.ts)) but
`getCloudToken()` **never calls it** — an expired OAuth access token is
returned `{ ok: true }` and used to authenticate. **Fix (CF-3):** have
`getCloudToken` return `{ ok:false, reason:'expired' }` when
`isTokenExpired(record)`, and treat that as inert (`token_unusable`) in the
relay credentials path.

### F3 — Heartbeat payloads are cleartext (only gzipped) — **MEDIUM** — document + minimize
Inbox payloads are AES-256-GCM encrypted, but `RelayHeartbeat` forwards
`current_task`, `session_id`, `current_llm` **unencrypted** (gzip is not
encryption), and the offline queue stores heartbeat bodies in cleartext on
disk. `current_task` can carry file paths / task descriptions. **GA action:**
gate heartbeat forwarding behind explicit consent (`forward.heartbeats`,
default off), document that heartbeat fields leave in clear, and drop
`session_id` from the wire shape unless needed.

### F4 — Endpoint is unvalidated / no SSRF consideration — **MEDIUM** — fix with F1
The endpoint is fully user-controlled and POSTed to with no scheme/host
validation beyond non-empty. **GA action:** validate the URL (https, parseable
host) at config load and **surface the configured endpoint in the consent
prompt** so the user confirms where fleet data is sent.

### F5 — Payload key derived from the bearer token — **LOW** — accept (documented)
`derivePayloadKey = scrypt(token, installation_id)` couples the data key to the
token; anyone who obtains the token can derive the key and decrypt queued/at-rest
ciphertext. Already flagged in-code as an MVP limitation. **Accept for GA**
with a documented note; future work: negotiate a dedicated DEK at login.

### F6 — Encrypted-file fallback key is machine-derived, not a user secret — **LOW** — accept (documented)
`EncryptedFileSecretStore` keys from `hostname|platform|arch` + a salt stored
*next to* the ciphertext (`.keyseed`). A local attacker who can read
`.autoclaw/cloud/` can reconstruct the key. The code already says so
("not against an attacker with code-execution"). `chmod 0600` is POSIX-only —
**no Windows ACL is set** (note for GA). **Accept**: the OS keychain path is
preferred; the fallback is a convenience. Document; consider a Windows ACL.

### F7 — Offline queue keeps cleartext routing metadata — **LOW/INFO** — accept
Inbox queue items keep `id/to/from/type/timestamp` + `installation_id` in clear
(only the body is encrypted). Local-only, gitignored. **Accept**; note it.

## Verified strengths (not findings)
- **Inert by default**: `readRelayConfig` → off; `relayIsActive` requires
  `enabled && endpoint`; every send also requires a stored token. Three
  independent gates, all default-deny.
- **Token hygiene**: token rides **only** in the `Authorization` header
  ([relay.ts:317](../src/cloud/relay.ts)); never in a body, the queue, or a log;
  `redactToken()` for human output; `RelaySendResult.detail` documented
  token-free.
- **Crypto**: AES-256-GCM, fresh random 12-byte IV per call, GCM auth tag set
  and verified on decrypt. No IV reuse.
- **Scoping**: `getCloudToken` rejects a token minted for another
  `installation_id` (`scope_mismatch`).
- **Bounded queue**: `MAX_QUEUE_ITEMS` cap (drop-oldest) + `MAX_RETRIES` drop.

## GA gate (consumed by CF-4)
| Finding | Severity | Disposition for GA |
|---|---|---|
| F1 HTTPS enforcement | HIGH | **MUST FIX in CF-3** |
| F2 expired-token rejection | MEDIUM | **MUST FIX in CF-3** |
| F3 heartbeat cleartext | MEDIUM | consent-gate + minimize + document |
| F4 endpoint validation | MEDIUM | fix with F1 + show endpoint at consent |
| F5 token-derived key | LOW | accept, documented |
| F6 file-store key strength | LOW | accept, documented; add Windows ACL note |
| F7 queue metadata cleartext | LOW | accept, documented |

**Unanimous-vote items:** F1 and F2 are blocking. CF-3 must resolve them and
CF-4 must confirm each finding is fixed or has a documented accepted-risk line
before the GA flip merges. Re-audit after CF-3.

---

## Resolution (CF-3 + CF-4) — 2026-06-05, claude-code

CF-3 landed the GA path; CF-4 walks each finding. Both must-fixes are resolved.

| Finding | Disposition | Evidence |
|---|---|---|
| **F1** HTTPS enforcement | **FIXED** | `endpointIsSecure()` + `relayIsActive()` now reject non-`https` (loopback `http` only). Tests: "F1: endpointIsSecure…", "F1: an http:// endpoint keeps the relay inert". |
| **F2** expired-token rejection | **FIXED** | `getCloudToken()` returns `reason:'expired'`; relay maps it to `token_unusable` (inert). Tests: "F2: getCloudToken rejects an expired token", "F2: an expired token makes the relay inert". |
| **F3** heartbeat cleartext | **ADDRESSED (opt-out + consent)** | `forward.heartbeats:false` skips the channel (`channel_disabled`); GA tier requires `consentAckAt`. **Deferred (accepted-risk):** dropping `session_id` from the wire shape — tracked for a follow-up; heartbeats still leave in clear when opted in. |
| **F4** endpoint validation / SSRF | **PARTIALLY FIXED** | Scheme validation done (F1). **Deferred:** the consent modal that *shows the endpoint* before enabling is an `extension.ts` UI task (outside `src/cloud/` scope) — tracked, not blocking the inert-safe code. |
| **F5** token-derived key | **ACCEPTED (documented)** | MVP limitation; future DEK negotiation. |
| **F6** file-store key strength | **ACCEPTED (documented)** | OS keychain preferred; Windows-ACL hardening tracked as a follow-up. |
| **F7** queue metadata cleartext | **ACCEPTED (documented)** | Local-only, gitignored. |

**Gate status:** both unanimous-vote blockers (F1, F2) FIXED with tests; F3/F4
residuals are documented accepted-risk follow-ups that do not weaken the
inert-by-default or token-hygiene guarantees. **CF-4 gate: PASS** — the GA path
is safe to ship opt-in. The relay still defaults to `preview`/inert; GA requires
`tier:ga` + `consentAckAt` + an `https` endpoint + a live token.

**Follow-ups (non-blocking, tracked):** (1) drop `session_id` from `RelayHeartbeat`;
(2) consent modal in `extension.ts` that displays the endpoint + writes
`consentAckAt`; (3) Windows ACL on `credentials.enc`/`.keyseed`.
