import * as assert from 'assert';
import {
  toResolvedRole, resolveRole, resolveType, resolveOrchestrator, resolveFleet,
  parseFleetManifest,
  type FleetManifest, type AgentSignal, type ResolveInput,
} from '../fleet/architecture';

const agents: AgentSignal[] = [
  { id: 'claude-code', can_orchestrate: false },
  { id: 'kilocode', agent_type: 'coder' },
  { id: 'sec-bot', agent_type: 'auditor' },
];

suite('fleet/architecture — toResolvedRole', () => {
  test('maps a canonical role string', () => {
    const r = toResolvedRole('reviewer');
    assert.strictEqual(r.canonical, 'reviewer');
    assert.strictEqual(r.custom, false);
    assert.strictEqual(r.cssClass, 'role-reviewer');
  });

  test('maps a synonym to its canonical role', () => {
    assert.strictEqual(toResolvedRole('security-auditor').canonical, 'security');
    assert.strictEqual(toResolvedRole('qa').canonical, 'tester');
  });

  test('preserves a custom label and colors it neutrally', () => {
    // A label with no canonical synonym/hint collision stays custom.
    const r = toResolvedRole('Vibe Marshal');
    assert.strictEqual(r.custom, true);
    assert.strictEqual(r.label, 'Vibe Marshal');
    assert.strictEqual(r.canonical, 'generalist');
    assert.strictEqual(r.cssClass, 'role-custom');
  });

  test('empty/blank → generalist (not custom)', () => {
    assert.strictEqual(toResolvedRole('').custom, false);
    assert.strictEqual(toResolvedRole('   ').canonical, 'generalist');
    assert.strictEqual(toResolvedRole(undefined).label, 'Generalist');
  });
});

suite('fleet/architecture — resolveRole precedence', () => {
  const manifest: FleetManifest = {
    agents: { 'claude-code': { role: 'orchestrator' }, 'kilocode': { role: 'my-custom-hat' } },
  };

  test('manifest role wins over everything', () => {
    const input: ResolveInput = { manifest, settingRoles: { 'claude-code': 'coder' }, inferRole: () => 'tester' };
    assert.strictEqual(resolveRole({ id: 'claude-code', agent_type: 'auditor' }, input).canonical, 'orchestrator');
  });

  test('manifest custom label is preserved', () => {
    const r = resolveRole({ id: 'kilocode' }, { manifest });
    assert.strictEqual(r.custom, true);
    assert.strictEqual(r.label, 'my-custom-hat');
  });

  test('settings override beats registry + inference', () => {
    const input: ResolveInput = { manifest: null, settingRoles: { x: 'security' }, inferRole: () => 'coder' };
    assert.strictEqual(resolveRole({ id: 'x', agent_type: 'coder' }, input).canonical, 'security');
  });

  test('registry agent_type beats inference', () => {
    const input: ResolveInput = { manifest: null, inferRole: () => 'coder' };
    assert.strictEqual(resolveRole({ id: 'x', agent_type: 'auditor' }, input).canonical, 'reviewer');
  });

  test('falls back to inference, then generalist', () => {
    assert.strictEqual(resolveRole({ id: 'x' }, { manifest: null, inferRole: () => 'tester' }).canonical, 'tester');
    assert.strictEqual(resolveRole({ id: 'x' }, { manifest: null }).canonical, 'generalist');
  });
});

suite('fleet/architecture — resolveType', () => {
  test('manifest type wins; unknown declared type degrades to coder', () => {
    const m: FleetManifest = { agents: { a: { agent_type: 'supervisor' }, b: { agent_type: 'wizard' } } };
    assert.strictEqual(resolveType({ id: 'a', agent_type: 'coder' }, m), 'supervisor');
    assert.strictEqual(resolveType({ id: 'b' }, m), 'coder');
  });

  test('falls back to registry type, then coder', () => {
    assert.strictEqual(resolveType({ id: 'x', agent_type: 'auditor' }, null), 'auditor');
    assert.strictEqual(resolveType({ id: 'x' }, null), 'coder');
  });
});

suite('fleet/architecture — resolveOrchestrator', () => {
  test('manifest.orchestrator wins when present in the fleet', () => {
    const m: FleetManifest = { orchestrator: 'kilocode' };
    assert.strictEqual(resolveOrchestrator(agents, { manifest: m, governancePrimary: 'claude-code' }), 'kilocode');
  });

  test('a manifest orchestrator not in the fleet is ignored (no ghost crown)', () => {
    const m: FleetManifest = { orchestrator: 'departed-agent' };
    assert.strictEqual(resolveOrchestrator(agents, { manifest: m, governancePrimary: 'claude-code' }), 'claude-code');
  });

  test('falls back to governance primary, then can_orchestrate, then null', () => {
    assert.strictEqual(resolveOrchestrator(agents, { manifest: null, governancePrimary: 'kilocode' }), 'kilocode');
    const withOrch: AgentSignal[] = [{ id: 'a' }, { id: 'b', can_orchestrate: true }];
    assert.strictEqual(resolveOrchestrator(withOrch, { manifest: null }), 'b');
    assert.strictEqual(resolveOrchestrator([{ id: 'a' }], { manifest: null }), null);
  });
});

suite('fleet/architecture — resolveFleet', () => {
  test('designated orchestrator is forced to the orchestrator role', () => {
    const m: FleetManifest = { orchestrator: 'claude-code' };
    const { roles, orchestrator } = resolveFleet(agents, { manifest: m });
    assert.strictEqual(orchestrator, 'claude-code');
    assert.strictEqual(roles['claude-code'].canonical, 'orchestrator');
    // others keep their own roles (agent_type 'coder' → coder; 'auditor' → reviewer)
    assert.strictEqual(roles['kilocode'].canonical, 'coder');
    assert.strictEqual(roles['sec-bot'].canonical, 'reviewer');
  });

  test('an explicit custom label on the orchestrator is NOT overridden', () => {
    const m: FleetManifest = { orchestrator: 'claude-code', agents: { 'claude-code': { role: 'Captain' } } };
    const { roles } = resolveFleet(agents, { manifest: m });
    assert.strictEqual(roles['claude-code'].custom, true);
    assert.strictEqual(roles['claude-code'].label, 'Captain');
  });
});

suite('fleet/architecture — parseFleetManifest', () => {
  test('parses valid JSON and tolerates a BOM', () => {
    const m = parseFleetManifest('﻿{"orchestrator":"x","agents":{"x":{"role":"coder"}}}');
    assert.strictEqual(m?.orchestrator, 'x');
  });

  test('returns null on garbage or a non-object agents field', () => {
    assert.strictEqual(parseFleetManifest('not json'), null);
    assert.strictEqual(parseFleetManifest('{"agents": 5}'), null);
  });
});
