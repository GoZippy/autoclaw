/**
 * handlers.ts — pure request handlers for the relay server (AF-10).
 *
 * Each handler takes the resolved account + the parsed request and returns a
 * `{ status, body }` — no socket, so they unit-test directly. They implement
 * exactly the contract the client (`src/cloud/relay.ts`) speaks:
 *   POST /v1/heartbeat   { installation_id, batched_at, heartbeats[] }
 *   POST /v1/inbox       { installation_id, batched_at, messages[] }
 *   GET  /v1/inbox?to=…  → { messages[] }   (drains)
 *   GET  /v1/heartbeat   → { heartbeats[] } (fleet view)
 */

import type { RelayStore, StoredMessage } from './store';

export interface HandlerResult {
  status: number;
  body: unknown;
}

interface HeartbeatBody {
  installation_id?: string;
  heartbeats?: Array<{ agent_id: string; timestamp: string; status: string; current_task: string | null; sprint: number | null; current_llm?: string }>;
}

interface InboxBody {
  installation_id?: string;
  messages?: StoredMessage[];
}

export async function handleHeartbeatPost(store: RelayStore, account: string, body: HeartbeatBody): Promise<HandlerResult> {
  const stored = await store.putHeartbeats(account, body.installation_id ?? 'unknown', body.heartbeats ?? []);
  return { status: 200, body: { ok: true, stored } };
}

export async function handleInboxPost(store: RelayStore, account: string, body: InboxBody): Promise<HandlerResult> {
  const stored = await store.putMessages(account, body.messages ?? []);
  return { status: 200, body: { ok: true, stored } };
}

export async function handleInboxGet(store: RelayStore, account: string, toParam?: string): Promise<HandlerResult> {
  const recipients = toParam
    ? toParam.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const messages = await store.drainMessages(account, recipients);
  return { status: 200, body: { messages } };
}

export async function handleHeartbeatGet(store: RelayStore, account: string): Promise<HandlerResult> {
  return { status: 200, body: { heartbeats: await store.getHeartbeats(account) } };
}
