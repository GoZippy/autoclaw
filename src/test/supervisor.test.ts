import * as assert from 'assert';
import {
  resolveRecovery,
  summarizeRecovery,
  DEFAULT_MAX_RETRIES,
  type RecoverySignals,
  type RecoveryAction,
  type ConcreteRecoveryAction,
  type ProposeAction,
} from '../orchestrator/supervisor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The concrete action behind a returned action (unwraps a propose wrapper). */
function unwrap(a: RecoveryAction): ConcreteRecoveryAction {
  return a.kind === 'propose' ? a.proposed : a;
}

/** Collect the distinct `kind`s present (after unwrapping proposals). */
function kinds(actions: RecoveryAction[]): string[] {
  return actions.map(a => unwrap(a).kind);
}

/** Serialize every action so rails can be asserted over the full payload. */
function serializeAll(actions: RecoveryAction[]): string {
  return JSON.stringify(actions);
}

suite('Self-Healing Supervisor — resolveRecovery', () => {

  // -------------------------------------------------------------------------
  // Rung: stale claim → steal_claim
  // -------------------------------------------------------------------------

  test('stale claim (owner unhealthy + expired) → steal_claim', () => {
    const signals: RecoverySignals = {
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }],
    };
    const actions = resolveRecovery(signals);
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'steal_claim');
    if (a.kind === 'steal_claim') {
      assert.strictEqual(a.task_id, 'B4');
      assert.strictEqual(a.owner, 'claude-code');
    }
  });

  test('stale claim NOT stolen when owner_healthy is true', () => {
    const actions = resolveRecovery({
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: true, expired: true }],
    });
    assert.deepStrictEqual(actions, []);
  });

  test('stale claim NOT stolen when not expired', () => {
    const actions = resolveRecovery({
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: false }],
    });
    assert.deepStrictEqual(actions, []);
  });

  test('no staleClaims signal → no steal_claim (no-op)', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('steal_claim'));
  });

  // -------------------------------------------------------------------------
  // Rung: dead dispatch → redispatch (bounded) / escalate (at ceiling)
  // -------------------------------------------------------------------------

  test('dead dispatch under the ceiling → redispatch with attempt = retries + 1', () => {
    const actions = resolveRecovery({
      deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: 0 }],
    });
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'redispatch');
    if (a.kind === 'redispatch') {
      assert.strictEqual(a.task_id, 'B7');
      assert.strictEqual(a.attempt, 1);
    }
  });

  test('dead dispatch one below the ceiling still redispatches', () => {
    const actions = resolveRecovery({
      deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: DEFAULT_MAX_RETRIES - 1 }],
    });
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'redispatch');
    if (a.kind === 'redispatch') {
      assert.strictEqual(a.attempt, DEFAULT_MAX_RETRIES);
    }
  });

  test('dead dispatch AT the ceiling → escalate, never another redispatch', () => {
    const actions = resolveRecovery({
      deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: DEFAULT_MAX_RETRIES }],
    });
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(unwrap(actions[0]).kind, 'escalate');
    assert.ok(!kinds(actions).includes('redispatch'));
  });

  test('dead dispatch OVER the ceiling → escalate', () => {
    const actions = resolveRecovery({
      deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: DEFAULT_MAX_RETRIES + 5 }],
    });
    assert.strictEqual(unwrap(actions[0]).kind, 'escalate');
  });

  test('custom maxRetries respected', () => {
    const actions = resolveRecovery(
      { deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: 4 }] },
      { maxRetries: 5 },
    );
    assert.strictEqual(unwrap(actions[0]).kind, 'redispatch');
  });

  test('no deadDispatches signal → no redispatch/escalate from this rung', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('redispatch'));
  });

  // -------------------------------------------------------------------------
  // Rung: failed twice → escalate
  // -------------------------------------------------------------------------

  test('failedTwice → escalate', () => {
    const actions = resolveRecovery({
      failedTwice: [{ task_id: 'C3', agent: 'claude-code', failCount: 2 }],
    });
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'escalate');
    if (a.kind === 'escalate') {
      assert.strictEqual(a.task_id, 'C3');
    }
  });

  test('no failedTwice signal → no escalate from this rung', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('escalate'));
  });

  // -------------------------------------------------------------------------
  // Rung: lease violation → revoke_trust
  // -------------------------------------------------------------------------

  test('lease violation → revoke_trust', () => {
    const actions = resolveRecovery({
      leaseViolations: [{ agent: 'kilocode', path: 'src/payments/x.ts', lane: 'SH' }],
    });
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'revoke_trust');
    if (a.kind === 'revoke_trust') {
      assert.strictEqual(a.agent, 'kilocode');
      assert.strictEqual(a.path, 'src/payments/x.ts');
    }
  });

  test('no leaseViolations signal → no revoke_trust', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('revoke_trust'));
  });

  // -------------------------------------------------------------------------
  // Rung: corrupt comms → quarantine
  // -------------------------------------------------------------------------

  test('corrupt comms → quarantine (never delete)', () => {
    const actions = resolveRecovery({
      corruptComms: [{ file: 'inboxes/shared/bad.json', detail: 'truncated JSON' }],
    });
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'quarantine');
    if (a.kind === 'quarantine') {
      assert.strictEqual(a.file, 'inboxes/shared/bad.json');
    }
  });

  test('no corruptComms signal → no quarantine', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('quarantine'));
  });

  // -------------------------------------------------------------------------
  // Rung: unreachable → mark_stale
  // -------------------------------------------------------------------------

  test('unreachable agent → mark_stale', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'hermes-01' }] });
    assert.strictEqual(actions.length, 1);
    const a = unwrap(actions[0]);
    assert.strictEqual(a.kind, 'mark_stale');
    if (a.kind === 'mark_stale') {
      assert.strictEqual(a.agent, 'hermes-01');
    }
  });

  test('no unreachable signal → no mark_stale', () => {
    const actions = resolveRecovery({ corruptComms: [{ file: 'f', detail: 'd' }] });
    assert.ok(!kinds(actions).includes('mark_stale'));
  });

  // -------------------------------------------------------------------------
  // Rung: drift → surface_finding ONLY (never auto-fix)
  // -------------------------------------------------------------------------

  test('drift → surface_finding only, never a fix/steal/redispatch kind', () => {
    const actions = resolveRecovery({
      driftFindings: [
        { type: 'task_status_mismatch', task_id: 'C1', description: 'state vs yaml differ' },
      ],
    });
    assert.strictEqual(actions.length, 1);
    const k = kinds(actions);
    assert.deepStrictEqual(k, ['surface_finding']);
    // Explicitly assert NO action-taking kind leaked in from drift.
    assert.ok(!k.includes('steal_claim'));
    assert.ok(!k.includes('redispatch'));
    assert.ok(!k.includes('escalate'));
    assert.ok(!k.includes('revoke_trust'));
    assert.ok(!k.includes('quarantine'));
  });

  test('no driftFindings signal → no surface_finding', () => {
    const actions = resolveRecovery({ unreachable: [{ agent: 'x' }] });
    assert.ok(!kinds(actions).includes('surface_finding'));
  });

  // -------------------------------------------------------------------------
  // Empty signals
  // -------------------------------------------------------------------------

  test('empty signals → no actions', () => {
    assert.deepStrictEqual(resolveRecovery({}), []);
  });

  // -------------------------------------------------------------------------
  // Hard rails across every action
  // -------------------------------------------------------------------------

  test('every returned action has a non-empty finding and none mention master', () => {
    const signals: RecoverySignals = {
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }],
      deadDispatches: [
        { task_id: 'B7', agent: 'kilocode', retries: 0 },
        { task_id: 'B8', agent: 'kilocode', retries: DEFAULT_MAX_RETRIES },
      ],
      failedTwice: [{ task_id: 'C3', agent: 'claude-code', failCount: 3 }],
      leaseViolations: [{ agent: 'kilocode', path: 'src/x.ts', lane: 'SH' }],
      corruptComms: [{ file: 'bad.json', detail: 'truncated' }],
      unreachable: [{ agent: 'hermes-01' }],
      driftFindings: [{ type: 'task_status_mismatch', task_id: 'C1', description: 'differ' }],
    };
    const actions = resolveRecovery(signals);
    assert.ok(actions.length >= 7);

    for (const a of actions) {
      assert.strictEqual(typeof a.finding, 'string');
      assert.ok(a.finding.trim().length > 0, 'finding must be non-empty');
      assert.strictEqual(typeof a.reason, 'string');
      assert.ok(a.reason.trim().length > 0, 'reason must be non-empty');
    }

    // RAIL 1: no action object anywhere references 'master'.
    assert.ok(
      !/master/i.test(serializeAll(actions)),
      'no recovery action may reference the master branch',
    );
  });

  test('rails hold in propose mode too (finding present, no master)', () => {
    const actions = resolveRecovery(
      {
        staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }],
        driftFindings: [{ type: 't', task_id: 'C1', description: 'd' }],
      },
      { mode: 'propose' },
    );
    for (const a of actions) {
      assert.ok(a.finding.trim().length > 0);
    }
    assert.ok(!/master/i.test(serializeAll(actions)));
  });

  // -------------------------------------------------------------------------
  // Propose mode wrapping
  // -------------------------------------------------------------------------

  test('propose mode wraps actions as { kind: "propose", proposed }', () => {
    const actions = resolveRecovery(
      { staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }] },
      { mode: 'propose' },
    );
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].kind, 'propose');
    const wrapper = actions[0] as ProposeAction;
    assert.strictEqual(wrapper.proposed.kind, 'steal_claim');
    assert.ok(wrapper.finding.trim().length > 0);
    // The wrapper mirrors the inner action's finding/reason.
    assert.strictEqual(wrapper.finding, wrapper.proposed.finding);
  });

  test('default mode is act (raw actions, not wrapped)', () => {
    const actions = resolveRecovery({
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }],
    });
    assert.strictEqual(actions[0].kind, 'steal_claim');
  });

  // -------------------------------------------------------------------------
  // summarizeRecovery
  // -------------------------------------------------------------------------

  test('summarizeRecovery returns a sensible one-liner', () => {
    const actions = resolveRecovery({
      staleClaims: [{ task_id: 'B4', owner: 'claude-code', owner_healthy: false, expired: true }],
      deadDispatches: [{ task_id: 'B7', agent: 'kilocode', retries: DEFAULT_MAX_RETRIES }],
    });
    const summary = summarizeRecovery(actions);
    assert.strictEqual(summary, '2 actions: steal_claim B4; escalate B7');
  });

  test('summarizeRecovery handles empty and singular', () => {
    assert.strictEqual(summarizeRecovery([]), '0 actions');
    const one = resolveRecovery({ unreachable: [{ agent: 'h1' }] });
    assert.strictEqual(summarizeRecovery(one), '1 action: mark_stale h1');
  });

  test('summarizeRecovery marks proposals', () => {
    const actions = resolveRecovery(
      { unreachable: [{ agent: 'h1' }] },
      { mode: 'propose' },
    );
    assert.strictEqual(summarizeRecovery(actions), '1 action: propose(mark_stale h1)');
  });
});
