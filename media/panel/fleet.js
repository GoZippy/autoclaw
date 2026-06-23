/* fleet.js — AutoClaw Fleet dashboard webview script.
 *
 * CSP-safe: loaded via <script nonce>, no inline handlers, no eval. All DOM is
 * built with createElement (no innerHTML with untrusted content) so message
 * payloads cannot inject markup.
 *
 * Receives `{ type: 'model', model }` and `{ type: 'error', message }` from the
 * extension host; sends `{ command: 'ready' | 'refresh' | 'ping' }` back.
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ---- small DOM helpers --------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }
  function clear(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
  }
  function byId(id) { return document.getElementById(id); }

  // ---- presence bar -------------------------------------------------------
  function renderPresence(presence) {
    const t = byId('presence-text');
    if (t) { t.textContent = presence && presence.text ? presence.text : 'No agents tracked'; }
  }

  // ---- health grid --------------------------------------------------------
  function renderHealthGrid(rows) {
    const body = byId('health-grid-body');
    clear(body);
    if (!rows || rows.length === 0) {
      const tr = el('tr');
      const td = el('td', 'empty', 'No heartbeats yet.');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach(function (r) {
      const tr = el('tr');
      const tdAgent = el('td');
      tdAgent.appendChild(el('span', 'dot ' + r.color));
      tdAgent.appendChild(document.createTextNode(r.agentId));
      tr.appendChild(tdAgent);
      tr.appendChild(el('td', null, r.state));
      tr.appendChild(el('td', null, r.lastSeenLabel));
      tr.appendChild(el('td', 'num', r.queueDepth));
      body.appendChild(tr);
    });
  }

  // ---- agent cards --------------------------------------------------------
  function renderCardDetail(card) {
    const detail = el('div', 'card-detail hidden');

    const dt = card.detail || { claimedTasks: [], sprintAssignments: [], lastOutbound: [] };

    function listBlock(title, items, fmt) {
      detail.appendChild(el('h4', null, title));
      if (!items || items.length === 0) {
        detail.appendChild(el('div', 'empty', '—'));
        return;
      }
      const ul = el('ul');
      items.forEach(function (it) { ul.appendChild(el('li', null, fmt(it))); });
      detail.appendChild(ul);
    }

    listBlock('Claimed tasks', dt.claimedTasks, function (x) { return x; });
    listBlock('Sprint assignments', dt.sprintAssignments, function (x) { return x; });
    listBlock('Last outbound', dt.lastOutbound, function (m) {
      return m.type + ' → ' + m.to + ': ' + m.preview;
    });

    // LANE B: per-agent work-history timeline. The fleet model's card detail
    // carries the agent's claimed (in-flight) tasks and its recent outbound
    // activity; render them as a compact, newest-first timeline so the operator
    // sees what this agent is driving without cross-referencing the board.
    var claimed = dt.claimedTasks || [];
    var outbound = dt.lastOutbound || [];
    if (claimed.length || outbound.length) {
      detail.appendChild(el('h4', null, 'Work history'));
      var ol = el('ol', 'history-timeline');
      claimed.forEach(function (t) {
        var li = el('li', 'history-row history-active');
        li.appendChild(el('span', 'history-dot history-dot-active'));
        li.appendChild(el('span', 'history-task', t));
        li.appendChild(el('span', 'history-state', 'in flight'));
        ol.appendChild(li);
      });
      outbound.forEach(function (m) {
        var li = el('li', 'history-row history-done');
        li.appendChild(el('span', 'history-dot history-dot-done'));
        li.appendChild(el('span', 'history-task', m.type));
        li.appendChild(el('span', 'history-title', '→ ' + m.to + ': ' + m.preview));
        ol.appendChild(li);
      });
      detail.appendChild(ol);
    }

    // LANE B: per-agent Command & Control action row. Each button posts
    // {command, agentId} to the host; the host owns confirmation (Evict opens a
    // REQUIRED modal). stopPropagation so a click never toggles the card.
    var actions = el('div', 'card-actions');
    function actionBtn(command, label, title, cls) {
      var b = el('button', 'btn-action' + (cls ? ' ' + cls : ''), label);
      b.title = title;
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        vscode.postMessage({ command: command, agentId: card.agentId });
      });
      return b;
    }
    var ping = el('button', 'btn-ping', 'Ping');
    ping.title = 'Ping this agent';
    ping.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ command: 'ping', agentId: card.agentId });
    });
    actions.appendChild(ping);
    actions.appendChild(actionBtn('messageAgent', 'Message', 'Send this agent a message (lands in its inbox).'));
    actions.appendChild(actionBtn('pauseAgent', 'Pause', 'Ask this agent to stop claiming new work.'));
    actions.appendChild(actionBtn('resumeAgent', 'Resume', 'Tell a paused agent it may claim work again.'));
    actions.appendChild(actionBtn('reassignAgent', 'Reassign', 'Release a claim this agent holds back to the board.'));
    actions.appendChild(actionBtn('evictAgent', 'Evict', 'Evict this agent (releases work, revokes trust, retires it). Confirmation required.', 'btn-evict'));
    detail.appendChild(actions);
    return detail;
  }

  function renderCards(cards) {
    const grid = byId('card-grid');
    clear(grid);
    const badge = byId('cards-badge');
    if (badge) { badge.textContent = cards ? cards.length : 0; }

    if (!cards || cards.length === 0) {
      grid.appendChild(el('p', 'empty', 'No agents registered.'));
      return;
    }

    cards.forEach(function (card) {
      const c = el('div', 'agent-card');
      // Drill-down parity with the sidebar: the card is a keyboard-focusable
      // toggle (Enter/Space expands its .card-detail, same as a click). This
      // makes the .agent-card:focus-visible affordance in fleet.css reachable.
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.setAttribute('aria-expanded', 'false');

      const top = el('div', 'card-top');
      top.appendChild(el('span', 'avatar', card.avatar));
      const ident = el('div');
      const nameRow = el('div', 'card-name');
      nameRow.appendChild(el('span', 'dot ' + card.color));
      nameRow.appendChild(document.createTextNode(card.name));
      ident.appendChild(nameRow);
      if (card.role) { ident.appendChild(el('div', 'card-role', card.role)); }
      top.appendChild(ident);
      c.appendChild(top);

      c.appendChild(el('div', 'card-meta',
        card.host + ' · ' + card.lastHeartbeatLabel));
      c.appendChild(el('div', 'card-task',
        card.currentTask ? '▸ ' + card.currentTask : 'idle'));

      if (card.capabilities && card.capabilities.length) {
        const caps = el('div', 'caps');
        card.capabilities.forEach(function (cap) {
          caps.appendChild(el('span', 'cap-tag', cap));
        });
        c.appendChild(caps);
      }

      const detail = renderCardDetail(card);
      c.appendChild(detail);

      function toggleDetail() {
        const nowHidden = detail.classList.toggle('hidden');
        c.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
      }
      c.addEventListener('click', toggleDetail);
      // Keyboard parity: Enter / Space expands, but never when the focus is on a
      // nested action button (those handle their own activation + stopPropagation).
      c.addEventListener('keydown', function (ev) {
        if (ev.target !== c) { return; }
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          toggleDetail();
        }
      });

      grid.appendChild(c);
    });
  }

  // ---- agent tree ---------------------------------------------------------
  function renderTreeNode(node) {
    const wrap = el('div', 'tree-node');
    const row = el('div', 'tree-row');
    row.appendChild(el('span', 'dot ' + node.color));
    row.appendChild(el('span', 'avatar', node.avatar));
    row.appendChild(el('span', null, node.name));
    if (node.currentTask) {
      row.appendChild(el('span', 'tree-task', '— ' + node.currentTask));
    }
    wrap.appendChild(row);
    if (node.children && node.children.length) {
      const kids = el('div', 'tree-children');
      node.children.forEach(function (ch) {
        kids.appendChild(renderTreeNode(ch));
      });
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function renderTree(tree) {
    const host = byId('agent-tree');
    clear(host);
    if (!tree || tree.length === 0) {
      host.appendChild(el('p', 'empty', 'No agents.'));
      return;
    }
    tree.forEach(function (root) { host.appendChild(renderTreeNode(root)); });
  }

  // ---- awaiting you -------------------------------------------------------
  function renderAwaiting(items) {
    const body = byId('awaiting-body');
    clear(body);
    const badge = byId('awaiting-badge');
    if (badge) { badge.textContent = items ? items.length : 0; }

    if (!items || items.length === 0) {
      body.appendChild(el('p', 'empty', 'Nothing awaiting your response.'));
      return;
    }
    items.forEach(function (it) {
      const row = el('div', 'awaiting-item' + (it.overdue ? ' overdue' : ''));
      const meta = el('div', 'awaiting-meta');
      meta.appendChild(document.createTextNode(
        it.from + ' · ' + it.type));
      if (it.overdue) {
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(el('span', 'overdue-tag', 'OVERDUE'));
      }
      row.appendChild(meta);
      row.appendChild(el('div', 'awaiting-preview', it.preview));
      body.appendChild(row);
    });
  }

  // ---- activity feed ------------------------------------------------------
  function renderActivity(events) {
    const feed = byId('activity-feed');
    clear(feed);
    if (!events || events.length === 0) {
      feed.appendChild(el('p', 'empty', 'No activity yet.'));
      return;
    }
    events.forEach(function (ev) {
      const row = el('div', 'activity-row');
      row.appendChild(el('span', 'act-kind ' + ev.kind));
      row.appendChild(el('span', 'act-time', ev.timeLabel));
      row.appendChild(el('span', null, ev.text));
      feed.appendChild(row);
    });
  }

  // ---- cost ledger --------------------------------------------------------
  function fmtWall(ms) {
    if (!ms || ms < 1000) { return (ms || 0) + 'ms'; }
    const s = Math.round(ms / 1000);
    if (s < 60) { return s + 's'; }
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  function renderCost(cost) {
    const body = byId('cost-table-body');
    clear(body);
    const rows = (cost && cost.perAgent) || [];
    if (rows.length === 0) {
      const tr = el('tr');
      const td = el('td', 'empty', 'No cost entries.');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
    } else {
      rows.forEach(function (r) {
        const tr = el('tr');
        tr.appendChild(el('td', null, r.agentId));
        tr.appendChild(el('td', 'num', r.totalTokens.toLocaleString()));
        tr.appendChild(el('td', 'num', fmtWall(r.totalWallMs)));
        tr.appendChild(el('td', 'num', r.actionCount));
        body.appendChild(tr);
      });
    }

    const rail = byId('rationale-rail');
    clear(rail);
    const rationales = (cost && cost.recentRationales) || [];
    rationales.forEach(function (r) {
      const item = el('div', 'rationale-item');
      item.appendChild(document.createTextNode(r.agentId + ': '));
      item.appendChild(el('span', 'because', r.because));
      rail.appendChild(item);
    });
  }

  // ---- agendaboard --------------------------------------------------------
  function formatAge(ms) {
    if (!isFinite(ms) || ms < 0) { return '—'; }
    if (ms < 60000) { return Math.round(ms / 1000) + 's'; }
    if (ms < 3600000) { return Math.round(ms / 60000) + 'm'; }
    return Math.round(ms / 3600000) + 'h';
  }

  function boardSubsection(title, count, body) {
    const wrap = el('div', 'board-subsection');
    const h = el('h3', 'board-subhead');
    h.appendChild(document.createTextNode(title + ' '));
    h.appendChild(el('span', 'badge', String(count)));
    wrap.appendChild(h);
    wrap.appendChild(body);
    return wrap;
  }

  function boardEmpty(message) { return el('p', 'empty', message); }

  function boardTable(headers, rows) {
    const tbl = el('table', 'board-table');
    const thead = el('thead');
    const trh = el('tr');
    headers.forEach(function (h) { trh.appendChild(el('th', null, h)); });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tb = el('tbody');
    rows.forEach(function (cells) {
      const tr = el('tr');
      cells.forEach(function (c) {
        const td = el('td');
        if (c && typeof c === 'object' && c.code) {
          td.appendChild(el('code', null, c.code));
        } else if (c && typeof c === 'object' && c.warn) {
          const span = el('span', 'board-warn', c.warn);
          td.appendChild(span);
        } else {
          td.textContent = c == null ? '' : String(c);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    return tbl;
  }

  function renderBoard(board) {
    const body = byId('board-body');
    if (!body) { return; }
    clear(body);

    const badge = byId('board-fleet-badge');
    if (badge) {
      const live = board && typeof board.live_count === 'number' ? board.live_count : 0;
      const total = board && typeof board.fleet_size === 'number' ? board.fleet_size : 0;
      badge.textContent = live + ' / ' + total;
    }

    if (!board) {
      body.appendChild(boardEmpty('No board snapshot yet.'));
      return;
    }

    // Claimable
    var rows = (board.claimable || []).map(function (c) {
      return [{ code: c.task_id }, c.priority || '—', c.sprint == null ? '—' : c.sprint, c.title || ''];
    });
    body.appendChild(boardSubsection(
      'Claimable', rows.length,
      rows.length === 0
        ? boardEmpty('Every open task has an owner or is awaiting review.')
        : boardTable(['Task', 'Priority', 'Sprint', 'Title'], rows),
    ));

    // In flight
    rows = (board.in_flight || []).map(function (i) {
      return [
        { code: i.task_id },
        i.claimed_by,
        formatAge(i.age_ms),
        i.owner_healthy ? 'yes' : { warn: 'no' },
      ];
    });
    body.appendChild(boardSubsection(
      'In flight', rows.length,
      rows.length === 0
        ? boardEmpty('No active claims.')
        : boardTable(['Task', 'Owner', 'Age', 'Owner healthy'], rows),
    ));

    // Awaiting review
    rows = (board.awaiting_review || []).map(function (r) {
      var votes = (r.votes_received || 0) + '/' + (r.votes_required || 0);
      if (r.approvals || r.request_changes) {
        votes += ' (+' + (r.approvals || 0) + '/−' + (r.request_changes || 0) + ')';
      }
      return [
        { code: r.task_id }, r.author, r.rule, votes,
        (r.reviewers || []).join(', '), formatAge(r.age_ms),
      ];
    });
    body.appendChild(boardSubsection(
      'Awaiting review', rows.length,
      rows.length === 0
        ? boardEmpty('No reviews open.')
        : boardTable(['Task', 'Author', 'Rule', 'Votes', 'Reviewers', 'Age'], rows),
    ));

    // Stuck
    rows = (board.stuck || []).map(function (s) {
      return [
        { code: s.task_id }, { warn: s.reason }, formatAge(s.age_ms), s.detail || '',
      ];
    });
    body.appendChild(boardSubsection(
      'Stuck', rows.length,
      rows.length === 0
        ? boardEmpty('Nothing stuck — fleet is healthy.')
        : boardTable(['Task', 'Reason', 'Age', 'Detail'], rows),
    ));

    // Recent evidence (capsules) — a read-only log of completed review cycles.
    var caps = board.recent_capsules || [];
    if (caps.length) {
      rows = caps.map(function (c) {
        var gate = c.gates_passed === undefined ? '—' : (c.gates_passed ? '✓' : { warn: '✗' });
        return [{ code: c.task_id }, c.verdict || '—', gate, c.votes_count == null ? 0 : c.votes_count, c.source || '—', { code: c.run_id }];
      });
      body.appendChild(boardSubsection(
        'Recent evidence', rows.length,
        boardTable(['Task', 'Verdict', 'Gate', 'Votes', 'Source', 'Run'], rows),
      ));
    }
  }

  // ---- top-level render ---------------------------------------------------
  function render(model) {
    if (!model) { return; }
    renderPresence(model.presence);
    renderBoard(model.board);
    renderAwaiting(model.awaitingYou);
    renderHealthGrid(model.healthGrid);
    renderCards(model.cards);
    renderTree(model.tree);
    renderCost(model.cost);
    renderActivity(model.activity);
    vscode.setState({ model: model });
  }

  function renderError(message) {
    const t = byId('presence-text');
    if (t) { t.textContent = message; }
  }

  // ---- wiring -------------------------------------------------------------
  window.addEventListener('message', function (event) {
    const data = event.data || {};
    if (data.type === 'model') { render(data.model); }
    else if (data.type === 'error') { renderError(data.message); }
  });

  const refreshBtn = byId('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      vscode.postMessage({ command: 'refresh' });
    });
  }

  // ---- fleet actions toolbar (Command Center P1) --------------------------
  // Each button just posts a command the host maps to an existing, already-
  // registered command — no fleet logic lives here.
  function wireAction(id, command) {
    const btn = byId(id);
    if (btn) {
      btn.addEventListener('click', function () {
        vscode.postMessage({ command: command });
      });
    }
  }
  wireAction('btn-join-prompt', 'generateJoinPrompt');
  wireAction('btn-invite-agent', 'inviteAgent');
  wireAction('btn-admit-agent', 'admitAgent');
  wireAction('btn-decline-agent', 'declineAgent');

  // Restore last state immediately, then ask the host for fresh data.
  const prev = vscode.getState();
  if (prev && prev.model) { render(prev.model); }
  vscode.postMessage({ command: 'ready' });
})();
