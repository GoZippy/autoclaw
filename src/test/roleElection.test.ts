import * as assert from 'assert';
import {
  needsToRoleNeeds, scoreNeed, electRole, distributeRoles, shouldReRole,
  AgentCard, RoleNeed,
} from '../fleet/roleElection';
import { NeedsVector } from '../fleet/needs';

/** Minimal needs-vector builder for the bits role election reads. */
function makeNeeds(partial: Partial<NeedsVector>): NeedsVector {
  return {
    open_lanes: [],
    role_coverage_gap: [],
    staleness_pressure: [],
    unclaimed_findings: 0,
    summary: '',
    ...partial,
  };
}

suite('Role election (SA-2)', () => {

  test('needsToRoleNeeds merges open lanes + gaps and dedupes (open-lane wins)', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'SA', role: 'tester', required_capabilities: ['jest'], unclaimed: 2 },
      ],
      // 'tester' is already covered by an open lane → bare gap entry must NOT win;
      // 'security' is a fresh bare gap → becomes a need with no lane / no caps.
      role_coverage_gap: ['tester', 'security'],
    });

    const roleNeeds = needsToRoleNeeds(needs);
    assert.strictEqual(roleNeeds.length, 2);

    const tester = roleNeeds.find(r => r.role === 'tester')!;
    assert.ok(tester, 'tester need present');
    assert.strictEqual(tester.lane, 'SA');               // open-lane entry won
    assert.deepStrictEqual(tester.required_capabilities, ['jest']);

    const security = roleNeeds.find(r => r.role === 'security')!;
    assert.ok(security, 'security gap present');
    assert.strictEqual(security.lane, undefined);
    assert.deepStrictEqual(security.required_capabilities, []);
  });

  test('scoreNeed: full capability match beats partial', () => {
    const need: RoleNeed = { role: 'coder', required_capabilities: ['ts', 'node'] };
    const full: AgentCard = { agent_id: 'a', skills: ['ts', 'node'] };
    const partial: AgentCard = { agent_id: 'b', skills: ['ts'] };
    assert.ok(scoreNeed(need, full) > scoreNeed(need, partial));
  });

  test('scoreNeed: can-play bonus raises the score', () => {
    const need: RoleNeed = { role: 'coder', required_capabilities: ['ts', 'node'] };
    const withPlay: AgentCard = { agent_id: 'a', skills: ['ts'], roles_can_play: ['coder'] };
    const without: AgentCard = { agent_id: 'b', skills: ['ts'] };
    assert.ok(scoreNeed(need, withPlay) > scoreNeed(need, without));
  });

  test('scoreNeed: cost reduces the score', () => {
    const need: RoleNeed = { role: 'coder', required_capabilities: ['ts'] };
    const cheap: AgentCard = { agent_id: 'a', skills: ['ts'], cost: 1 };
    const pricey: AgentCard = { agent_id: 'b', skills: ['ts'], cost: 4 };
    assert.ok(scoreNeed(need, cheap) > scoreNeed(need, pricey));
    // Non-positive cost is treated as 1 (finite, equal to cheap).
    const zeroCost: AgentCard = { agent_id: 'c', skills: ['ts'], cost: 0 };
    assert.strictEqual(scoreNeed(need, zeroCost), scoreNeed(need, cheap));
  });

  test('scoreNeed: zero when the agent fits nothing', () => {
    const need: RoleNeed = { role: 'security', required_capabilities: ['threat-model'] };
    const noFit: AgentCard = { agent_id: 'a', skills: ['react'], roles_can_play: ['coder'] };
    assert.strictEqual(scoreNeed(need, noFit), 0);
  });

  test('electRole picks the highest-scoring fillable need', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'C', role: 'coder', required_capabilities: ['ts'], unclaimed: 1 },
        { lane: 'T', role: 'tester', required_capabilities: ['jest', 'playwright'], unclaimed: 1 },
      ],
    });
    // Agent has the full tester stack but only partial coder → tester wins.
    const card: AgentCard = {
      agent_id: 'q', skills: ['jest', 'playwright'], roles_can_play: ['tester'],
    };
    const elected = electRole(needs, card);
    assert.ok(elected);
    assert.strictEqual(elected!.role, 'tester');
    assert.strictEqual(elected!.lane, 'T');
    assert.ok(elected!.score > 0);
  });

  test('electRole returns null when the agent fits nothing', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'S', role: 'security', required_capabilities: ['threat-model'], unclaimed: 1 },
      ],
    });
    const card: AgentCard = { agent_id: 'q', skills: ['react'], roles_can_play: ['coder'] };
    assert.strictEqual(electRole(needs, card), null);
  });

  test('distributeRoles: two agents whose top pick is the SAME role get distinct assignments', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'C', role: 'coder', required_capabilities: ['ts'], unclaimed: 1 },
        { lane: 'T', role: 'tester', required_capabilities: ['ts'], unclaimed: 1 },
      ],
    });
    // Both agents have 'ts' and can play both roles → both top-pick the same role,
    // but greedy distribution must hand them DISTINCT roles.
    const cards: AgentCard[] = [
      { agent_id: 'alice', skills: ['ts'], roles_can_play: ['coder', 'tester'] },
      { agent_id: 'bob', skills: ['ts'], roles_can_play: ['coder', 'tester'] },
    ];
    const out = distributeRoles(needs, cards);
    assert.strictEqual(out.length, 2);

    const roles = out.map(a => a.role).sort();
    assert.deepStrictEqual(roles, ['coder', 'tester']);   // distinct, both filled

    const agents = out.map(a => a.agent_id).sort();
    assert.deepStrictEqual(agents, ['alice', 'bob']);     // each agent assigned once
  });

  test('distributeRoles: stops when no positive scores remain', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'S', role: 'security', required_capabilities: ['threat-model'], unclaimed: 1 },
      ],
    });
    const cards: AgentCard[] = [
      { agent_id: 'a', skills: ['react'], roles_can_play: ['coder'] },
    ];
    assert.deepStrictEqual(distributeRoles(needs, cards), []);
  });

  test('shouldReRole: returns a new role only when the lane is drained AND a different better role is open', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'T', role: 'tester', required_capabilities: ['jest'], unclaimed: 1 },
      ],
    });
    const card: AgentCard = { agent_id: 'q', skills: ['jest'], roles_can_play: ['coder', 'tester'] };

    // Lane drained + a different fillable role (tester) is open → propose re-role.
    const reroled = shouldReRole({ currentRole: 'coder', currentLaneDrained: true, needs, card });
    assert.ok(reroled);
    assert.strictEqual(reroled!.role, 'tester');
  });

  test('shouldReRole: null when the current lane is NOT drained', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'T', role: 'tester', required_capabilities: ['jest'], unclaimed: 1 },
      ],
    });
    const card: AgentCard = { agent_id: 'q', skills: ['jest'], roles_can_play: ['tester'] };
    assert.strictEqual(
      shouldReRole({ currentRole: 'coder', currentLaneDrained: false, needs, card }),
      null,
    );
  });

  test('shouldReRole: null when the only open role is the one already held', () => {
    const needs = makeNeeds({
      open_lanes: [
        { lane: 'C', role: 'coder', required_capabilities: ['ts'], unclaimed: 1 },
      ],
    });
    const card: AgentCard = { agent_id: 'q', skills: ['ts'], roles_can_play: ['coder'] };
    // Lane drained but the best (and only) fit is the role it already holds → stay.
    assert.strictEqual(
      shouldReRole({ currentRole: 'coder', currentLaneDrained: true, needs, card }),
      null,
    );
  });
});
