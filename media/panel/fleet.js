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

    const ping = el('button', 'btn-ping', 'Ping');
    ping.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ command: 'ping', agentId: card.agentId });
    });
    detail.appendChild(ping);
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

      c.addEventListener('click', function () {
        detail.classList.toggle('hidden');
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

  // ---- top-level render ---------------------------------------------------
  function render(model) {
    if (!model) { return; }
    renderPresence(model.presence);
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

  // Restore last state immediately, then ask the host for fresh data.
  const prev = vscode.getState();
  if (prev && prev.model) { render(prev.model); }
  vscode.postMessage({ command: 'ready' });
})();
