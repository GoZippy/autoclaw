/**
 * triggerHooks.test.ts — HKS-1..3 (agent-trigger-hooks spec).
 *
 * Covers: hooks.yaml parsing, zero-config no-op, the pure matcher (filters,
 * cooldown, hourly cap, HALT, via_hook exclusion, target templates), the
 * executor's audit trail, message→event construction (incl. self-amplification
 * tagging), the fleet HALT kill switch, and the dispatchWork HALT gate.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseHooksYaml,
  loadHookRules,
  matchHooks,
  freshHookState,
  renderTarget,
  executeHook,
  buildHookEventFromMessageFile,
  isFleetHalted,
  setFleetHalted,
  HALT_FILE_REL,
  DEFAULT_MAX_FIRINGS_PER_HOUR,
} from '../hooks/triggerHooks';
import type { HookRule, HookEvent, HookDecision } from '../hooks/triggerHooks';
import { dispatchWork, LOOP_SIDE_CAR_DIR } from '../orchestratorLoop';
import type { WorkPackage } from '../orchestratorLoop';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-hooks-'));
}

function rule(overrides: Partial<HookRule> = {}): HookRule {
  return {
    id: 'wake-reviewer',
    on: 'message',
    filter: { type: 'review_request' },
    action: 'dispatch',
    target: '{{to}}',
    ...overrides,
  };
}

function msgEvent(payload: Record<string, unknown> = {}, via_hook?: string): HookEvent {
  return { on: 'message', payload: { type: 'review_request', to: 'kilocode', ...payload }, via_hook };
}

// ---------------------------------------------------------------------------
// parseHooksYaml / loadHookRules
// ---------------------------------------------------------------------------

suite('TriggerHooks — hooks.yaml parsing', () => {
  test('parses a rule with an inline filter map', () => {
    const rules = parseHooksYaml([
      'hooks:',
      '  - id: wake-reviewer',
      '    on: message',
      '    filter: { type: review_request, to: kilocode }',
      '    action: dispatch',
      '    target: "{{to}}"',
      '    cooldown_seconds: 120',
    ].join('\n'));
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].id, 'wake-reviewer');
    assert.strictEqual(rules[0].on, 'message');
    assert.deepStrictEqual(rules[0].filter, { type: 'review_request', to: 'kilocode' });
    assert.strictEqual(rules[0].target, '{{to}}');
    assert.strictEqual(rules[0].cooldown_seconds, 120);
  });

  test('parses a nested filter block with numeric coercion', () => {
    const rules = parseHooksYaml([
      'hooks:',
      '  - id: surface-stall',
      '    on: heartbeat_stall',
      '    filter:',
      '      seconds_stale_gte: 600',
      '    action: notify',
    ].join('\n'));
    assert.strictEqual(rules.length, 1);
    assert.deepStrictEqual(rules[0].filter, { seconds_stale_gte: 600 });
  });

  test('drops invalid rules (unknown on/action, missing id) with warnings; never throws', () => {
    const warnings: string[] = [];
    const rules = parseHooksYaml([
      'hooks:',
      '  - id: bad-on',
      '    on: full-moon',
      '    action: notify',
      '  - id: bad-action',
      '    on: message',
      '    action: self-destruct',
      '  - on: message',
      '    action: notify',
      '  - id: good',
      '    on: message',
      '    action: notify',
    ].join('\n'), (w) => warnings.push(w));
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].id, 'good');
    assert.strictEqual(warnings.length, 3);
  });

  test('empty/garbage text yields no rules', () => {
    assert.deepStrictEqual(parseHooksYaml(''), []);
    assert.deepStrictEqual(parseHooksYaml('not yaml at all\n%%%'), []);
  });

  test('loadHookRules: missing file ⇒ [] (zero-config no-op)', async () => {
    const root = makeTmpRoot();
    assert.deepStrictEqual(await loadHookRules(root), []);
  });
});

// ---------------------------------------------------------------------------
// matchHooks (pure)
// ---------------------------------------------------------------------------

suite('TriggerHooks — matcher', () => {
  test('fires on a matching event and renders the target template', () => {
    const state = freshHookState(1000);
    const decisions = matchHooks([rule()], msgEvent(), state, 1000);
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].outcome, 'fire');
    assert.strictEqual(decisions[0].target, 'kilocode');
  });

  test('filter mismatch and wrong event kind produce no decision', () => {
    const state = freshHookState(1000);
    assert.strictEqual(matchHooks([rule()], msgEvent({ type: 'task_complete' }), state, 1000).length, 0);
    assert.strictEqual(matchHooks([rule({ on: 'consensus' })], msgEvent(), state, 1000).length, 0);
  });

  test('_gte numeric comparator', () => {
    const r = rule({ id: 'stall', on: 'heartbeat_stall', filter: { seconds_stale_gte: 600 }, action: 'notify', target: undefined });
    const state = freshHookState(1000);
    const stale: HookEvent = { on: 'heartbeat_stall', payload: { agent_id: 'a', seconds_stale: 700 } };
    const fresh: HookEvent = { on: 'heartbeat_stall', payload: { agent_id: 'a', seconds_stale: 10 } };
    assert.strictEqual(matchHooks([r], stale, state, 1000)[0]?.outcome, 'fire');
    assert.strictEqual(matchHooks([r], fresh, state, 999_000).length, 0);
  });

  test('via_hook-tagged events never match anything (no self-amplification)', () => {
    const state = freshHookState(1000);
    assert.strictEqual(matchHooks([rule()], msgEvent({}, 'some-rule'), state, 1000).length, 0);
  });

  test('HALT suppresses every matching rule', () => {
    const state = freshHookState(1000);
    state.halted = true;
    const decisions = matchHooks([rule()], msgEvent(), state, 1000);
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].outcome, 'suppressed_halt');
    assert.strictEqual(state.firingsThisHour, 0, 'suppressed firings do not consume the hourly budget');
  });

  test('cooldown: second matching event within the window is suppressed', () => {
    const state = freshHookState(0);
    const first = matchHooks([rule({ cooldown_seconds: 300 })], msgEvent(), state, 0);
    assert.strictEqual(first[0].outcome, 'fire');
    const second = matchHooks([rule({ cooldown_seconds: 300 })], msgEvent(), state, 10_000);
    assert.strictEqual(second[0].outcome, 'suppressed_cooldown');
    const third = matchHooks([rule({ cooldown_seconds: 300 })], msgEvent(), state, 301_000);
    assert.strictEqual(third[0].outcome, 'fire', 'fires again once the cooldown elapses');
  });

  test('hourly cap suppresses and the window rolls', () => {
    const state = freshHookState(0);
    state.firingsThisHour = DEFAULT_MAX_FIRINGS_PER_HOUR;
    const capped = matchHooks([rule({ cooldown_seconds: 0 })], msgEvent(), state, 1000);
    assert.strictEqual(capped[0].outcome, 'suppressed_cap');
    // One hour later the window rolls and the rule fires again.
    const afterRoll = matchHooks([rule({ cooldown_seconds: 0 })], msgEvent(), state, 3_600_001);
    assert.strictEqual(afterRoll[0].outcome, 'fire');
  });

  test('renderTarget: unknown fields render empty', () => {
    assert.strictEqual(renderTarget('{{to}}-{{missing}}', { to: 'x' }), 'x-');
    assert.strictEqual(renderTarget(undefined, {}), undefined);
  });
});

// ---------------------------------------------------------------------------
// executeHook (audit + actions via injected deps)
// ---------------------------------------------------------------------------

suite('TriggerHooks — executor', () => {
  function decision(outcome: HookDecision['outcome'], overrides: Partial<HookDecision> = {}): HookDecision {
    return { rule: rule(), event: msgEvent(), target: 'kilocode', outcome, ...overrides };
  }

  function readAudit(root: string): Array<Record<string, unknown>> {
    const p = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'hooks', 'audit.jsonl');
    if (!fs.existsSync(p)) { return []; }
    return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  }

  test('fire + dispatch: calls the injected dispatch and audits hook_fired', async () => {
    const root = makeTmpRoot();
    const calls: string[] = [];
    await executeHook(decision('fire'), {
      workspaceRoot: root,
      dispatch: async (target) => { calls.push(target); },
    });
    assert.deepStrictEqual(calls, ['kilocode']);
    const audit = readAudit(root);
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].result, 'hook_fired');
    // comms-log mirror exists too
    const log = fs.readFileSync(path.join(root, '.autoclaw', 'orchestrator', 'comms', 'comms-log.jsonl'), 'utf8');
    assert.ok(log.includes('hook_fired'));
  });

  test('suppressed decision audits hook_suppressed and never dispatches', async () => {
    const root = makeTmpRoot();
    const calls: string[] = [];
    await executeHook(decision('suppressed_halt'), {
      workspaceRoot: root,
      dispatch: async (target) => { calls.push(target); },
    });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(readAudit(root)[0].result, 'hook_suppressed');
  });

  test('notify action fires the notify dep and audits', async () => {
    const root = makeTmpRoot();
    const notes: string[] = [];
    await executeHook(decision('fire', { rule: rule({ action: 'notify' }) }), {
      workspaceRoot: root,
      notify: (m) => { notes.push(m); },
    });
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(readAudit(root)[0].result, 'hook_fired');
  });

  test('unimplemented action (relay) audits hook_error, dispatch with empty target audits hook_error', async () => {
    const root = makeTmpRoot();
    await executeHook(decision('fire', { rule: rule({ action: 'relay' }) }), { workspaceRoot: root });
    await executeHook(decision('fire', { target: '' }), { workspaceRoot: root, dispatch: async () => { /* noop */ } });
    const results = readAudit(root).map(a => a.result);
    assert.deepStrictEqual(results, ['hook_error', 'hook_error']);
  });
});

// ---------------------------------------------------------------------------
// Message-file → event (self-amplification tagging)
// ---------------------------------------------------------------------------

suite('TriggerHooks — message events', () => {
  test('builds a message event from an inbox file', async () => {
    const root = makeTmpRoot();
    const inbox = path.join(root, 'inboxes', 'kilocode');
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, 'm1.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'review_request', from: 'claude-code', task_id: 'T1' }));
    const ev = await buildHookEventFromMessageFile(file);
    assert.ok(ev);
    assert.strictEqual(ev!.on, 'message');
    assert.strictEqual(ev!.payload.type, 'review_request');
    assert.strictEqual(ev!.payload.to, 'kilocode', 'inbox dirname fills a missing to');
    assert.strictEqual(ev!.via_hook, undefined);
  });

  test('orchestrator-loop task_claim wakes are tagged via_hook (no re-trigger)', async () => {
    const root = makeTmpRoot();
    const shared = path.join(root, 'inboxes', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    const file = path.join(shared, 'claim.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'task_claim', from: 'orchestrator-loop', task_id: 'next-kilocode' }));
    const ev = await buildHookEventFromMessageFile(file);
    assert.strictEqual(ev!.via_hook, 'orchestrator-loop');
    assert.strictEqual(matchHooks([rule({ filter: { type: 'task_claim' } })], ev!, freshHookState(0), 0).length, 0);
  });

  test('malformed json ⇒ null', async () => {
    const root = makeTmpRoot();
    const file = path.join(root, 'broken.json');
    fs.writeFileSync(file, '{not json');
    assert.strictEqual(await buildHookEventFromMessageFile(file), null);
  });
});

// ---------------------------------------------------------------------------
// Fleet HALT kill switch + dispatchWork gate
// ---------------------------------------------------------------------------

suite('TriggerHooks — fleet HALT kill switch', () => {
  test('setFleetHalted toggles the HALT file with a reason body', async () => {
    const root = makeTmpRoot();
    assert.strictEqual(isFleetHalted(root), false);
    await setFleetHalted(root, true, 'testing');
    assert.strictEqual(isFleetHalted(root), true);
    const body = JSON.parse(fs.readFileSync(path.join(root, HALT_FILE_REL), 'utf8'));
    assert.strictEqual(body.reason, 'testing');
    await setFleetHalted(root, false);
    assert.strictEqual(isFleetHalted(root), false);
  });

  test('dispatchWork refuses to dispatch while the fleet is halted', async () => {
    const root = makeTmpRoot();
    await setFleetHalted(root, true, 'unit test');
    const pkg: WorkPackage = {
      type: 'work_package', taskId: 'H1', taskName: 'halted task', description: '',
      filePaths: [], successCriteria: ['pass'], sprint: 1,
      assignToVendor: 'kilocode', priority: 'low', timeBudgetMs: 0,
    };
    const res = await dispatchWork(root, pkg);
    assert.strictEqual(res, null, 'HALT engaged ⇒ no dispatch');
    const sidecar = path.join(root, LOOP_SIDE_CAR_DIR);
    assert.ok(!fs.existsSync(sidecar) || fs.readdirSync(sidecar).length === 0, 'no sidecar file written');

    // Release and verify dispatch works again (the gate is the only change).
    await setFleetHalted(root, false);
    const res2 = await dispatchWork(root, pkg);
    assert.ok(res2 !== null, 'resume ⇒ dispatch proceeds');
    assert.ok(fs.existsSync(res2!));
  });
});
