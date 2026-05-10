import * as assert from 'assert';
import {
  esc, formatContextWindow, formatAge, shortSessionId,
  statusBadgeClass, trustBadgeClass,
  renderChips, renderDetailRow, renderAgentCard, renderAgentList,
  extractPlatform, payloadExcerpt, filterAwaitingYou, renderAwaitingYou,
  renderFabricHealth,
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

  test('renderAwaitingYou row carries Reply button data attributes', () => {
    const rows: AwaitingYouRow[] = [{
      message: makeMessage({ task_id: 'T-9', sprint: 4 }),
      excerpt: 'Please review',
    }];
    const html = renderAwaitingYou(rows);
    assert.match(html, /class="awaiting-row"/);
    assert.match(html, /class="reply-btn"/);
    assert.match(html, /data-message-id="msg-1"/);
    assert.match(html, /data-from="kiro"/);
    assert.match(html, /data-type="review_request"/);
    assert.match(html, /sprint 4/);
    assert.match(html, /T-9/);
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
});
