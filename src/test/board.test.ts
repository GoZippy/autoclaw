/**
 * board.test.ts — Pure-function coverage for the agendaboard builder + renderer,
 * plus one IO test covering writeBoard end-to-end.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CLAIM_TTL_DEFAULT_MS,
  HEARTBEAT_OFFLINE_MS,
  REVIEW_OVERDUE_MS,
  BOARD_CAPSULES_MAX,
  buildBoard,
  renderBoardMarkdown,
  type BoardCapsule,
  type BoardClaim,
  type BoardConsensus,
  type BoardHeartbeat,
  type BoardTask,
} from '../orchestrator/board';
import { writeBoard } from '../orchestrator/boardWriter';

function cap(over: Partial<BoardCapsule> & { run_id: string; task_id: string }): BoardCapsule {
  return { source: 'consensus', verdict: 'approved', votes_count: 2, evaluated_at: new Date(now).toISOString(), ...over };
}

const now = new Date('2026-05-24T12:00:00Z').getTime();

function hb(over: Partial<BoardHeartbeat> & { agent_id: string }): BoardHeartbeat {
  return {
    timestamp: new Date(now - 30_000).toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildBoard — bucketing
// ---------------------------------------------------------------------------

suite('board — buildBoard claimable bucket', () => {
  test('open task with no claim and no deps is claimable', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'open', depends_on: [] }],
      claims: [], consensus: [], heartbeats: [],
      now,
    });
    assert.strictEqual(board.claimable.length, 1);
    assert.strictEqual(board.claimable[0].task_id, 'T1');
  });

  test('blocked task is not claimable', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'blocked', depends_on: [] }],
      claims: [], consensus: [], heartbeats: [], now,
    });
    assert.strictEqual(board.claimable.length, 0);
  });

  test('open task with an unsatisfied dep is NOT claimable', () => {
    const tasks: BoardTask[] = [
      { id: 'T1', status: 'open', depends_on: [] },
      { id: 'T2', status: 'open', depends_on: ['T1'] },
    ];
    const board = buildBoard({ tasks, claims: [], consensus: [], heartbeats: [], now });
    assert.deepStrictEqual(board.claimable.map(c => c.task_id), ['T1']);
  });

  test('open task whose dep is merged IS claimable', () => {
    const tasks: BoardTask[] = [
      { id: 'T1', status: 'merged', depends_on: [] },
      { id: 'T2', status: 'open', depends_on: ['T1'] },
    ];
    const board = buildBoard({ tasks, claims: [], consensus: [], heartbeats: [], now });
    assert.deepStrictEqual(board.claimable.map(c => c.task_id), ['T2']);
  });

  test('claimable items sort by priority high → medium → low → unset', () => {
    const tasks: BoardTask[] = [
      { id: 'lo', status: 'open', priority: 'low' },
      { id: 'hi', status: 'open', priority: 'high' },
      { id: 'md', status: 'open', priority: 'medium' },
      { id: 'un', status: 'open' },
    ];
    const board = buildBoard({ tasks, claims: [], consensus: [], heartbeats: [], now });
    assert.deepStrictEqual(board.claimable.map(c => c.task_id), ['hi', 'md', 'lo', 'un']);
  });

  test('claimed and in-review tasks are not claimable', () => {
    const tasks: BoardTask[] = [
      { id: 'open1', status: 'open' },
      { id: 'claimed1', status: 'open' },
      { id: 'review1', status: 'open' },
    ];
    const claims: BoardClaim[] = [
      { task_id: 'claimed1', claimed_by: 'kilocode', claimed_at: new Date(now - 1000).toISOString() },
    ];
    const consensus: BoardConsensus[] = [
      { task_id: 'review1', author: 'claude-code', opened_at: new Date(now - 1000).toISOString(), reviewers: ['kilocode'], votes: [], rule: 'majority' },
    ];
    const board = buildBoard({ tasks, claims, consensus, heartbeats: [], now });
    assert.deepStrictEqual(board.claimable.map(c => c.task_id), ['open1']);
  });
});

suite('board — buildBoard in-flight bucket', () => {
  test('fresh claim with healthy owner is in-flight, not stuck', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_progress' }],
      claims: [{ task_id: 'T1', claimed_by: 'kilocode', claimed_at: new Date(now - 1000).toISOString() }],
      consensus: [],
      heartbeats: [hb({ agent_id: 'kilocode' })],
      now,
    });
    assert.strictEqual(board.in_flight.length, 1);
    assert.strictEqual(board.in_flight[0].owner_healthy, true);
    assert.strictEqual(board.stuck.length, 0);
  });

  test('claim with no fresh heartbeat from owner surfaces as stuck (owner_offline)', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_progress' }],
      claims: [{ task_id: 'T1', claimed_by: 'kilocode', claimed_at: new Date(now - 1000).toISOString() }],
      consensus: [],
      heartbeats: [hb({ agent_id: 'kilocode', timestamp: new Date(now - HEARTBEAT_OFFLINE_MS - 1000).toISOString() })],
      now,
    });
    assert.strictEqual(board.in_flight[0].owner_healthy, false);
    assert.ok(board.stuck.some(s => s.reason === 'owner_offline'));
  });

  test('claim older than its TTL surfaces as stuck (claim_expired)', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_progress' }],
      claims: [{
        task_id: 'T1',
        claimed_by: 'kilocode',
        claimed_at: new Date(now - CLAIM_TTL_DEFAULT_MS - 1000).toISOString(),
      }],
      consensus: [],
      heartbeats: [hb({ agent_id: 'kilocode' })],
      now,
    });
    assert.ok(board.stuck.some(s => s.reason === 'claim_expired'));
  });
});

suite('board — buildBoard awaiting-review bucket', () => {
  test('three reviewers → majority threshold 2', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_review' }],
      claims: [],
      consensus: [{
        task_id: 'T1', author: 'claude-code',
        opened_at: new Date(now - 1000).toISOString(),
        reviewers: ['kilocode', 'kiro', 'antigravity'],
        votes: [{ voter: 'kilocode', vote: 'approve' }],
        rule: 'majority',
      }],
      heartbeats: [], now,
    });
    const item = board.awaiting_review[0];
    assert.strictEqual(item.votes_received, 1);
    assert.strictEqual(item.votes_required, 2);
    assert.strictEqual(item.approvals, 1);
  });

  test('unanimous rule sets required = reviewers.length', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_review' }],
      claims: [],
      consensus: [{
        task_id: 'T1', author: 'a',
        opened_at: new Date(now - 1000).toISOString(),
        reviewers: ['b', 'c'], votes: [], rule: 'unanimous',
      }],
      heartbeats: [], now,
    });
    assert.strictEqual(board.awaiting_review[0].votes_required, 2);
  });

  test('overdue review without enough votes surfaces as stuck', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_review' }],
      claims: [],
      consensus: [{
        task_id: 'T1', author: 'a',
        opened_at: new Date(now - REVIEW_OVERDUE_MS - 1000).toISOString(),
        reviewers: ['b', 'c'], votes: [], rule: 'majority',
      }],
      heartbeats: [], now,
    });
    assert.ok(board.stuck.some(s => s.reason === 'review_overdue'));
  });

  test('consensus with empty reviewers list surfaces as stuck (no_eligible_reviewers)', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'in_review' }],
      claims: [],
      consensus: [{
        task_id: 'T1', author: 'a',
        opened_at: new Date(now - 1000).toISOString(),
        reviewers: [], votes: [], rule: 'majority',
      }],
      heartbeats: [], now,
    });
    assert.ok(board.stuck.some(s => s.reason === 'no_eligible_reviewers'));
  });
});

suite('board — buildBoard fleet stats', () => {
  test('live_count excludes stale/halted/offline heartbeats', () => {
    const board = buildBoard({
      tasks: [],
      claims: [],
      consensus: [],
      heartbeats: [
        hb({ agent_id: 'live1' }),
        hb({ agent_id: 'live2' }),
        hb({ agent_id: 'stale', timestamp: new Date(now - HEARTBEAT_OFFLINE_MS - 1000).toISOString() }),
        hb({ agent_id: 'halted', status: 'halted' }),
      ],
      now,
    });
    assert.strictEqual(board.fleet_size, 4);
    assert.strictEqual(board.live_count, 2);
  });
});

// ---------------------------------------------------------------------------
// renderBoardMarkdown
// ---------------------------------------------------------------------------

suite('board — renderBoardMarkdown', () => {
  test('contains all four section headers and the summary table', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'open' }],
      claims: [], consensus: [], heartbeats: [], now,
    });
    const md = renderBoardMarkdown(board);
    assert.ok(md.includes('# AutoClaw Agendaboard'));
    assert.ok(md.includes('## Claimable'));
    assert.ok(md.includes('## In flight'));
    assert.ok(md.includes('## Awaiting review'));
    assert.ok(md.includes('## Stuck'));
    assert.ok(md.includes('| Claimable | 1 |'));
  });

  test('escapes pipes in cell content', () => {
    const board = buildBoard({
      tasks: [{ id: 'T1', status: 'open', title: 'has | pipe' }],
      claims: [], consensus: [], heartbeats: [], now,
    });
    const md = renderBoardMarkdown(board);
    assert.ok(md.includes('has \\| pipe'));
  });

  test('renders a Recent evidence section only when capsules exist', () => {
    const without = renderBoardMarkdown(buildBoard({ tasks: [], claims: [], consensus: [], heartbeats: [], now }));
    assert.ok(!without.includes('## Recent evidence'));
    const withCaps = renderBoardMarkdown(buildBoard({
      tasks: [], claims: [], consensus: [], heartbeats: [],
      capsules: [cap({ run_id: 'run-1', task_id: 'T1', verdict: 'blocked', gates_passed: false })],
      now,
    }));
    assert.ok(withCaps.includes('## Recent evidence'));
    assert.ok(withCaps.includes('`T1`'));
    assert.ok(withCaps.includes('blocked'));
  });
});

suite('board — recent capsules', () => {
  test('summaries are sorted newest-first and capped at BOARD_CAPSULES_MAX', () => {
    const many: BoardCapsule[] = [];
    for (let i = 0; i < BOARD_CAPSULES_MAX + 5; i++) {
      many.push(cap({ run_id: `run-${i}`, task_id: `T${i}`, evaluated_at: new Date(now - i * 1000).toISOString() }));
    }
    const board = buildBoard({ tasks: [], claims: [], consensus: [], heartbeats: [], capsules: many, now });
    assert.strictEqual(board.recent_capsules?.length, BOARD_CAPSULES_MAX);
    assert.strictEqual(board.recent_capsules?.[0].run_id, 'run-0'); // newest (largest evaluated_at)
  });

  test('omitted entirely when there are no capsules', () => {
    const board = buildBoard({ tasks: [], claims: [], consensus: [], heartbeats: [], now });
    assert.strictEqual(board.recent_capsules, undefined);
  });
});

// ---------------------------------------------------------------------------
// writeBoard — IO
// ---------------------------------------------------------------------------

function mkTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-board-'));
}

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

suite('board — writeBoard end-to-end', () => {
  test('writes board.json + board.md from a populated tree', async () => {
    const ws = mkTempWorkspace();
    try {
      const orch = path.join(ws, '.autoclaw', 'orchestrator');
      const comms = path.join(orch, 'comms');
      fs.mkdirSync(path.join(comms, 'claims'), { recursive: true });
      fs.mkdirSync(path.join(comms, 'consensus', 'active'), { recursive: true });
      fs.mkdirSync(path.join(comms, 'heartbeats'), { recursive: true });

      // state.json with one open task.
      fs.writeFileSync(path.join(orch, 'state.json'), JSON.stringify({
        project: 'demo', current_sprint: 1, total_sprints: 1,
        tasks_complete: 0, tasks_total: 2,
        agents: { kilocode: { status: 'idle', sprint: 1, tasks: ['T1', 'T2'] } },
        last_updated: new Date(now - 1000).toISOString(),
        tasks: [
          { id: 'T1', title: 'first', status: 'open' },
          { id: 'T2', title: 'second', status: 'open' },
        ],
      }, null, 2));

      // T1 is claimed by kilocode.
      fs.writeFileSync(path.join(comms, 'claims', 'T1.json'), JSON.stringify({
        task_id: 'T1', claimed_by: 'kilocode',
        claimed_at: new Date(now - 1000).toISOString(),
      }, null, 2));

      // kilocode heartbeat (fresh) so owner is healthy.
      fs.writeFileSync(path.join(comms, 'heartbeats', 'kilocode.json'), JSON.stringify({
        agent_id: 'kilocode', timestamp: new Date(now - 5000).toISOString(),
        status: 'active', current_task: 'T1', sprint: 1,
      }, null, 2));

      // A persisted evidence capsule should surface on the board.
      fs.mkdirSync(path.join(comms, 'consensus', 'results'), { recursive: true });
      fs.writeFileSync(path.join(comms, 'consensus', 'results', 'T1-run-abc.json'), JSON.stringify({
        run_id: 'run-abc', source: 'consensus', task_id: 'T1', sprint: 1,
        final_verdict: 'approved', status: 'consensus_reached', rounds: 1, votes_count: 2,
        gates_passed: true, artifacts: { capsule_path: '', votes_dir: '' },
        evaluated_at: new Date(now - 2000).toISOString(),
      }, null, 2));

      const result = await writeBoard({ workspaceRoot: ws, now, generator: 'test' });

      assert.ok(fs.existsSync(result.jsonPath));
      assert.ok(fs.existsSync(result.mdPath));

      const board = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
      assert.strictEqual(board.generator, 'test');
      assert.strictEqual(board.fleet_size, 1);
      assert.strictEqual(board.live_count, 1);
      assert.strictEqual(board.in_flight.length, 1);
      assert.strictEqual(board.in_flight[0].task_id, 'T1');
      assert.strictEqual(board.claimable.length, 1);
      assert.strictEqual(board.claimable[0].task_id, 'T2');

      assert.strictEqual(board.recent_capsules.length, 1);
      assert.strictEqual(board.recent_capsules[0].run_id, 'run-abc');
      assert.strictEqual(board.recent_capsules[0].verdict, 'approved');

      const md = fs.readFileSync(result.mdPath, 'utf8');
      assert.ok(md.includes('# AutoClaw Agendaboard'));
      assert.ok(md.includes('`T1`'));
      assert.ok(md.includes('`T2`'));
      assert.ok(md.includes('## Recent evidence'));
    } finally {
      rmrf(ws);
    }
  });

  test('writes an empty board against an uninitialised workspace', async () => {
    const ws = mkTempWorkspace();
    try {
      const result = await writeBoard({ workspaceRoot: ws, now });
      const board = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
      assert.strictEqual(board.claimable.length, 0);
      assert.strictEqual(board.in_flight.length, 0);
      assert.strictEqual(board.awaiting_review.length, 0);
      assert.strictEqual(board.stuck.length, 0);
      assert.strictEqual(board.fleet_size, 0);
    } finally {
      rmrf(ws);
    }
  });
});
