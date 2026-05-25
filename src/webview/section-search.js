// Section search / filter component for AutoClaw panel
// @ts-nocheck
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────
  const AUTO_HIDE_THRESHOLD = 5; // hide search bar when ≤ N items

  // ── State (per-section) ──────────────────────────────────────────────
  const filterState = new Map(); // sectionId → { query, sort, chips, visible }

  // ── Helpers ──────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getSectionItems(sectionId) {
    const body = document.getElementById(sectionId + '-content');
    if (!body) return [];
    // Each direct child of the body that is a table row, agent card, or message row
    return Array.from(body.querySelectorAll('.agent-card, .message-row, .task-row, .todo-item, tr, .awaiting-row'));
  }

  function getItemText(item) {
    // Collect all text content for filtering
    return (item.textContent || '').toLowerCase();
  }

  function matchesFilter(item, query, chips) {
    if (!query && (!chips || chips.length === 0)) return true;
    const text = getItemText(item);
    if (query && !text.includes(query)) return false;
    if (chips && chips.length > 0) {
      // All active chips must match some part of the text
      return chips.every(c => text.includes(c.toLowerCase()));
    }
    return true;
  }

  function applySort(items, sortKey) {
    if (!sortKey || sortKey === 'default') return items;
    const sorted = [...items];
    switch (sortKey) {
      case 'recency':
        // Sort by data-timestamp attr descending
        sorted.sort((a, b) => {
          const ta = a.getAttribute('data-timestamp') || '';
          const tb = b.getAttribute('data-timestamp') || '';
          return tb.localeCompare(ta);
        });
        break;
      case 'alpha':
        sorted.sort((a, b) => {
          const ta = (a.textContent || '').toLowerCase();
          const tb = (b.textContent || '').toLowerCase();
          return ta.localeCompare(tb);
        });
        break;
      case 'active-first':
        // Items with status-dot active come first
        sorted.sort((a, b) => {
          const aActive = a.querySelector('.status-dot.status-active') ? 0 : 1;
          const bActive = b.querySelector('.status-dot.status-active') ? 0 : 1;
          return aActive - bActive;
        });
        break;
    }
    return sorted;
  }

  // ── Build filter bar HTML ────────────────────────────────────────────
  function buildFilterBar(sectionId, config) {
    const chips = config.chips || [];
    const sortOptions = config.sort || [];
    const inputId = 'filter-input-' + sectionId;
    const barId = 'filter-bar-' + sectionId;

    let html = '<div class="section-filter-bar" id="' + escHtml(barId) + '">';
    html += '<input type="text" class="section-filter-input" id="' + escHtml(inputId) + '" ';
    html += 'placeholder="Filter\u2026" aria-label="Filter ' + escHtml(config.label || sectionId) + '" ';
    html += 'autocomplete="off" spellcheck="false" />';

    if (sortOptions.length > 0) {
      html += '<select class="section-filter-sort" id="filter-sort-' + escHtml(sectionId) + '" aria-label="Sort order">';
      for (const opt of sortOptions) {
        html += '<option value="' + escHtml(opt.value) + '">' + escHtml(opt.label) + '</option>';
      }
      html += '</select>';
    }

    for (const chip of chips) {
      html += '<span class="section-filter-chip" data-chip="' + escHtml(chip.id) + '" ';
      html += 'data-active="false" tabindex="0" role="button" ';
      html += 'aria-pressed="false">' + escHtml(chip.label) + '</span>';
    }

    html += '<span class="section-filter-empty" id="filter-empty-' + escHtml(sectionId) + '">';
    html += 'No matching items</span>';
    html += '</div>';
    return html;
  }

  // ── Toggle search bar visibility ─────────────────────────────────────
  function toggleSearchBar(sectionId) {
    const bar = document.getElementById('filter-bar-' + sectionId);
    if (!bar) return;
    const isActive = bar.classList.toggle('active');
    const toggle = document.querySelector('.section-search-toggle[data-section="' + sectionId + '"]');
    if (toggle) toggle.setAttribute('data-active', String(isActive));
    if (isActive) {
      const input = document.getElementById('filter-input-' + sectionId);
      if (input) input.focus();
    }
    // Persist
    const state = filterState.get(sectionId) || {};
    state.visible = isActive;
    filterState.set(sectionId, state);
    persistState(sectionId);
  }

  // ── Apply filter to a section ────────────────────────────────────────
  function applyFilter(sectionId) {
    const bar = document.getElementById('filter-bar-' + sectionId);
    if (!bar) return;
    const input = document.getElementById('filter-input-' + sectionId);
    const query = (input?.value || '').toLowerCase().trim();

    const sortSelect = document.getElementById('filter-sort-' + sectionId);
    const sortKey = sortSelect?.value || 'default';

    const chipEls = bar.querySelectorAll('.section-filter-chip');
    const activeChips = [];
    chipEls.forEach(chip => {
      if (chip.getAttribute('data-active') === 'true') {
        activeChips.push(chip.getAttribute('data-chip'));
      }
    });

    const items = getSectionItems(sectionId);
    let visible = 0;
    items.forEach(item => {
      const match = matchesFilter(item, query, activeChips);
      if (match) {
        item.classList.remove('filter-hidden');
        visible++;
      } else {
        item.classList.add('filter-hidden');
      }
    });

    // Show/hide empty state
    const emptyEl = document.getElementById('filter-empty-' + sectionId);
    if (emptyEl) emptyEl.classList.toggle('visible', visible === 0 && items.length > 0);

    // Apply sort via DOM reorder
    if (sortKey !== 'default') {
      const body = document.getElementById(sectionId + '-content');
      if (body) {
        const visibleItems = items.filter(i => !i.classList.contains('filter-hidden'));
        const sorted = applySort(visibleItems, sortKey);
        sorted.forEach(item => body.appendChild(item));
      }
    }

    // Persist
    const state = filterState.get(sectionId) || {};
    state.query = query;
    state.sort = sortKey;
    state.chips = activeChips;
    filterState.set(sectionId, state);
    persistState(sectionId);
  }

  // ── Persistence via vscode.setState (Memento-like) ───────────────────
  function persistState(sectionId) {
    try {
      const vscode = acquireVsCodeApi();
      if (vscode && filterState.has(sectionId)) {
        vscode.postMessage({ command: 'persistFilterState', sectionId, state: filterState.get(sectionId) });
      }
    } catch (_) { /* ignore */ }
  }

  function restoreState(sectionId) {
    try {
      const vscode = acquireVsCodeApi();
      if (vscode) {
        vscode.postMessage({ command: 'getFilterState', sectionId });
      }
    } catch (_) { /* ignore */ }
  }

  // ── Wire up a section ────────────────────────────────────────────────
  function wireSection(sectionId, config) {
    const header = document.querySelector('.section-header[data-section="' + sectionId + '"]');
    if (!header) return;

    const items = getSectionItems(sectionId);

    // Only show search toggle if item count > threshold
    if (items.length <= AUTO_HIDE_THRESHOLD) return;

    // Add search toggle button to header header
    const toggle = document.createElement('span');
    toggle.className = 'section-search-toggle';
    toggle.setAttribute('data-section', sectionId);
    toggle.setAttribute('data-active', 'false');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('aria-label', 'Toggle filter for ' + (config.label || sectionId));
    toggle.textContent = '\u{1F50D}'; // 🔍
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSearchBar(sectionId);
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleSearchBar(sectionId);
      }
    });

    // Insert before the badge (or at end if no badge)
    const badge = header.querySelector('.section-badge');
    if (badge) {
      header.insertBefore(toggle, badge);
    } else {
      header.appendChild(toggle);
    }

    // Inject filter bar after the section body
    const body = document.getElementById(sectionId + '-content');
    if (body) {
      const barHtml = buildFilterBar(sectionId, config);
      body.insertAdjacentHTML('beforebegin', barHtml);

      // Wire input
      const input = document.getElementById('filter-input-' + sectionId);
      if (input) {
        let debounceTimer;
        input.addEventListener('input', () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => applyFilter(sectionId), 150);
        });
      }

      // Wire sort
      const sort = document.getElementById('filter-sort-' + sectionId);
      if (sort) {
        sort.addEventListener('change', () => applyFilter(sectionId));
      }

      // Wire chips
      const bar = document.getElementById('filter-bar-' + sectionId);
      if (bar) {
        bar.querySelectorAll('.section-filter-chip').forEach(chip => {
          const toggleChip = () => {
            const isActive = chip.getAttribute('data-active') === 'true';
            chip.setAttribute('data-active', String(!isActive));
            chip.setAttribute('aria-pressed', String(!isActive));
            applyFilter(sectionId);
          };
          chip.addEventListener('click', (e) => { e.stopPropagation(); toggleChip(); });
          chip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleChip(); }
          });
        });
      }
    }

    // Restore persisted state
    restoreState(sectionId);
  }

  // ── Message handler extension ────────────────────────────────────────
  // Hook into existing message handler without replacing it
  const origAddEventListener = window.addEventListener.bind(window);
  let wired = false;

  function ensureWired() {
    if (wired) return;
    wired = true;

    // Override the message handler to handle our commands
    window.addEventListener('message', event => {
      try {
        const msg = event.data;
        if (!msg || !msg.command) return;

        switch (msg.command) {
          case 'restoreFilterState':
            if (msg.sectionId && msg.state) {
              filterState.set(msg.sectionId, msg.state);
              const bar = document.getElementById('filter-bar-' + msg.sectionId);
              if (bar && msg.state.visible) {
                bar.classList.add('active');
                const toggle = document.querySelector('.section-search-toggle[data-section="' + msg.sectionId + '"]');
                if (toggle) toggle.setAttribute('data-active', 'true');
              }
              const input = document.getElementById('filter-input-' + msg.sectionId);
              if (input && msg.state.query) input.value = msg.state.query;
              const sort = document.getElementById('filter-sort-' + msg.sectionId);
              if (sort && msg.state.sort) sort.value = msg.state.sort;
              if (msg.state.chips) {
                const bar2 = document.getElementById('filter-bar-' + msg.sectionId);
                if (bar2) {
                  bar2.querySelectorAll('.section-filter-chip').forEach(chip => {
                    if (msg.state.chips.includes(chip.getAttribute('data-chip'))) {
                      chip.setAttribute('data-active', 'true');
                      chip.setAttribute('aria-pressed', 'true');
                    }
                  });
                }
              }
              applyFilter(msg.sectionId);
            }
            break;
        }
      } catch (err) {
        console.error('Section search message handler error:', err);
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.SectionSearch = {
    wire: wireSection,
    ensureWired: ensureWired,
    toggle: toggleSearchBar,
    applyFilter: applyFilter,
    getState: (sectionId) => filterState.get(sectionId) || null,
    setState: (sectionId, state) => { filterState.set(sectionId, state); },
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureWired());
  } else {
    ensureWired();
  }
})();
