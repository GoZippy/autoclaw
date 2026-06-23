/**
 * fleetDigest.test.ts — Pure-function coverage for FLEET-DIGEST.
 *
 * Mirrors the style of `webview-rendering.test.ts`: mocha tdd `suite`/`test`,
 * node `assert`, small factory helpers, no `vscode` / no fs. The module under
 * test is pure and deterministic (timestamp is an argument), so every
 * assertion is a plain value check.
 */

import * as assert from 'assert';
import {
  buildFleetDigest,
  serializeFleetDigest,
  FLEET_DIGEST_SCHEMA_VERSION,
  FLEET_STATUS_REL_PATH,
  type FleetDigestModel,
} from '../fleet/fleetDigest';
import type { AgentCard, FleetDashboardModel } from '../views/fleetViewModel';
import type { BoardModel } from '../orchestrator/board';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeCard(over: Partial<AgentCard> & { agentId: string }): AgentCard {
  return {
    name: over.name ?? over.agentId,
    avatar: '🤖',
    role: 'coder',
    host: 'local',
    origin: 'local',
    isRemote: false,
    currentTask: null,
    lastHeartbeat: '2026-06-22T00:00:00.000Z',
    lastHeartbeatLabel: '1m ago',
    capabilities: [],
    color: 'green',
    state: 'alive',
    parentId: null,
    detail: { claimedTasks: [], sprintAssignments: [], lastOutbound: [] },
    ...over,
  };
}

function makeModel(over: Partial<FleetDashboardModel> = {}): FleetDashboardModel {
  return {
    generatedAt: '2026-06-22T00:00:00.000Z',
    selfAgentId: 'claude-code',
    cards: [],
    tree: [],
    awaitingYou: [],
    activity: [],
    healthGrid: [],
    cost: { perAgent: [], totalTokens: 0, totalWallMs: 0, recentRationales: [] },
    presence: { working: 0, needsReview: 0, down: 0, total: 0, text: '' },
    pending: [],
    ...over,
  };
}

function makeBoard(over: Partial<BoardModel> = {}): BoardModel {
  return {
    generated_at: '2026-06-22T00:00:00.000Z',
    generator: 'orchestrator-loop',
    fleet_size: 0,
    live_count: 0,
    claimable: [],
    in_flight: [],
    awaiting_review: [],
    stuck: [],
    ...over,
  };
}

const TS = '2026-06-22T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Constants & schema
// ---------------------------------------------------------------------------

suite('fleetDigest — constants & schema', () => {
  test('schema version is pinned to 1', () => {
    assert.strictEqual(FLEET_DIGEST_SCHEMA_VERSION, 1);
  });

  test('digest carries the pinned schema_version', () => {
    const d = buildFleetDigest(makeModel(), TS);
    assert.strictEqual(d.schema_version, FLEET_DIGEST_SCHEMA_VERSION);
    assert.strictEqual(d.schema_version, 1);
  });

  test('the relative write path is the comms fleet-status file', () => {
    assert.strictEqual(
      FLEET_STATUS_REL_PATH,
      '.autoclaw/orchestrator/comms/fleet-status.json',
    );
  });

  test('generated_at echoes the caller-supplied timestamp (no Date.now)', () => {
    assert.strictEqual(buildFleetDigest(makeModel(), TS).generated_at, TS);
    // Epoch-ms input is normalized to ISO.
    const epoch = Date.parse(TS);
    assert.strictEqual(buildFleetDigest(makeModel(), epoch).generated_at, TS);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

suite('fleetDigest — determinism', () => {
  test('same input + timestamp ⇒ byte-identical serialization', () => {
    const model: FleetDigestModel = {
      ...makeModel({
        selfAgentId: 'claude-code',
        cards: [
          makeCard({ agentId: 'kilocode', role: 'reviewer', state: 'alive' }),
          makeCard({
            agentId: 'claude-code',
            role: 'coder',
            detail: { claimedTasks: ['B1', 'B2'], sprintAssignments: [], lastOutbound: [] },
          }),
        ],
        awaitingYou: [
          {
            id: 'm-1', from: 'kilocode', type: 'review_request',
            timestamp: TS, preview: 'review', deadline: null, overdue: false,
          },
        ],
        presence: { working: 1, needsReview: 1, down: 0, total: 2, text: '' },
      }),
      board: makeBoard({
        claimable: [{ task_id: 'C1', files: [], reason: 'open_no_claim' }],
        in_flight: [{
          task_id: 'B1', claimed_by: 'claude-code', claimed_at: TS,
          age_ms: 1000, owner_healthy: true,
        }],
        awaiting_review: [{
          task_id: 'A1', author: 'kilocode', opened_at: TS, age_ms: 1000,
          reviewers: ['claude-code'], votes_received: 0, votes_required: 1,
          rule: 'majority', approvals: 0, request_changes: 0,
        }],
      }),
    };
    const a = serializeFleetDigest(buildFleetDigest(model, TS));
    const b = serializeFleetDigest(buildFleetDigest(model, TS));
    assert.strictEqual(a, b);
  });

  test('serialization has sorted keys and a trailing newline', () => {
    const s = serializeFleetDigest(buildFleetDigest(makeModel(), TS));
    assert.ok(s.endsWith('\n'), 'must end with a trailing newline');
    // Top-level keys appear in sorted order.
    const topKeys = Object.keys(JSON.parse(s));
    assert.deepStrictEqual(topKeys, [...topKeys].sort());
    // agent_count sorts before schema_version, schema_version before self_agent_id.
    assert.ok(s.indexOf('"agent_count"') < s.indexOf('"schema_version"'));
    assert.ok(s.indexOf('"schema_version"') < s.indexOf('"self_agent_id"'));
  });

  test('agent order in output is sorted by id, independent of card order', () => {
    const d1 = buildFleetDigest(
      makeModel({ cards: [makeCard({ agentId: 'zeta' }), makeCard({ agentId: 'alpha' })] }),
      TS,
    );
    const d2 = buildFleetDigest(
      makeModel({ cards: [makeCard({ agentId: 'alpha' }), makeCard({ agentId: 'zeta' })] }),
      TS,
    );
    assert.deepStrictEqual(d1.agents.map(a => a.id), ['alpha', 'zeta']);
    assert.deepStrictEqual(d2.agents.map(a => a.id), ['alpha', 'zeta']);
  });

  test('current_llm is included only when the model card carries one', () => {
    const withLlm = makeCard({ agentId: 'a' });
    (withLlm as unknown as Record<string, unknown>).current_llm = 'claude-opus-4-8';
    const d = buildFleetDigest(
      makeModel({ cards: [withLlm, makeCard({ agentId: 'b' })] }),
      TS,
    );
    const a = d.agents.find(x => x.id === 'a')!;
    const b = d.agents.find(x => x.id === 'b')!;
    assert.strictEqual(a.current_llm, 'claude-opus-4-8');
    assert.ok(!('current_llm' in b), 'no current_llm key when the card lacks one');
  });
});

// ---------------------------------------------------------------------------
// Empty-fleet edge case
// ---------------------------------------------------------------------------

suite('fleetDigest — empty fleet', () => {
  test('empty model produces a valid, zeroed digest (no board)', () => {
    const d = buildFleetDigest(makeModel(), TS);
    assert.strictEqual(d.agent_count, 0);
    assert.strictEqual(d.live_count, 0);
    assert.strictEqual(d.awaiting_you, 0);
    assert.deepStrictEqual(d.agents, []);
    assert.deepStrictEqual(d.claims, { total: 0, by_agent: {} });
    assert.deepStrictEqual(d.lanes, {
      claimable: 0, in_flight: 0, awaiting_review: 0, stuck: 0,
    });
    assert.strictEqual(d.cycle, 'idle');
  });

  test('empty fleet still serializes cleanly with schema + timestamp', () => {
    const s = serializeFleetDigest(buildFleetDigest(makeModel(), TS));
    const parsed = JSON.parse(s);
    assert.strictEqual(parsed.schema_version, 1);
    assert.strictEqual(parsed.generated_at, TS);
  });
});

// ---------------------------------------------------------------------------
// Lane + awaiting + claims mapping
// ---------------------------------------------------------------------------

suite('fleetDigest — lane / awaiting / claims mapping', () => {
  test('lane counts mirror the board section lengths', () => {
    const board = makeBoard({
      claimable: [
        { task_id: 'C1', files: [], reason: 'open_no_claim' },
        { task_id: 'C2', files: [], reason: 'open_no_claim' },
      ],
      in_flight: [{
        task_id: 'B1', claimed_by: 'cc', claimed_at: TS, age_ms: 1, owner_healthy: true,
      }],
      awaiting_review: [{
        task_id: 'A1', author: 'kilocode', opened_at: TS, age_ms: 1,
        reviewers: ['cc'], votes_received: 0, votes_required: 1,
        rule: 'majority', approvals: 0, request_changes: 0,
      }],
      stuck: [
        { task_id: 'S1', reason: 'owner_offline', detail: 'x', age_ms: 1 },
        { task_id: 'S2', reason: 'claim_expired', detail: 'y', age_ms: 1 },
        { task_id: 'S3', reason: 'review_overdue', detail: 'z', age_ms: 1 },
      ],
    });
    const withBoard: FleetDigestModel = { ...makeModel(), board };
    const d = buildFleetDigest(withBoard, TS);
    assert.deepStrictEqual(d.lanes, {
      claimable: 2, in_flight: 1, awaiting_review: 1, stuck: 3,
    });
  });

  test('awaiting_you count maps from the model awaitingYou list', () => {
    const d = buildFleetDigest(
      makeModel({
        awaitingYou: [
          { id: 'm1', from: 'k', type: 'question', timestamp: TS, preview: 'a', deadline: null, overdue: false },
          { id: 'm2', from: 'k', type: 'review_request', timestamp: TS, preview: 'b', deadline: null, overdue: false },
        ],
      }),
      TS,
    );
    assert.strictEqual(d.awaiting_you, 2);
  });

  test('claims rollup is derived from per-card claimed tasks', () => {
    const d = buildFleetDigest(
      makeModel({
        cards: [
          makeCard({
            agentId: 'claude-code',
            detail: { claimedTasks: ['B1', 'B2'], sprintAssignments: [], lastOutbound: [] },
          }),
          makeCard({
            agentId: 'kilocode',
            detail: { claimedTasks: ['B3'], sprintAssignments: [], lastOutbound: [] },
          }),
          makeCard({ agentId: 'idle-agent' }), // no claims
        ],
      }),
      TS,
    );
    assert.strictEqual(d.claims.total, 3);
    assert.deepStrictEqual(d.claims.by_agent, { 'claude-code': 2, kilocode: 1 });
    const cc = d.agents.find(a => a.id === 'claude-code')!;
    assert.strictEqual(cc.inflight, 2);
    const idle = d.agents.find(a => a.id === 'idle-agent')!;
    assert.strictEqual(idle.inflight, 0);
  });

  test('per-agent done counts the reviews that agent authored', () => {
    const board = makeBoard({
      awaiting_review: [
        {
          task_id: 'A1', author: 'kilocode', opened_at: TS, age_ms: 1,
          reviewers: ['cc'], votes_received: 0, votes_required: 1,
          rule: 'majority', approvals: 0, request_changes: 0,
        },
        {
          task_id: 'A2', author: 'kilocode', opened_at: TS, age_ms: 1,
          reviewers: ['cc'], votes_received: 0, votes_required: 1,
          rule: 'majority', approvals: 0, request_changes: 0,
        },
      ],
    });
    const model: FleetDigestModel = {
      ...makeModel({ cards: [makeCard({ agentId: 'kilocode' }), makeCard({ agentId: 'cc' })] }),
      board,
    };
    const d = buildFleetDigest(model, TS);
    assert.strictEqual(d.agents.find(a => a.id === 'kilocode')!.done, 2);
    assert.strictEqual(d.agents.find(a => a.id === 'cc')!.done, 0);
  });

  test('live_count mirrors the panel presence.working rollup', () => {
    const d = buildFleetDigest(
      makeModel({ presence: { working: 3, needsReview: 1, down: 1, total: 5, text: '' } }),
      TS,
    );
    assert.strictEqual(d.live_count, 3);
  });

  test('cycle label follows board activity', () => {
    // reviewing wins over in-flight.
    const reviewing = buildFleetDigest(
      { ...makeModel({ cards: [makeCard({ agentId: 'a' })] }),
        board: makeBoard({
          in_flight: [{ task_id: 'B1', claimed_by: 'a', claimed_at: TS, age_ms: 1, owner_healthy: true }],
          awaiting_review: [{
            task_id: 'A1', author: 'a', opened_at: TS, age_ms: 1, reviewers: [],
            votes_received: 0, votes_required: 1, rule: 'majority', approvals: 0, request_changes: 0,
          }],
        }) },
      TS,
    );
    assert.strictEqual(reviewing.cycle, 'reviewing');

    const working = buildFleetDigest(
      { ...makeModel({ cards: [makeCard({ agentId: 'a' })] }),
        board: makeBoard({
          in_flight: [{ task_id: 'B1', claimed_by: 'a', claimed_at: TS, age_ms: 1, owner_healthy: true }],
        }) },
      TS,
    );
    assert.strictEqual(working.cycle, 'working');

    const waiting = buildFleetDigest(
      makeModel({ cards: [makeCard({ agentId: 'a' })] }),
      TS,
    );
    assert.strictEqual(waiting.cycle, 'waiting');
  });
});
