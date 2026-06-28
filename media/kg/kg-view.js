// @ts-nocheck
/*
 * kg-view.js — webview app for the AutoClaw Knowledge Graph viewer.
 *
 * Receives { type:'data', data:{ health, thoughts, edges, stats } } from the
 * extension and renders two tabs: a faceted Browser (list + detail inspector)
 * and an interactive force-directed Graph (vendored force-graph UMD → global
 * `ForceGraph`). Read-only. State is persisted via the webview getState/setState
 * so a hide/show keeps the user's tab + filters.
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ---- palette + stable category→color mapping ----------------------------
  const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295'];
  const colorCache = { kind: new Map(), agent: new Map(), project: new Map() };
  function colorFor(dim, value) {
    const cache = colorCache[dim] || colorCache.kind;
    if (cache.has(value)) return cache.get(value);
    // deterministic hash so colors are stable across renders
    let h = 0;
    const s = String(value);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const c = PALETTE[(cache.size + h) % PALETTE.length];
    cache.set(value, c);
    return c;
  }
  function hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  // ---- state --------------------------------------------------------------
  const prev = vscode.getState() || {};
  let raw = { health: null, thoughts: [], edges: [], stats: null };
  let byId = new Map();
  let tab = prev.tab || 'browser';
  let colorBy = prev.colorBy || 'kind';
  let showDerived = prev.showDerived !== false;
  let asofRatio = 1;           // 0..1 across [minTime, maxTime]; 1 = now
  let selectedId = null;
  let search = prev.search || '';
  let searchMode = prev.searchMode || 'filter'; // 'filter' (substring) | 'semantic' (kg.searchSimilar)
  let semanticIds = null;      // ranked thought ids from the KG engine, or null
  let semanticPending = false;
  let fKind = '', fAgent = '', fProject = '';
  let timeMin = 0, timeMax = 0;

  let Graph = null;            // force-graph instance (lazy)
  let graphBuilt = false;
  const highlightNodes = new Set();
  const highlightLinks = new Set();
  const nodeCache = new Map(); // id -> node obj, reused across rebuilds to keep x/y

  // ---- dom ----------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    health: $('kg-health'), stats: $('kg-stats'), refresh: $('kg-refresh'),
    tabs: document.querySelectorAll('.kg-tab'),
    search: $('kg-search'), searchmode: $('kg-searchmode'),
    fKind: $('kg-filter-kind'), fAgent: $('kg-filter-agent'),
    fProject: $('kg-filter-project'), derived: $('kg-derived'), count: $('kg-filter-count'),
    browser: $('kg-browser'), graphPane: $('kg-graph-pane'), list: $('kg-list'),
    graph: $('kg-graph'), legend: $('kg-legend'), detail: $('kg-detail'),
    colorby: $('kg-colorby'), asof: $('kg-asof'), asofLabel: $('kg-asof-label'),
    asofReset: $('kg-asof-reset'), fit: $('kg-fit'),
  };

  function persist() {
    vscode.setState({ tab, colorBy, showDerived, search, searchMode });
  }

  // ---- filtering ----------------------------------------------------------
  function facetPass(t) {
    if (fKind && t.kind !== fKind) return false;
    if (fAgent && t.agent !== fAgent) return false;
    if (fProject && t.project !== fProject) return false;
    return true;
  }
  function filteredThoughts() {
    // Semantic mode with results in hand: honor the KG engine's rank order,
    // then apply the facet filters on top. Substring tokens are ignored here.
    if (searchMode === 'semantic' && semanticIds) {
      const ordered = [];
      for (const id of semanticIds) {
        const t = byId.get(id);
        if (t && facetPass(t)) ordered.push(t);
      }
      return ordered;
    }
    // Filter mode (or semantic with no query yet): substring + facets.
    const tokens = (searchMode === 'filter' ? search : '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return raw.thoughts.filter((t) => {
      if (!facetPass(t)) return false;
      if (tokens.length) {
        const hay = `${t.text} ${t.agent} ${t.kind} ${t.task_id || ''} ${t.project} ${t.sprint || ''}`.toLowerCase();
        for (const tk of tokens) if (hay.indexOf(tk) === -1) return false;
      }
      return true;
    });
  }
  /** Ask the extension to run kg.searchSimilar for the current query. */
  function triggerSemantic() {
    const q = search.trim();
    if (!q) { semanticIds = null; semanticPending = false; renderBrowser(); if (tab === 'graph') renderGraph(); return; }
    semanticPending = true;
    el.count.textContent = 'Searching…';
    vscode.postMessage({ command: 'search', q, k: 80 });
  }

  function asofInstant() {
    if (!timeMax) return Infinity;
    return timeMin + (timeMax - timeMin) * asofRatio;
  }
  function presentAt(t, instant) {
    // __c / __vt are precomputed in renderAll so this stays cheap per frame.
    if (t.__c != null && t.__c > instant) return false;
    if (t.__vt != null && t.__vt <= instant) return false;
    return true;
  }

  // ---- browser ------------------------------------------------------------
  function renderBrowser() {
    const items = filteredThoughts();
    const semantic = searchMode === 'semantic' && semanticIds;
    el.count.textContent = `${items.length} of ${raw.thoughts.length} thoughts${semantic ? ' · ranked by similarity' : ''}`;
    if (!items.length) {
      const msg = !raw.thoughts.length
        ? 'The knowledge graph is empty. Thoughts are recorded by the orchestrator, /learn, and the kg.record MCP tool.'
        : (semantic ? 'No semantically similar thoughts.' : 'No thoughts match the current filters.');
      el.list.innerHTML = `<p class="empty">${msg}</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const t of items) {
      const card = document.createElement('div');
      card.className = 'kg-card' + (t.id === selectedId ? ' selected' : '');
      card.style.borderLeftColor = colorFor('kind', t.kind);
      const chip = colorFor('kind', t.kind);
      card.innerHTML =
        `<div class="kg-card-head">` +
        `<span class="kg-kind" style="background:${chip}">${esc(t.kind)}</span>` +
        `<span class="kg-card-meta">${esc(t.agent)}${t.task_id ? ' · ' + esc(t.task_id) : ''} · ${esc(shortDate(t.created_at))}</span>` +
        `</div>` +
        `<div class="kg-card-text">${esc(clip(t.text, 280))}</div>`;
      card.addEventListener('click', () => select(t.id));
      frag.appendChild(card);
    }
    el.list.innerHTML = '';
    el.list.appendChild(frag);
  }

  // ---- detail inspector ---------------------------------------------------
  function edgesFor(id) {
    const out = [], inc = [];
    for (const e of raw.edges) {
      if (!showDerived && e.derived) continue;
      if (e.from === id) out.push(e);
      else if (e.to === id) inc.push(e);
    }
    return { out, inc };
  }
  function renderDetail() {
    if (!selectedId || !byId.has(selectedId)) { el.detail.classList.add('hidden'); return; }
    const t = byId.get(selectedId);
    const { out, inc } = edgesFor(selectedId);
    const field = (k, v) => v ? `<div class="kg-field"><span class="k">${k}</span><span class="v">${esc(String(v))}</span></div>` : '';
    const edgeRow = (e, dir) => {
      const otherId = dir === 'out' ? e.to : e.from;
      const other = byId.get(otherId);
      const label = other ? clip(other.text, 60) : otherId;
      return `<div class="kg-edge" data-goto="${esc(otherId)}">` +
        `<span class="kg-edge-kind">${dir === 'out' ? '→' : '←'} ${esc(e.kind)}${e.derived ? ' (derived)' : ''}:</span> ${esc(label)}</div>`;
    };
    let metaHtml = '';
    if (t.meta && Object.keys(t.meta).length) {
      metaHtml = `<h3>Metadata</h3><pre class="kg-meta">${esc(JSON.stringify(t.meta, null, 2))}</pre>`;
    }
    let edgesHtml = '';
    if (out.length || inc.length) {
      edgesHtml = `<h3>Relations (${out.length + inc.length})</h3>` +
        out.map((e) => edgeRow(e, 'out')).join('') + inc.map((e) => edgeRow(e, 'in')).join('');
    }
    el.detail.innerHTML =
      `<button class="kg-mini kg-detail-close" title="Close">✕</button>` +
      `<h2>${esc(t.kind)}</h2>` +
      `<div class="kg-detail-text">${esc(t.text)}</div>` +
      field('Agent', t.agent) + field('Project', t.project) + field('Task', t.task_id) +
      field('Sprint', t.sprint) + field('Created', t.created_at) +
      field('Valid from', t.valid_from) + field('Valid to', t.valid_to || '— (still valid)') +
      field('ID', t.id) +
      metaHtml + edgesHtml +
      `<div class="kg-detail-actions">` +
      `<button class="kg-mini" id="kg-copytext">Copy text</button>` +
      `<button class="kg-mini" id="kg-copyid">Copy ID</button>` +
      `<button class="kg-mini" id="kg-focus">Focus in graph</button>` +
      `</div>`;
    el.detail.classList.remove('hidden');
    el.detail.querySelector('.kg-detail-close').addEventListener('click', () => { selectedId = null; renderDetail(); renderBrowser(); if (tab === 'graph') nudgePaint(); });
    el.detail.querySelector('#kg-copytext').addEventListener('click', () => vscode.postMessage({ command: 'copyText', text: t.text }));
    el.detail.querySelector('#kg-copyid').addEventListener('click', () => vscode.postMessage({ command: 'copyId', id: t.id }));
    el.detail.querySelector('#kg-focus').addEventListener('click', () => focusInGraph(t.id));
    el.detail.querySelectorAll('.kg-edge').forEach((row) =>
      row.addEventListener('click', () => select(row.getAttribute('data-goto'))));
  }

  function select(id) {
    selectedId = id;
    renderDetail();
    renderBrowser();
    if (tab === 'graph' && Graph) nudgePaint();
  }

  // ---- graph --------------------------------------------------------------
  function buildGraphData() {
    const items = filteredThoughts();
    const present = new Set(items.map((t) => t.id));
    // Reuse cached node objects so force-graph preserves x/y across filter/search
    // changes (fresh objects would re-randomize the layout on every keystroke).
    const nodes = items.map((t) => {
      const ex = nodeCache.get(t.id);
      if (ex) { ex.t = t; return ex; }
      const n = { id: t.id, t };
      nodeCache.set(t.id, n);
      return n;
    });
    const links = [];
    for (const e of raw.edges) {
      if (!showDerived && e.derived) continue;
      if (present.has(e.from) && present.has(e.to)) {
        links.push({ source: e.from, target: e.to, kind: e.kind, derived: !!e.derived });
      }
    }
    return { nodes, links };
  }

  function neighborsOf(id) {
    const ns = new Set();
    for (const e of raw.edges) {
      if (!showDerived && e.derived) continue;
      if (e.from === id) ns.add(e.to);
      else if (e.to === id) ns.add(e.from);
    }
    return ns;
  }

  function nodeColor(node) {
    const instant = asofInstant();
    const faded = !presentAt(node.t, instant);
    const base = colorFor(colorBy, node.t[colorBy]);
    if (highlightNodes.size) {
      if (highlightNodes.has(node.id)) return base;
      return hexToRgba(base, 0.12);
    }
    if (faded) return hexToRgba(base, 0.12);
    if (node.id === selectedId) return '#ffffff';
    return base;
  }
  function nodeVal(node) { return node.id === selectedId ? 6 : 3; }
  function nodeLabel(node) {
    const t = node.t;
    return `<div style="max-width:280px;font-size:11px;padding:4px 6px;background:#1e1e1e;color:#eee;border-radius:4px">` +
      `<b>${esc(t.kind)}</b> · ${esc(t.agent)}<br/>${esc(clip(t.text, 140))}</div>`;
  }
  function linkColor(link) {
    if (highlightLinks.has(link)) return 'rgba(255,255,255,0.9)';
    if (link.derived) return 'rgba(140,140,140,0.25)';
    return 'rgba(120,170,220,0.55)';
  }
  function linkWidth(link) { return highlightLinks.has(link) ? 2.5 : (link.derived ? 0.6 : 1.2); }

  function ensureGraph() {
    if (graphBuilt) return;
    if (typeof ForceGraph === 'undefined') {
      el.graph.innerHTML = '<p class="empty">Graph library failed to load.</p>';
      return;
    }
    Graph = ForceGraph()(el.graph)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id')
      .nodeRelSize(3)
      .nodeVal(nodeVal)
      .nodeColor(nodeColor)
      .nodeLabel(nodeLabel)
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkDirectionalArrowLength((l) => (l.derived ? 0 : 3))
      .linkDirectionalArrowRelPos(1)
      .onNodeClick((node) => { select(node.id); Graph.centerAt(node.x, node.y, 400); })
      .onNodeHover((node) => {
        highlightNodes.clear(); highlightLinks.clear();
        if (node) {
          highlightNodes.add(node.id);
          for (const n of neighborsOf(node.id)) highlightNodes.add(n);
          for (const l of Graph.graphData().links) {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const tg = typeof l.target === 'object' ? l.target.id : l.target;
            if (s === node.id || tg === node.id) highlightLinks.add(l);
          }
        }
        el.graph.style.cursor = node ? 'pointer' : '';
        nudgePaint();
      })
      .onBackgroundClick(() => { selectedId = null; renderDetail(); renderBrowser(); nudgePaint(); });
    graphBuilt = true;
  }

  function nudgePaint() {
    if (!Graph) return;
    // Re-assign accessors to force a repaint after a state change (selection,
    // hover, as-of). force-graph redraws when an accessor is (re)set.
    Graph.nodeColor(nodeColor).linkColor(linkColor).linkWidth(linkWidth);
  }

  function sizeGraph() {
    if (!Graph) return;
    const w = el.graph.clientWidth, h = el.graph.clientHeight;
    if (w > 0 && h > 0) Graph.width(w).height(h);
  }

  function renderGraph() {
    ensureGraph();
    if (!Graph) return;
    Graph.graphData(buildGraphData());
    sizeGraph();
    setTimeout(() => { sizeGraph(); Graph.zoomToFit(400, 30); }, 60);
  }

  function focusInGraph(id) {
    setTab('graph');
    selectedId = id;
    renderDetail();
    if (Graph) {
      const node = Graph.graphData().nodes.find((n) => n.id === id);
      if (node && node.x != null) Graph.centerAt(node.x, node.y, 500).zoom(4, 500);
      nudgePaint();
    }
  }

  // ---- legend -------------------------------------------------------------
  function renderLegend() {
    const counts = {};
    for (const t of raw.thoughts) {
      const key = t[colorBy];
      counts[key] = (counts[key] || 0) + 1;
    }
    const entries = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    el.legend.innerHTML = entries.map((k) =>
      `<span class="kg-legend-item"><span class="kg-swatch" style="background:${colorFor(colorBy, k)}"></span>${esc(k)} (${counts[k]})</span>`
    ).join('') || '<span class="kg-muted">no data</span>';
  }

  // ---- tabs ---------------------------------------------------------------
  function setTab(next) {
    tab = next;
    el.tabs.forEach((b) => {
      const on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    el.browser.classList.toggle('active', tab === 'browser');
    el.graphPane.classList.toggle('active', tab === 'graph');
    if (tab === 'graph') { renderGraph(); renderLegend(); }
    persist();
  }

  // ---- top-level render ---------------------------------------------------
  function renderHealth() {
    const h = raw.health;
    if (!h) { el.health.textContent = ''; return; }
    el.health.classList.toggle('ok', h.ok);
    el.health.classList.toggle('degraded', h.degraded);
    el.health.textContent = h.degraded
      ? 'kg: degraded'
      : `kg: ready · ${h.driver || '?'} · ${h.vec ? 'vec' : 'no-vec'}/${h.fts ? 'fts' : 'no-fts'}`;
    el.health.title = `Embeddings: ${h.embedding}\nDB: ${h.dbPath}\nClick to run a health check`;
  }
  function renderStats() {
    const s = raw.stats;
    if (!s) { el.stats.textContent = ''; return; }
    el.stats.textContent = `${s.thoughts} thoughts · ${s.edges} edges${s.derivedEdges ? ' (+' + s.derivedEdges + ' derived)' : ''} · ${Object.keys(s.kinds).length} kinds · ${Object.keys(s.agents).length} agents`;
  }
  function fillSelect(sel, values, current) {
    const keep = sel.firstElementChild; // "All …" option
    sel.innerHTML = '';
    sel.appendChild(keep);
    for (const v of values.sort()) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === current) o.selected = true;
      sel.appendChild(o);
    }
  }
  function renderAll() {
    byId = new Map(raw.thoughts.map((t) => [t.id, t]));
    // Precompute parsed validity timestamps once (presentAt runs per frame).
    for (const t of raw.thoughts) {
      const c = Date.parse(t.valid_from || t.created_at);
      t.__c = isFinite(c) ? c : 0;
      const vt = t.valid_to ? Date.parse(t.valid_to) : NaN;
      t.__vt = isFinite(vt) ? vt : null;
    }
    const times = raw.thoughts.map((t) => Date.parse(t.created_at)).filter(isFinite);
    timeMin = times.length ? Math.min(...times) : 0;
    timeMax = times.length ? Math.max(...times) : 0;
    fillSelect(el.fKind, [...new Set(raw.thoughts.map((t) => t.kind))], fKind);
    fillSelect(el.fAgent, [...new Set(raw.thoughts.map((t) => t.agent))], fAgent);
    fillSelect(el.fProject, [...new Set(raw.thoughts.map((t) => t.project))], fProject);
    renderHealth();
    renderStats();
    renderBrowser();
    renderDetail();
    if (tab === 'graph') { renderGraph(); renderLegend(); }
  }

  // ---- events -------------------------------------------------------------
  el.tabs.forEach((b) => b.addEventListener('click', () => setTab(b.getAttribute('data-tab'))));
  el.refresh.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  el.health.addEventListener('click', () => vscode.postMessage({ command: 'openHealth' }));
  let searchTimer;
  el.search.value = search;
  el.search.addEventListener('input', () => {
    search = el.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (searchMode === 'semantic') { triggerSemantic(); }
      else { renderBrowser(); if (tab === 'graph') renderGraph(); }
      persist();
    }, searchMode === 'semantic' ? 320 : 160);
  });
  el.searchmode.value = searchMode;
  el.searchmode.addEventListener('change', () => {
    searchMode = el.searchmode.value;
    semanticIds = null; semanticPending = false;
    if (searchMode === 'semantic' && search.trim()) { triggerSemantic(); }
    else { renderBrowser(); if (tab === 'graph') renderGraph(); }
    persist();
  });
  el.fKind.addEventListener('change', () => { fKind = el.fKind.value; renderBrowser(); if (tab === 'graph') renderGraph(); });
  el.fAgent.addEventListener('change', () => { fAgent = el.fAgent.value; renderBrowser(); if (tab === 'graph') renderGraph(); });
  el.fProject.addEventListener('change', () => { fProject = el.fProject.value; renderBrowser(); if (tab === 'graph') renderGraph(); });
  el.derived.checked = showDerived;
  el.derived.addEventListener('change', () => { showDerived = el.derived.checked; renderDetail(); if (tab === 'graph') renderGraph(); persist(); });
  el.colorby.value = colorBy;
  el.colorby.addEventListener('change', () => { colorBy = el.colorby.value; renderLegend(); nudgePaint(); persist(); });
  el.asof.addEventListener('input', () => {
    asofRatio = Number(el.asof.value) / 100;
    const inst = asofInstant();
    el.asofLabel.textContent = asofRatio >= 1 || !isFinite(inst) ? 'now' : shortDate(new Date(inst).toISOString());
    nudgePaint();
  });
  el.asofReset.addEventListener('click', () => { el.asof.value = 100; asofRatio = 1; el.asofLabel.textContent = 'now'; nudgePaint(); });
  el.fit.addEventListener('click', () => { sizeGraph(); if (Graph) Graph.zoomToFit(400, 30); });
  window.addEventListener('resize', () => { if (tab === 'graph') sizeGraph(); });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'data') {
      raw = m.data;
      if (selectedId && !raw.thoughts.find((t) => t.id === selectedId)) selectedId = null;
      // A live refresh while a semantic query is active: re-run it against fresh data.
      if (searchMode === 'semantic' && search.trim()) { renderAll(); triggerSemantic(); }
      else { renderAll(); }
    } else if (m.type === 'searchResults') {
      // Drop stale responses (the query moved on since this request was sent).
      if (searchMode !== 'semantic' || m.q !== search.trim()) return;
      semanticPending = false;
      semanticIds = Array.isArray(m.ids) ? m.ids : [];
      renderBrowser();
      if (tab === 'graph') renderGraph();
    } else if (m.type === 'error') {
      el.list.innerHTML = `<p class="empty">${esc(m.message)}</p>`;
    }
  });

  // ---- utils --------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function shortDate(iso) { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

  // ---- boot ---------------------------------------------------------------
  setTab(tab);
  vscode.postMessage({ command: 'ready' });
})();
