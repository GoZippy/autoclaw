/**
 * premium-advanced.test.ts — public-side tests for the advanced-orchestration
 * seam (3rd premium engine).
 *
 * Verifies the parts that live in the PUBLIC repo (the real engine lives in the
 * private @autoclaw/premium package and is tested there):
 *  - the free fallback `runAdvancedOrchestration` returns the typed result shape
 *    (so the public build works without the private package);
 *  - `buildAdvancedInput` parses the dependency-free descriptor, merges agents
 *    from the registry when omitted, and returns a starter template when there's
 *    nothing usable to plan.
 *
 * Host-free (no `vscode`), fully offline.
 */

import * as assert from 'assert';

import { createUnavailablePremiumApi } from '../premium/unavailablePremium';
import { buildAdvancedInput, ADVANCED_INPUT_TEMPLATE } from '../premium/advancedInput';

const WS = '/tmp/adv-ws';

suite('premium-advanced', function () {
  suite('free fallback', function () {
    test('runAdvancedOrchestration returns the typed result shape', async function () {
      const api = createUnavailablePremiumApi({ extensionPath: '.' });
      assert.ok(typeof api.runAdvancedOrchestration === 'function', 'fallback present');
      const res = await api.runAdvancedOrchestration!({
        workspaceRoot: WS,
        objective: 'speed',
        tasks: [{ id: 'T1' }],
        agents: [{ id: 'a1' }],
      });
      assert.ok(res.markdown.includes('Advanced Orchestration'), 'markdown');
      assert.deepStrictEqual(res.assignments, []);
      assert.deepStrictEqual(res.criticalPath, []);
      assert.strictEqual(res.projectedSprints, 0);
      assert.strictEqual(res.featureTier, 'pro');
      assert.ok(typeof res.createdAt === 'string');
    });
  });

  suite('buildAdvancedInput', function () {
    test('valid descriptor → ok input', function () {
      const r = buildAdvancedInput({
        workspaceRoot: WS,
        inputJson: JSON.stringify({ objective: 'cost', tasks: [{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }], agents: [{ id: 'a1' }] }),
      });
      assert.ok(r.ok, 'ok');
      if (r.ok) {
        assert.strictEqual(r.input.tasks.length, 2);
        assert.strictEqual(r.input.agents.length, 1);
        assert.strictEqual(r.input.objective, 'cost');
        assert.strictEqual(r.input.workspaceRoot, WS);
      }
    });

    test('agents omitted → merged from registry.json', function () {
      const r = buildAdvancedInput({
        workspaceRoot: WS,
        inputJson: JSON.stringify({ tasks: [{ id: 'T1' }] }),
        registryJson: JSON.stringify({ agents: [{ id: 'claude-code', capabilities: ['typescript'] }, { id: 'kilocode' }] }),
      });
      assert.ok(r.ok, 'ok');
      if (r.ok) {
        assert.deepStrictEqual(r.input.agents.map((a) => a.id).sort(), ['claude-code', 'kilocode']);
        assert.deepStrictEqual(r.input.agents.find((a) => a.id === 'claude-code')!.capabilities, ['typescript']);
      }
    });

    test('no input → starter template', function () {
      const r = buildAdvancedInput({ workspaceRoot: WS });
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.strictEqual(r.reason, 'no_input');
        assert.strictEqual(r.template, ADVANCED_INPUT_TEMPLATE);
        assert.ok(JSON.parse(r.template).tasks.length > 0, 'template is valid JSON with tasks');
      }
    });

    test('invalid json → template (no throw)', function () {
      const r = buildAdvancedInput({ workspaceRoot: WS, inputJson: '{ not json' });
      assert.strictEqual(r.ok, false);
      if (!r.ok) { assert.strictEqual(r.reason, 'invalid_json'); }
    });

    test('tasks present but no agents anywhere → no_agents', function () {
      const r = buildAdvancedInput({ workspaceRoot: WS, inputJson: JSON.stringify({ tasks: [{ id: 'T1' }] }) });
      assert.strictEqual(r.ok, false);
      if (!r.ok) { assert.strictEqual(r.reason, 'no_agents'); }
    });
  });
});
