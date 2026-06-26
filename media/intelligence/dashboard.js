/*
 * dashboard.js — Intelligence metrics dashboard webview script.
 *
 * Logic-light by design (the host shapes all data in the host-free metrics
 * store). Responsibilities: request data on load, render summary cards, draw a
 * kept-rate line chart and a Real-vs-Estimated token bar chart with pure Canvas
 * (no CDN, no external libs), wire the action buttons, and toggle the empty
 * state. CSP-safe: this file runs under a nonce; it never uses eval/inline.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const els = {
    empty: document.getElementById('empty-state'),
    error: document.getElementById('error-banner'),
    dashboard: document.getElementById('dashboard'),
    cards: document.getElementById('summary-cards'),
    keptChart: document.getElementById('kept-rate-chart'),
    tokenChart: document.getElementById('token-chart'),
    recent: document.getElementById('recent-runs'),
    // Intelligence Health card (Theme 2).
    healthCard: document.getElementById('health-card'),
    healthDot: document.getElementById('health-dot'),
    healthStatus: document.getElementById('health-status'),
    healthProvider: document.getElementById('health-provider'),
    healthIndex: document.getElementById('health-index'),
    healthNudges: document.getElementById('health-nudges'),
  };

  // ---- Theme-aware colors (read from CSS variables) -----------------------
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  function palette() {
    return {
      fg: cssVar('--vscode-foreground', '#ccc'),
      grid: cssVar('--vscode-panel-border', 'rgba(127,127,127,0.3)'),
      line: cssVar('--vscode-charts-green', '#89d185'),
      real: cssVar('--vscode-charts-blue', '#3794ff'),
      est: cssVar('--vscode-charts-yellow', '#cca700'),
      muted: cssVar('--vscode-descriptionForeground', '#999'),
    };
  }

  // ---- Buttons ------------------------------------------------------------
  document.querySelectorAll('button.action').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const action = btn.getAttribute('data-action');
      if (action === 'refresh') {
        vscode.postMessage({ command: 'refresh' });
      } else if (action) {
        vscode.postMessage({ command: 'run', action: action });
      }
    });
  });

  // ---- Message handling ---------------------------------------------------
  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.type === 'error') {
      showError(msg.message || 'Unknown error');
      return;
    }
    if (msg.type === 'data') {
      render(msg.data || {});
      return;
    }
    if (msg.type === 'health') {
      renderHealth(msg.health || null);
    }
  });

  function showError(message) {
    els.error.hidden = false;
    els.error.textContent = message;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Backend status indicator ------------------------------------------
  // Auto-detected on every refresh: when the vector backend is installed we
  // hide the "Backend" deploy CTA and show a green "● Online" pill; otherwise
  // we surface the CTA with an install hint. Undefined backend ⇒ leave the CTA
  // as-is (detection unavailable).
  function renderBackendStatus(backend) {
    const btn = document.querySelector('button[data-action="install-backend"]');
    const pill = document.getElementById('backend-online');
    if (!backend) {
      if (btn) { btn.hidden = false; }
      if (pill) { pill.hidden = true; }
      return;
    }
    if (backend.installed) {
      if (btn) { btn.hidden = true; btn.title = 'Vector backend installed at ' + (backend.path || ''); }
      if (pill) { pill.hidden = false; pill.title = 'Vector backend online — RAG enabled (' + (backend.path || '') + ')'; }
    } else {
      if (btn) {
        btn.hidden = false;
        btn.title = 'Install the vector backend (sqlite-vec) to enable RAG' +
          (backend.path ? ' — target: ' + backend.path : '');
      }
      if (pill) { pill.hidden = true; }
    }
  }

  // ---- Render -------------------------------------------------------------
  function render(data) {
    els.error.hidden = true;

    // Backend indicator applies in both empty and populated states.
    renderBackendStatus(data.backend);

    if (data.empty) {
      els.dashboard.hidden = true;
      els.empty.hidden = false;
      if (data.noWorkspace) {
        els.empty.querySelector('.empty-hint').textContent =
          'Open a workspace folder to see intelligence metrics.';
      }
      return;
    }

    els.empty.hidden = true;
    els.dashboard.hidden = false;

    renderCards(data.summary || {});
    renderRecent(data.runs || []);
    drawLineChart(els.keptChart, (data.trends && data.trends.keptRate) || []);
    drawTokenChart(els.tokenChart, data.trends || {});
  }

  function pct(n) {
    return (Math.round((n || 0) * 1000) / 10).toFixed(1) + '%';
  }

  function fmtTokens(n) {
    if (!n) { return '0'; }
    if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
    return String(n);
  }

  // ---- Humanize helpers (health card) -------------------------------------
  function fmtBytes(n) {
    if (!n || n <= 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function relTime(iso) {
    if (!iso) { return null; }
    const then = Date.parse(iso);
    if (isNaN(then)) { return null; }
    const sec = Math.round((Date.now() - then) / 1000);
    if (sec < 0) { return 'just now'; }
    if (sec < 60) { return sec + 's ago'; }
    const min = Math.round(sec / 60);
    if (min < 60) { return min + 'm ago'; }
    const hr = Math.round(min / 60);
    if (hr < 24) { return hr + 'h ago'; }
    const day = Math.round(hr / 24);
    if (day < 30) { return day + 'd ago'; }
    const mon = Math.round(day / 30);
    if (mon < 12) { return mon + 'mo ago'; }
    return Math.round(mon / 12) + 'y ago';
  }

  function fmtCount(n) {
    if (n === undefined || n === null) { return '—'; }
    if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
    return String(n);
  }

  function renderCards(summary) {
    const tokens = summary.tokens || { estimated: 0, real: 0, hasReal: false };
    const cards = [
      { value: summary.totalRuns || 0, label: 'Runs' },
      { value: summary.totalSessions || 0, label: 'Sessions' },
      { value: pct(summary.avgKeptRate), label: 'Avg kept rate' },
      { value: summary.totalPatterns || 0, label: 'Patterns' },
      {
        value: fmtTokens(tokens.hasReal ? tokens.real : tokens.estimated),
        label: tokens.hasReal ? 'Real tokens' : 'Est. tokens',
      },
      { value: '$' + (summary.totalCostUsd || 0).toFixed(4), label: 'Cost' },
    ];
    els.cards.innerHTML = cards
      .map(function (c) {
        return (
          '<div class="card"><div class="value">' +
          escapeHtml(c.value) +
          '</div><div class="label">' +
          escapeHtml(c.label) +
          '</div></div>'
        );
      })
      .join('');
  }

  function renderRecent(runs) {
    const recent = runs.slice(-8).reverse();
    if (recent.length === 0) {
      els.recent.innerHTML = '<div class="recent-row">No runs.</div>';
      return;
    }
    els.recent.innerHTML = recent
      .map(function (r) {
        const when = new Date(r.ts).toLocaleString();
        const real = r.realTokens ? r.realTokens.prompt + r.realTokens.completion : 0;
        const tokenLabel = real
          ? '<span class="badge-real">' + fmtTokens(real) + ' real</span>'
          : '<span class="badge-est">' + fmtTokens(r.estTokens || 0) + ' est</span>';
        const focus = r.focus ? ' &middot; ' + escapeHtml(r.focus) : '';
        return (
          '<div class="recent-row"><span class="when">' +
          escapeHtml(when) +
          '</span><span class="meta">' +
          (r.sessionsAnalyzed || 0) +
          ' sess &middot; ' +
          pct(r.keptRate) +
          ' kept &middot; ' +
          tokenLabel +
          focus +
          '</span></div>'
        );
      })
      .join('');
  }

  // ---- Intelligence Health card -------------------------------------------
  // Driven by the separate { type:'health', health } message. Renders a
  // traffic-light status, a provider row, an index row (chunks, model/dim,
  // indexed-when, db size, STALE badge), and a list of nudges. Nudge action
  // buttons post { command:'run-action', commandId } — the host validates the
  // command id against a whitelist before executing.
  function renderHealth(health) {
    if (!els.healthCard) { return; }

    if (!health) {
      els.healthCard.hidden = false;
      setHealthDot('unknown');
      els.healthStatus.textContent = 'Health unavailable';
      els.healthProvider.textContent = '—';
      els.healthIndex.textContent = '—';
      els.healthNudges.innerHTML =
        '<div class="health-nudge nudge-info"><div class="nudge-body">' +
        '<div class="nudge-detail">Could not read the intelligence health snapshot.</div>' +
        '</div></div>';
      return;
    }

    els.healthCard.hidden = false;

    const status = health.status === 'green' || health.status === 'amber' || health.status === 'red'
      ? health.status
      : 'unknown';
    setHealthDot(status);
    els.healthStatus.textContent =
      status === 'green' ? 'Healthy' :
      status === 'amber' ? 'Needs attention' :
      status === 'red' ? 'Action required' : 'Unknown';

    // Provider row.
    const provider = health.provider || {};
    els.healthProvider.textContent = provider.detail || provider.resolved || provider.configured || 'unknown';

    // Index row.
    renderHealthIndex(health.index || {});

    // Nudges.
    renderHealthNudges(health.nudges || []);
  }

  function setHealthDot(status) {
    const dot = els.healthDot;
    if (!dot) { return; }
    dot.className = 'health-dot health-dot-' + status;
  }

  function renderHealthIndex(index) {
    const parts = [];
    if (index.neverIndexed) {
      parts.push('not indexed');
    } else {
      parts.push(fmtCount(index.chunkCount) + ' chunks');
      if (index.storeModel) {
        parts.push(index.storeModel + (index.storeDimension ? ' / ' + index.storeDimension + 'd' : ''));
      }
      const rel = relTime(index.indexedAt);
      if (rel) { parts.push('indexed ' + rel); }
      if (index.dbSizeBytes) { parts.push(fmtBytes(index.dbSizeBytes)); }
      if ((index.driftFiles || 0) > 0) { parts.push(index.driftFiles + ' files drifted'); }
    }
    // Escape every part exactly once at the join; the STALE badge below is the
    // only intentional markup.
    let html = parts.map(function (p) { return escapeHtml(p); }).join(' &middot; ');
    if (index.stale || index.embeddingDegraded) {
      html += ' <span class="health-stale-badge">STALE</span>';
    }
    if (!index.backendInstalled) {
      html += ' <span class="health-degraded-badge">no backend</span>';
    }
    els.healthIndex.innerHTML = html || '—';
  }

  function renderHealthNudges(nudges) {
    if (!nudges.length) {
      els.healthNudges.innerHTML =
        '<div class="health-nudge nudge-info"><div class="nudge-body">' +
        '<div class="nudge-title">All good</div>' +
        '<div class="nudge-detail">No intelligence-health issues detected.</div>' +
        '</div></div>';
      return;
    }

    els.healthNudges.innerHTML = nudges
      .map(function (n) {
        const sev = (n.severity === 'error' || n.severity === 'warn' || n.severity === 'info')
          ? n.severity : 'info';
        let btn = '';
        if (n.action && n.action.command) {
          btn =
            '<button type="button" class="nudge-action" ' +
            'data-command-id="' + escapeHtml(n.action.command) + '">' +
            escapeHtml(n.action.label || 'Fix') +
            '</button>';
        }
        return (
          '<div class="health-nudge nudge-' + sev + '">' +
          '<div class="nudge-body">' +
          '<div class="nudge-title">' + escapeHtml(n.title || '') + '</div>' +
          '<div class="nudge-detail">' + escapeHtml(n.detail || '') + '</div>' +
          '</div>' +
          btn +
          '</div>'
        );
      })
      .join('');

    // Wire nudge action buttons (CSP-safe: addEventListener, no inline handlers).
    els.healthNudges.querySelectorAll('button.nudge-action').forEach(function (b) {
      b.addEventListener('click', function () {
        const commandId = b.getAttribute('data-command-id');
        if (commandId) {
          vscode.postMessage({ command: 'run-action', commandId: commandId });
        }
      });
    });
  }

  // ---- Canvas helpers -----------------------------------------------------
  // Scale the backing store to device pixels for crisp lines, then draw in CSS
  // pixel space.
  function setupCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(cssW * ratio);
    canvas.height = Math.round(cssH * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function drawLineChart(canvas, points) {
    const c = setupCanvas(canvas);
    const p = palette();
    const pad = { l: 38, r: 10, t: 12, b: 22 };
    const plotW = c.w - pad.l - pad.r;
    const plotH = c.h - pad.t - pad.b;

    // Axes
    c.ctx.strokeStyle = p.grid;
    c.ctx.lineWidth = 1;
    c.ctx.beginPath();
    c.ctx.moveTo(pad.l, pad.t);
    c.ctx.lineTo(pad.l, pad.t + plotH);
    c.ctx.lineTo(pad.l + plotW, pad.t + plotH);
    c.ctx.stroke();

    // Y gridlines + labels at 0/50/100%
    c.ctx.fillStyle = p.muted;
    c.ctx.font = '10px sans-serif';
    c.ctx.textAlign = 'right';
    c.ctx.textBaseline = 'middle';
    [0, 0.5, 1].forEach(function (frac) {
      const y = pad.t + plotH - frac * plotH;
      c.ctx.strokeStyle = p.grid;
      c.ctx.globalAlpha = 0.4;
      c.ctx.beginPath();
      c.ctx.moveTo(pad.l, y);
      c.ctx.lineTo(pad.l + plotW, y);
      c.ctx.stroke();
      c.ctx.globalAlpha = 1;
      c.ctx.fillText(Math.round(frac * 100) + '%', pad.l - 5, y);
    });

    if (!points.length) {
      return;
    }

    const n = points.length;
    function x(i) {
      return n === 1 ? pad.l + plotW / 2 : pad.l + (i / (n - 1)) * plotW;
    }
    function y(v) {
      const clamped = Math.max(0, Math.min(1, v));
      return pad.t + plotH - clamped * plotH;
    }

    // Line
    c.ctx.strokeStyle = p.line;
    c.ctx.lineWidth = 2;
    c.ctx.beginPath();
    points.forEach(function (pt, i) {
      const px = x(i);
      const py = y(pt.value);
      if (i === 0) { c.ctx.moveTo(px, py); } else { c.ctx.lineTo(px, py); }
    });
    c.ctx.stroke();

    // Dots
    c.ctx.fillStyle = p.line;
    points.forEach(function (pt, i) {
      c.ctx.beginPath();
      c.ctx.arc(x(i), y(pt.value), n > 40 ? 1.5 : 2.5, 0, Math.PI * 2);
      c.ctx.fill();
    });
  }

  function drawTokenChart(canvas, trends) {
    const c = setupCanvas(canvas);
    const p = palette();
    const est = trends.estTokens || [];
    const real = trends.realTokens || [];
    const n = Math.max(est.length, real.length);

    const pad = { l: 44, r: 10, t: 12, b: 22 };
    const plotW = c.w - pad.l - pad.r;
    const plotH = c.h - pad.t - pad.b;

    // Axes
    c.ctx.strokeStyle = p.grid;
    c.ctx.lineWidth = 1;
    c.ctx.beginPath();
    c.ctx.moveTo(pad.l, pad.t);
    c.ctx.lineTo(pad.l, pad.t + plotH);
    c.ctx.lineTo(pad.l + plotW, pad.t + plotH);
    c.ctx.stroke();

    if (n === 0) {
      return;
    }

    let max = 0;
    for (let i = 0; i < n; i++) {
      max = Math.max(max, (est[i] && est[i].value) || 0, (real[i] && real[i].value) || 0);
    }
    if (max <= 0) {
      max = 1;
    }

    // Y labels (0, max)
    c.ctx.fillStyle = p.muted;
    c.ctx.font = '10px sans-serif';
    c.ctx.textAlign = 'right';
    c.ctx.textBaseline = 'middle';
    c.ctx.fillText('0', pad.l - 5, pad.t + plotH);
    c.ctx.fillText(fmtTokens(max), pad.l - 5, pad.t);

    const slot = plotW / n;
    const barGap = Math.min(4, slot * 0.15);
    const groupW = slot - barGap;
    const barW = groupW / 2;

    for (let i = 0; i < n; i++) {
      const baseX = pad.l + i * slot + barGap / 2;
      const realV = (real[i] && real[i].value) || 0;
      const estV = (est[i] && est[i].value) || 0;

      const realH = (realV / max) * plotH;
      c.ctx.fillStyle = p.real;
      c.ctx.fillRect(baseX, pad.t + plotH - realH, barW, realH);

      const estH = (estV / max) * plotH;
      c.ctx.fillStyle = p.est;
      c.ctx.fillRect(baseX + barW, pad.t + plotH - estH, barW, estH);
    }
  }

  // Re-render charts on resize so they stay crisp / proportional.
  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      vscode.postMessage({ command: 'refresh' });
    }, 150);
  });

  // Tell the host we're ready for the first data push.
  vscode.postMessage({ command: 'ready' });
})();
