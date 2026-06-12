# AutoClaw Relay Server (self-host)

The relay is a small store-and-forward server that lets your machines coordinate
**cross-machine**. The AutoClaw extension (the *client*) forwards heartbeats +
inbox messages to it and pulls messages other machines left for you. Running
your own relay is **free** — it's the self-hosted tier of the open-core model
(see [MONETIZATION.md](MONETIZATION.md)). The hosted (paid) variant is the same
server plus a subscription check at the auth seam
([specs/relay-entitlement.spec.md](specs/relay-entitlement.spec.md)).

## What it is (and is not)
- A dependency-free Node HTTP server (`src/relay-server/`, ~4 small files).
- It **never decrypts your messages** — inbox payloads are AES-256-GCM encrypted
  by the sending client; the relay only stores + serves the ciphertext. Only the
  receiving machine (which derives the same key) can read them.
- Heartbeats are stored in clear (low-sensitivity status), exactly as the client
  sends them.
- It is **not** the canonical record — your local `.autoclaw/` file-bus is. The
  relay is the cross-machine transport.

## Run it
```sh
# from a checkout of this repo
npm run compile
AUTOCLAW_RELAY_TOKENS="my-secret-token:my-account" \
AUTOCLAW_RELAY_DATA_DIR=./relay-data \
AUTOCLAW_RELAY_PORT=8787 \
npm run relay:serve
```
- `AUTOCLAW_RELAY_TOKENS` — `token:account[,token2:account]`. Every machine that
  should share messages uses a token mapped to the **same account**. The server
  refuses to start with no tokens (no open relays).
- `AUTOCLAW_RELAY_DATA_DIR` — where messages/heartbeats are stored (default `./relay-data`).
- `AUTOCLAW_RELAY_PORT` — listen port (default `8787`).

Put it behind HTTPS (a reverse proxy / your platform's TLS) — the client
**requires** an `https://` endpoint (loopback `http` allowed for local testing).

## Point the extension at it
On each machine: **AutoClaw: Enable Cloud Relay**, give it `https://<your-host>`,
then `cloud login` with the matching token. Forwarding + pull are inert until
both are set.

## Endpoints (the client contract)
| Method | Path | Body / query | Purpose |
|---|---|---|---|
| `GET`  | `/v1/health` | — (no auth) | liveness |
| `POST` | `/v1/heartbeat` | `{installation_id, batched_at, heartbeats[]}` (gzip) | upsert heartbeats |
| `POST` | `/v1/inbox` | `{installation_id, batched_at, messages[]}` (gzip) | store messages (encrypted bodies) |
| `GET`  | `/v1/inbox?to=a,b` | — | **drain** messages for recipients |
| `GET`  | `/v1/heartbeat` | — | fleet heartbeats (for a cross-machine view) |

All but `/v1/health` require `Authorization: Bearer <token>`.

## Delivery model (MVP)
`GET /v1/inbox` **drains** — it returns and deletes the messages (at-most-once).
The client applies them idempotently (dedup by id). This is fine for a fast-path
transport; a future revision can add ack-based at-least-once delivery + a TTL
sweep. Accounts are isolated — a token for account A can never read account B.

## Hardening before you expose it publicly
- Terminate TLS in front of it.
- Use long, random tokens; one account per user/team.
- Add a reverse-proxy rate limit.
- For multi-tenant/paid hosting, replace `resolveAccount` with the subscription
  lookup from the entitlement spec (the auth seam is isolated for exactly this).
