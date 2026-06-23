import * as assert from 'assert';
import {
  renderBoard, renderMessageFeed, buildThreads, boardTaskCount, MAX_CARDS_PER_COLUMN,
  inferRoleFromActivity, resolveDisplayRole,
  type BoardSnapshot, type BoardRenderContext, type ThreadMessage,
} from '../webview-render-board';

const NOW = new Date('2026-06-12T12:00:00Z').getTime();

const ctx: BoardRenderContext = {
  roleOf: { 'claude-code': 'coder', kilocode: 'reviewer', orch: 'orchestrator' },
  nameOf: { 'claude-code': 'Claude Code', kilocode: 'Kilo Code', orch: 'Orchestrator' },
  modelOf: { 'claude-code': 'claude-fable-5' },
  now: NOW,
};

const board: BoardSnapshot = {
  fleet_size: 3,
  live_count: 2,
  claimable: [
    { task_id: 'T-1', title: 'Add login', sprint: 2, priority: 'high', files: ['a.ts', 'b.ts'] },
  ],
  in_flight: [
    { task_id: 'T-2', title: 'Build panel', claimed_by: 'claude-code', age_ms: 120000, owner_healthy: true },
  ],
  awaiting_review: [
    { task_id: 'T-3', author: 'claude-code', reviewers: ['kilocode'], votes_received: 0, votes_required: 1, rule: 'majority', approvals: 0, request_changes: 0 },
  ],
  stuck: [
    { task_id: 'T-4', reason: 'claim_expired', detail: 'ttl exceeded', age_ms: 500000 },
  ],
};

suite('board renderer — kanban shell', () => {
  test('renders four columns with correct counts', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('board-col-backlog'));
    assert.ok(html.includes('board-col-inflight'));
    assert.ok(html.includes('board-col-review'));
    assert.ok(html.includes('board-col-blocked'));
    // one card per column → col-count of 1 each
    assert.strictEqual((html.match(/col-count">1</g) || []).length, 4);
  });

  test('no Recent evidence strip when there are no capsules', () => {
    assert.ok(!renderBoard(board, ctx).includes('board-evidence'));
  });

  test('renders a Recent evidence strip with verdict + gate state', () => {
    const withCaps: BoardSnapshot = {
      ...board,
      recent_capsules: [
        { run_id: 'run-xyz', task_id: 'T-3', source: 'consensus', verdict: 'blocked', gates_passed: false, votes_count: 2, evaluated_at: new Date(NOW).toISOString() },
      ],
    };
    const html = renderBoard(withCaps, ctx);
    assert.ok(html.includes('board-evidence'));
    assert.ok(html.includes('Recent evidence'));
    assert.ok(html.includes('run-xyz'));
    assert.ok(html.includes('ev-gate-fail'));
  });

  test('null board → friendly empty hint, no kanban shell', () => {
    const html = renderBoard(null, ctx);
    assert.ok(!html.includes('board-kanban'));
    assert.ok(html.includes('No board yet'));
  });

  test('in-flight card shows assignee name + abbreviated model', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('Claude Code'));
    assert.ok(html.includes('claude-fable-5'));
  });

  test('review card shows reviewer + vote tally', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('Kilo Code'));
    assert.ok(html.includes('0/1'));
  });

  test('stuck card surfaces the reason without underscores', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('claim expired'));
  });

  test('participant chips carry the role color class', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('who role-coder'));     // claude-code
    assert.ok(html.includes('who role-reviewer'));  // kilocode
  });
});

suite('board renderer — card detail drill-down (Lane A)', () => {
  test('every card carries a detail toggle + a collapsed .card-detail block', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('card-detail-toggle'), 'detail toggle present');
    // The detail block ships collapsed (hidden) so the board reads compact.
    assert.ok(/<div class="card-detail" hidden>/.test(html), 'detail block hidden by default');
  });

  test('claimable detail surfaces priority/sprint/files', () => {
    const html = renderBoard(board, ctx);
    // T-1 lists two files in its detail.
    assert.ok(html.includes('detail-files'));
    assert.ok(html.includes('a.ts') && html.includes('b.ts'));
    assert.ok(html.includes('>high<'), 'priority value present in detail');
  });

  test('review detail surfaces approvals / change-requests / votes / rule', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('Approvals'));
    assert.ok(html.includes('Change requests'));
    assert.ok(html.includes('>majority<'), 'consensus rule value present');
    assert.ok(html.includes('detail-reviewers'), 'reviewers row present');
  });

  test('stuck detail surfaces reason + detail note', () => {
    const html = renderBoard(board, ctx);
    assert.ok(html.includes('>claim expired<'), 'reason in detail KV');
    assert.ok(html.includes('ttl exceeded'), 'detail note rendered');
  });

  test('Open-chat button renders ONLY when sessionOf has the owner', () => {
    // No sessionOf → no button anywhere (graceful omission, no dead button).
    assert.ok(!renderBoard(board, ctx).includes('session-open'));
    // With a session for the in-flight owner (claude-code), its card gets one.
    const withSession: BoardRenderContext = {
      ...ctx,
      sessionOf: {
        'claude-code': { session_id: 'sess-abc', source: 'claude-code', rawRef: '/x/raw' },
      },
    };
    const html = renderBoard(board, withSession);
    assert.ok(html.includes('session-open'), 'open-chat button rendered for owner with a session');
    assert.ok(html.includes('data-session-id="sess-abc"'));
    assert.ok(html.includes('data-source="claude-code"'));
    assert.ok(html.includes('data-raw-ref="/x/raw"'));
  });

  test('no Open-chat button for an owner absent from sessionOf', () => {
    // kilocode authors no in-flight work and has no session entry → review card
    // (authored by claude-code) gets a button, but only because claude-code has one.
    const onlyKilo: BoardRenderContext = {
      ...ctx,
      sessionOf: { kilocode: { session_id: 'k-1', source: 'kilocode' } },
    };
    const html = renderBoard(board, onlyKilo);
    // The in-flight + done + review cards are owned by claude-code (no session) →
    // no button references claude-code's (absent) session.
    assert.ok(!html.includes('data-session-id="k-1"'),
      'kilocode session never surfaces (it owns no card here)');
  });

  test('a card with no detail/sessionOf renders no toggle (back-compat)', () => {
    // An empty board still produces the empty hint, never a stray toggle.
    const empty = renderBoard({ claimable: [], in_flight: [], awaiting_review: [], stuck: [] }, ctx);
    assert.ok(!empty.includes('card-detail-toggle'));
  });
});

suite('board renderer — large fleets', () => {
  test('caps cards per column and shows a "+N more" footer', () => {
    const n = MAX_CARDS_PER_COLUMN + 5;
    const big: BoardSnapshot = {
      claimable: Array.from({ length: n }, (_, i) => ({ task_id: `C-${i}` })),
    };
    const html = renderBoard(big, ctx);
    // Only the cap is rendered as cards…
    assert.strictEqual((html.match(/board-card /g) || []).length, MAX_CARDS_PER_COLUMN);
    // …but the column count reflects the true total, and overflow is noted.
    assert.ok(html.includes(`col-count">${n}<`));
    assert.ok(html.includes('+5 more'));
  });
});

suite('board renderer — threads', () => {
  const entries: ThreadMessage[] = [
    { timestamp: '2026-06-12T11:00:00Z', type: 'task_claim', from: 'claude-code', to: 'shared', task_id: 'T-2', message: 'claiming T-2' },
    { timestamp: '2026-06-12T11:30:00Z', type: 'question', from: 'claude-code', to: 'kilocode', task_id: 'T-2', message: 'which file owns auth?' },
    { timestamp: '2026-06-12T10:00:00Z', type: 'system', from: 'orch', task_id: undefined, message: 'no task' },
  ];

  test('buildThreads groups by task and drops entries with no task_id', () => {
    const threads = buildThreads(entries);
    assert.deepStrictEqual(Object.keys(threads), ['T-2']);
    assert.strictEqual(threads['T-2'].length, 2);
    // sorted oldest-first
    assert.strictEqual(threads['T-2'][0].type, 'task_claim');
  });

  test('board cards expose a thread toggle with the message count', () => {
    const html = renderBoard(board, { ...ctx, threads: buildThreads(entries) });
    // T-2 has 2 messages → a thread-toggle button showing 2
    assert.ok(html.includes('thread-toggle'));
    assert.ok(/thread-toggle[^>]*data-task-id="T-2"/.test(html));
  });

  test('tasks with no messages render no toggle', () => {
    const html = renderBoard(board, { ...ctx, threads: buildThreads(entries) });
    // T-1 has no thread → its card should not carry a toggle for T-1
    assert.ok(!/thread-toggle[^>]*data-task-id="T-1"/.test(html));
  });
});

suite('board renderer — message feed', () => {
  const entries: ThreadMessage[] = [
    { timestamp: '2026-06-12T11:00:00Z', type: 'task_claim', from: 'claude-code', to: 'shared', task_id: 'T-2' },
    { timestamp: '2026-06-12T11:30:00Z', type: 'review_request', from: 'claude-code', to: 'kilocode', task_id: 'T-3' },
  ];

  test('renders newest first with role-colored participants', () => {
    const html = renderMessageFeed(entries, ctx);
    const firstIdx = html.indexOf('T-3');
    const secondIdx = html.indexOf('T-2');
    assert.ok(firstIdx >= 0 && secondIdx >= 0 && firstIdx < secondIdx, 'newest (T-3) should appear first');
    assert.ok(html.includes('who role-coder'));
  });

  test('empty feed → friendly empty state', () => {
    assert.ok(renderMessageFeed([], ctx).includes('No messages yet'));
  });

  test('escapes message types / ids', () => {
    const html = renderMessageFeed(
      [{ timestamp: '2026-06-12T11:00:00Z', type: '<x>', from: 'a', task_id: '<y>' }], ctx);
    assert.ok(!html.includes('<x>'));
    assert.ok(html.includes('&lt;x&gt;'));
  });
});

suite('board renderer — inferRoleFromActivity', () => {
  test('an active claim-holder is a coder', () => {
    assert.strictEqual(inferRoleFromActivity('claude-code', board), 'coder');
  });

  test('an author of work in review is a coder', () => {
    // claude-code authored T-3 (in awaiting_review) and holds no claim here.
    const noClaim: BoardSnapshot = { ...board, in_flight: [] };
    assert.strictEqual(inferRoleFromActivity('claude-code', noClaim), 'coder');
  });

  test('a pure reviewer is a reviewer', () => {
    // kilocode only reviews T-3 here (no claim, not author).
    const onlyReview: BoardSnapshot = {
      awaiting_review: [{ task_id: 'T-3', author: 'claude-code', reviewers: ['kilocode'] }],
    };
    assert.strictEqual(inferRoleFromActivity('kilocode', onlyReview), 'reviewer');
  });

  test('an agent with no board activity, or a null board, is generalist', () => {
    assert.strictEqual(inferRoleFromActivity('nobody', board), 'generalist');
    assert.strictEqual(inferRoleFromActivity('claude-code', null), 'generalist');
  });
});

suite('board renderer — resolveDisplayRole precedence', () => {
  test('declared override wins over everything', () => {
    const role = resolveDisplayRole({
      declared: 'security', role: 'coder', agent_type: 'coder',
      can_orchestrate: true, agentId: 'claude-code', board,
    });
    assert.strictEqual(role, 'security');
  });

  test('a generalist declaration does not override real signal', () => {
    const role = resolveDisplayRole({
      declared: 'generalist', agent_type: 'auditor', agentId: 'x', board: null,
    });
    assert.strictEqual(role, 'reviewer'); // auditor → reviewer
  });

  test('registry agent_type beats board activity', () => {
    const role = resolveDisplayRole({
      agent_type: 'supervisor', agentId: 'claude-code', board,
    });
    assert.strictEqual(role, 'orchestrator'); // not coder from board activity
  });

  test('falls back to board activity when nothing is declared/registered', () => {
    const role = resolveDisplayRole({ agentId: 'claude-code', board });
    assert.strictEqual(role, 'coder'); // authored T-3 in review
  });

  test('generalist when no signal anywhere', () => {
    assert.strictEqual(resolveDisplayRole({ agentId: 'nobody', board: null }), 'generalist');
  });
});

suite('board renderer — boardTaskCount', () => {
  test('sums all four lanes', () => {
    assert.strictEqual(boardTaskCount(board), 4);
  });
  test('null → 0', () => {
    assert.strictEqual(boardTaskCount(null), 0);
  });
});
