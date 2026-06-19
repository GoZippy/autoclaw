/**
 * supervisor.ts — Self-healing recovery resolver (SH-1).
 *
 * Where {@link ./reconcile.ts | reconcile} only *detects* drift and broadcasts a
 * `system` message, the supervisor decides the *bounded, logged, reversible*
 * recovery actions the fleet should take in response to live failure signals. It
 * EXTENDS the detect-only sweep — it does not duplicate it: reconcile findings
 * arrive as one of the input signals here and are passed straight through as a
 * surface-only finding (never auto-fixed).
 *
 * `resolveRecovery` is a PURE function over plain objects — no fs, no vscode, no
 * clock. The same signals always produce the same actions, so the whole recovery
 * ladder is unit-testable in isolation. The thin orchestrator-loop adapter that
 * gathers signals from disk (board.json / beacons / leases / reconcile-report)
 * and actually performs + logs the actions lives elsewhere (the HEAL phase wiring);
 * this module is just the decision core.
 *
 * OWNER DECISION (2026-06-16): the default mode is **ACT-THEN-REPORT** (rails on),
 * NOT propose-only. The supervisor emits the raw recovery action to be performed
 * automatically, but every action carries a non-empty `finding` string — the
 * audit / `finding_report` content that MUST be emitted before or with the action.
 * A `propose` mode is available (wraps each action so a human approves first) but
 * is not the default.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §3 (the recovery ladder) and
 * the SH-1 manifest task in
 * .autoclaw/orchestrator/manifests/fleet-federation-ff.yaml.
 *
 * HARD RAILS (enforced here, asserted in src/test/supervisor.test.ts):
 *   1. No action ever references or targets the `master` branch — actions operate
 *      on task ids / agents / files only (recovery happens on branches/worktrees;
 *      promotion is always the existing merge gate).
 *   2. Every action object carries a non-empty `finding` string (act-then-report:
 *      the finding is the audit / `finding_report` content).
 *   3. Bounded retries: a dead dispatch with `retries >= maxRetries` yields
 *      `escalate`, never another `redispatch` — no infinite self-heal storms.
 *   4. A stale claim yields `steal_claim` ONLY when both `owner_healthy === false`
 *      AND `expired === true`; otherwise no action.
 *   5. Drift yields ONLY `surface_finding` — never an auto-fix action.
 */

// ---------------------------------------------------------------------------
// Input signals
// ---------------------------------------------------------------------------

/** A claim whose owner heartbeat is stale AND the claim is past its TTL. */
export interface StaleClaimSignal {
  task_id: string;
  owner: string;
  /** False when the owner's heartbeat is stale past TTL (recovery-eligible). */
  owner_healthy: boolean;
  /** True when the claim itself is past its TTL. */
  expired: boolean;
}

/** A task that was dispatched but whose agent process died. */
export interface DeadDispatchSignal {
  task_id: string;
  agent: string;
  /** How many times this dispatch has already been retried. */
  retries: number;
}

/** A task that has failed CI / review at least twice. */
export interface FailedTwiceSignal {
  task_id: string;
  agent: string;
  /** Number of CI/review failures observed (expected >= 2). */
  failCount: number;
}

/** An edit detected outside the agent's scope lease. */
export interface LeaseViolationSignal {
  agent: string;
  /** The offending path that fell outside the agent's lease. */
  path: string;
  /** The lane the agent was supposed to stay within. */
  lane: string;
}

/** A partial / corrupt comms write. */
export interface CorruptCommsSignal {
  file: string;
  detail: string;
}

/** An agent that has gone entirely silent (no presence signal at all). */
export interface UnreachableSignal {
  agent: string;
}

/**
 * An open reconcile drift finding. Mirrors the
 * {@link ../orchestrator/reconcile.ts | reconcile} `DriftRecord` shape (subset).
 */
export interface DriftFindingSignal {
  type: string;
  task_id: string;
  description: string;
}

/**
 * The full set of failure signals the supervisor reasons over. Every array is
 * optional and deny-by-default to empty — an absent signal means that rung is a
 * no-op this cycle.
 */
export interface RecoverySignals {
  staleClaims?: StaleClaimSignal[];
  deadDispatches?: DeadDispatchSignal[];
  failedTwice?: FailedTwiceSignal[];
  leaseViolations?: LeaseViolationSignal[];
  corruptComms?: CorruptCommsSignal[];
  unreachable?: UnreachableSignal[];
  driftFindings?: DriftFindingSignal[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Recovery resolution options. */
export interface RecoveryOptions {
  /**
   * `act` (default) → emit raw actions to be performed automatically
   * (act-then-report). `propose` → wrap each action as a `ProposeAction` so a
   * human approves it first.
   */
  mode?: 'act' | 'propose';
  /**
   * Maximum re-dispatch attempts before a dead dispatch escalates instead of
   * being retried again. Default {@link DEFAULT_MAX_RETRIES}.
   */
  maxRetries?: number;
}

/** Default re-dispatch ceiling (mirrors the ladder's "max N retries"). */
export const DEFAULT_MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Output actions (discriminated union on `kind`)
// ---------------------------------------------------------------------------

/**
 * Common fields every recovery action carries.
 *
 * RAIL 2: `finding` is ALWAYS a non-empty string — the audit / `finding_report`
 * content that must be emitted before or with the action (act-then-report).
 * No action ever carries a field that targets the `master` branch (RAIL 1).
 */
interface ActionBase {
  /** Human-readable why-this-action. */
  reason: string;
  /** The audit / finding_report text emitted with the action (never empty). */
  finding: string;
}

/** Steal a stale claim and re-open the task as claimable. */
export interface StealClaimAction extends ActionBase {
  kind: 'steal_claim';
  task_id: string;
  owner: string;
}

/** Re-dispatch a dead dispatch to the next-preferred capable agent. */
export interface RedispatchAction extends ActionBase {
  kind: 'redispatch';
  task_id: string;
  agent: string;
  /** The attempt number being made (= retries + 1). */
  attempt: number;
}

/** Escalate to a human (consensus / question) — stop auto-retry. */
export interface EscalateAction extends ActionBase {
  kind: 'escalate';
  task_id: string;
  reason: string;
}

/** Revoke trust for an off-lease edit (implies a `scope_violation` report). */
export interface RevokeTrustAction extends ActionBase {
  kind: 'revoke_trust';
  agent: string;
  path: string;
}

/** Quarantine a corrupt comms file — never delete, just move aside. */
export interface QuarantineAction extends ActionBase {
  kind: 'quarantine';
  file: string;
}

/** Mark an unreachable agent stale (honest presence) + rebalance hint. */
export interface MarkStaleAction extends ActionBase {
  kind: 'mark_stale';
  agent: string;
}

/** Surface a drift finding only — NEVER auto-fix (RAIL 5). */
export interface SurfaceFindingAction extends ActionBase {
  kind: 'surface_finding';
  detail: string;
}

/** Any concrete (act-mode) recovery action. */
export type ConcreteRecoveryAction =
  | StealClaimAction
  | RedispatchAction
  | EscalateAction
  | RevokeTrustAction
  | QuarantineAction
  | MarkStaleAction
  | SurfaceFindingAction;

/**
 * A proposal wrapper used in `propose` mode — the concrete action is held in
 * `proposed` so a human approves it before anything is performed.
 */
export interface ProposeAction extends ActionBase {
  kind: 'propose';
  proposed: ConcreteRecoveryAction;
}

/** Any action `resolveRecovery` can return. */
export type RecoveryAction = ConcreteRecoveryAction | ProposeAction;

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the bounded recovery actions for a set of failure signals.
 *
 * Pure: same `(signals, opts)` → same `RecoveryAction[]`. Each rung of the
 * recovery ladder fires only on its matching signal and is a no-op when that
 * signal is absent. In `propose` mode every concrete action is wrapped as a
 * {@link ProposeAction} so a human approves it first; in the default `act` mode
 * the raw concrete actions are returned (act-then-report).
 *
 * @param signals The on-disk failure signals (board / beacons / leases / drift).
 * @param opts    Mode + retry ceiling. Defaults: `act`, {@link DEFAULT_MAX_RETRIES}.
 * @returns The ordered list of recovery actions, each with a non-empty `finding`
 *          and never any reference to `master`.
 */
export function resolveRecovery(
  signals: RecoverySignals,
  opts: RecoveryOptions = {},
): RecoveryAction[] {
  const mode = opts.mode ?? 'act';
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const concrete: ConcreteRecoveryAction[] = [];

  // Rung 1 — stale claim → steal_claim.
  // RAIL 4: only when the owner is truly stale AND the claim is past TTL.
  for (const c of signals.staleClaims ?? []) {
    if (c.owner_healthy === false && c.expired === true) {
      concrete.push({
        kind: 'steal_claim',
        task_id: c.task_id,
        owner: c.owner,
        reason: `Claim on ${c.task_id} held by ${c.owner} is past TTL and the owner heartbeat is stale.`,
        finding: `steal_claim: re-opening ${c.task_id} (owner ${c.owner} stale + claim expired). Claim will be deleted and the task re-opened as claimable.`,
      });
    }
    // Otherwise: owner still healthy or claim not expired → no action (no-op).
  }

  // Rung 2 — dead dispatch → redispatch (bounded) else escalate.
  // RAIL 3: at/over the retry ceiling we escalate, never redispatch again.
  for (const d of signals.deadDispatches ?? []) {
    if (d.retries < maxRetries) {
      const attempt = d.retries + 1;
      concrete.push({
        kind: 'redispatch',
        task_id: d.task_id,
        agent: d.agent,
        attempt,
        reason: `Dispatch of ${d.task_id} to ${d.agent} died; retrying (attempt ${attempt}/${maxRetries}).`,
        finding: `redispatch: ${d.task_id} re-dispatched to the next-preferred capable agent, attempt ${attempt} of ${maxRetries} (previous owner ${d.agent} process died).`,
      });
    } else {
      concrete.push({
        kind: 'escalate',
        task_id: d.task_id,
        reason: `Dispatch of ${d.task_id} exceeded the ${maxRetries}-retry ceiling; escalating to a human.`,
        finding: `escalate: ${d.task_id} hit the re-dispatch ceiling (${d.retries} >= ${maxRetries}); opening a consensus/question item, auto-retry stopped.`,
      });
    }
  }

  // Rung 3 — failed CI/review twice → escalate (stop auto-retry).
  for (const f of signals.failedTwice ?? []) {
    concrete.push({
      kind: 'escalate',
      task_id: f.task_id,
      reason: `${f.task_id} failed CI/review ${f.failCount} times; escalating instead of retrying.`,
      finding: `escalate: ${f.task_id} failed ${f.failCount} times (owner ${f.agent}); opening a consensus/question item, never silently merging a red build.`,
    });
  }

  // Rung 4 — off-lease edit → revoke_trust (+ implied scope_violation report).
  for (const v of signals.leaseViolations ?? []) {
    concrete.push({
      kind: 'revoke_trust',
      agent: v.agent,
      path: v.path,
      reason: `${v.agent} edited ${v.path} outside its ${v.lane} lease.`,
      finding: `revoke_trust: ${v.agent} touched ${v.path} outside lane ${v.lane}; downgrading trust and filing a scope_violation.`,
    });
  }

  // Rung 5 — corrupt comms → quarantine (never delete).
  for (const cc of signals.corruptComms ?? []) {
    concrete.push({
      kind: 'quarantine',
      file: cc.file,
      reason: `Comms file ${cc.file} is corrupt or partially written: ${cc.detail}.`,
      finding: `quarantine: moving ${cc.file} aside (not deleting) and falling back to last-good; reason: ${cc.detail}.`,
    });
  }

  // Rung 6 — unreachable agent → mark_stale (honest presence) + rebalance hint.
  for (const u of signals.unreachable ?? []) {
    concrete.push({
      kind: 'mark_stale',
      agent: u.agent,
      reason: `${u.agent} has gone silent; marking it stale and rebalancing its open lanes.`,
      finding: `mark_stale: ${u.agent} marked stale in the panel (honest presence, never hidden); its open lanes are flagged for rebalance.`,
    });
  }

  // Rung 7 — drift → surface_finding ONLY (RAIL 5: never auto-fix).
  for (const dr of signals.driftFindings ?? []) {
    concrete.push({
      kind: 'surface_finding',
      detail: dr.description,
      reason: `Reconcile drift (${dr.type}) on ${dr.task_id} is open and unactioned.`,
      finding: `surface_finding: ${dr.type} on ${dr.task_id} — ${dr.description}. Surfaced only; drift is NEVER auto-fixed.`,
    });
  }

  if (mode === 'propose') {
    return concrete.map((a): ProposeAction => ({
      kind: 'propose',
      proposed: a,
      reason: a.reason,
      finding: a.finding,
    }));
  }

  return concrete;
}

// ---------------------------------------------------------------------------
// Summary helper
// ---------------------------------------------------------------------------

/** The concrete action behind a returned action (unwraps a propose wrapper). */
function unwrap(action: RecoveryAction): ConcreteRecoveryAction {
  return action.kind === 'propose' ? action.proposed : action;
}

/**
 * A primary task/agent/file label for an action, used in the one-line summary.
 */
function actionTarget(a: ConcreteRecoveryAction): string {
  switch (a.kind) {
    case 'steal_claim':
    case 'redispatch':
    case 'escalate':
      return a.task_id;
    case 'revoke_trust':
    case 'mark_stale':
      return a.agent;
    case 'quarantine':
      return a.file;
    case 'surface_finding':
      return a.detail;
  }
}

/**
 * Produce a human one-liner describing a set of resolved actions, e.g.
 * `"2 actions: steal_claim B4; escalate B7"`. Returns `"0 actions"` for an
 * empty list. Pure.
 */
export function summarizeRecovery(actions: RecoveryAction[]): string {
  if (actions.length === 0) {
    return '0 actions';
  }
  const parts = actions.map(a => {
    const inner = unwrap(a);
    const label = `${inner.kind} ${actionTarget(inner)}`;
    return a.kind === 'propose' ? `propose(${label})` : label;
  });
  const noun = actions.length === 1 ? 'action' : 'actions';
  return `${actions.length} ${noun}: ${parts.join('; ')}`;
}
