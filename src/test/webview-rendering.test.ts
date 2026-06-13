import * as assert from 'assert';
import {
  esc, formatContextWindow, formatAge, shortSessionId, shortModel,
  statusBadgeClass, trustBadgeClass,
  renderChips, renderDetailRow, renderAgentCard, renderAgentList,
  extractPlatform, payloadExcerpt, filterAwaitingYou, renderAwaitingYou,
  renderFabricHealth, bridgeTooltip, kgTooltip, kgClickCommand,
  agentHost, isRemoteAgent, agentRole, renderRoleChip, renderTeamSummary,
  renderSessionList,
  type AgentWithLive, type InboxSummary, type AwaitingYouRow, type FabricHealth,
} from '../webview-render';
import type { Message, RegisteredAgent, Heartbeat } from '../comms';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

suite('webview-render — escaping & formatters', () => {
  test('esc encodes < > & " \' as entities', () => {
    assert.strictEqual(esc('<b>"a"&\'b\'</b>'), '&lt;b&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/b&gt;');
  });

  test('esc handles undefined/null without throwing', () => {
    assert.strictEqual(esc(undefined), '');
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(0), '0');
  });

  test('formatContextWindow renders 1M, 200K, raw small values', () => {
    assert.strictEqual(formatContextWindow(1_000_000), '1M');
    assert.strictEqual(formatContextWindow(2_500_000), '2.5M');
    assert.strictEqual(formatContextWindow(200_000), '200K');
    assert.strictEqual(formatContextWindow(750), '750');
  });

  test('formatContextWindow returns empty string for falsy / non-finite', () => {
    assert.strictEqual(formatContextWindow(undefined), '');
    assert.strictEqual(formatContextWindow(0), '');
    assert.strictEqual(formatContextWindow(NaN), '');
  });

  test('formatAge buckets by seconds/minutes/hours/days', () => {
    const now = new Date('2026-05-10T00:00:00Z').getTime();
    const offset = (s: number) => new Date(now - s * 1000).toISOString();
    assert.strictEqual(formatAge(offset(30), now), '30s ago');
    assert.strictEqual(formatAge(offset(120), now), '2 min ago');
    assert.strictEqual(formatAge(offset(7200), now), '2h ago');
    assert.strictEqual(formatAge(offset(2 * 86400), now), '2d ago');
    assert.strictEqual(formatAge(null, now), 'never');
    assert.strictEqual(formatAge('not-a-date', now), 'never');
  });

  test('shortSessionId truncates >8 chars and leaves shorter ones alone', () => {
    assert.strictEqual(shortSessionId('abcdefgh'), 'abcdefgh');
    assert.strictEqual(shortSessionId('abcdefghijkl'), 'abcdefgh…');
    assert.strictEqual(shortSessionId(undefined), '');
  });

  test('shortModel drops vendor prefixes and date stamps', () => {
    assert.strictEqual(shortModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.strictEqual(shortModel('us.anthropic.claude-fable-5'), 'claude-fable-5');
    assert.strictEqual(shortModel('anthropic/claude-opus-4-8'), 'claude-opus-4-8');
    assert.strictEqual(shortModel('claude-fable-5'), 'claude-fable-5');
    assert.strictEqual(shortModel(undefined), '');
  });

  test('status & trust badge classes map known values', () => {
    assert.strictEqual(statusBadgeClass('active'), 'status-active');
    assert.strictEqual(statusBadgeClass('overloaded'), 'status-overloaded');
    assert.strictEqual(statusBadgeClass('mystery' as any), 'status-detected');
    assert.strictEqual(trustBadgeClass('high'), 'trust-high');
    assert.strictEqual(trustBadgeClass(undefined), 'trust-unknown');
  });

  test('extractPlatform recognises common extension ids', () => {
    assert.strictEqual(extractPlatform('anthropic.claude-code'), 'claude-code');
    assert.strictEqual(extractPlatform('kilocode.kilo-code'), 'kilocode');
    assert.strictEqual(extractPlatform('saoudrizwan.cursor'), 'cursor');
    assert.strictEqual(extractPlatform('publisher.unknown-thing'), 'unknown-thing');
  });
});

// ---------------------------------------------------------------------------
// Chip / row renderers
// ---------------------------------------------------------------------------

suite('webview-render — chips and rows', () => {
  test('renderChips hides itself when array is empty/undefined', () => {
    assert.strictEqual(renderChips('Capabilities', []), '');
    assert.strictEqual(renderChips('Capabilities', undefined), '');
  });

  test('renderChips emits one .chip per value with HTML-escape', () => {
    const html = renderChips('Capabilities', ['typescript', '<x>']);
    assert.match(html, /class="chip"/);
    assert.match(html, /typescript/);
    assert.match(html, /&lt;x&gt;/);
    assert.ok(!html.includes('<x>'));
  });

  test('renderDetailRow returns "" when value is empty', () => {
    assert.strictEqual(renderDetailRow('label', ''), '');
    assert.strictEqual(renderDetailRow('label', null), '');
    assert.strictEqual(renderDetailRow('label', undefined), '');
  });

  test('renderDetailRow encodes value HTML-safely', () => {
    const out = renderDetailRow('Trust', '<script>x</script>');
    assert.match(out, /&lt;script&gt;/);
  });
});

// ---------------------------------------------------------------------------
// Agent card rendering
// ---------------------------------------------------------------------------

function makeFullAgent(): AgentWithLive {
  return {
    id: 'kiro',
    name: 'Kiro',
    extension_id: 'kiro.ide',
    detected: true,
    inbox_path: 'inboxes/kiro',
    hooks_supported: true,
    last_heartbeat: '2026-05-10T00:00:00Z',
    status: 'active',
    capabilities: ['typescript', 'react', 'go'],
    llms_available: ['claude-3.5-sonnet', 'gpt-4o'],
    context_window: 1_000_000,
    trust_level: 'high',
    cost_budget: { daily_usd: 25, hourly_usd: 5 },
    rules_path: '.kiro/rules/cross-agent-protocol.md',
    live_status: 'active',
    heartbeat: {
      agent_id: 'kiro',
      timestamp: new Date(Date.now() - 90 * 1000).toISOString(),
      status: 'active',
      current_task: 'task-7',
      sprint: 3,
      session_id: 'abcdefgh-1234-5678',
      current_llm: 'claude-3.5-sonnet',
      queue_depth: 4,
      token_budget_remaining: 12_000,
      error_rate_1m: 0.02,
      last_error: { timestamp: '2026-05-09T23:00:00Z', message: 'transient timeout' },
    },
  };
}

function makeMinimalAgent(): AgentWithLive {
  return {
    id: 'cursor',
    name: 'Cursor',
    extension_id: null,
    detected: true,
    inbox_path: 'inboxes/cursor',
    hooks_supported: false,
    last_heartbeat: null,
    status: 'detected',
  };
}

suite('webview-render — agent cards', () => {
  test('renders an agent with all v2 fields without throwing', () => {
    const html = renderAgentCard(makeFullAgent(), {
      total: 5, unread: 2, awaiting_response: 1, archived: 1,
    });
    assert.match(html, /class="agent-card"/);
    assert.match(html, /status-pill status-active/);
    assert.match(html, /typescript/);
    assert.match(html, /claude-3.5-sonnet/);
    assert.match(html, /1M/);                   // context window
    assert.match(html, /trust-pill trust-high/);
    assert.match(html, /\$25\/day/);
    assert.match(html, /Queue Depth/);
    assert.match(html, /Tokens Remaining/);
    assert.match(html, /Error Rate \(1m\)/);
    assert.match(html, /transient timeout/);
    assert.match(html, /Session/);
    assert.match(html, /inbox-summary/);
    // ARIA
    assert.match(html, /role="button"/);
    assert.match(html, /aria-expanded="false"/);
  });

  test('renders an agent with NO v2 fields (minimal view)', () => {
    const html = renderAgentCard(makeMinimalAgent(), null);
    assert.match(html, /class="agent-card"/);
    assert.match(html, /status-pill status-detected/);
    assert.match(html, /Cursor/);
    // No chips / trust / queue depth content for minimal agents.
    assert.ok(!html.includes('Capabilities'));
    assert.ok(!html.includes('Trust'));
    assert.ok(!html.includes('Queue Depth'));
    assert.ok(!html.includes('inbox-summary'));
  });

  test('inbox-summary numbers come straight from the InboxSummary input', () => {
    const summary: InboxSummary = { total: 9, unread: 3, awaiting_response: 2, archived: 4 };
    const html = renderAgentCard(makeFullAgent(), summary);
    // The four counters appear in declared order — Total, Unread, Awaiting You, Archived.
    const re = /class="ic-num">(\d+)</g;
    const nums: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) { nums.push(parseInt(m[1], 10)); }
    assert.deepStrictEqual(nums, [9, 3, 2, 4]);
  });

  test('renderAgentList shows empty state when array is empty', () => {
    const html = renderAgentList([]);
    assert.match(html, /class="empty"/);
    assert.match(html, /No agents detected/);
  });

  test('renderAgentList concatenates all agents into HTML', () => {
    const html = renderAgentList([makeFullAgent(), makeMinimalAgent()]);
    assert.match(html, /Kiro/);
    assert.match(html, /Cursor/);
  });

  test('queue depth >= 10 marks the bar with .warn', () => {
    const a = makeFullAgent();
    (a.heartbeat as Heartbeat).queue_depth = 12;
    const html = renderAgentCard(a, null);
    assert.match(html, /queue-bar warn/);
  });
});

// ---------------------------------------------------------------------------
// Awaiting You filter + render
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    from: 'kiro',
    to: 'claude-code',
    type: 'review_request',
    timestamp: '2026-05-10T01:00:00Z',
    payload: { description: 'Please review the new HTTP handler' },
    requires_response: true,
    ...overrides,
  };
}

suite('webview-render — Awaiting You filter', () => {
  test('keeps only messages addressed to me, requires_response, no reply', () => {
    const me = 'claude-code';
    const messages: Message[] = [
      makeMessage({ id: 'm-1' }),
      makeMessage({ id: 'm-2', to: 'kiro' }),                                    // not me
      makeMessage({ id: 'm-3', requires_response: false }),                      // no response needed
      makeMessage({ id: 'm-4' }),
    ];
    const states = { 'm-4': { replied_at: '2026-05-10T02:00:00Z' } };           // already replied
    const out = filterAwaitingYou(messages, me, states);
    assert.deepStrictEqual(out.map(m => m.id), ['m-1']);
  });

  test('renderAwaitingYou empty case shows the empty paragraph', () => {
    const html = renderAwaitingYou([]);
    assert.match(html, /class="empty"/);
  });

  test('review_request rows render vote buttons (not a free-text reply)', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9', sprint: 4 }),
      excerpt: 'Please review',
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /class="awaiting-row"/);
    // Decision buttons, one per vote, carrying the task + message ids.
    assert.match(html, /data-vote="approve"/);
    assert.match(html, /data-vote="request_changes"/);
    assert.match(html, /data-vote="reject"/);
    assert.match(html, /data-task-id="T-9"/);
    assert.match(html, /data-message-id="msg-1"/);
    assert.match(html, /class="vote-comment"/);
    assert.match(html, /sprint 4/);
    // A review is a decision, not a reply — no free-text reply button here.
    assert.doesNotMatch(html, /class="reply-btn"/);
  });

  test('non-review items (question) keep the free-text Reply button', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ id: 'q-1', type: 'question', payload: { question: 'Which DB?' } }),
      excerpt: 'Which DB?',
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /class="reply-btn"/);
    assert.match(html, /data-type="question"/);
    assert.doesNotMatch(html, /data-vote="approve"/);
  });

  test('renderAwaitingYou renders the consensus tally and "needs you" hint', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9' }),
      excerpt: 'Please review',
      tally: {
        approvals: 1, requestChanges: 0, rejects: 0,
        votesReceived: 1, votesRequired: 2, rule: 'majority',
        reviewers: ['kilocode', 'claude-code'], myVote: null, decided: false,
      },
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /awaiting-tally needs-you/);
    assert.match(html, /1\/2 votes · majority/);
    assert.match(html, /Your decision is needed/);
  });

  test('renderAwaitingYou marks the reviewer\'s existing vote as cast', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9' }),
      excerpt: 'Please review',
      tally: {
        approvals: 1, requestChanges: 0, rejects: 0,
        votesReceived: 1, votesRequired: 2, rule: 'majority',
        reviewers: ['claude-code'], myVote: 'approve', decided: false,
      },
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /vote-approve cast/);
    assert.match(html, /aria-pressed="true"/);
  });

  test('renderAwaitingYou drills into resolved source context', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9' }),
      excerpt: 'Added retry logic',
      context: {
        found: true, author: 'kilocode', sprint: 2, branch: 'feat/x',
        summary: 'Added retry logic', files: ['src/a.ts', 'src/b.ts'],
        sourceId: 'msg-src-1',
      },
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /class="awaiting-detail" hidden/);
    assert.match(html, /feat\/x/);
    assert.match(html, /data-file="src\/a.ts"/);
    assert.match(html, /You're deciding whether this work is approved/);
  });

  test('renderAwaitingYou shows a graceful message when source work is missing', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9' }),
      excerpt: 'Peer review requested',
      context: { found: false, sourceId: 'msg-gone', author: 'kilocode' },
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /detail-missing/);
    assert.match(html, /msg-gone/);
  });

  test('payloadExcerpt prefers human fields and truncates long bodies', () => {
    assert.strictEqual(
      payloadExcerpt({ summary: 'short answer' }),
      'short answer'
    );
    const long = 'x'.repeat(200);
    const out = payloadExcerpt({ message: long });
    assert.ok(out.length <= 141);
    assert.ok(out.endsWith('…'));
  });

  test('payloadExcerpt describes auto-promoted reviews instead of dumping JSON', () => {
    const out = payloadExcerpt({
      author: 'kilocode',
      source_task_complete_id: 'msg-2026-05-03T05-30-00-task-complete',
      reason: 'auto_promoted',
      review_policy: 'peer',
    });
    assert.match(out, /Peer review requested by kilocode/);
    assert.doesNotMatch(out, /source_task_complete_id/);
  });

  test('payloadExcerpt JSON-stringifies unknown payload shape', () => {
    const out = payloadExcerpt({ foo: 'bar' });
    assert.match(out, /foo/);
  });
});

// ---------------------------------------------------------------------------
// Fabric health
// ---------------------------------------------------------------------------

suite('webview-render — fabric health', () => {
  test('null health falls back to poll/off labels', () => {
    const html = renderFabricHealth(null);
    assert.match(html, /bridge: poll/);
    assert.match(html, /kg: off/);
  });

  test('SSE active → bridge-sse class', () => {
    const h: FabricHealth = { bridge: 'sse', kg: 'off', sse_clients: 1, ws_clients: 0 };
    const html = renderFabricHealth(h);
    assert.match(html, /bridge-sse/);
    assert.match(html, /bridge: sse/);
  });

  test('WS active outranks SSE', () => {
    const h: FabricHealth = { bridge: 'ws', kg: 'running', sse_clients: 0, ws_clients: 2 };
    const html = renderFabricHealth(h);
    assert.match(html, /bridge-ws/);
    assert.match(html, /kg-running/);
  });

  test('kg unreachable shows red', () => {
    const html = renderFabricHealth({ bridge: 'poll', kg: 'unreachable' });
    assert.match(html, /kg-unreachable/);
  });

  // ── UI-1: tooltips + click actions ──────────────────────────────────────
  test('UI-1: bridge tooltip explains each transport', () => {
    assert.match(bridgeTooltip('poll'), /filesystem polling/i);
    assert.match(bridgeTooltip('sse'),  /Server-Sent Events/);
    assert.match(bridgeTooltip('ws'),   /WebSocket/);
    assert.match(bridgeTooltip('off'),  /disabled/i);
  });

  test('UI-1: bridge tooltip includes client counts when present', () => {
    const tip = bridgeTooltip('sse', { bridge: 'sse', kg: 'off', sse_clients: 3, ws_clients: 0, bridge_port: 7141 });
    assert.match(tip, /SSE=3/);
    assert.match(tip, /WS=0/);
    assert.match(tip, /Port 7141/);
  });

  test('UI-1: kg tooltip explains each state', () => {
    assert.match(kgTooltip('off'),         /not running/i);
    assert.match(kgTooltip('running'),     /active/i);
    assert.match(kgTooltip('unreachable'), /not responding/i);
  });

  test('UI-1: kg click command depends on state', () => {
    assert.strictEqual(kgClickCommand('off'),         'startKgDaemon');
    assert.strictEqual(kgClickCommand('running'),     'openKgDashboard');
    assert.strictEqual(kgClickCommand('unreachable'), 'restartKgDaemon');
  });

  test('UI-1: rendered chips are buttons with data-fabric-action + title + aria-label', () => {
    const html = renderFabricHealth({ bridge: 'poll', kg: 'off' });
    // Both chips must be <button> with explicit action + a11y attrs.
    assert.match(html, /<button[^>]+data-fabric-action="openBridgeDoc"[^>]+title="[^"]+"[^>]+aria-label="[^"]+"/);
    assert.match(html, /<button[^>]+data-fabric-action="startKgDaemon"[^>]+title="[^"]+"[^>]+aria-label="[^"]+"/);
  });

  test('UI-1: tooltips render for every (bridge,kg) state combination', () => {
    const bridges: FabricHealth['bridge'][] = ['poll', 'sse', 'ws', 'off'];
    const kgs:     FabricHealth['kg'][]     = ['off', 'running', 'unreachable'];
    for (const bridge of bridges) {
      for (const kg of kgs) {
        const html = renderFabricHealth({ bridge, kg });
        assert.match(html, /title="[^"]+bridge[^"]*"/i, `bridge=${bridge} kg=${kg}: bridge title missing`);
        assert.match(html, /title="[^"]+(daemon|graph)[^"]*"/i, `bridge=${bridge} kg=${kg}: kg title missing`);
        assert.match(html, new RegExp(`bridge-${bridge}`), `bridge=${bridge}: class missing`);
        assert.match(html, new RegExp(`kg-${kg}`), `kg=${kg}: class missing`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// UI-2: panel version footer
// ---------------------------------------------------------------------------

import { readExtensionVersionFromDisk, readGitBranchFromDisk, renderPanelFooter } from '../webview-render';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

suite('webview-render — UI-2 panel footer', () => {
  test('renderPanelFooter renders version + branch when both present', () => {
    const html = renderPanelFooter('3.1.0-dev', 'feat/v3.1');
    assert.match(html, /class="panel-footer"/);
    assert.match(html, /AutoClaw v3\.1\.0-dev/);
    assert.match(html, /branch: feat\/v3\.1/);
    assert.match(html, /role="contentinfo"/);
  });

  test('renderPanelFooter omits branch when null', () => {
    const html = renderPanelFooter('3.1.0', null);
    assert.match(html, /AutoClaw v3\.1\.0/);
    assert.ok(!html.includes('branch:'), 'branch should be omitted when null');
  });

  test('renderPanelFooter falls back to v? when version is null', () => {
    const html = renderPanelFooter(null, 'master');
    assert.match(html, /AutoClaw v\?/);
    assert.match(html, /branch: master/);
  });

  test('renderPanelFooter HTML-escapes version and branch', () => {
    const html = renderPanelFooter('1.0.0"<script>', 'feat/<x>');
    assert.ok(!/<script>/.test(html), 'raw <script> must not appear in output');
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;x&gt;/);
  });

  test('readExtensionVersionFromDisk returns null on missing package.json', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'autoclaw-ui2-'));
    try {
      assert.strictEqual(readExtensionVersionFromDisk(tmp), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readExtensionVersionFromDisk reads version from package.json', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'autoclaw-ui2-'));
    try {
      fs.writeFileSync(nodePath.join(tmp, 'package.json'), JSON.stringify({ version: '9.9.9' }));
      assert.strictEqual(readExtensionVersionFromDisk(tmp), '9.9.9');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readGitBranchFromDisk returns null when .git/HEAD is missing', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'autoclaw-ui2-'));
    try {
      assert.strictEqual(readGitBranchFromDisk(tmp), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readGitBranchFromDisk parses ref form of .git/HEAD', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'autoclaw-ui2-'));
    try {
      fs.mkdirSync(nodePath.join(tmp, '.git'));
      fs.writeFileSync(nodePath.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/feat/v3.1\n');
      assert.strictEqual(readGitBranchFromDisk(tmp), 'feat/v3.1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readGitBranchFromDisk returns null on detached HEAD', () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'autoclaw-ui2-'));
    try {
      fs.mkdirSync(nodePath.join(tmp, '.git'));
      fs.writeFileSync(nodePath.join(tmp, '.git', 'HEAD'), 'abc1234567890def\n');
      assert.strictEqual(readGitBranchFromDisk(tmp), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke: agent missing in registry doesn't break renderer
// ---------------------------------------------------------------------------

suite('webview-render — defensive edges', () => {
  test('renderAgentCard tolerates agent with extension_id=null', () => {
    const a: AgentWithLive = {
      id: 'detect-only',
      name: 'Detect',
      extension_id: null,
      detected: true,
      inbox_path: '',
      hooks_supported: false,
      last_heartbeat: null,
      status: 'detected',
    };
    const html = renderAgentCard(a);
    assert.match(html, /detect-only/);
    assert.ok(!html.includes('class="agent-platform"'));
  });

  test('renderAgentCard ignores hb fields not present', () => {
    const a = makeFullAgent();
    a.heartbeat = { agent_id: 'kiro', timestamp: new Date().toISOString(), status: 'active', current_task: null, sprint: null };
    const html = renderAgentCard(a);
    assert.ok(!html.includes('Queue Depth'));
    assert.ok(!html.includes('Last Error'));
  });

  test('agent without name falls back to id in the head', () => {
    const a = makeMinimalAgent();
    (a as RegisteredAgent).name = '';
    const html = renderAgentCard(a);
    assert.match(html, /class="agent-name">cursor</);
  });

  test('v2 fields: machine_id, machine_ip, max_parallel_tasks rendered', () => {
    const a = makeMinimalAgent();
    a.machine_id = 'dev-laptop-01';
    a.machine_ip = '192.168.1.42';
    a.max_parallel_tasks = 3;
    const html = renderAgentCard(a);
    assert.ok(html.includes('dev-laptop-01'), 'machine_id rendered');
    assert.ok(html.includes('192.168.1.42'), 'machine_ip rendered');
    assert.ok(html.includes('>3<'), 'max_parallel_tasks rendered');
  });

  test('v2 fields: human_in_loop_required shows required label', () => {
    const a = makeMinimalAgent();
    a.human_in_loop_required = true;
    const html = renderAgentCard(a);
    assert.ok(html.includes('Human-in-Loop'), 'label rendered');
    assert.ok(html.includes('required'), 'value rendered');
  });

  test('v2 fields: tools_supported and skills_loaded rendered as chips', () => {
    const a = makeMinimalAgent();
    a.tools_supported = ['read_file', 'run_tests'];
    a.skills_loaded = ['kdream', 'orchestrate'];
    const html = renderAgentCard(a);
    assert.ok(html.includes('read_file'), 'tool chip rendered');
    assert.ok(html.includes('run_tests'), 'tool chip rendered');
    assert.ok(html.includes('kdream'), 'skill chip rendered');
    assert.ok(html.includes('orchestrate'), 'skill chip rendered');
  });

  test('v2 fields: absent optional fields produce no output', () => {
    const a = makeMinimalAgent();
    const html = renderAgentCard(a);
    assert.ok(!html.includes('Machine'), 'no machine_id row when absent');
    assert.ok(!html.includes('Human-in-Loop'), 'no human_in_loop row when absent');
    assert.ok(!html.includes('Max Parallel'), 'no max_parallel row when absent');
  });
});

// ---------------------------------------------------------------------------
// CF-2: cross-machine origin badge + per-host grouping
// ---------------------------------------------------------------------------

suite('webview-render — cross-machine fleet (CF-2)', () => {
  test('agentHost resolves host → machine_id → "local"', () => {
    assert.strictEqual(agentHost({ ...makeMinimalAgent(), host: 'box-9' }), 'box-9');
    assert.strictEqual(agentHost({ ...makeMinimalAgent(), machine_id: 'm1' }), 'm1');
    assert.strictEqual(agentHost(makeMinimalAgent()), 'local');
  });

  test('isRemoteAgent only true for origin=relay', () => {
    assert.strictEqual(isRemoteAgent({ ...makeMinimalAgent(), origin: 'relay' }), true);
    assert.strictEqual(isRemoteAgent({ ...makeMinimalAgent(), origin: 'local' }), false);
    assert.strictEqual(isRemoteAgent(makeMinimalAgent()), false);
  });

  test('local agent renders no origin badge (single-host path unchanged)', () => {
    const html = renderAgentCard(makeMinimalAgent());
    assert.ok(!html.includes('origin-badge'), 'no badge for a local agent');
  });

  test('remote agent renders an origin badge with its host', () => {
    const a: AgentWithLive = { ...makeMinimalAgent(), origin: 'relay', host: 'workstation-2' };
    const html = renderAgentCard(a);
    assert.ok(html.includes('origin-badge origin-remote'), 'badge present');
    assert.ok(html.includes('workstation-2'), 'host shown in badge');
    assert.ok(html.includes('Host'), 'host detail row present');
  });

  test('renderAgentList stays flat when no relay agents present', () => {
    const html = renderAgentList([makeMinimalAgent(), { ...makeMinimalAgent(), id: 'x2' }]);
    assert.ok(!html.includes('host-group-header'), 'no group headers without relay data');
  });

  test('renderAgentList groups local-first then remote hosts, with counts', () => {
    const agents: AgentWithLive[] = [
      { ...makeMinimalAgent(), id: 'remote-b', origin: 'relay', host: 'zeta' },
      { ...makeMinimalAgent(), id: 'local-a' },
      { ...makeMinimalAgent(), id: 'remote-a', origin: 'relay', host: 'alpha' },
    ];
    const html = renderAgentList(agents);
    // Grouping headers present.
    assert.ok(html.includes('host-group-header local'), 'local group header');
    assert.ok(html.includes('This machine'), 'local label');
    assert.ok(html.includes('alpha') && html.includes('zeta'), 'remote host labels');
    // Order: This machine first, then alpha, then zeta.
    const iLocal = html.indexOf('This machine');
    const iAlpha = html.indexOf('>alpha<');
    const iZeta = html.indexOf('>zeta<');
    assert.ok(iLocal < iAlpha && iAlpha < iZeta, 'local-first then hosts alphabetically');
  });
});

// ---------------------------------------------------------------------------
// Roles, team summary, sessions (fleet visibility upgrade)
// ---------------------------------------------------------------------------

suite('webview-render — roles & model on cards', () => {
  test('agentRole resolves explicit role over agent_type', () => {
    const a: AgentWithLive = { ...makeMinimalAgent(), role: 'reviewer', agent_type: 'coder' };
    assert.strictEqual(agentRole(a), 'reviewer');
  });

  test('renderRoleChip compact uses the abbreviation; full uses the label', () => {
    assert.match(renderRoleChip('security', true), /role-security/);
    assert.match(renderRoleChip('security', true), /SEC/);
    assert.match(renderRoleChip('security', false), /Security/);
  });

  test('card head shows a role chip and the current model abbreviated', () => {
    const a: AgentWithLive = {
      ...makeMinimalAgent(), id: 'cc', name: 'Claude', role: 'coder', status: 'active',
      heartbeat: {
        agent_id: 'cc', timestamp: new Date().toISOString(), status: 'active',
        current_task: null, sprint: null, current_llm: 'us.anthropic.claude-fable-5',
      },
    };
    const html = renderAgentCard(a);
    assert.match(html, /role-chip role-coder/);
    // Visible model text is abbreviated; the full id is preserved in the title.
    assert.match(html, /class="agent-model" title="us\.anthropic\.claude-fable-5">claude-fable-5</);
  });
});

suite('webview-render — team summary', () => {
  test('shows live/total and role distribution chips', () => {
    const agents: AgentWithLive[] = [
      { ...makeMinimalAgent(), id: 'a1', role: 'coder', status: 'active' },
      { ...makeMinimalAgent(), id: 'a2', role: 'coder', status: 'idle' },
      { ...makeMinimalAgent(), id: 'a3', role: 'reviewer', status: 'offline' },
    ];
    const html = renderTeamSummary(agents);
    assert.match(html, /team-summary/);
    assert.match(html, /2<\/span>\/3 live/);     // 2 live of 3
    assert.match(html, /role-coder/);
    assert.match(html, /role-reviewer/);
    assert.match(html, /role-count">2</);         // two coders counted
  });

  test('empty fleet → empty string (no strip)', () => {
    assert.strictEqual(renderTeamSummary([]), '');
  });
});

suite('webview-render — session list', () => {
  const mkHb = (id: string, ageMin: number, model?: string): Heartbeat => ({
    agent_id: 'cc',
    timestamp: new Date(Date.now() - ageMin * 60000).toISOString(),
    status: 'active', current_task: 'T-9', sprint: 1, session_id: id, current_llm: model,
  });

  test('renders one row per session, newest first, model abbreviated', () => {
    const html = renderSessionList([mkHb('old12345', 30), mkHb('new67890', 1, 'claude-haiku-4-5-20251001')]);
    assert.match(html, /session-list/);
    assert.match(html, /session-list-count">2</);
    const iNew = html.indexOf('new67890');
    const iOld = html.indexOf('old12345');
    assert.ok(iNew >= 0 && iOld >= 0 && iNew < iOld, 'newest session first');
    assert.match(html, /claude-haiku-4-5</);
  });

  test('sessions older than 10 min get the stale class', () => {
    const html = renderSessionList([mkHb('stale123', 30)]);
    assert.match(html, /session-row stale/);
  });

  test('empty → empty string', () => {
    assert.strictEqual(renderSessionList([]), '');
    assert.strictEqual(renderSessionList(undefined), '');
  });
});
