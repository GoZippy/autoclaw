// KDream Dashboard JavaScript
(function() {
    const vscode = acquireVsCodeApi();

let allTasks = [];
  let allLogs = [];
  let allTodos = [];
  let currentFilter = '';
  let memorySearchResults = [];
  let currentMemoryQuery = '';
  let allTags = [];
  let selectedTag = '';
  let selectedPriority = '';
  let memoryHistory = [];
  let healthHistory = [];
  let healthChart = null;
  let workflowHistory = [];
  // Routing state
  let routingZmlrOnline = false;
  let routingSessions = [];
  let routingModels = [];
  let routingRateLimits = [];
    
    window.addEventListener('message', event => {
        try {
            const message = event.data;
            switch (message.command) {
                case 'updateStatus':
                    updateStatus(message.data);
                    break;
                case 'updateTasks':
                    allTasks = message.data || [];
                    allTags = message.tags || [];
                    updateTagFilter();
                    renderFilteredTasks();
                    break;
                case 'updateLogs':
                    allLogs = message.data || [];
                    renderFilteredLogs();
                    break;
                case 'updateAdapterHealth':
                    updateAdapterHealth(message.data);
                    break;
case 'updateTodos':
                     allTodos = message.data || [];
                     renderFilteredTodos();
                     break;
                 case 'updateAdapterHealthHistory':
                     healthHistory = message.data || [];
                     renderHealthChart(healthHistory);
                     break;
                 case 'error':
                    showError(message.data);
                    break;
                case 'exportResult':
                    handleExportResult(message.data, message.type);
                    break;
                case 'memorySearchResults':
                    memorySearchResults = message.data || [];
                    currentMemoryQuery = message.query || '';
                    renderMemorySearchResults();
                    break;
                  case 'showMemoryHistory':
                     memoryHistory = message.data || [];
                     renderMemoryHistory();
                     break;
                 case 'updateWorkflowHistory':
                     workflowHistory = message.data || [];
                     renderWorkflowHistory();
                     break;
                 // ── Intelligent Routing ───────────────────────────────────
                 case 'routing:zmlrStatus':
                     routingZmlrOnline = !!message.online;
                     renderRoutingZMLRStatus();
                     break;
                 case 'routing:sessions':
                     routingSessions = message.data || [];
                     renderRoutingSessions();
                     break;
                 case 'routing:modelList':
                     routingModels = message.data || [];
                     renderRoutingModelList();
                     break;
                 case 'routing:rateLimits':
                     routingRateLimits = message.data || [];
                     renderRoutingRateLimits();
                     break;
                 case 'routing:decision':
                     if (message.error) {
                         document.getElementById('routing-model-list').innerHTML =
                             '<p class="error-text">Routing error: ' + escapeHtml(message.error) + '</p>';
                     } else {
                         const d = message.data;
                         document.getElementById('routing-model-list').innerHTML =
                             '<div class="routing-decision">' +
                             '<strong>Decision:</strong> ' + escapeHtml(d.model) +
                             (d.viaZMLR ? ' <span class="badge-zmlr">via ZMLR</span>' : ' <span class="badge-direct">direct</span>') +
                             '<br><em>' + escapeHtml(d.reason) + '</em>' +
                             '<br><strong>Fallback chain:</strong> ' + (d.fallbackChain || []).map(f => escapeHtml(f.modelId)).join(' → ') +
                             '</div>';
                     }
                     break;
                 case 'routing:config':
                     const zmlrUrlInput = document.getElementById('routing-zmlr-url');
                     const failoverSelect = document.getElementById('routing-failover-mode');
                     if (zmlrUrlInput) { zmlrUrlInput.value = message.zmlrUrl || ''; }
                     if (failoverSelect) { failoverSelect.value = message.failoverMode || 'ask'; }
                     break;
                 case 'routing:settingsSaved':
                     showRoutingNotice('Settings saved.');
                     break;
            }
        } catch (err) {
            console.error('KDream Dashboard message handler error:', err);
            showError(err.message || 'An unexpected error occurred');
        }
    });
    
    function showError(message) {
        const container = document.getElementById('dashboard-container');
        if (container) {
            container.innerHTML = `
                <div class="error-state">
                    <h2>Error</h2>
                    <p>${escapeHtml(message)}</p>
                    <button onclick="location.reload()">Reload Dashboard</button>
                </div>
            `;
        }
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    document.getElementById('refresh-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
    });
    
    document.getElementById('help-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'openHelp' });
    });
    
    document.getElementById('zmlr-link').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ command: 'openZmlrDownload' });
    });

    document.getElementById('load-history-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'loadMemoryHistory' });
    });
    
    // Export button and dropdown
    const exportBtn = document.getElementById('export-btn');
    const exportDropdown = document.getElementById('export-dropdown');
    
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = exportDropdown.style.display === 'block';
        exportDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    document.addEventListener('click', () => {
        exportDropdown.style.display = 'none';
    });
    
    exportDropdown.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const type = btn.dataset.export;
            exportDropdown.style.display = 'none';
            vscode.postMessage({ command: 'exportData', type });
        });
    });
    
    function handleExportResult(data, type) {
        const labels = { tasks: 'Tasks', logs: 'Logs', todos: 'TODOs', all: 'All Data' };
        navigator.clipboard.writeText(data).then(() => {
            showToast((labels[type] || 'Data') + ' copied to clipboard!');
        }).catch(() => {
            showToast('Failed to copy to clipboard');
        });
    }
    
function showToast(message) {
         const existing = document.querySelector('.toast');
         if (existing) existing.remove();
         const toast = document.createElement('div');
         toast.className = 'toast';
         toast.textContent = message;
         document.body.appendChild(toast);
         setTimeout(() => toast.remove(), 2000);
     }

     // Health chart rendering functions
     function renderHealthChart(historyData) {
         // If we don't have Chart.js loaded, load it from CDN
         if (typeof Chart === 'undefined') {
             const script = document.createElement('script');
             script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
             script.onload = () => {
                 createHealthChart(historyData);
             };
             document.head.appendChild(script);
         } else {
             createHealthChart(historyData);
         }
     }

     function createHealthChart(historyData) {
         const ctx = document.getElementById('health-chart').getContext('2d');
         
         // Destroy existing chart if it exists
         if (healthChart) {
             healthChart.destroy();
         }
         
         if (historyData.length === 0) {
             // Show empty chart with message
             healthChart = new Chart(ctx, {
                 type: 'bar',
                 data: {
                     labels: ['No Data'],
                     datasets: [{
                         label: 'Adapter Health History',
                         data: [0],
                         backgroundColor: 'rgba(200, 200, 200, 0.5)'
                     }]
                 },
                 options: {
                     responsive: true,
                     maintainAspectRatio: false,
                     plugins: {
                         tooltip: {
                             enabled: false
                         },
                         legend: {
                             display: false
                         }
                     }
                 }
             });
             return;
         }
         
         // Prepare data for each adapter
         const adapterData = {};
         const labels = historyData.map(entry => 
             new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
         );
         
         // Group data by adapter
         historyData.forEach(entry => {
             entry.adapters.forEach(adapter => {
                 if (!adapterData[adapter.name]) {
                     adapterData[adapter.name] = {
                         responseTimes: [],
                         errorRates: [],
                         statuses: []
                     };
                 }
                 adapterData[adapter.name].responseTimes.push(adapter.responseTime || 0);
                 adapterData[adapter.name].errorRates.push(adapter.errorRate || 0);
                 adapterData[adapter.name].statuses.push(adapter.status);
             });
         });
         
         // Create datasets for each adapter (limit to first 3 for clarity)
         const datasets = [];
         const colors = [
             { border: 'rgb(75, 192, 192)', background: 'rgba(75, 192, 192, 0.2)' },
             { border: 'rgb(255, 99, 132)', background: 'rgba(255, 99, 132, 0.2)' },
             { border: 'rgb(54, 162, 235)', background: 'rgba(54, 162, 235, 0.2)' }
         ];
         
         let colorIndex = 0;
         for (const [adapterName, data] of Object.entries(adapterData)) {
             if (colorIndex >= colors.length) break;
             
             datasets.push({
                 label: `${adapterName} Response Time (ms)`,
                 data: data.responseTimes,
                 borderColor: colors[colorIndex].border,
                 backgroundColor: colors[colorIndex].background,
                 yAxisID: 'y1',
                 tension: 0.1,
                 fill: false
             });
             
             datasets.push({
                 label: `${adapterName} Error Rate`,
                 data: data.errorRates.map(rate => rate * 100), // Convert to percentage
                 borderColor: colors[colorIndex].border,
                 backgroundColor: colors[colorIndex].background,
                 yAxisID: 'y2',
                 tension: 0.1,
                 fill: false,
                 borderDash: [5, 5]
             });
             
             colorIndex++;
         }
         
         // Create dual-axis chart
         healthChart = new Chart(ctx, {
             type: 'line',
             data: {
                 labels: labels,
                 datasets: datasets
             },
             options: {
                 responsive: true,
                 maintainAspectRatio: false,
                 scales: {
                     y1: {
                         type: 'linear',
                         display: true,
                         position: 'left',
                         title: { display: true, text: 'Response Time (ms)' }
                     },
                     y2: {
                         type: 'linear',
                         display: true,
                         position: 'right',
                         title: { display: true, text: 'Error Rate (%)' },
                         grid: { drawOnChartArea: false }
                     }
                 },
                 plugins: {
                     tooltip: {
                         mode: 'index',
                         intersect: false
                     },
                     legend: {
                         position: 'top'
                     }
                 }
             }
         });
     }

     // Render health alerts
     function renderHealthAlerts(alerts) {
         const container = document.getElementById('alerts-list');
         container.innerHTML = '';
         
         if (alerts.length === 0) {
             container.innerHTML = '<p>No active alerts.</p>';
             return;
         }
         
         alerts.forEach(alert => {
             const alertDiv = document.createElement('div');
             alertDiv.className = `health-alert alert-${alert.severity}`;
             
             const time = document.createElement('span');
             time.className = 'alert-time';
             time.textContent = new Date(alert.timestamp).toLocaleTimeString();
             
             const message = document.createElement('span');
             message.className = 'alert-message';
             message.textContent = alert.message;
             
             alertDiv.appendChild(time);
             alertDiv.appendChild(message);
             container.appendChild(alertDiv);
         });
     }
    
    // Collapse/expand section handlers
    document.querySelectorAll('.collapse-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            const content = document.getElementById(section + '-content');
            if (!content) return;
            const isCollapsed = content.style.display === 'none';
            content.style.display = isCollapsed ? '' : 'none';
            btn.textContent = isCollapsed ? '▼' : '▶';
            try {
                localStorage.setItem('kdream-collapsed-' + section, String(!isCollapsed));
            } catch {}
        });
    });
    
    // Restore collapsed state on load
    document.querySelectorAll('.collapse-btn').forEach(btn => {
        const section = btn.dataset.section;
        try {
            if (localStorage.getItem('kdream-collapsed-' + section) === 'true') {
                const content = document.getElementById(section + '-content');
                if (content) {
                    content.style.display = 'none';
                    btn.textContent = '▶';
                }
            }
        } catch {}
    });
    
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear');
    let searchDebounceTimer = null;
    
    searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value ? 'block' : 'none';
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            currentFilter = searchInput.value.trim().toLowerCase();
            renderFilteredTasks();
            renderFilteredLogs();
            renderFilteredTodos();
        }, 200);
    });
    
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        currentFilter = '';
        clearBtn.style.display = 'none';
        renderFilteredTasks();
        renderFilteredLogs();
        renderFilteredTodos();
      });
      
      // Set up tag filter event listener
      document.addEventListener('DOMContentLoaded', () => {
          const tagFilter = document.getElementById('tag-filter');
          if (tagFilter) {
              tagFilter.addEventListener('change', (e) => {
                  selectedTag = e.target.value;
                  renderFilteredTasks();
              });
          }
          
          const priorityFilter = document.getElementById('priority-filter');
          if (priorityFilter) {
              priorityFilter.addEventListener('change', (e) => {
                  selectedPriority = e.target.value;
                  renderFilteredTasks();
              });
          }
          
          // Set up health history controls
          const historyTimeRange = document.getElementById('history-time-range');
          if (historyTimeRange) {
              historyTimeRange.addEventListener('change', () => {
                  refreshHealthHistory();
              });
          }
          
          const refreshHistoryBtn = document.getElementById('refresh-history-btn');
          if (refreshHistoryBtn) {
              refreshHistoryBtn.addEventListener('click', () => {
                  refreshHealthHistory();
              });
          }
      });
      
      // Function to refresh health history based on selected time range
      function refreshHealthHistory() {
          const timeRangeSelect = document.getElementById('history-time-range');
          let hours = 24; // default
          
          if (timeRangeSelect) {
              const value = timeRangeSelect.value;
              if (value === '6h') hours = 6;
              else if (value === '24h') hours = 24;
              else if (value === '7d') hours = 7 * 24; // 7 days in hours
          }
          
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
              getAdapterHealthHistory(workspaceRoot, hours).then(history => {
                  vscode.postMessage({ command: 'updateAdapterHealthHistory', data: history });
              }).catch(error => {
                  console.error('Failed to get adapter health history:', error);
                  vscode.postMessage({ command: 'updateAdapterHealthHistory', data: [] });
              });
          }
      }
      
      // Track currently focused section for navigation
      const sections = ['status', 'tasks', 'logs', 'adapter-health', 'memory-history'];
      let currentSectionIndex = 0;

      // Handle keyboard shortcuts from extension
      window.addEventListener('message', event => {
          try {
              const message = event.data;
              
              if (message.command === 'toggleDashboardSection') {
                  const direction = message.direction || 'next';
                  if (direction === 'next') {
                      currentSectionIndex = (currentSectionIndex + 1) % sections.length;
                  } else if (direction === 'prev') {
                      currentSectionIndex = (currentSectionIndex - 1 + sections.length) % sections.length;
                  }
                  toggleSectionByIndex(currentSectionIndex);
              }
              
              if (message.command === 'focusSearchInput') {
                  const searchInput = document.getElementById('search-input');
                  if (searchInput) {
                      searchInput.focus();
                  }
              }
          } catch (err) {
              console.error('KDream Dashboard message handler error:', err);
              showError(err.message || 'An unexpected error occurred');
          }
      });
      
      // Add global keyboard listener for dashboard navigation
      document.addEventListener('keydown', (e) => {
          // Only handle shortcuts when dashboard has focus or is active
          if (!document.activeElement.closest('#dashboard-container')) return;
          
          // Prevent browser shortcuts
          e.preventDefault();
          
          switch (e.key) {
              case 'ArrowLeft':
                  if (e.ctrlKey && e.altKey) {
                      vscode.postMessage({ command: 'kdream.toggleSection', direction: 'prev' });
                  }
                  break;
              case 'ArrowRight':
                  if (e.ctrlKey && e.altKey) {
                      vscode.postMessage({ command: 'kdream.toggleSection', direction: 'next' });
                  }
                  break;
              case 'r':
                  if (e.ctrlKey && e.altKey) {
                      vscode.postMessage({ command: 'kdream.refreshDashboard' });
                  }
                  break;
              case 'f':
                  if (e.ctrlKey && e.altKey) {
                      vscode.postMessage({ command: 'kdream.searchDashboard' });
                  }
                  break;
              case 'h':
                  if (e.ctrlKey && e.altKey) {
                      vscode.postMessage({ command: 'kdream.helpDashboard' });
                  }
                  break;
              case 'Escape':
                  // Close search dropdown or export dropdown when ESC pressed
                  const exportDropdown = document.getElementById('export-dropdown');
                  if (exportDropdown && exportDropdown.style.display === 'block') {
                      exportDropdown.style.display = 'none';
                  }
                  break;
          }
      });
      
      // Add keyboard navigation within sections
      document.addEventListener('keydown', (e) => {
          // Handle navigation within todo items
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              const focusedElement = document.activeElement;
              if (focusedElement.closest('.todo-item')) {
                  e.preventDefault();
                  const todos = Array.from(document.querySelectorAll('.todo-item'));
                  const currentIndex = todos.indexOf(focusedElement);
                  let newIndex;
                  
                  if (e.key === 'ArrowUp') {
                      newIndex = (currentIndex - 1 + todos.length) % todos.length;
                  } else if (e.key === 'ArrowDown') {
                      newIndex = (currentIndex + 1) % todos.length;
                  }
                  
                  todos[newIndex]?.focus();
              }
          }
      });
      
      // Function to toggle section by index
      function toggleSectionByIndex(index) {
          sections.forEach((section, i) => {
              const btn = document.querySelector(`.collapse-btn[data-section="${section}"]`);
              const content = document.getElementById(`${section}-content`);
              if (btn && content) {
                  const isVisible = i === index;
                  content.style.display = isVisible ? '' : 'none';
                  btn.textContent = isVisible ? '▼' : '▶';
                  try {
                      localStorage.setItem(`kdream-collapsed-${section}`, String(!isVisible));
                  } catch {}
              }
          });
      }
      
      // Initialize keyboard state on load
      document.addEventListener('DOMContentLoaded', () => {
          // Restore last section or default to first
          const lastSection = localStorage.getItem('kdream-last-section');
          if (lastSection && sections.includes(lastSection)) {
              currentSectionIndex = sections.indexOf(lastSection);
          }
          
          // Set initial section visibility
          toggleSectionByIndex(currentSectionIndex);
          
          // Remember last viewed section
          document.addEventListener('visibilitychange', () => {
              if (!document.hidden) {
                  const visibleSection = sections.find(section => {
                      const content = document.getElementById(`${section}-content`);
                      return content && content.style.display !== 'none';
                  });
                  if (visibleSection) {
                      localStorage.setItem('kdream-last-section', visibleSection);
                  }
              }
          });
      });
    });
    
    function matchesFilter(text) {
        if (!currentFilter) return true;
        return text.toLowerCase().includes(currentFilter);
    }

    function parseTagsFromContent(text) {
        const tagRegex = /#(\w+)/g;
        const tags = [];
        let match;
        while ((match = tagRegex.exec(text)) !== null) {
            tags.push(match[1]);
        }
        return tags;
    }

    function getPriorityIcon(priority) {
        switch (priority) {
            case 'high': return '🔴';
            case 'medium': return '🟡';
            case 'low': return '🔵';
            default: return '';
        }
    }

    function getDueDateStatus(dueDate) {
        if (!dueDate) return 'none';
        
        const due = new Date(dueDate);
        const now = new Date();
        const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);
        
        if (diffHours < 0) return 'overdue';
        if (diffHours < 24) return 'due-soon';
        return 'upcoming';
    }

    function formatDueDate(dueDate) {
        if (!dueDate) return '';
        
        const date = new Date(dueDate);
        const now = new Date();
        const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        if (diffDays === -1) return 'Yesterday';
        if (diffDays > 0 && diffDays <= 7) return `In ${diffDays} days`;
        if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;
        
        return date.toLocaleDateString();
    }

    function updateTagFilter() {
        const tagSelect = document.getElementById('tag-filter');
        if (!tagSelect) return;

        // Clear existing options except "All Tags"
        while (tagSelect.options.length > 1) {
            tagSelect.remove(1);
        }

        // Add all available tags
        allTags.forEach(tag => {
            const option = document.createElement('option');
            option.value = tag;
            option.textContent = `#${tag}`;
            tagSelect.appendChild(option);
        });

        tagSelect.value = selectedTag;
    }


    
    function renderFilteredTasks() {
        const filtered = allTasks.filter(task => {
            if (!matchesFilter(task.description)) return false;
            if (selectedTag) {
                const taskTags = parseTagsFromContent(task.description);
                if (!taskTags.includes(selectedTag)) return false;
            }
            if (selectedPriority) {
                if (selectedPriority === 'overdue') {
                    if (!task.dueDate) return false;
                    const dueStatus = getDueDateStatus(task.dueDate);
                    if (dueStatus !== 'overdue') return false;
                } else if (task.priority !== selectedPriority) {
                    return false;
                }
            }
            return true;
        });
        updateTasks(filtered);
        const countEl = document.getElementById('tasks-count');
        if (countEl) {
            let filterText = '';
            if (selectedTag) filterText += ` (tag: #${selectedTag})`;
            if (selectedPriority) {
                let priorityLabel = '';
                switch (selectedPriority) {
                    case 'high': priorityLabel = '🔴 High'; break;
                    case 'medium': priorityLabel = '🟡 Medium'; break;
                    case 'low': priorityLabel = '🔵 Low'; break;
                    case 'overdue': priorityLabel = '⚠️ Overdue'; break;
                }
                filterText += ` (${priorityLabel} Priority)`;
            }
            countEl.textContent = (currentFilter || selectedTag || selectedPriority) ? `(${filtered.length} of ${allTasks.length})${filterText}` : '';
        }
    }
    
    function renderFilteredLogs() {
        const filtered = allLogs.filter(log => matchesFilter(log));
        updateLogs(filtered);
        const countEl = document.getElementById('logs-count');
        if (countEl) {
            countEl.textContent = currentFilter ? `(${filtered.length} of ${allLogs.length})` : '';
        }
    }
    
    function renderFilteredTodos() {
        const filtered = allTodos.filter(todo =>
            matchesFilter(todo.description) ||
            (todo.source && matchesFilter(todo.source.file))
        );
        updateTodos(filtered);
        const countEl = document.getElementById('todos-count');
        if (countEl) {
            countEl.textContent = currentFilter ? `(${filtered.length} of ${allTodos.length})` : '';
        }
    }
    
    document.getElementById('copy-todos-btn').addEventListener('click', () => {
        if (allTodos.length === 0) return;
        const lines = allTodos.map(todo => {
            const checkbox = '[ ]';
            const sourceInfo = todo.source ? ` ${todo.source.file}:${todo.source.line}` : '';
            return `- ${checkbox} ${todo.description}${sourceInfo}`;
        });
        const text = lines.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('copy-todos-btn');
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('copied');
            }, 1500);
        });
    });
    
    function updateStatus(data) {
        const statusContent = document.getElementById('status-content');
        while (statusContent.firstChild) {
            statusContent.removeChild(statusContent.firstChild);
        }
        if (data) {
            const fields = [
                { label: 'Status', value: data.status || 'Unknown' },
                { label: 'Started', value: data.started ? new Date(data.started).toLocaleString() : 'N/A' },
                { label: 'Tick Count', value: String(data.tick || 0) },
                { label: 'Last Dream', value: data.lastDream ? new Date(data.lastDream).toLocaleString() : 'Never' }
            ];
            fields.forEach(field => {
                const p = document.createElement('p');
                const strong = document.createElement('strong');
                strong.textContent = field.label + ':';
                p.appendChild(strong);
                p.appendChild(document.createTextNode(' ' + field.value));
                statusContent.appendChild(p);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No status data available. Run /kdream start to begin.';
            statusContent.appendChild(p);
        }
    }
    
    function updateTasks(data) {
        const tasksContent = document.getElementById('tasks-content');
        while (tasksContent.firstChild) {
            tasksContent.removeChild(tasksContent.firstChild);
        }
        if (data && data.length > 0) {
            data.forEach(task => {
                const taskItem = document.createElement('div');
                taskItem.className = 'task-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = task.completed;
                checkbox.disabled = true;

                const taskText = document.createElement('div');
                taskText.className = 'task-text';

                // Priority badge
                if (task.priority) {
                    const priorityBadge = document.createElement('span');
                    priorityBadge.className = `priority-badge priority-${task.priority}`;
                    priorityBadge.textContent = getPriorityIcon(task.priority);
                    taskText.appendChild(priorityBadge);
                }

                const description = document.createElement('span');
                description.textContent = task.description;

                taskText.appendChild(description);

                // Due date indicator
                if (task.dueDate) {
                    const dueStatus = getDueDateStatus(task.dueDate);
                    const dueBadge = document.createElement('span');
                    dueBadge.className = `due-date due-${dueStatus}`;
                    dueBadge.textContent = formatDueDate(task.dueDate);
                    dueBadge.title = `Due: ${new Date(task.dueDate).toLocaleDateString()}`;
                    taskText.appendChild(dueBadge);
                }

                // Add source information if available
                if (task.source) {
                    const sourceInfo = document.createElement('div');
                    sourceInfo.className = 'task-source';

                    const fileLink = document.createElement('span');
                    fileLink.className = 'task-source-file';
                    fileLink.textContent = `${task.source.file}:${task.source.line}`;
                    fileLink.style.cursor = 'pointer';
                    fileLink.onclick = () => {
                        vscode.postMessage({
                            command: 'openFileAtLine',
                            file: task.source.file,
                            line: task.source.line
                        });
                    };

                    sourceInfo.appendChild(fileLink);

                    if (task.source.date) {
                        const dateInfo = document.createElement('span');
                        dateInfo.className = 'task-source-date';
                        dateInfo.textContent = ` (${task.source.date})`;
                        sourceInfo.appendChild(dateInfo);
                    }

                    taskText.appendChild(sourceInfo);
                }

                taskItem.appendChild(checkbox);
                taskItem.appendChild(taskText);

                // Add tags if present
                const taskTags = parseTagsFromContent(task.description);
                if (taskTags.length > 0) {
                    const tagsContainer = document.createElement('div');
                    tagsContainer.className = 'task-tags';
                    taskTags.forEach(tag => {
                        const tagElement = document.createElement('span');
                        tagElement.className = 'task-tag';
                        tagElement.textContent = `#${tag}`;
                        tagsContainer.appendChild(tagElement);
                    });
                    taskItem.appendChild(tagsContainer);
                }

                tasksContent.appendChild(taskItem);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = currentFilter || selectedTag || selectedPriority ? 'No matching tasks.' : 'No tasks or follow-ups found.';
            tasksContent.appendChild(p);
        }
    }
    
    function updateLogs(data) {
        const logsContent = document.getElementById('logs-content');
        while (logsContent.firstChild) {
            logsContent.removeChild(logsContent.firstChild);
        }
        if (data && data.length > 0) {
            data.forEach(log => {
                const logEntry = document.createElement('div');
                logEntry.className = 'log-entry';
                logEntry.textContent = log;
                logsContent.appendChild(logEntry);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = currentFilter ? 'No matching logs.' : 'No recent activity.';
            logsContent.appendChild(p);
        }
    }
    
    function updateAdapterHealth(data) {
        const adapterContent = document.getElementById('adapter-health-content');
        adapterContent.innerHTML = '';
        if (data && data.length > 0) {
            data.forEach(adapter => {
                const adapterStatus = document.createElement('div');
                adapterStatus.className = 'adapter-status';
                
                const indicator = document.createElement('span');
                indicator.className = 'indicator ' + adapter.status;
                
                const nameSpan = document.createElement('span');
                nameSpan.textContent = adapter.name;
                
                const detailsSpan = document.createElement('span');
                detailsSpan.textContent = adapter.details || '';
                detailsSpan.style.marginLeft = 'auto';
                detailsSpan.style.color = 'var(--vscode-descriptionForeground)';
                
                adapterStatus.appendChild(indicator);
                adapterStatus.appendChild(nameSpan);
                adapterStatus.appendChild(detailsSpan);
                adapterContent.appendChild(adapterStatus);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No adapter health data available.';
            adapterContent.appendChild(p);
        }
    }
    
    function updateTodos(data) {
        const todosContent = document.getElementById('todos-content');
        while (todosContent.firstChild) {
            todosContent.removeChild(todosContent.firstChild);
        }
        if (data && data.length > 0) {
            data.forEach(todo => {
                const todoItem = document.createElement('div');
                todoItem.className = 'todo-item';
                todoItem.style.cursor = 'pointer';
                todoItem.title = 'Click to open file';
                
                if (todo.source) {
                    todoItem.addEventListener('click', () => {
                        vscode.postMessage({ command: 'openFileAtLine', file: todo.source.file, line: todo.source.line });
                    });
                }
                
                const typeBadge = document.createElement('span');
                typeBadge.className = 'todo-type ' + (todo.description.startsWith('FIXME') ? 'fixme' : 'todo');
                typeBadge.textContent = todo.description.startsWith('FIXME') ? 'FIXME' : 'TODO';
                
                const fileSpan = document.createElement('span');
                fileSpan.className = 'todo-file';
                fileSpan.textContent = todo.source ? `${todo.source.file}:${todo.source.line}` : '';
                
                const textSpan = document.createElement('span');
                textSpan.className = 'todo-text';
                textSpan.textContent = todo.description.replace(/^(TODO|FIXME):\s*/, '');
                
                todoItem.appendChild(typeBadge);
                todoItem.appendChild(fileSpan);
                todoItem.appendChild(textSpan);
                todosContent.appendChild(todoItem);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = currentFilter ? 'No matching TODOs.' : 'No TODOs or FIXMEs found.';
            todosContent.appendChild(p);
        }
    }

    function renderMemorySearchResults() {
        const container = document.getElementById('memory-search-content');
        if (!container) return;

        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        if (memorySearchResults.length === 0) {
            const p = document.createElement('p');
            p.textContent = currentMemoryQuery ?
                `No results found for "${currentMemoryQuery}".` :
                'Use Ctrl+Shift+P → "KDream: Search Memory" to search.';
            container.appendChild(p);
            return;
        }

        const summary = document.createElement('p');
        summary.textContent = `Found ${memorySearchResults.length} results for "${currentMemoryQuery}"`;
        summary.style.fontWeight = 'bold';
        summary.style.marginBottom = '10px';
        container.appendChild(summary);

        memorySearchResults.forEach(result => {
            const item = document.createElement('div');
            item.className = 'memory-result-item';

            const header = document.createElement('div');
            header.className = 'memory-result-header';

            const fileLink = document.createElement('span');
            fileLink.className = 'memory-result-file';
            fileLink.textContent = `${result.file}:${result.line}`;
            fileLink.style.cursor = 'pointer';
            fileLink.onclick = () => {
                vscode.postMessage({ command: 'openMemoryFile', file: result.file, line: result.line });
            };

            const highlightedText = document.createElement('div');
            highlightedText.className = 'memory-result-text';
            const before = result.text.substring(0, result.matchIndex);
            const match = result.text.substring(result.matchIndex, result.matchIndex + currentMemoryQuery.length);
            const after = result.text.substring(result.matchIndex + currentMemoryQuery.length);
            highlightedText.innerHTML = `${before}<mark>${match}</mark>${after}`;

            const context = document.createElement('div');
            context.className = 'memory-result-context';
            context.textContent = result.context;

            item.appendChild(header);
            header.appendChild(fileLink);
            item.appendChild(highlightedText);
            item.appendChild(context);
            container.appendChild(item);
        });
    }

     function renderMemoryHistory() {
        const container = document.getElementById('history-timeline');
        container.innerHTML = '';

        if (memoryHistory.length === 0) {
            container.innerHTML = '<p>No history available.</p>';
            return;
        }

        memoryHistory.forEach(snapshot => {
            const item = document.createElement('div');
            item.className = 'history-item';

            const header = document.createElement('div');
            header.className = 'history-header';

            const date = document.createElement('span');
            date.className = 'history-date';
            date.textContent = new Date(snapshot.timestamp).toLocaleDateString();

            const summary = document.createElement('span');
            summary.className = 'history-summary';
            summary.textContent = `${Object.keys(snapshot.memoryFiles).length} files, ${snapshot.consolidationEvents.length} events`;

            header.appendChild(date);
            header.appendChild(summary);

            const events = document.createElement('div');
            events.className = 'history-events';

            snapshot.consolidationEvents.forEach(event => {
                const eventItem = document.createElement('div');
                eventItem.className = 'history-event';

                const time = document.createElement('span');
                time.className = 'event-time';
                time.textContent = new Date(event.timestamp).toLocaleTimeString();

                const desc = document.createElement('span');
                desc.className = 'event-description';
                desc.textContent = event.description;

                eventItem.appendChild(time);
                eventItem.appendChild(desc);
                events.appendChild(eventItem);
            });

            item.appendChild(header);
            item.appendChild(events);
            container.appendChild(item);
        });
    }

    function renderWorkflowHistory() {
        const container = document.getElementById('workflow-history-list');
        if (!container) return;
        container.innerHTML = '';

        if (workflowHistory.length === 0) {
            container.innerHTML = '<p style="color: var(--vscode-descriptionForeground); font-size: 0.9em;">No workflow executions recorded yet.</p>';
            return;
        }

        workflowHistory.slice(-10).reverse().forEach(record => {
            const item = document.createElement('div');
            item.className = `workflow-history-item workflow-${record.status}`;

            const header = document.createElement('div');
            header.className = 'workflow-history-header';

            const name = document.createElement('span');
            name.className = 'workflow-history-name';
            name.textContent = record.workflowName;

            const status = document.createElement('span');
            status.className = `workflow-status workflow-status-${record.status}`;
            status.textContent = record.status;

            header.appendChild(name);
            header.appendChild(status);
            item.appendChild(header);

            const meta = document.createElement('div');
            meta.className = 'workflow-history-meta';

            const time = document.createElement('div');
            time.className = 'workflow-history-time';
            time.textContent = new Date(record.startTime).toLocaleString();

            const steps = document.createElement('div');
            steps.className = 'workflow-history-steps';
            const successSteps = record.steps.filter(s => s.status === 'success').length;
            steps.textContent = `${successSteps}/${record.steps.length} steps`;

            if (record.endTime) {
                const duration = document.createElement('div');
                duration.className = 'workflow-history-duration';
                const startMs = new Date(record.startTime).getTime();
                const endMs = new Date(record.endTime).getTime();
                const seconds = Math.round((endMs - startMs) / 1000);
                duration.textContent = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m ${seconds % 60}s`;
                meta.appendChild(time);
                meta.appendChild(duration);
            } else {
                meta.appendChild(time);
            }

            meta.appendChild(steps);
            item.appendChild(meta);

            container.appendChild(item);
        });
    }

     // Set up tag filter event listener
     document.addEventListener('DOMContentLoaded', () => {
         const tagFilter = document.getElementById('tag-filter');
         if (tagFilter) {
             tagFilter.addEventListener('change', (e) => {
                 selectedTag = e.target.value;
                 renderFilteredTasks();
             });
         }
         
         const priorityFilter = document.getElementById('priority-filter');
         if (priorityFilter) {
             priorityFilter.addEventListener('change', (e) => {
                 selectedPriority = e.target.value;
                 renderFilteredTasks();
             });
         }
         
         // Set up health history controls
         const historyTimeRange = document.getElementById('history-time-range');
         if (historyTimeRange) {
             historyTimeRange.addEventListener('change', () => {
                 refreshHealthHistory();
             });
         }
         
         const refreshHistoryBtn = document.getElementById('refresh-history-btn');
         if (refreshHistoryBtn) {
             refreshHistoryBtn.addEventListener('click', () => {
                 refreshHealthHistory();
             });
         }
     });
     
      // Function to refresh health history based on selected time range
      function refreshHealthHistory() {
          const timeRangeSelect = document.getElementById('history-time-range');
          let hours = 24; // default
          
          if (timeRangeSelect) {
              const value = timeRangeSelect.value;
              if (value === '6h') hours = 6;
              else if (value === '24h') hours = 24;
              else if (value === '7d') hours = 7 * 24; // 7 days in hours
          }
          
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
              getAdapterHealthHistory(workspaceRoot, hours).then(history => {
                  vscode.postMessage({ command: 'updateAdapterHealthHistory', data: history });
              }).catch(error => {
                  console.error('Failed to get adapter health history:', error);
                  vscode.postMessage({ command: 'updateAdapterHealthHistory', data: [] });
              });
          }
      }

    vscode.postMessage({ command: 'getInitialData' });
});
         }
     }
     
      // Add function to request health history updates from extension
      window.addEventListener('message', event => {
          try {
              const message = event.data;
              switch (message.command) {
                  case 'updateStatus':
                      updateStatus(message.data);
                      break;
                  case 'updateTasks':
                      allTasks = message.data || [];
                      allTags = message.tags || [];
                      updateTagFilter();
                      renderFilteredTasks();
                      break;
                  case 'updateLogs':
                      allLogs = message.data || [];
                      renderFilteredLogs();
                      break;
                  case 'updateAdapterHealth':
                      updateAdapterHealth(message.data);
                      break;
                  case 'updateTodos':
                      allTodos = message.data || [];
                      renderFilteredTodos();
                      break;
                  case 'updateAdapterHealthHistory':
                      healthHistory = message.data || [];
                      renderHealthChart(healthHistory);
                      break;
                  case 'error':
                      showError(message.data);
                      break;
                  case 'exportResult':
                      handleExportResult(message.data, message.type);
                      break;
                  case 'memorySearchResults':
                      memorySearchResults = message.data || [];
                      currentMemoryQuery = message.query || '';
                      renderMemorySearchResults();
                      break;
                  case 'showMemoryHistory':
                      memoryHistory = message.data || [];
                      renderMemoryHistory();
                      break;
                  case 'updateWorkflowHistory':
                      workflowHistory = message.data || [];
                      renderWorkflowHistory();
                      break;
                  case 'updateWorkflowHistory':
                      workflowHistory = message.data || [];
                      renderWorkflowHistory();
                      break;
              }
          } catch (err) {
              console.error('KDream Dashboard message handler error:', err);
              showError(err.message || 'An unexpected error occurred');
          }
      });

    vscode.postMessage({ command: 'getInitialData' });

    // ── Intelligent Routing Panel ─────────────────────────────────────────

    function escapeHtml(str) {
        if (!str) { return ''; }
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderRoutingZMLRStatus() {
        const badge = document.getElementById('routing-zmlr-status');
        if (!badge) { return; }
        badge.textContent = routingZmlrOnline ? 'ZMLR: Online' : 'ZMLR: Offline';
        badge.className = 'routing-zmlr-badge ' + (routingZmlrOnline ? 'zmlr-online' : 'zmlr-offline');
    }

    function renderRoutingSessions() {
        const container = document.getElementById('routing-sessions-list');
        if (!container) { return; }
        if (!routingSessions.length) {
            container.innerHTML = '<p class="dim-text">No active sessions tracked.</p>';
            return;
        }
        const rows = routingSessions.map(s => {
            const statusClass = s.status === 'healthy' ? 'status-healthy' :
                                s.status === 'failed'  ? 'status-failed'  :
                                s.status === 'stalled' ? 'status-warn'    : 'status-info';
            const ageMs = Date.now() - (s.lastActivity || 0);
            const ageMin = Math.floor(ageMs / 60000);
            return '<div class="routing-session-row">' +
                '<span class="session-badge ' + statusClass + '">' + escapeHtml(s.status) + '</span>' +
                '<span class="session-id">' + escapeHtml(s.id) + '</span>' +
                '<span class="session-age dim-text">' + ageMin + 'm ago</span>' +
                (s.failureReason ? '<span class="session-error dim-text">' + escapeHtml(s.failureReason) + '</span>' : '') +
                (s.status !== 'healthy' ? '<button class="heal-btn" data-session="' + escapeHtml(s.id) + '">Heal</button>' : '') +
                '</div>';
        }).join('');
        container.innerHTML = '<div class="routing-sessions">' + rows + '</div>';
        container.querySelectorAll('.heal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'routing:healSessions', sessionId: btn.dataset.session });
            });
        });
    }

    const TIER_COLORS = { local: '#6a9fb5', free: '#90a959', 'low-cost': '#f4bf75', mid: '#aa759f', sota: '#ac4142' };

    function renderRoutingModelList() {
        const container = document.getElementById('routing-model-list');
        if (!container) { return; }
        if (!routingModels.length) {
            container.innerHTML = '<p class="dim-text">Click "Rank Models" to see ranked list.</p>';
            return;
        }
        const rows = routingModels.slice(0, 10).map((m, i) => {
            const color = TIER_COLORS[m.tier] || '#888';
            const backedOff = m._backedOff ? ' <span class="badge-warn">backed off</span>' : '';
            return '<div class="routing-model-row">' +
                '<span class="model-rank">' + (i + 1) + '</span>' +
                '<span class="model-name">' + escapeHtml(m.name) + backedOff + '</span>' +
                '<span class="model-tier" style="color:' + color + '">' + escapeHtml(m.tier) + '</span>' +
                '<span class="model-score">' + (m.capabilities ? Object.values(m.capabilities)[0].toFixed(2) : '—') + '</span>' +
                (m.rpmLimit ? '<span class="model-rpm dim-text">' + m.rpmLimit + ' rpm</span>' : '<span class="model-rpm dim-text">∞</span>') +
                '</div>';
        }).join('');
        container.innerHTML = '<div class="routing-model-list-inner">' + rows + '</div>';
    }

    function renderRoutingRateLimits() {
        const container = document.getElementById('routing-ratelimit-list');
        if (!container) { return; }
        if (!routingRateLimits.length) {
            container.innerHTML = '<p class="dim-text">No rate-limit data yet.</p>';
            return;
        }
        const now = Date.now();
        const rows = routingRateLimits.map(r => {
            const backedOffMs = Math.max(0, r.backoffUntil - now);
            const backoffStr = backedOffMs > 0 ? Math.ceil(backedOffMs / 1000) + 's backoff' : 'available';
            const cls = backedOffMs > 0 ? 'status-failed' : 'status-healthy';
            return '<div class="ratelimit-row">' +
                '<span class="ratelimit-model dim-text">' + escapeHtml(r.model) + '</span>' +
                '<span class="ratelimit-status ' + cls + '">' + backoffStr + '</span>' +
                '<span class="ratelimit-counts dim-text">✓' + r.successCount + ' ✗' + r.errorCount + '</span>' +
                '</div>';
        }).join('');
        container.innerHTML = '<div class="ratelimit-list-inner">' + rows + '</div>';
    }

    function showRoutingNotice(msg) {
        const el = document.getElementById('routing-model-list');
        if (el) { el.insertAdjacentHTML('beforebegin', '<p class="routing-notice">' + escapeHtml(msg) + '</p>'); }
    }

    // Button wiring
    document.addEventListener('DOMContentLoaded', () => {
        // Routing panel buttons
        const healBtn = document.getElementById('routing-heal-btn');
        if (healBtn) {
            healBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'routing:healSessions' });
            });
        }

        const decideBtn = document.getElementById('routing-decide-btn');
        if (decideBtn) {
            decideBtn.addEventListener('click', () => {
                const taskType = document.getElementById('routing-task-type')?.value || 'general';
                const maxTier = document.getElementById('routing-max-tier')?.value || 'sota';
                vscode.postMessage({ command: 'routing:decide', taskType, maxTier });
            });
        }

        const recheckBtn = document.getElementById('routing-recheck-btn');
        if (recheckBtn) {
            recheckBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'routing:recheckZMLR' });
            });
        }

        const rankBtn = document.getElementById('routing-rank-btn');
        if (rankBtn) {
            rankBtn.addEventListener('click', () => {
                const taskType = document.getElementById('routing-task-type')?.value || 'general';
                const maxTier = document.getElementById('routing-max-tier')?.value || 'sota';
                vscode.postMessage({ command: 'routing:rankModels', taskType, maxTier });
            });
        }

        const saveSettingsBtn = document.getElementById('routing-save-settings-btn');
        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', () => {
                const zmlrUrl = document.getElementById('routing-zmlr-url')?.value;
                const failoverMode = document.getElementById('routing-failover-mode')?.value;
                vscode.postMessage({ command: 'routing:saveSettings', zmlrUrl, failoverMode });
            });
        }
    });
})();
