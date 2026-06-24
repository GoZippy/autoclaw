/**
 * boardRefresh.test.ts — L2 real-time board refresh (producer core).
 *
 * Pure tests for the anti-loop allow-list predicate and the debounce/coalesce
 * engine (fake timers), plus fs tests proving refreshBoardNow honors the L1
 * single-active gate (a standby writes nothing; a solo supervisor writes).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  makeShouldRefreshBoard,
  startBoardRefreshService,
  refreshBoardNow,
  MIN_BOARD_REFRESH_DEBOUNCE_MS,
} from '../orchestrator/boardRefresh';

// ---------------------------------------------------------------------------
// Anti-loop predicate
// ---------------------------------------------------------------------------

suite('boardRefresh — makeShouldRefreshBoard (allow-list, anti-loop)', () => {
  const should = makeShouldRefreshBoard();
  const W = '/home/u/proj/.autoclaw/orchestrator';

  test('INCLUDES the board inputs', () => {
    assert.ok(should(`${W}/comms/claims/B1.json`), 'claims');
    assert.ok(should(`${W}/comms/agents/kiro/claim-B1.json`), 'per-agent claim');
    assert.ok(should(`${W}/comms/consensus/active/B1.json`), 'consensus active');
    assert.ok(should(`${W}/comms/consensus/resolved/B1.json`), 'consensus resolved');
    assert.ok(should(`${W}/comms/consensus/results/T1-run1.json`), 'consensus results (capsules)');
    assert.ok(should(`${W}/comms/heartbeats/kiro.json`), 'heartbeats');
    assert.ok(should(`${W}/comms/inboxes/shared/m1.json`), 'shared inbox');
    // A dispatch task_claim message in the shared inbox IS a board input (note the
    // 'claim-' substring — proves the allow is by location, not a loose match):
    assert.ok(should(`${W}/comms/inboxes/shared/2026-06-24T00-00-00-000Z-task_claim-T1.json`),
      'shared-inbox dispatch message');
    assert.ok(should(`${W}/state.json`), 'state.json');
    // Windows separators normalize:
    assert.ok(should(`C:\\proj\\.autoclaw\\orchestrator\\comms\\heartbeats\\kiro.json`), 'backslashes');
  });

  test('EXCLUDES the producer outputs + bookkeeping (no watch loop)', () => {
    assert.ok(!should(`${W}/board.json`), 'board.json');
    assert.ok(!should(`${W}/board.md`), 'board.md');
    assert.ok(!should(`${W}/board.json.tmp-12345-0`), 'atomic-publish temp sibling');
    assert.ok(!should(`${W}/board.md.tmp-12345-1`), 'md temp sibling');
    assert.ok(!should(`${W}/comms/supervisor.lock.json`), 'lease file');
    // E1b: the cluster map + its atomic-publish temp sibling are lease writes —
    // a renew would self-retrigger the watch if either passed (default-deny keeps them out).
    assert.ok(!should(`${W}/comms/cluster-map.json`), 'cluster map (E1b lease store)');
    assert.ok(!should(`${W}/comms/cluster-map.json.tmp-12345-2`), 'cluster map temp sibling');
    // E2b-ii: monitor-presence files are lease keepalives — a renew must not arm a refresh.
    assert.ok(!should(`${W}/comms/monitors/orchestrator-loop-ab12.json`), 'monitor presence (E2b-ii roster)');
    assert.ok(!should(`${W}/comms/monitors/orchestrator-loop-ab12.json.tmp-9-9`), 'monitor presence temp sibling');
    // E3: cluster-map gossip beats must NEVER retrigger the board watch (default-deny).
    assert.ok(!should(`${W}/comms/gossip/cluster-map/orchestrator-loop-ab12.json`), 'cluster-map gossip beat (E3)');
    assert.ok(!should(`${W}/comms/gossip/cluster-map/orchestrator-loop-ab12.json.tmp-9-9`), 'gossip beat temp sibling');
    assert.ok(!should(`${W}/comms/loop-journal.jsonl`), 'loop journal');
    assert.ok(!should(`${W}/comms/loop-state.json`), 'loop state (anchored: not state.json)');
    assert.ok(!should(`${W}/comms/comms-log.jsonl`), 'comms log');
    // Realistic dispatch sidecar names (the `_dispatch` dir is excluded by the
    // `_`-prefix rule; the shared-inbox `task_claim-` form is a separate ALLOW above):
    assert.ok(!should(`${W}/comms/agents/_dispatch/next-kiro-1735000000000-ab12cd34.json`),
      'dispatch sidecar under _dispatch');
    assert.ok(!should(`${W}/comms/agents/_dispatch/task_claim-next-kiro.json`),
      'task_claim sidecar under _dispatch (not /claim-)');
  });

  test('EXCLUDES anything outside the orchestrator tree + junk input', () => {
    assert.ok(!should('/home/u/proj/src/index.ts'), 'source file');
    assert.ok(!should('/home/u/proj/.autoclaw/vector/db.sqlite'), 'other .autoclaw data');
    assert.ok(!should(''), 'empty');
    assert.ok(!should(undefined as unknown as string), 'undefined');
  });
});

// ---------------------------------------------------------------------------
// Debounce + coalesce engine (fake timers)
// ---------------------------------------------------------------------------

type FakeHandle = ReturnType<typeof setTimeout>;
function fakeTimers() {
  let seq = 0;
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const setTimeoutFn = (cb: () => void, ms: number): FakeHandle => {
    const id = ++seq;
    timers.set(id, { cb, ms });
    return id as unknown as FakeHandle;
  };
  const clearTimeoutFn = (h: FakeHandle): void => { timers.delete(h as unknown as number); };
  const fireMs = (ms: number): void => {
    for (const [id, t] of [...timers.entries()]) {
      if (t.ms === ms) { timers.delete(id); t.cb(); }
    }
  };
  const fireSmallest = (): void => {
    if (timers.size === 0) { return; }
    const min = Math.min(...[...timers.values()].map((t) => t.ms));
    fireMs(min);
  };
  return { timers, setTimeoutFn, clearTimeoutFn, fireMs, fireSmallest };
}
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 8; i++) { await Promise.resolve(); }
}
const CLAIM = '/p/.autoclaw/orchestrator/comms/claims/a.json';
const HB = '/p/.autoclaw/orchestrator/comms/heartbeats/x.json';

suite('boardRefresh — startBoardRefreshService (debounce/coalesce)', () => {
  test('coalesces a burst of changes into ONE refresh', async () => {
    const ft = fakeTimers();
    let runs = 0;
    const svc = startBoardRefreshService({
      refresh: async () => { runs += 1; },
      debounceMs: 300, maxWaitMs: 0, shouldRefresh: () => true,
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    svc.notifyChange(CLAIM); svc.notifyChange(CLAIM); svc.notifyChange(HB);
    assert.ok(svc.pending, 'pending after a change');
    ft.fireSmallest();
    await flushMicro();
    assert.strictEqual(runs, 1, 'three changes → one refresh');
    assert.strictEqual(svc.runs, 1);
  });

  test('no producer OUTPUT (fed through the real default predicate) arms a refresh', () => {
    // Integration loop-guard: every file a refresh itself writes — board.json/.md,
    // the atomic temp sibling, the renewed supervisor.lock.json, loop-state.json —
    // must pass through notifyChange + the REAL predicate and arm nothing.
    const ft = fakeTimers();
    const svc = startBoardRefreshService({
      refresh: async () => {}, maxWaitMs: 0, // default predicate (no override)
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    for (const out of [
      '/p/.autoclaw/orchestrator/board.json',
      '/p/.autoclaw/orchestrator/board.md',
      '/p/.autoclaw/orchestrator/board.json.tmp-9-0',
      '/p/.autoclaw/orchestrator/comms/supervisor.lock.json',
      '/p/.autoclaw/orchestrator/comms/loop-state.json',
    ]) {
      svc.notifyChange(out);
    }
    assert.ok(!svc.pending, 'no producer output arms a refresh');
    assert.strictEqual(ft.timers.size, 0, 'no timer armed by any producer output');
  });

  test('a change arriving mid-run schedules exactly one follow-up refresh', async () => {
    const ft = fakeTimers();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const svc = startBoardRefreshService({
      refresh: async () => { runs += 1; if (runs === 1) { await gate; } },
      debounceMs: 300, maxWaitMs: 0, shouldRefresh: () => true,
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    svc.notifyChange(CLAIM);
    ft.fireSmallest(); await flushMicro();         // refresh #1 starts, awaits gate
    assert.strictEqual(runs, 1);
    svc.notifyChange(HB);                          // arrives mid-run → pending, no new timer yet
    assert.ok(svc.pending);
    release(); await flushMicro();                 // refresh #1 finishes → finally arms a follow-up
    assert.ok(ft.timers.size >= 1, 'a follow-up debounce timer was armed');
    ft.fireSmallest(); await flushMicro();         // refresh #2
    assert.strictEqual(runs, 2, 'exactly one follow-up');
  });

  test('maxWait forces a refresh even when the debounce keeps re-arming (anti-starvation)', async () => {
    const ft = fakeTimers();
    let runs = 0;
    const svc = startBoardRefreshService({
      refresh: async () => { runs += 1; },
      debounceMs: 300, maxWaitMs: 1000, shouldRefresh: () => true,
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    svc.notifyChange(CLAIM);
    assert.strictEqual(ft.timers.size, 2, 'debounce + maxWait armed');
    ft.fireMs(1000);              // fire ONLY the maxWait ceiling, never the debounce
    await flushMicro();
    assert.strictEqual(runs, 1, 'maxWait forced the refresh');
  });

  test('debounce is clamped to the floor', () => {
    const ft = fakeTimers();
    const svc = startBoardRefreshService({
      refresh: async () => {}, debounceMs: 5, maxWaitMs: 0, shouldRefresh: () => true,
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    svc.notifyChange(CLAIM);
    const armed = [...ft.timers.values()][0];
    assert.strictEqual(armed.ms, MIN_BOARD_REFRESH_DEBOUNCE_MS);
  });

  test('stop() halts and clears timers; later changes are ignored', async () => {
    const ft = fakeTimers();
    let runs = 0;
    const svc = startBoardRefreshService({
      refresh: async () => { runs += 1; }, debounceMs: 300, maxWaitMs: 1000, shouldRefresh: () => true,
      setTimeoutFn: ft.setTimeoutFn, clearTimeoutFn: ft.clearTimeoutFn,
    });
    svc.notifyChange(CLAIM);
    svc.stop();
    assert.ok(!svc.running);
    assert.strictEqual(ft.timers.size, 0, 'timers cleared on stop');
    svc.notifyChange(CLAIM);
    assert.ok(!svc.pending, 'ignores changes after stop');
    ft.fireSmallest(); await flushMicro();
    assert.strictEqual(runs, 0);
  });
});

// ---------------------------------------------------------------------------
// refreshBoardNow — L1 single-active gate (fs)
// ---------------------------------------------------------------------------

function makeWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-brefresh-'));
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return d;
}
function writeLease(ws: string, holder: string): void {
  const now = Date.now();
  fs.writeFileSync(
    path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'supervisor.lock.json'),
    JSON.stringify({
      holder, acquired_at: new Date(now - 5000).toISOString(),
      heartbeat: new Date(now).toISOString(), expires: new Date(now + 90_000).toISOString(),
    }, null, 2), 'utf8',
  );
}
const boardJson = (ws: string): string => path.join(ws, '.autoclaw', 'orchestrator', 'board.json');

suite('boardRefresh — refreshBoardNow (single-active gate)', () => {
  test('a standby (foreign fresh lease) writes NO board', async () => {
    const ws = makeWs();
    try {
      writeLease(ws, 'other-loop');
      const r = await refreshBoardNow({ workspaceRoot: ws, holderId: 'me', singleActive: true });
      assert.strictEqual(r.refreshed, false);
      assert.strictEqual(r.standby, true);
      assert.strictEqual(fs.existsSync(boardJson(ws)), false);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  // The PRODUCTION steady state: the 30s tick already holds the lease under
  // LOOP_INSTANCE_ID, then a watch event calls refreshBoardNow with the SAME id.
  // The whole real-time path depends on acquireSupervisorRole treating a
  // self-held fresh lease as a RENEW (isSupervisor:true), not a stand-by.
  test('renews a SELF-held fresh lease and writes (production steady state)', async () => {
    const ws = makeWs();
    try {
      writeLease(ws, 'me'); // already ours, fresh
      const r = await refreshBoardNow({ workspaceRoot: ws, holderId: 'me', singleActive: true });
      assert.strictEqual(r.refreshed, true, 'same-holder fresh lease must RENEW, not stand by');
      assert.strictEqual(r.standby, false);
      assert.strictEqual(fs.existsSync(boardJson(ws)), true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('a solo host wins the lease and writes the board', async () => {
    const ws = makeWs();
    try {
      const r = await refreshBoardNow({ workspaceRoot: ws, holderId: 'me', singleActive: true });
      assert.strictEqual(r.refreshed, true);
      assert.strictEqual(r.standby, false);
      assert.strictEqual(fs.existsSync(boardJson(ws)), true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('legacy mode (singleActive=false) writes the board even with a foreign lease', async () => {
    const ws = makeWs();
    try {
      writeLease(ws, 'other-loop');
      const r = await refreshBoardNow({ workspaceRoot: ws, holderId: 'me', singleActive: false });
      assert.strictEqual(r.refreshed, true);
      assert.strictEqual(fs.existsSync(boardJson(ws)), true);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});
