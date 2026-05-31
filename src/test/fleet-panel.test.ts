/**
 * fleet-panel.test.ts — Unit tests for the Fleet panel pure render-data builders
 * (`src/views/fleetViewModelBuilders.ts`) and the read-only data layer
 * (`src/panel/fleetData.ts`).
 *
 * No `vscode` import — runs in plain Node/Mocha (TDD UI), consistent with the
 * project's other unit suites (lmd.test.ts, orchestrator.test.ts).
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  relativeAge,
  healthColor,
  buildHealthGrid,
  messagePreview,
  buildOutboundSummaries,
  avatarFor,
  buildAgentCards,
  buildAgentTree,
  buildAwaitingYou,
  activityKindForMessage,
  buildActivityFeed,
  buildCostLedger,
  buildPresence,
  buildFleetDashboard,
  mergeFleetHeartbeats,
  fleetKey,
  LOCAL_HOST,
  type RawHeartbeat,
  type RawAgentProfile,
  type RawMessage,
  type RawInboxState,
  type AgentCardInputs,
  type FleetDashboardInputs,
} from '../views/fleetViewModelBuilders';
import type { AgentHealth } from '../lmd/types';
import type { CostLedgerEntry, AwaitingItem } from '../views/fleetViewModel';
import {
  gatherFleetData,
  deriveHealthFromHeartbeats,
  readAgentProfiles,
  readClaims,
} from '../panel/fleetData';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-21T12:00:00.000Z').getTime();

function iso(offsetSec: number): string {
  return new Date(NOW + offsetSec * 1000).toISOString();
}

function health(agentId: string, state: AgentHealth['state'], ageSec: number): AgentHealth {
  return {
    agentId,
    state,
    lastHeartbeatAt: iso(-ageSec),
    missedHeartbeats: state === 'alive' ? 0 : 3,
    queueDepth: 2,
  };
}

function msg(over: Partial<RawMessage>): RawMessage {
  return {
    id: over.id ?? 'm1',
    from: over.from ?? 'a',
    to: over.to ?? 'b',
    type: over.type ?? 'question',
    timestamp: over.timestamp ?? iso(-10),
    requires_response: over.requires_response,
    response_deadline: over.response_deadline,
    payload: over.payload,
    task_id: over.task_id,
  };
}

// ---------------------------------------------------------------------------

suite('Fleet panel — time + colour helpers', () => {
  test('relativeAge formats seconds/minutes/hours/days', () => {
    assert.strictEqual(relativeAge(iso(-2), NOW), 'now');
    assert.strictEqual(relativeAge(iso(-30), NOW), '30s ago');
    assert.strictEqual(relativeAge(iso(-180), NOW), '3m ago');
    assert.strictEqual(relativeAge(iso(-7200), NOW), '2h ago');
    assert.strictEqual(relativeAge(iso(-172800), NOW), '2d ago');
  });

  test('relativeAge handles unparseable input', () => {
    assert.strictEqual(relativeAge('not-a-date', NOW), '—');
  });

  test('healthColor maps states to traffic-light colours', () => {
    assert.strictEqual(healthColor('alive'), 'green');
    assert.strictEqual(healthColor('degraded'), 'amber');
    assert.strictEqual(healthColor('stalled'), 'red');
    assert.strictEqual(healthColor('dead'), 'red');
  });
});

suite('Fleet panel — health grid', () => {
  test('builds rows and sorts worst-health-first', () => {
    const rows = buildHealthGrid(
      [
        health('alive-agent', 'alive', 5),
        health('dead-agent', 'dead', 600),
        health('degraded-agent', 'degraded', 90),
      ],
      NOW
    );
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].agentId, 'dead-agent');
    assert.strictEqual(rows[0].color, 'red');
    assert.strictEqual(rows[1].agentId, 'degraded-agent');
    assert.strictEqual(rows[2].agentId, 'alive-agent');
    assert.strictEqual(rows[2].color, 'green');
  });

  test('queueDepth defaults to 0 when absent', () => {
    const rows = buildHealthGrid(
      [{ agentId: 'x', state: 'alive', lastHeartbeatAt: iso(-1), missedHeartbeats: 0 }],
      NOW
    );
    assert.strictEqual(rows[0].queueDepth, 0);
  });
});

suite('Fleet panel — message previews + outbound', () => {
  test('messagePreview prefers payload.message then falls back', () => {
    assert.strictEqual(
      messagePreview(msg({ payload: { message: '  hello   world ' } })),
      'hello world'
    );
    assert.strictEqual(
      messagePreview(msg({ type: 'system', to: 'shared', payload: {} })),
      'system → shared'
    );
  });

  test('messagePreview truncates long text', () => {
    const long = 'x'.repeat(200);
    const out = messagePreview(msg({ payload: { summary: long } }));
    assert.strictEqual(out.length, 100);
    assert.ok(out.endsWith('…'));
  });

  test('buildOutboundSummaries returns newest-first, capped', () => {
    const messages = [
      msg({ id: 'o1', from: 'me', timestamp: iso(-100) }),
      msg({ id: 'o2', from: 'me', timestamp: iso(-10) }),
      msg({ id: 'o3', from: 'other', timestamp: iso(-5) }),
      msg({ id: 'o4', from: 'me', timestamp: iso(-50) }),
    ];
    const out = buildOutboundSummaries(messages, 'me', 2);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, 'o2');
    assert.strictEqual(out[1].id, 'o4');
  });
});

suite('Fleet panel — agent cards', () => {
  test('avatarFor uses initials of two words, else first 2 chars', () => {
    assert.strictEqual(avatarFor('claude-code'), 'CC');
    assert.strictEqual(avatarFor('kilocode', 'Kilo Code'), 'KC');
    assert.strictEqual(avatarFor('x'), 'X');
  });

  function cardInputs(): AgentCardInputs {
    return {
      profiles: [
        { id: 'claude-code', name: 'Claude Code', role: 'Panel', capabilities: ['ui'] },
        { id: 'kilocode', name: 'Kilo Code', role: 'Bridge', parent_id: 'claude-code' },
      ],
      heartbeats: new Map<string, RawHeartbeat>([
        ['claude-code', { agent_id: 'claude-code', timestamp: iso(-3), current_task: 'C5' }],
        ['kilocode', { agent_id: 'kilocode', timestamp: iso(-400), current_task: null }],
      ]),
      health: new Map<string, AgentHealth>([
        ['claude-code', health('claude-code', 'alive', 3)],
        ['kilocode', health('kilocode', 'stalled', 400)],
      ]),
      messages: [
        msg({ id: 's1', from: 'claude-code', to: 'shared', type: 'finding_report' }),
      ],
      sprintAssignments: new Map([['claude-code', ['sprint-3: Panel']]]),
      claimedTasks: new Map([['claude-code', ['C5']]]),
    };
  }

  test('buildAgentCards populates identity + detail and sorts by health', () => {
    const cards = buildAgentCards(cardInputs(), NOW);
    assert.strictEqual(cards.length, 2);
    // Stalled agent sorts first.
    assert.strictEqual(cards[0].agentId, 'kilocode');
    assert.strictEqual(cards[0].color, 'red');
    const cc = cards.find(c => c.agentId === 'claude-code')!;
    assert.strictEqual(cc.avatar, 'CC');
    assert.strictEqual(cc.currentTask, 'C5');
    assert.deepStrictEqual(cc.capabilities, ['ui']);
    assert.deepStrictEqual(cc.detail.claimedTasks, ['C5']);
    assert.deepStrictEqual(cc.detail.sprintAssignments, ['sprint-3: Panel']);
    assert.strictEqual(cc.detail.lastOutbound.length, 1);
  });

  test('buildAgentTree nests sub-agents under parents', () => {
    const cards = buildAgentCards(cardInputs(), NOW);
    const tree = buildAgentTree(cards);
    assert.strictEqual(tree.length, 1, 'one root');
    assert.strictEqual(tree[0].agentId, 'claude-code');
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].agentId, 'kilocode');
  });

  test('buildAgentTree promotes orphans (unknown parent) to roots', () => {
    const cards = buildAgentCards(
      {
        ...cardInputs(),
        profiles: [{ id: 'orphan', name: 'Orphan', parent_id: 'ghost' }],
        heartbeats: new Map(),
        health: new Map(),
      },
      NOW
    );
    const tree = buildAgentTree(cards);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].agentId, 'orphan');
  });

  test('buildAgentTree breaks self-parent cycles', () => {
    const cards = buildAgentCards(
      {
        ...cardInputs(),
        profiles: [{ id: 'loop', name: 'Loop', parent_id: 'loop' }],
        heartbeats: new Map(),
        health: new Map(),
      },
      NOW
    );
    const tree = buildAgentTree(cards);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].children.length, 0);
  });
});

suite('Fleet panel — cross-machine merge (CF-1)', () => {
  test('tags local + relay origins and keys distinct hosts separately', () => {
    const merged = mergeFleetHeartbeats(
      [{ agent_id: 'claude-code', timestamp: iso(-3) }],
      [{ agent_id: 'claude-code', timestamp: iso(-4), host: 'workstation-2' }],
      { localHost: 'laptop-1', now: NOW }
    );
    assert.strictEqual(merged.length, 2, 'same agent on two hosts = two rows');
    const local = merged.find(h => h.host === 'laptop-1')!;
    const remote = merged.find(h => h.host === 'workstation-2')!;
    assert.strictEqual(local.origin, 'local');
    assert.strictEqual(remote.origin, 'relay');
  });

  test('de-dupes same (agent, host) to the freshest heartbeat', () => {
    const merged = mergeFleetHeartbeats(
      [
        { agent_id: 'a', timestamp: iso(-30) },
        { agent_id: 'a', timestamp: iso(-2) },
      ],
      [],
      { localHost: 'h', now: NOW }
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].timestamp, iso(-2));
  });

  test('local wins over relay on a same-host timestamp tie', () => {
    const t = iso(-5);
    const merged = mergeFleetHeartbeats(
      [{ agent_id: 'a', timestamp: t }],
      [{ agent_id: 'a', timestamp: t, host: 'box' }],
      { localHost: 'box', now: NOW }
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].origin, 'local');
  });

  test('relay rows age out beyond relayStaleMs; local rows never do', () => {
    const merged = mergeFleetHeartbeats(
      [{ agent_id: 'local-old', timestamp: iso(-99999) }],
      [
        { agent_id: 'fresh', timestamp: iso(-10), host: 'remote' },
        { agent_id: 'stale', timestamp: iso(-600), host: 'remote' },
      ],
      { localHost: 'me', now: NOW, relayStaleMs: 60_000 }
    );
    const ids = merged.map(h => h.agent_id).sort();
    assert.deepStrictEqual(ids, ['fresh', 'local-old'], 'stale relay dropped, local kept');
  });

  test('relay row with an unparseable timestamp ages out when stale-checking', () => {
    const merged = mergeFleetHeartbeats(
      [],
      [{ agent_id: 'x', timestamp: 'not-a-date', host: 'r' }],
      { now: NOW, relayStaleMs: 60_000 }
    );
    assert.strictEqual(merged.length, 0);
  });

  test('fleetKey composes agent + host', () => {
    assert.strictEqual(fleetKey('a', 'h'), 'a::h');
  });

  test('buildAgentCards marks a relay-fed heartbeat as remote, keeps local default', () => {
    const cards = buildAgentCards({
      profiles: [
        { id: 'local-agent' },
        { id: 'remote-agent' },
      ],
      heartbeats: new Map<string, RawHeartbeat>([
        ['local-agent', { agent_id: 'local-agent', timestamp: iso(-2) }],
        ['remote-agent', { agent_id: 'remote-agent', timestamp: iso(-2), origin: 'relay', host: 'box-9' }],
      ]),
      health: new Map(),
      messages: [],
      sprintAssignments: new Map(),
      claimedTasks: new Map(),
    }, NOW);

    const local = cards.find(c => c.agentId === 'local-agent')!;
    const remote = cards.find(c => c.agentId === 'remote-agent')!;
    assert.strictEqual(local.origin, 'local');
    assert.strictEqual(local.isRemote, false);
    assert.strictEqual(local.host, LOCAL_HOST);
    assert.strictEqual(remote.origin, 'relay');
    assert.strictEqual(remote.isRemote, true);
    assert.strictEqual(remote.host, 'box-9');
  });
});

suite('Fleet panel — Awaiting You filter', () => {
  test('to==me ∧ requires_response ∧ replied_at==null', () => {
    const messages = [
      msg({ id: 'a1', to: 'me', requires_response: true }),
      msg({ id: 'a2', to: 'me', requires_response: false }), // no response needed
      msg({ id: 'a3', to: 'other', requires_response: true }), // not for me
      msg({ id: 'a4', to: 'me', requires_response: true }), // replied
      msg({ id: 'a5', to: 'me', requires_response: true }), // archived
    ];
    const states = new Map<string, RawInboxState>([
      ['a4', { msg_id: 'a4', read_at: iso(-5), replied_at: iso(-1), archived_at: null }],
      ['a5', { msg_id: 'a5', read_at: iso(-5), replied_at: null, archived_at: iso(-1) }],
    ]);
    const out = buildAwaitingYou(messages, 'me', states, NOW);
    assert.deepStrictEqual(out.map(x => x.id), ['a1']);
  });

  test('overdue items sort first and are flagged', () => {
    const messages = [
      msg({ id: 'fresh', to: 'me', requires_response: true, timestamp: iso(-10),
            response_deadline: iso(3600) }),
      msg({ id: 'late', to: 'me', requires_response: true, timestamp: iso(-20),
            response_deadline: iso(-100) }),
    ];
    const out = buildAwaitingYou(messages, 'me', new Map(), NOW);
    assert.strictEqual(out[0].id, 'late');
    assert.strictEqual(out[0].overdue, true);
    assert.strictEqual(out[1].overdue, false);
  });
});

suite('Fleet panel — activity feed', () => {
  test('activityKindForMessage maps comms types', () => {
    assert.strictEqual(activityKindForMessage('task_claim'), 'task_started');
    assert.strictEqual(activityKindForMessage('task_complete'), 'task_complete');
    assert.strictEqual(activityKindForMessage('finding_report'), 'finding_raised');
    assert.strictEqual(activityKindForMessage('review_request'), 'review_requested');
    assert.strictEqual(activityKindForMessage('answer'), 'message');
  });

  test('buildActivityFeed merges messages + health events, newest-first', () => {
    const messages = [
      msg({ id: 'm-old', from: 'a', type: 'task_claim', timestamp: iso(-300) }),
      msg({ id: 'm-new', from: 'b', type: 'task_complete', timestamp: iso(-10) }),
    ];
    const feed = buildActivityFeed(
      messages,
      [{ agentId: 'c', kind: 'agent_died', timestamp: iso(-100), text: 'c died' }],
      NOW
    );
    assert.strictEqual(feed.length, 3);
    assert.strictEqual(feed[0].id, 'm-new');
    assert.strictEqual(feed[2].id, 'm-old');
    assert.ok(feed.some(e => e.kind === 'agent_died'));
  });

  test('buildActivityFeed caps at limit', () => {
    const many: RawMessage[] = [];
    for (let i = 0; i < 80; i++) {
      many.push(msg({ id: `x${i}`, type: 'question', timestamp: iso(-i) }));
    }
    assert.strictEqual(buildActivityFeed(many, [], NOW, 50).length, 50);
  });
});

suite('Fleet panel — cost ledger', () => {
  test('rolls up per-agent tokens + wall-clock + rationale rail', () => {
    const entries: CostLedgerEntry[] = [
      { agentId: 'a', tokens: 100, wallMs: 2000, because: 'compiled', timestamp: iso(-10) },
      { agentId: 'a', tokens: 50, wallMs: 1000, because: 'tested', timestamp: iso(-5) },
      { agentId: 'b', tokens: 300, wallMs: 500, because: 'reviewed', timestamp: iso(-1) },
    ];
    const view = buildCostLedger(entries);
    assert.strictEqual(view.totalTokens, 450);
    assert.strictEqual(view.totalWallMs, 3500);
    // Sorted by tokens descending → b first.
    assert.strictEqual(view.perAgent[0].agentId, 'b');
    const a = view.perAgent.find(r => r.agentId === 'a')!;
    assert.strictEqual(a.totalTokens, 150);
    assert.strictEqual(a.actionCount, 2);
    // Rationale rail newest-first.
    assert.strictEqual(view.recentRationales[0].because, 'reviewed');
  });

  test('cost ledger handles empty input', () => {
    const view = buildCostLedger([]);
    assert.strictEqual(view.totalTokens, 0);
    assert.strictEqual(view.perAgent.length, 0);
  });
});

suite('Fleet panel — presence summary', () => {
  test('counts working / needs-review / down', () => {
    const inputs: AgentCardInputs = {
      profiles: [
        { id: 'w1' }, { id: 'w2' }, { id: 'idle1' }, { id: 'dead1' },
      ],
      heartbeats: new Map([
        ['w1', { agent_id: 'w1', timestamp: iso(-1), current_task: 'T1' }],
        ['w2', { agent_id: 'w2', timestamp: iso(-1), current_task: 'T2' }],
        ['idle1', { agent_id: 'idle1', timestamp: iso(-1), current_task: null }],
        ['dead1', { agent_id: 'dead1', timestamp: iso(-999), current_task: 'T3' }],
      ]),
      health: new Map([
        ['w1', health('w1', 'alive', 1)],
        ['w2', health('w2', 'alive', 1)],
        ['idle1', health('idle1', 'alive', 1)],
        ['dead1', health('dead1', 'dead', 999)],
      ]),
      messages: [],
      sprintAssignments: new Map(),
      claimedTasks: new Map(),
    };
    const cards = buildAgentCards(inputs, NOW);
    const awaiting = new Map<string, AwaitingItem[]>([
      ['w1', [{ id: 'x', from: 'y', type: 'question', timestamp: iso(-1),
               preview: 'p', deadline: null, overdue: false }]],
    ]);
    const presence = buildPresence(cards, awaiting);
    assert.strictEqual(presence.working, 2);
    assert.strictEqual(presence.down, 1);
    assert.strictEqual(presence.needsReview, 1);
    assert.strictEqual(presence.total, 4);
    assert.strictEqual(presence.text, '2 agents working, 1 needs review, 1 down');
  });

  test('singular grammar for one working agent', () => {
    const inputs: AgentCardInputs = {
      profiles: [{ id: 'solo' }],
      heartbeats: new Map([['solo', { agent_id: 'solo', timestamp: iso(-1), current_task: 'T' }]]),
      health: new Map([['solo', health('solo', 'alive', 1)]]),
      messages: [], sprintAssignments: new Map(), claimedTasks: new Map(),
    };
    const cards = buildAgentCards(inputs, NOW);
    const presence = buildPresence(cards, new Map());
    assert.strictEqual(presence.text, '1 agent working');
  });
});

suite('Fleet panel — buildFleetDashboard assembly', () => {
  test('produces a complete model', () => {
    const cardInputs: AgentCardInputs = {
      profiles: [{ id: 'me', name: 'Me' }, { id: 'peer', name: 'Peer' }],
      heartbeats: new Map([
        ['me', { agent_id: 'me', timestamp: iso(-2), current_task: 'C5' }],
      ]),
      health: new Map([['me', health('me', 'alive', 2)]]),
      messages: [],
      sprintAssignments: new Map(),
      claimedTasks: new Map(),
    };
    const awaitingMsg = msg({ id: 'q1', from: 'peer', to: 'me', requires_response: true });
    const inputs: FleetDashboardInputs = {
      selfAgentId: 'me',
      cardInputs,
      allMessages: [awaitingMsg],
      selfInboxStates: new Map(),
      inboxStatesByAgent: new Map(),
      messagesByRecipient: new Map([['me', [awaitingMsg]]]),
      health: [health('me', 'alive', 2)],
      cost: [{ agentId: 'me', tokens: 10, wallMs: 100, because: 'x', timestamp: iso(-1) }],
    };
    const model = buildFleetDashboard(inputs, NOW);
    assert.strictEqual(model.selfAgentId, 'me');
    assert.strictEqual(model.cards.length, 2);
    assert.strictEqual(model.awaitingYou.length, 1);
    assert.strictEqual(model.awaitingYou[0].id, 'q1');
    assert.strictEqual(model.cost.totalTokens, 10);
    assert.ok(model.presence.text.length > 0);
    assert.ok(model.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// Data layer (file I/O) tests
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-fleet-test-'));
}

function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

suite('Fleet panel — fleetData read layer', () => {
  test('deriveHealthFromHeartbeats maps age to states', () => {
    const hbs = new Map<string, RawHeartbeat>([
      ['fresh', { agent_id: 'fresh', timestamp: iso(-5) }],
      ['old', { agent_id: 'old', timestamp: iso(-400) }],
    ]);
    const out = deriveHealthFromHeartbeats(hbs, NOW);
    const fresh = out.find(h => h.agentId === 'fresh')!;
    const old = out.find(h => h.agentId === 'old')!;
    assert.strictEqual(fresh.state, 'alive');
    assert.strictEqual(old.state, 'dead');
  });

  test('readAgentProfiles reads the comms registry', async () => {
    const ws = makeWorkspace();
    try {
      writeJson(
        path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'registry.json'),
        { agents: [{ id: 'claude-code', name: 'Claude Code' }] }
      );
      const profiles = await readAgentProfiles(ws);
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].id, 'claude-code');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('readClaims groups task ids by claiming agent', async () => {
    const ws = makeWorkspace();
    try {
      const claimsDir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'claims');
      writeJson(path.join(claimsDir, 'C5.json'),
        { task_ids: ['C5'], claimed_by: 'claude-code' });
      writeJson(path.join(claimsDir, 'B1.json'),
        { task_id: 'B1', claimed_by: 'kilocode' });
      const claims = await readClaims(ws);
      assert.deepStrictEqual(claims.get('claude-code'), ['C5']);
      assert.deepStrictEqual(claims.get('kilocode'), ['B1']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('gatherFleetData assembles a model end-to-end from disk', async () => {
    const ws = makeWorkspace();
    try {
      const comms = path.join(ws, '.autoclaw', 'orchestrator', 'comms');
      writeJson(path.join(comms, 'registry.json'), {
        agents: [
          { id: 'claude-code', name: 'Claude Code', role: 'Panel' },
          { id: 'kilocode', name: 'Kilo Code', role: 'Bridge' },
        ],
      });
      writeJson(path.join(comms, 'heartbeats', 'claude-code.json'), {
        agent_id: 'claude-code', timestamp: iso(-3), current_task: 'C5', queue_depth: 1,
      });
      // A question addressed to claude-code requiring a response.
      writeJson(path.join(comms, 'inboxes', 'claude-code', 'q1.json'), {
        id: 'q1', from: 'kilocode', to: 'claude-code', type: 'question',
        timestamp: iso(-60), requires_response: true, payload: { question: 'ready?' },
      });
      // An outbound finding from claude-code in the shared inbox.
      writeJson(path.join(comms, 'inboxes', 'shared', 'f1.json'), {
        id: 'f1', from: 'claude-code', to: 'shared', type: 'finding_report',
        timestamp: iso(-30), requires_response: false, payload: { summary: 'noted' },
      });
      writeJson(path.join(comms, 'claims', 'C5.json'),
        { task_ids: ['C5'], claimed_by: 'claude-code' });

      const model = await gatherFleetData({
        workspaceRoot: ws,
        selfAgentId: 'claude-code',
        now: NOW,
      });

      assert.strictEqual(model.cards.length, 2);
      assert.strictEqual(model.awaitingYou.length, 1);
      assert.strictEqual(model.awaitingYou[0].id, 'q1');
      assert.ok(model.activity.length >= 2, 'feed has the two messages');
      const cc = model.cards.find(c => c.agentId === 'claude-code')!;
      assert.deepStrictEqual(cc.detail.claimedTasks, ['C5']);
      assert.strictEqual(cc.currentTask, 'C5');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('gatherFleetData tolerates a missing .autoclaw tree', async () => {
    const ws = makeWorkspace();
    try {
      const model = await gatherFleetData({
        workspaceRoot: ws,
        selfAgentId: 'claude-code',
        now: NOW,
      });
      assert.strictEqual(model.cards.length, 0);
      assert.strictEqual(model.awaitingYou.length, 0);
      assert.strictEqual(model.presence.total, 0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
