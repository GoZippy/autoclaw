// AutoClaw Unified Panel — merged KDream + Orchestrator dashboard
// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  // ── Persistent UI state ───────────────────────────────────────────
  // The Team view re-renders agent cards / board / awaiting-you via
  // innerHTML on every data tick, which nukes any expand/collapse the
  // user had open. We keep the user's view state here (source of truth)
  // and re-apply it after each render. vscode.getState/setState persist
  // it across full webview reloads (tab switch, window reload, restart).
  //   sections: { [sectionId]: bool }  — only user-overridden sections
  //   agents:   { [agentId]: true }    — open agent cards
  //   threads:  { [taskId]: true }     — open board message-threads
  const _saved = vscode.getState() || {};
  const uiState = {
    sections: (_saved && _saved.sections) || {},
    agents: (_saved && _saved.agents) || {},
    threads: (_saved && _saved.threads) || {},
  };
  function saveUiState() {
    vscode.setState({
      sections: uiState.sections,
      agents: uiState.agents,
      threads: uiState.threads,
    });
  }

  // ── Quick-action buttons ──────────────────────────────────────────
  document.getElementById('btn-launch-skill')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'launchSkill' });
  });

  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn?.addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' });
    // Visual feedback: swap label for 1.2s
    if (refreshBtn) {
      const orig = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing\u2026';
      refreshBtn.disabled = true;
      setTimeout(() => {
        refreshBtn.textContent = orig;
        refreshBtn.disabled = false;
      }, 1200);
    }
  });

  document.getElementById('btn-export')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportSnapshot' });
  });

  // ── Collapsible sections ──────────────────────────────────────────
  document.querySelectorAll('.section-header').forEach(header => {
    const section = header.parentElement;
    const key = section && section.id;
    const toggle = () => {
      const open = section.classList.toggle('open');
      header.setAttribute('aria-expanded', String(open));
      if (key) { uiState.sections[key] = open; saveUiState(); }
    };
    header.addEventListener('click', toggle);
    // Keyboard accessibility
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });

  // Re-apply any section open/closed state the user previously chose.
  // Runs once at load (DOM is ready — this script is at end of <body>).
  function restoreSections() {
    document.querySelectorAll('.panel-section').forEach(section => {
      const key = section.id;
      if (key && Object.prototype.hasOwnProperty.call(uiState.sections, key)) {
        const open = !!uiState.sections[key];
        section.classList.toggle('open', open);
        const head = section.querySelector('.section-header');
        if (head) head.setAttribute('aria-expanded', String(open));
      }
    });
  }
  restoreSections();

  // ── Message handler ───────────────────────────────────────────────
  window.addEventListener('message', event => {
    try {
      const { command, data } = event.data;
      switch (command) {
        // KDream data
        case 'updateStatus': updateStatus(data); break;
        case 'updateTasks': updateTasks(data); break;
        case 'updateTodos': updateTodos(data); break;
        case 'updateLogs': updateLogs(data); break;
        case 'updateAdapterHealth': updateAdapterHealth(data); break;
        case 'updateCodeChurn': updateCodeChurn(data); break;
        case 'updateProductivity': updateProductivity(data); break;
        case 'updateHealth': updateHealth(data); break;
        // Orchestrator data
        case 'updateAgents': renderAgents(data); break;
        case 'updateBoard': renderBoardHtml(data); break;
        case 'updateMessages': renderMessages(data); break;
        case 'updateSprints': renderSprints(data); break;
        case 'updateTimeline': renderTimeline(data); break;
        // v2.5 panel additions
        case 'updateAgentCards': renderAgentCardsHtml(data); break;
        case 'updateAwaitingYou': renderAwaitingYouHtml(data); break;
        case 'updateFabricHealth': renderFabricHealthHtml(data); break;
        // Errors
        case 'error': showError(data); break;
      }
    } catch (err) {
      console.error('AutoClaw panel message handler error:', err);
    }
  });

  // ── Agents section ────────────────────────────────────────────────
  function renderAgents(agents) {
    const el = document.getElementById('agents-content');
    if (!el) return;
    if (!agents?.length) {
      el.innerHTML = '<p class="empty">No agents detected.</p>';
      setBadge('agents-badge', '0');
      return;
    }
    setBadge('agents-badge', String(agents.length));
    let h = '<table><tr><th>Agent</th><th>Status</th><th>Task</th><th>Seen</th></tr>';
    for (const a of agents) {
      const s = a.live_status || a.status;
      const task = a.heartbeat?.current_task || '\u2014';
      const seen = a.heartbeat ? timeAgo(a.heartbeat.timestamp) : 'never';
      h += '<tr>';
      h += '<td><span class="status-dot status-' + esc(s) + '"></span>' + esc(a.name) + '</td>';
      h += '<td>' + esc(s) + '</td>';
      h += '<td>' + esc(task) + '</td>';
      h += '<td>' + esc(seen) + '</td>';
      h += '</tr>';
    }
    el.innerHTML = h + '</table>';
  }

  // ── v2.5 Agent cards (HTML pre-rendered server-side) ──────────────
  function renderAgentCardsHtml(payload) {
    const el = document.getElementById('agents-content');
    if (!el) return;
    const html = (payload && typeof payload.html === 'string') ? payload.html : '';
    const count = (payload && typeof payload.count === 'number') ? payload.count : 0;
    el.innerHTML = html || '<p class="empty">No agents detected.</p>';
    setBadge('agents-badge', String(count));
    // Wire up expand/collapse + Reply buttons after each render.
    el.querySelectorAll('.agent-card-head').forEach(head => {
      head.addEventListener('click', () => toggleAgentCard(head));
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleAgentCard(head);
        }
      });
    });
    // Re-apply expansion the user had open before this data tick.
    el.querySelectorAll('.agent-card').forEach(card => {
      const id = card.getAttribute('data-agent-id');
      if (id && uiState.agents[id]) {
        card.classList.add('open');
        const head = card.querySelector('.agent-card-head');
        if (head) head.setAttribute('aria-expanded', 'true');
        const body = card.querySelector('.agent-card-body');
        if (body) body.removeAttribute('hidden');
      }
    });
  }

  function toggleAgentCard(head) {
    const card = head.closest('.agent-card');
    if (!card) return;
    const isOpen = card.classList.toggle('open');
    head.setAttribute('aria-expanded', String(isOpen));
    const body = head.parentElement?.querySelector('.agent-card-body');
    if (body) {
      if (isOpen) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    }
    const id = card.getAttribute('data-agent-id');
    if (id) {
      if (isOpen) uiState.agents[id] = true; else delete uiState.agents[id];
      saveUiState();
    }
  }

  // ── v2.5 Awaiting You section ─────────────────────────────────────
  function renderAwaitingYouHtml(payload) {
    const el = document.getElementById('awaiting-you-content');
    if (!el) return;
    const html = (payload && typeof payload.html === 'string') ? payload.html : '';
    const count = (payload && typeof payload.count === 'number') ? payload.count : 0;
    el.innerHTML = html || '<p class="empty">Nothing awaiting your response.</p>';
    setBadge('awaiting-you-badge', String(count));
    const section = document.getElementById('awaiting-you-section');
    if (section) {
      // Respect the user's explicit choice if they've toggled this section;
      // otherwise auto-open when there is anything awaiting them.
      if (Object.prototype.hasOwnProperty.call(uiState.sections, 'awaiting-you-section')) {
        const open = !!uiState.sections['awaiting-you-section'];
        section.classList.toggle('open', open);
      } else if (count > 0) {
        section.classList.add('open');
      }
    }
    // Wire Reply buttons (question / generic items)
    el.querySelectorAll('.reply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const messageId = btn.getAttribute('data-message-id');
        const from = btn.getAttribute('data-from');
        const type = btn.getAttribute('data-type');
        vscode.postMessage({ command: 'replyAwaiting', messageId, from, type });
      });
    });

    // Expand / collapse the drill-down detail panel.
    el.querySelectorAll('.awaiting-head[data-action="toggle-detail"]').forEach(head => {
      const toggle = () => {
        const row = head.closest('.awaiting-row');
        const detail = row && row.querySelector('.awaiting-detail');
        const caret = head.querySelector('.awaiting-caret');
        if (!detail) return;
        const opening = detail.hasAttribute('hidden');
        if (opening) { detail.removeAttribute('hidden'); } else { detail.setAttribute('hidden', ''); }
        head.setAttribute('aria-expanded', opening ? 'true' : 'false');
        if (caret) caret.textContent = opening ? '▾' : '▸';
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    // Wire Approve / Request changes / Reject vote buttons.
    el.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.awaiting-row');
        const commentEl = row && row.querySelector('.vote-comment');
        vscode.postMessage({
          command: 'castVote',
          taskId: btn.getAttribute('data-task-id'),
          vote: btn.getAttribute('data-vote'),
          messageId: btn.getAttribute('data-message-id'),
          from: btn.getAttribute('data-from'),
          comment: commentEl ? commentEl.value : '',
        });
      });
    });

    // Wire file links in the drill-down panel.
    el.querySelectorAll('.file-link').forEach(link => {
      link.addEventListener('click', () => {
        vscode.postMessage({ command: 'openAwaitingFile', file: link.getAttribute('data-file') });
      });
    });
  }

  // ── v2.5 Fabric health badges ─────────────────────────────────────
  function renderFabricHealthHtml(payload) {
    const el = document.getElementById('fabric-health-bar');
    if (!el) return;
    el.innerHTML = (payload && typeof payload.html === 'string') ? payload.html : '';
    // UI-1: every chip is a <button data-fabric-action="..."> — wire it.
    el.querySelectorAll('[data-fabric-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-fabric-action');
        if (action) vscode.postMessage({ command: action });
      });
    });
  }

  // ── Sprints section ───────────────────────────────────────────────
  function renderSprints(sprints) {
    const el = document.getElementById('sprints-content');
    const section = document.getElementById('sprints-section');
    if (!el) return;
    if (!sprints?.length) {
      el.innerHTML = '<p class="empty">No sprint plan yet.</p>';
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = '';
    setBadge('sprints-badge', String(sprints.length));
    let h = '';
    for (const s of sprints) {
      const p = s.status === 'merged' ? 100
        : s.status === 'approved' ? 90
        : s.status === 'in_progress' ? 50
        : s.status === 'assigned' ? 10 : 0;
      h += '<div class="sprint-bar">';
      h += '<span class="sprint-label">Sprint ' + s.number + '</span>';
      h += '<div class="sprint-progress" role="progressbar" aria-valuenow="' + p + '" aria-valuemin="0" aria-valuemax="100">';
      h += '<div class="sprint-fill ' + esc(s.status) + '" style="width:' + p + '%"></div></div>';
      h += '<span class="sprint-status">' + esc(s.status) + ' (' + s.tasks + 't)</span>';
      h += '</div>';
    }
    el.innerHTML = h;
  }

  // ── Messages section ──────────────────────────────────────────────
  function renderBoardHtml(payload) {
    const el = document.getElementById('board-content');
    if (!el) return;
    const html = (payload && typeof payload.html === 'string') ? payload.html : '';
    const count = (payload && typeof payload.count === 'number') ? payload.count : 0;
    el.innerHTML = html || '<p class="empty">No board yet.</p>';
    setBadge('board-badge', String(count));
    // Wire the per-task message-thread toggles on each card.
    el.querySelectorAll('.thread-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.board-card');
        const thread = card && card.querySelector('.task-thread');
        if (!thread) return;
        const opening = thread.hasAttribute('hidden');
        if (opening) thread.removeAttribute('hidden'); else thread.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        card.classList.toggle('thread-open', opening);
        const tid = card.getAttribute('data-task-id');
        if (tid) {
          if (opening) uiState.threads[tid] = true; else delete uiState.threads[tid];
          saveUiState();
        }
      });
    });
    // Re-apply any threads the user had expanded before this data tick.
    el.querySelectorAll('.board-card').forEach(card => {
      const tid = card.getAttribute('data-task-id');
      if (tid && uiState.threads[tid]) {
        const thread = card.querySelector('.task-thread');
        const btn = card.querySelector('.thread-toggle');
        if (thread) thread.removeAttribute('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        card.classList.add('thread-open');
      }
    });
  }

  function renderMessages(payload) {
    const el = document.getElementById('messages-content');
    if (!el) return;
    // Back-compat: accept either the new {html,count} payload or a raw array.
    if (Array.isArray(payload)) {
      if (!payload.length) { el.innerHTML = '<p class="empty">No messages yet.</p>'; setBadge('messages-badge', '0'); return; }
      let h = '<div class="msg-feed">';
      for (const e of payload.slice().reverse()) {
        h += '<div class="msg-entry"><span class="msg-time">' + esc(new Date(e.timestamp).toLocaleTimeString()) + '</span> ';
        h += '<span class="msg-type">' + esc(e.type) + '</span> <span class="msg-from">' + esc(e.from) + '</span>';
        if (e.to) h += ' \u2192 <span class="msg-to">' + esc(e.to) + '</span>';
        if (e.task_id) h += ' <em>(' + esc(e.task_id) + ')</em>';
        h += '</div>';
      }
      el.innerHTML = h + '</div>';
      setBadge('messages-badge', String(payload.length));
      return;
    }
    const html = (payload && typeof payload.html === 'string') ? payload.html : '';
    const count = (payload && typeof payload.count === 'number') ? payload.count : 0;
    el.innerHTML = html || '<p class="empty">No messages yet.</p>';
    setBadge('messages-badge', String(count));
  }

  // ── Timeline (folded into Activity) ───────────────────────────────
  function renderTimeline(snapshots) {
    const el = document.getElementById('timeline-content');
    if (!el) return;
    if (!snapshots?.length) { el.innerHTML = ''; return; }
    let h = '<div style="margin-top:6px;border-top:1px solid var(--vscode-panel-border);padding-top:4px;font-size:0.8em;color:var(--vscode-descriptionForeground)">Orchestrator snapshots</div>';
    for (const s of snapshots.slice().reverse().slice(0, 10)) {
      h += '<div class="log-entry">';
      h += '<span style="color:var(--vscode-descriptionForeground)">' + new Date(s.timestamp).toLocaleTimeString() + '</span> ';
      h += '<strong>' + esc(s.event) + '</strong> \u2014 ' + esc(s.description);
      h += '</div>';
    }
    el.innerHTML = h;
  }

  // ── KDream: Status ────────────────────────────────────────────────
  function updateStatus(data) {
    const el = document.getElementById('status-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data) {
      el.innerHTML = '<p class="empty">No status data. Run /kdream start to begin.</p>';
      return;
    }
    const fields = [
      { label: 'Status', value: data.status || 'Unknown' },
      { label: 'Started', value: data.started ? new Date(data.started).toLocaleString() : 'N/A' },
      { label: 'Tick Count', value: String(data.tick || 0) },
      { label: 'Last Dream', value: data.lastDream ? new Date(data.lastDream).toLocaleString() : 'Never' }
    ];
    fields.forEach(f => {
      const p = document.createElement('p');
      p.style.margin = '2px 0';
      p.style.fontSize = '0.85em';
      const b = document.createElement('strong');
      b.textContent = f.label + ':';
      p.appendChild(b);
      p.appendChild(document.createTextNode(' ' + f.value));
      el.appendChild(p);
    });
  }

  // ── KDream: Tasks & follow-ups ────────────────────────────────────
  function updateTasks(data) {
    const el = document.getElementById('tasks-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data?.length) {
      el.innerHTML = '<p class="empty">No tasks or follow-ups found.</p>';
      setBadge('tasks-badge', '0');
      return;
    }
    setBadge('tasks-badge', String(data.length));
    data.forEach((task, index) => {
      const item = document.createElement('div');
      item.className = 'task-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = task.completed;
      cb.setAttribute('aria-label', task.description);
      if (!task.completed) {
        cb.addEventListener('change', () => {
          if (cb.checked) {
            cb.disabled = true;
            vscode.postMessage({ command: 'markTaskComplete', taskIndex: index, taskDescription: task.description });
          }
        });
      } else {
        cb.disabled = true;
      }

      const span = document.createElement('span');
      span.textContent = task.description;
      if (task.completed) {
        span.style.textDecoration = 'line-through';
        span.style.opacity = '0.6';
      }

      item.appendChild(cb);
      item.appendChild(span);
      el.appendChild(item);
    });
  }

  // ── KDream: TODOs & FIXMEs ────────────────────────────────────────
  function updateTodos(data) {
    const el = document.getElementById('todos-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data?.length) {
      el.innerHTML = '<p class="empty">No TODOs or FIXMEs found.</p>';
      return;
    }
    data.forEach(todo => {
      const item = document.createElement('div');
      item.className = 'todo-item';

      const typeRaw = String(todo?.type || 'TODO');
      const badge = document.createElement('span');
      badge.className = 'todo-type ' + typeRaw.toLowerCase();
      badge.textContent = typeRaw;

      const file = document.createElement('span');
      file.className = 'todo-file';
      file.textContent = (todo.file || '?') + ':' + (todo.line ?? '?');

      const text = document.createElement('span');
      text.className = 'todo-text';
      text.textContent = todo.text || '';
      text.title = todo.text || '';

      item.appendChild(badge);
      item.appendChild(file);
      item.appendChild(text);
      el.appendChild(item);
    });
  }

  // ── KDream: Recent activity logs ──────────────────────────────────
  function updateLogs(data) {
    const el = document.getElementById('logs-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data?.length) {
      el.innerHTML = '<p class="empty">No recent activity.</p>';
      return;
    }
    data.forEach(log => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.textContent = log;
      el.appendChild(entry);
    });
  }

  // ── KDream: Adapter health ────────────────────────────────────────
  function updateAdapterHealth(data) {
    const el = document.getElementById('adapter-health-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data?.length) {
      el.innerHTML = '<p class="empty">No adapter health data.</p>';
      return;
    }
    const label = document.createElement('div');
    label.className = 'health-group-label';
    label.textContent = 'Adapters';
    el.appendChild(label);
    data.forEach(adapter => {
      const row = document.createElement('div');
      row.className = 'adapter-status';

      const status = String(adapter?.status || 'unknown');
      const safeStatus = /^[a-z0-9_-]+$/i.test(status) ? status : 'unknown';
      const dot = document.createElement('span');
      dot.className = 'indicator ' + safeStatus;

      const name = document.createElement('span');
      name.textContent = adapter.name || '(unnamed)';

      const details = document.createElement('span');
      details.textContent = adapter.details || '';
      details.style.marginLeft = 'auto';
      details.style.color = 'var(--vscode-descriptionForeground)';

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(details);
      el.appendChild(row);
    });
  }

  // ── KDream: Code churn metrics ────────────────────────────────────
  function updateCodeChurn(data) {
    const el = document.getElementById('code-churn-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data) {
      el.innerHTML = '<p class="empty">No git repository detected.</p>';
      return;
    }
    const label = document.createElement('div');
    label.className = 'health-group-label';
    label.textContent = 'Code Churn';
    el.appendChild(label);
    const metrics = [
      { label: 'Commits (7d)', value: data.commitsLast7Days },
      { label: 'Commits (30d)', value: data.commitsLast30Days },
      { label: 'Lines +/-', value: '+' + data.linesAdded + ' / -' + data.linesDeleted },
      { label: 'Churn Rate', value: data.churnRate + ' lines/commit' },
    ];
    metrics.forEach(m => {
      const p = document.createElement('p');
      p.style.margin = '2px 0';
      p.style.fontSize = '0.85em';
      const b = document.createElement('strong');
      b.textContent = m.label + ':';
      p.appendChild(b);
      p.appendChild(document.createTextNode(' ' + m.value));
      el.appendChild(p);
    });
  }

  // ── KDream: Productivity insights ─────────────────────────────────
  function updateProductivity(data) {
    const el = document.getElementById('productivity-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data) return;
    const label = document.createElement('div');
    label.className = 'health-group-label';
    label.textContent = 'Productivity';
    el.appendChild(label);
    const items = [
      { label: 'TODO Resolution', value: (data.todoResolutionRate * 100).toFixed(1) + '%' },
      { label: 'Commit Freq', value: data.commitFrequency + '/day' },
      { label: 'Active Days (30d)', value: data.activeDays },
    ];
    items.forEach(m => {
      const p = document.createElement('p');
      p.style.margin = '2px 0';
      p.style.fontSize = '0.85em';
      const b = document.createElement('strong');
      b.textContent = m.label + ':';
      p.appendChild(b);
      p.appendChild(document.createTextNode(' ' + m.value));
      el.appendChild(p);
    });
  }

  // ── KDream: Project health indicators ─────────────────────────────
  function updateHealth(data) {
    const el = document.getElementById('health-content');
    if (!el) return;
    el.innerHTML = '';
    if (!data) {
      el.innerHTML = '<p class="empty">No health data available.</p>';
      return;
    }
    const label = document.createElement('div');
    label.className = 'health-group-label';
    label.textContent = 'Project Health';
    el.appendChild(label);
    const indicators = [
      { label: 'Open TODOs', value: data.openTodos, showBar: false },
      { label: 'Uncommitted Changes', value: data.uncommittedChanges, showBar: false },
      { label: 'Memory Completeness', value: data.memoryCompleteness + '%', showBar: true, percent: data.memoryCompleteness },
      { label: 'Adapter Coverage', value: data.adapterCoverage + '%', showBar: true, percent: data.adapterCoverage }
    ];
    indicators.forEach(ind => {
      const item = document.createElement('div');
      item.className = 'metric-item';

      const label = document.createElement('span');
      label.className = 'metric-label';
      label.textContent = ind.label;

      const value = document.createElement('span');
      value.className = 'metric-value';
      value.textContent = ind.value;

      item.appendChild(label);
      item.appendChild(value);

      if (ind.showBar) {
        const pct = Math.max(0, Math.min(100, Number(ind.percent) || 0));
        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuenow', String(pct));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-label', ind.label + ': ' + pct + ' percent');
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        if (pct < 50) fill.classList.add('error');
        else if (pct < 80) fill.classList.add('warning');
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        item.appendChild(bar);
      }

      el.appendChild(item);
    });
  }

  // ── Error display ─────────────────────────────────────────────────
  function showError(message) {
    const el = document.getElementById('panel-root');
    if (el) {
      el.innerHTML = '<div class="error-state"><h2>Error</h2><p>' + esc(message) + '</p><button onclick="location.reload()">Reload</button></div>';
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }

  function setBadge(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ── Request initial data ──────────────────────────────────────────
  vscode.postMessage({ command: 'getInitialData' });

  // ── Section search wiring (UI-5/UI-6/UI-7) ─────────────────────────
  // Config per section: sort options, filter chips, auto-hide threshold.
  // Only sections with >5 items get a search toggle (set in section-search.js).
  const sectionSearchConfigs = {
    'agents': {
      label: 'Agents',
      sort: [
        { value: 'default', label: 'Default' },
        { value: 'alpha', label: 'A–Z' },
        { value: 'active-first', label: 'Active first' }
      ],
      chips: [
        { id: 'active', label: 'Active' },
        { id: 'idle', label: 'Idle' },
        { id: 'stalled', label: 'Stalled' }
      ]
    },
    'messages': {
      label: 'Messages',
      sort: [
        { value: 'default', label: 'Default' },
        { value: 'recency', label: 'Newest' },
        { value: 'alpha', label: 'A–Z' }
      ],
      chips: [
        { id: 'task_assign', label: 'Assign' },
        { id: 'review_request', label: 'Review' },
        { id: 'task_complete', label: 'Complete' },
        { id: 'finding_report', label: 'Finding' }
      ]
    },
    'tasks': {
      label: 'Tasks',
      sort: [
        { value: 'default', label: 'Default' },
        { value: 'recency', label: 'Newest' },
        { value: 'alpha', label: 'A–Z' }
      ],
      chips: [
        { id: 'pending', label: 'Pending' },
        { id: 'complete', label: 'Done' }
      ]
    }
  };

  // Wire sections after DOM is ready
  function wireSectionSearch() {
    if (!window.SectionSearch) return;
    window.SectionSearch.ensureWired();
    for (const [sectionId, config] of Object.entries(sectionSearchConfigs)) {
      window.SectionSearch.wire(sectionId, config);
    }
  }

  // Wire on initial load and after each render cycle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => wireSectionSearch());
  } else {
    wireSectionSearch();
  }

  // Re-wire after message updates (content may have changed)
  const _origAddEventListener = window.addEventListener;
  // Hook into the existing message handler to re-wire after renders
  window.addEventListener('message', (event) => {
    try {
      const { command } = event.data;
      // Re-wire after any content-updating command
      if (['updateAgentCards', 'updateMessages', 'updateTasks', 'updateTodos',
           'updateSprints', 'updateAwaitingYou', 'updateFabricHealth'].includes(command)) {
        // Small delay to let DOM update complete
        setTimeout(() => wireSectionSearch(), 0);
      }
    } catch (_) { /* ignore */ }
  });
})();
