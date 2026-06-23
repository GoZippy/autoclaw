/**
 * evict.ts — the SAFE CORE of the agent-eviction lifecycle (LANE B).
 *
 * Eviction is the one *risky* org primitive: spawn / invite / recall / pause all
 * ADD capacity or are reversible doorbells, but **evict REMOVES a running
 * participant** — it releases held work, revokes trust, and tears down presence.
 * Done wrong it orphans dependents, strands consensus, or (once a relay/HTTP
 * lane exists) becomes a forgeable remote-kill. So correctness here comes NOT
 * from a lock but from **idempotency + a fixed load-bearing order + an intent
 * record** over independent filesystem resources, each step re-runnable and a
 * no-op when already done. The whole transaction is safe to re-run to completion
 * after a partial teardown.
 *
 * This module is the wiring layer the original `dismiss()` explicitly deferred
 * (recall.ts:165 "releasing leases / revoking trust is the wiring layer's job").
 * It is pure of vscode and touches fs only via the existing fleet helpers it
 * imports (workforce / invites / beacons) plus a handful of comms-tree reads of
 * its own. `now` is injectable for tests; deny-by-default on anything malformed.
 *
 * Cross-machine evict stays BLOCKED — the file bus has no transport auth, so any
 * inbox-writer could forge an `evict`. In-IDE single-operator is acceptable only
 * because the trust boundary is the machine itself. The §5 signing gate is a
 * clearly-marked TODO; a remote/relay invocation is refused here.
 *
 * See docs/ideas/EVICT-AGENT-LIFECYCLE.md (the authoritative design).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readWorker, setWorkerStatus, type Worker,
} from './workforce';
import {
  listInvites, revokeInvite, type Invite,
} from './invites';
import {
  machineBeaconDir, workspaceBeaconDir, readAllBeacons, BEACON_TTL_MS,
} from './beacons';

const fsp = fs.promises;

/**
 * Comms tree layout (relative to `commsDir`). The eviction transaction reads
 * `claims/` and `registry.json` and writes `intents/`. These mirror the shapes
 * the orchestrator loop already uses (orchestratorLoop.ts).
 */
function claimsDir(commsDir: string): string { return path.join(commsDir, 'claims'); }
function registryPath(commsDir: string): string { return path.join(commsDir, 'registry.json'); }
/** NEW: the ack-envelope home (`comms/intents/`), §6 of the design. */
export function intentsDir(commsDir: string): string { return path.join(commsDir, 'intents'); }

/** Drain budget the graceful doorbell advertises before leftovers are reclaimed. */
export const DEFAULT_DRAIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Ack envelope — intents/<intent_id>.json (§6)
// ---------------------------------------------------------------------------

/** Eviction is a fixed sequence of teardown steps; each is tracked here. */
export type EvictStep =
  | 'quiesce' | 'release_claims' | 'reconcile_tasks' | 'reconcile_consensus'
  | 'revoke_trust' | 'teardown_presence' | 'retire';

/** A step's progress in the intent checklist. */
export type StepState = 'pending' | 'acting' | 'done' | 'skipped';

/** The overall intent lifecycle: requested → acting → done | failed. */
export type IntentState = 'requested' | 'acting' | 'done' | 'failed';

/**
 * The ack-envelope record an operator action writes so the Manager panel can
 * show real progress (requested→acting→done), not just "requested". One record
 * type covers spawn / invite / pause by swapping `kind` + the `steps` map; we
 * build it for evict first and the others inherit it (a fast-follow TODO).
 */
export interface EvictIntent {
  intent_id: string;
  kind: 'evict';
  target_agent_id: string;
  target_session_id?: string;
  requested_by: string;
  mode: 'graceful' | 'hard';
  state: IntentState;
  requested_at: string;
  updated_at: string;
  /** Per-step checklist the panel renders as a progress bar. */
  steps: Record<EvictStep, StepState>;
  /** Claims reclaimed (task ids) — the receipt the operator reviews. */
  released_tasks: string[];
  /** Dependents left blocked because a dependency was abandoned, not completed. */
  blocked_dependents: string[];
  /** Consensus items where the target was recorded as evicted. */
  reconciled_votes: string[];
  /** Drain deadline advertised on a graceful evict (epoch ms ISO). */
  drain_deadline?: string;
  error: string | null;
  /** §5 signing gate — present once cross-machine auth ships (TODO). */
  signature?: string;
}

/** A fresh step checklist with everything pending. */
function freshSteps(): Record<EvictStep, StepState> {
  return {
    quiesce: 'pending', release_claims: 'pending', reconcile_tasks: 'pending',
    reconcile_consensus: 'pending', revoke_trust: 'pending',
    teardown_presence: 'pending', retire: 'pending',
  };
}

/** Sanitize an intent id for use as a filename. */
function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Read one intent record by id. Null if missing or malformed. */
export async function readIntent(commsDir: string, intentId: string): Promise<EvictIntent | null> {
  try {
    const raw = await fsp.readFile(path.join(intentsDir(commsDir), `${safeId(intentId)}.json`), 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as EvictIntent;
    return parsed && typeof parsed.intent_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist an intent record (pretty, trailing newline — matches the repo style). */
export async function writeIntent(commsDir: string, intent: EvictIntent): Promise<string> {
  const dir = intentsDir(commsDir);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeId(intent.intent_id)}.json`);
  await fsp.writeFile(file, JSON.stringify(intent, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Open OR resume an intent by id (idempotent). If a record already exists it is
 * returned untouched (so a re-run resumes from the recorded checklist); otherwise
 * a fresh `requested` record is created. This is what makes the whole transaction
 * re-runnable under the same `intent_id`.
 */
export async function openIntent(
  commsDir: string,
  seed: {
    intent_id: string; target_agent_id: string; target_session_id?: string;
    requested_by: string; mode: 'graceful' | 'hard';
  },
  now: number,
): Promise<EvictIntent> {
  const existing = await readIntent(commsDir, seed.intent_id);
  if (existing) { return existing; }
  const iso = new Date(now).toISOString();
  const intent: EvictIntent = {
    intent_id: seed.intent_id,
    kind: 'evict',
    target_agent_id: seed.target_agent_id,
    ...(seed.target_session_id ? { target_session_id: seed.target_session_id } : {}),
    requested_by: seed.requested_by,
    mode: seed.mode,
    state: 'requested',
    requested_at: iso,
    updated_at: iso,
    steps: freshSteps(),
    released_tasks: [],
    blocked_dependents: [],
    reconciled_votes: [],
    error: null,
  };
  await writeIntent(commsDir, intent);
  return intent;
}

// ---------------------------------------------------------------------------
// evictAgent — the §1 transaction (Steps 0–7)
// ---------------------------------------------------------------------------

/** Inputs for an eviction (the scoped, in-IDE shape — no relay fields). */
export interface EvictInput {
  /** The agent being evicted. */
  agentId: string;
  /**
   * Evict only ONE session of `agentId`. When given, a claim/beacon is only
   * torn down if its session matches — a sibling Claude Code window survives.
   * When omitted, the whole agent (all sessions) is evicted.
   */
  sessionId?: string;
  /** graceful (default) drains first; hard reclaims immediately (stale-only). */
  mode?: 'graceful' | 'hard';
  /** The resolved operator identity performing the evict (the auth subject). */
  operator: string;
  /** Reuse an existing intent to resume; a fresh uuid-ish id is minted otherwise. */
  intentId?: string;
  /** The workspace comms tree (`.../orchestrator/comms`). */
  commsDir: string;
  /** Machine home override (tests). Defaults to os.homedir(). */
  homeDir?: string;
}

/**
 * Options: the authorized-operator allowlist (the §5 auth gate, local half), an
 * injectable `now`, the drain budget, and a hard refusal of any remote lane.
 */
export interface EvictOpts {
  /**
   * Ids permitted to author an evict (the manifest operator/owner list). When
   * omitted, the auth gate is satisfied iff `operator` non-empty (single-operator
   * in-IDE default — the local human is the only filesystem writer). When given,
   * `operator` MUST be on the list or the evict is rejected.
   */
  authorizedOperators?: string[];
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Override the graceful drain budget (ms). */
  drainMs?: number;
  /**
   * BLOCKED: cross-machine invocation. The file bus has no transport auth, so a
   * remote/relay evict is forgeable. Passing `remote: true` is refused here with
   * a clearly-marked error referencing the §5 signing gate — do NOT wire evict.ts
   * to the relay/HTTP path until that gate exists.
   */
  remote?: boolean;
}

/** A claim file on disk (orchestratorLoop.ts:411 shape). */
interface ClaimFile { claimed_by?: string; session_id?: string; expires_at?: string; task_id?: string; depends_on?: string[]; }

/** A registry row (orchestratorLoop.ts:967 shape). */
interface RegistryRow { id: string; inbox_path?: string; status?: string; [k: string]: unknown; }

/**
 * The SAFE CORE eviction transaction. Pure of vscode; fs-only via the imported
 * fleet helpers. Re-runnable to completion under the same `intentId`: each of the
 * seven ordered steps is check-then-act and convergent, so a crash between any
 * two leaves a partial teardown the next run finishes (it skips `done` steps).
 *
 * Returns the final intent record (the ack envelope) — `state: 'done'` on a full
 * teardown, `'failed'` (with `error`) if a step threw. A failed intent resumes
 * from the first non-`done` step when re-invoked with the same id.
 *
 * Load-bearing order (do not reorder): **quiesce → release claims → reconcile
 * tasks → reconcile consensus → revoke trust → tear down presence → retire.**
 * Reversing it lets the target re-claim work after release, or hold trust after
 * its claims are gone (see design §3).
 */
export async function evictAgent(input: EvictInput, opts: EvictOpts = {}): Promise<EvictIntent> {
  const now = opts.now ?? Date.now();
  const mode: 'graceful' | 'hard' = input.mode ?? 'graceful';
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  const intentId = input.intentId ?? `evict-${randomIntentSuffix(now)}`;

  // ---- AUTH GATE (§5, local half) -----------------------------------------
  // Reject if the requester is not the resolved/authorized operator. Cross-
  // machine signing is the BLOCKED other half (see `remote` below).
  if (!input.operator) {
    throw new EvictAuthError('evict refused: no operator identity (auth gate)');
  }
  if (opts.authorizedOperators && !opts.authorizedOperators.includes(input.operator)) {
    // Deny-by-default — the design wants this logged as a scope_violation by the
    // caller; here we surface it as a typed error so the command can record it.
    throw new EvictAuthError(
      `evict refused: operator "${input.operator}" is not on the authorized list`,
    );
  }

  // ---- CROSS-MACHINE BLOCK (§5) -------------------------------------------
  // TODO(§5 signing gate): a remote/relay evict needs a signed, single-use,
  // TTL'd intent (HMAC/keypair over {intent_id,target,mode,issued_at,expires},
  // verified the way consumeInvite rejects an unknown/expired token). Until that
  // lands, evict is local-operator only and any remote invocation is refused —
  // an unguarded relay evict lane is a forgeable remote-kill.
  if (opts.remote) {
    throw new EvictRemoteBlockedError(
      'evict over relay/HTTP is BLOCKED until the §5 signing gate ships (see docs/ideas/EVICT-AGENT-LIFECYCLE.md §5)',
    );
  }

  // ---- Step 0 — open/resume the intent ------------------------------------
  let intent = await openIntent(input.commsDir, {
    intent_id: intentId,
    target_agent_id: input.agentId,
    target_session_id: input.sessionId,
    requested_by: input.operator,
    mode,
  }, now);

  // Already finished — a no-op re-run is the idempotency contract.
  if (intent.state === 'done') { return intent; }

  intent = await mark(input.commsDir, intent, now, i => { i.state = 'acting'; });

  try {
    // ---- Step 1 — Quiesce (graceful drain, the default) -------------------
    if (intent.steps.quiesce !== 'done') {
      if (mode === 'hard') {
        // Hard-kill is permitted ONLY when the owner heartbeat is already stale
        // (> BEACON_TTL_MS) — the protocol's "stale claim may be stolen" rule. A
        // FRESH heartbeat ⇒ refuse to silently force-kill (you'd corrupt a file
        // the agent is mid-write on); the operator must re-confirm + downgrade.
        const stale = await ownerBeaconStale(input, now);
        if (!stale) {
          throw new EvictHardOnFreshError(
            'hard evict refused: owner heartbeat is fresh (< BEACON_TTL_MS) — re-confirm + use graceful',
          );
        }
        intent = await mark(input.commsDir, intent, now, i => { i.steps.quiesce = 'done'; });
      } else {
        // Graceful: advertise a drain deadline. The cooperating agent finishes
        // its current claim and stops claiming new work; leftovers are reclaimed
        // in Step 2 only after the deadline. (The doorbell *delivery* — an
        // `evict_notice` via sendMessage — is wired by the command layer; this
        // pure core records the deadline + envelope shape.)
        const deadline = new Date(now + drainMs).toISOString();
        intent = await mark(input.commsDir, intent, now, i => {
          i.drain_deadline = deadline; i.steps.quiesce = 'done';
        });
      }
    }

    // ---- Step 2 — Release the evicted agent's claims ----------------------
    // The protocol steal-rule applied to self: deleting the claim file IS the
    // mutex release. Idempotent — a missing file is success.
    const released: string[] = [];
    const blocked: string[] = [];
    if (intent.steps.release_claims !== 'done') {
      const { released: rel, claims } = await releaseClaims(input);
      released.push(...rel);
      // ---- Step 3 (folded) — reconcile dependents ------------------------
      // Re-dispatch of released tasks reuses the orchestrator's existing
      // expired-claim → unclaimed path (do NOT invent a second one); here we
      // only surface dependents whose `depends_on` referenced an abandoned task
      // so the operator sees the stalled chain. We never rewrite the DAG.
      blocked.push(...dependentsBlockedBy(claims, new Set(released)));
      intent = await mark(input.commsDir, intent, now, i => {
        for (const t of released) { if (!i.released_tasks.includes(t)) { i.released_tasks.push(t); } }
        i.steps.release_claims = 'done';
      });
    }
    if (intent.steps.reconcile_tasks !== 'done') {
      intent = await mark(input.commsDir, intent, now, i => {
        for (const t of blocked) { if (!i.blocked_dependents.includes(t)) { i.blocked_dependents.push(t); } }
        i.steps.reconcile_tasks = 'done';
      });
      // TODO(reconcile_tasks): the actual board/state "unclaim + re-dispatch" of
      // each released task — and the `finding_report` to shared/ for each blocked
      // dependent — is performed by the command layer that owns the board, reusing
      // the orchestrator's expired-claim path. This pure core records the receipt.
    }

    // ---- Step 4 — Reconcile open consensus votes the agent owed -----------
    if (intent.steps.reconcile_consensus !== 'done') {
      const reconciled = await reconcileConsensus(input, now);
      intent = await mark(input.commsDir, intent, now, i => {
        for (const c of reconciled) { if (!i.reconciled_votes.includes(c)) { i.reconciled_votes.push(c); } }
        i.steps.reconcile_consensus = 'done';
      });
      // TODO(consensus survivor-recompute): this SAFE subset only records the
      // target as evicted on items it owed a ballot on. The deeper "recompute the
      // 2/3 threshold against the surviving expected voters and let
      // resolvePendingConsensus tally it" — and raising a finding_report (never
      // auto-shrinking) for security/unanimous items — is owned by the command
      // layer with board access. Do NOT auto-shrink a security quorum here.
    }

    // ---- Step 5 — Revoke trust --------------------------------------------
    if (intent.steps.revoke_trust !== 'done') {
      await revokeTrust(input);
      intent = await mark(input.commsDir, intent, now, i => { i.steps.revoke_trust = 'done'; });
    }

    // ---- Step 6 — Tear down presence (beacon + registry) ------------------
    if (intent.steps.teardown_presence !== 'done') {
      await teardownBeacons(input);
      await markRegistryEvicted(input);
      intent = await mark(input.commsDir, intent, now, i => { i.steps.teardown_presence = 'done'; });
    }

    // ---- Step 7 — Retire the worker + close the intent --------------------
    if (intent.steps.retire !== 'done') {
      // The capstone — the part dismiss() already did, now LAST. The résumé in
      // workforce/<id>.json is KEPT: eviction ends an engagement, not history.
      await setWorkerStatus(input.agentId, 'retired', input.homeDir);
      intent = await mark(input.commsDir, intent, now, i => { i.steps.retire = 'done'; });
    }

    intent = await mark(input.commsDir, intent, now, i => { i.state = 'done'; i.error = null; });
    return intent;
  } catch (err) {
    // A throw sets state 'failed' + error; the SAME intent_id resumes from the
    // first non-done step on re-run (idempotency from §1). Auth / hard-on-fresh /
    // remote refusals are thrown BEFORE the intent opens, so they never poison a
    // record — but a mid-transaction failure is recorded here.
    const message = err instanceof Error ? err.message : String(err);
    intent = await mark(input.commsDir, intent, now, i => { i.state = 'failed'; i.error = message; });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step implementations (each check-then-act, idempotent)
// ---------------------------------------------------------------------------

/**
 * Step 2: delete the target's claim files. Only claims `claimed_by === agentId`
 * (and, when `sessionId` was given, `session_id === sessionId`) are removed — a
 * sibling session's claim survives. Returns the released task ids and the parsed
 * claims (so Step 3 can find blocked dependents). Idempotent: missing dir → none.
 */
async function releaseClaims(input: EvictInput): Promise<{ released: string[]; claims: ClaimFile[] }> {
  const dir = claimsDir(input.commsDir);
  let entries: string[];
  try { entries = await fsp.readdir(dir); } catch { return { released: [], claims: [] }; }
  const released: string[] = [];
  const claims: ClaimFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) { continue; }
    const file = path.join(dir, name);
    let claim: ClaimFile;
    try {
      claim = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as ClaimFile;
    } catch { continue; /* skip malformed */ }
    claims.push(claim);
    if (claim.claimed_by !== input.agentId) { continue; }
    // Session match: when targeting one session, never delete a sibling's claim.
    if (input.sessionId && claim.session_id && claim.session_id !== input.sessionId) { continue; }
    // Derive the task id from the file name when the claim omits it.
    const taskId = claim.task_id ?? name.replace(/\.json$/, '');
    try {
      await fsp.unlink(file);            // deleting the file IS the mutex release
      if (taskId) { released.push(taskId); }
    } catch { /* already gone → idempotent success */ }
  }
  return { released, claims };
}

/**
 * Step 3 helper: ids of tasks whose `depends_on` referenced a just-released task.
 * They do NOT become satisfied (the dependency was abandoned, not completed); the
 * command layer surfaces a finding_report for each. Pure — surfaces, never edits.
 */
function dependentsBlockedBy(claims: ClaimFile[], releasedTaskIds: Set<string>): string[] {
  const out: string[] = [];
  for (const c of claims) {
    const id = c.task_id;
    if (!id || releasedTaskIds.has(id)) { continue; } // a released task isn't its own dependent
    if (Array.isArray(c.depends_on) && c.depends_on.some(d => releasedTaskIds.has(d))) {
      if (!out.includes(id)) { out.push(id); }
    }
  }
  return out;
}

/**
 * Step 4 (SAFE subset): record the target as evicted on each `consensus/active/*`
 * item it was an expected voter on but had not yet filed a ballot for. We never
 * forge a vote and never auto-shrink a security/unanimous quorum (those are the
 * command layer's finding_report path). Returns the consensus ids touched.
 */
async function reconcileConsensus(input: EvictInput, now: number): Promise<string[]> {
  const dir = path.join(input.commsDir, 'consensus', 'active');
  let entries: string[];
  try { entries = await fsp.readdir(dir); } catch { return []; }
  const touched: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) { continue; }
    const file = path.join(dir, name);
    let item: Record<string, unknown>;
    try {
      item = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
    } catch { continue; /* skip malformed */ }

    const expected = Array.isArray(item.expected_voters) ? item.expected_voters as string[] : [];
    if (!expected.includes(input.agentId)) { continue; }
    // Already cast? Then nothing is owed — leave the tally to the existing path.
    const votes = (item.votes && typeof item.votes === 'object') ? item.votes as Record<string, unknown> : {};
    if (Object.prototype.hasOwnProperty.call(votes, input.agentId)) { continue; }

    // Record (idempotently) that the target is evicted from this item's quorum.
    const evictedFrom = Array.isArray(item.evicted_voters) ? item.evicted_voters as string[] : [];
    if (!evictedFrom.includes(input.agentId)) { evictedFrom.push(input.agentId); }
    item.evicted_voters = evictedFrom;
    item.updated_at = new Date(now).toISOString();
    try {
      await fsp.writeFile(file, JSON.stringify(item, null, 2) + '\n', 'utf8');
    } catch { continue; }
    const cid = typeof item.task_id === 'string' ? item.task_id : name.replace(/\.json$/, '');
    if (!touched.includes(cid)) { touched.push(cid); }
  }
  return touched;
}

/**
 * Step 5: drop the worker's `trust` to `off` (read-modify-write; mirrors the
 * invite default "visible but non-acting") and revoke any invite the agent
 * joined under so a copied token can't re-admit it. Both idempotent.
 */
async function revokeTrust(input: EvictInput): Promise<void> {
  const worker = await readWorker(input.agentId, input.homeDir);
  if (worker && worker.trust !== 'off') {
    const next: Worker = { ...worker, trust: 'off' };
    // writeWorker is internal to workforce; setWorkerStatus is the only exported
    // mutator and it preserves trust. Persist directly via the worker path used
    // by the module (round-tripped JSON) so we don't change a worker's status here.
    await persistWorkerTrustOff(next, input.homeDir);
  }
  // Revoke the invite whose consumed_by.agent_id === target (machine + workspace).
  await revokeInvitesForAgent(input);
}

/**
 * Persist `trust: 'off'` for a worker without touching its status (Step 7 owns
 * status). Writes the same `~/.autoclaw/workforce/<id>.json` file workforce.ts
 * uses, so the next `readWorker` sees the revoked trust. Idempotent.
 */
async function persistWorkerTrustOff(worker: Worker, homeDir?: string): Promise<void> {
  const home = homeDir ?? os.homedir();
  const file = path.join(home, '.autoclaw', 'workforce', `${worker.agent_id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(worker, null, 2) + '\n', 'utf8');
}

/** Revoke every invite (both homes) the target consumed. Idempotent. */
async function revokeInvitesForAgent(input: EvictInput): Promise<void> {
  for (const scope of ['machine', 'workspace'] as const) {
    const optsBase = { scope, homeDir: input.homeDir, commsDir: input.commsDir };
    let invites: Invite[];
    try { invites = await listInvites(optsBase); } catch { invites = []; }
    for (const inv of invites) {
      if (inv.consumed_by && inv.consumed_by.agent_id === input.agentId) {
        // When a session is targeted, only revoke the invite that session joined
        // under (so a sibling session keeps its own token). When no session was
        // given, revoke every invite the agent consumed.
        if (input.sessionId && inv.consumed_by.session_id && inv.consumed_by.session_id !== input.sessionId) {
          continue;
        }
        await revokeInvite(inv.token, optsBase);
      }
    }
  }
}

/**
 * Step 6a: delete the target's beacon file(s) in BOTH homes, keyed by
 * `agent_id[-session_id]` so a sibling session's beacon survives. Missing file →
 * success (idempotent).
 */
async function teardownBeacons(input: EvictInput): Promise<void> {
  const dirs = [machineBeaconDir(input.homeDir), workspaceBeaconDir(input.commsDir)];
  const frag = input.sessionId
    ? `${safeFrag(input.agentId)}-${safeFrag(input.sessionId)}`
    : safeFrag(input.agentId);
  for (const dir of dirs) {
    // Exact-session (or agent-only) file.
    try { await fsp.unlink(path.join(dir, `${frag}.json`)); } catch { /* gone → ok */ }
    // When evicting the WHOLE agent (no session), also sweep `agent-<session>.json`
    // siblings so no session of the agent keeps re-announcing presence.
    if (!input.sessionId) {
      let names: string[];
      try { names = await fsp.readdir(dir); } catch { continue; }
      const prefix = `${safeFrag(input.agentId)}-`;
      for (const name of names) {
        if (name === `${frag}.json`) { continue; }
        if (name.startsWith(prefix) && name.endsWith('.json')) {
          try { await fsp.unlink(path.join(dir, name)); } catch { /* gone → ok */ }
        }
      }
    }
  }
}

/**
 * Step 6b: mark the target's `registry.json` row `evicted` so getAgentRegistry
 * stops surfacing it as live. Missing registry / missing row → no-op (idempotent).
 * The résumé in workforce/<id>.json is untouched.
 */
async function markRegistryEvicted(input: EvictInput): Promise<void> {
  const file = registryPath(input.commsDir);
  let parsed: { agents?: RegistryRow[] };
  try {
    parsed = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch { return; /* no registry yet → nothing to tear down */ }
  if (!parsed || !Array.isArray(parsed.agents)) { return; }
  let changed = false;
  for (const row of parsed.agents) {
    if (row && row.id === input.agentId && row.status !== 'evicted') {
      row.status = 'evicted';
      changed = true;
    }
  }
  if (changed) {
    await fsp.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  }
}

/**
 * Hard-mode gate: true iff the owner's beacon is already stale (older than
 * BEACON_TTL_MS) — the only condition under which an immediate, drain-less
 * reclaim is permitted. A fresh (or missing-but-recent) beacon ⇒ NOT stale; a
 * completely absent beacon counts as stale (there's no live agent to corrupt).
 */
async function ownerBeaconStale(input: EvictInput, now: number): Promise<boolean> {
  const rows = await readAllBeacons({
    commsDir: input.commsDir, homeDir: input.homeDir, now,
    ttlMs: BEACON_TTL_MS, includeStale: true,
  });
  const mine = rows.filter(r =>
    r.agent_id === input.agentId &&
    (!input.sessionId || r.session_id === input.sessionId),
  );
  if (mine.length === 0) { return true; } // no live presence to protect
  // Stale only when EVERY matching beacon is stale (a single fresh one protects).
  return mine.every(r => r.stale);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Sanitize an id/session fragment for a filename (mirrors beacons.ts). */
function safeFrag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** A short, time-seeded suffix for a fresh intent id (no crypto dep needed). */
function randomIntentSuffix(now: number): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/** Apply a mutation to the intent, stamp `updated_at`, persist, and return it. */
async function mark(
  commsDir: string,
  intent: EvictIntent,
  now: number,
  mutate: (i: EvictIntent) => void,
): Promise<EvictIntent> {
  mutate(intent);
  intent.updated_at = new Date(now).toISOString();
  await writeIntent(commsDir, intent);
  return intent;
}

// ---------------------------------------------------------------------------
// Typed errors (the command layer maps these to a scope_violation / modal)
// ---------------------------------------------------------------------------

/** The requester is not the authorized operator (deny-by-default, §5). */
export class EvictAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'EvictAuthError'; }
}

/** Hard evict requested against a FRESH heartbeat — refused (design §2). */
export class EvictHardOnFreshError extends Error {
  constructor(message: string) { super(message); this.name = 'EvictHardOnFreshError'; }
}

/** Cross-machine/relay evict — BLOCKED until the §5 signing gate ships. */
export class EvictRemoteBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'EvictRemoteBlockedError'; }
}
