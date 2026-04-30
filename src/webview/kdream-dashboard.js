// KDream Dashboard JavaScript
(function() {
    const vscode = acquireVsCodeApi();
    
    // Error boundary: wrap message handler in try/catch
    window.addEventListener('message', event => {
        try {
            const message = event.data;
            switch (message.command) {
                case 'updateStatus':
                    updateStatus(message.data);
                    break;
                case 'updateTasks':
                    updateTasks(message.data);
                    break;
                case 'updateLogs':
                    updateLogs(message.data);
                    break;
                case 'updateAdapterHealth':
                    updateAdapterHealth(message.data);
                    break;
                case 'updateTodos':
                    updateTodos(message.data);
                    break;
                case 'updateCodeChurn':
                    updateCodeChurn(message.data);
                    break;
                case 'updateProductivity':
                    updateProductivity(message.data);
                    break;
                case 'updateHealth':
                    updateHealth(message.data);
                    break;
                case 'error':
                    showError(message.data);
                    break;
            }
        } catch (err) {
            console.error('KDream Dashboard message handler error:', err);
            showError(err.message || 'An unexpected error occurred');
        }
    });
    
    // Error display function
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
    
    // Helper to escape HTML in error messages
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Refresh button handler
    document.getElementById('refresh-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
    });

    // Scan TODOs button handler (if present in HTML)
    const scanBtn = document.getElementById('scan-todos-btn');
    if (scanBtn) {
        scanBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'scanTodos' });
        });
    }

    // Export Snapshot button handler (if present in HTML)
    const exportBtn = document.getElementById('export-snapshot-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'exportSnapshot' });
        });
    }
    
    function updateStatus(data) {
        const statusContent = document.getElementById('status-content');
        // Clear existing content
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
        tasksContent.innerHTML = '';
        if (data && data.length > 0) {
            data.forEach((task, index) => {
                const taskItem = document.createElement('div');
                taskItem.className = 'task-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = task.completed;
                // Allow toggling incomplete tasks to mark them complete
                if (!task.completed) {
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            checkbox.disabled = true;
                            vscode.postMessage({ command: 'markTaskComplete', taskIndex: index, taskDescription: task.description });
                        }
                    });
                } else {
                    checkbox.disabled = true;
                }

                const span = document.createElement('span');
                span.textContent = task.description;
                if (task.completed) {
                    span.style.textDecoration = 'line-through';
                    span.style.opacity = '0.6';
                }

                taskItem.appendChild(checkbox);
                taskItem.appendChild(span);
                tasksContent.appendChild(taskItem);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No tasks or follow-ups found.';
            tasksContent.appendChild(p);
        }
    }
    
    function updateLogs(data) {
        const logsContent = document.getElementById('logs-content');
        logsContent.innerHTML = '';
        if (data && data.length > 0) {
            data.forEach(log => {
                const logEntry = document.createElement('div');
                logEntry.className = 'log-entry';
                logEntry.textContent = log;
                logsContent.appendChild(logEntry);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No recent activity.';
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
        todosContent.innerHTML = '';
        if (data && data.length > 0) {
            data.forEach(todo => {
                const todoItem = document.createElement('div');
                todoItem.className = 'todo-item';

                const typeBadge = document.createElement('span');
                typeBadge.className = 'todo-type ' + todo.type.toLowerCase();
                typeBadge.textContent = todo.type;

                const fileSpan = document.createElement('span');
                fileSpan.className = 'todo-file';
                fileSpan.textContent = todo.file + ':' + todo.line;

                const textSpan = document.createElement('span');
                textSpan.className = 'todo-text';
                textSpan.textContent = todo.text;

                todoItem.appendChild(typeBadge);
                todoItem.appendChild(fileSpan);
                todoItem.appendChild(textSpan);
                todosContent.appendChild(todoItem);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No TODOs or FIXMEs found.';
            todosContent.appendChild(p);
        }
    }

    function updateCodeChurn(data) {
        const churnContent = document.getElementById('code-churn-content');
        churnContent.innerHTML = '';
        if (data) {
            const metrics = [
                { label: 'Total Commits', value: data.totalCommits },
                { label: 'Commits (7d)', value: data.commitsLast7Days },
                { label: 'Commits (30d)', value: data.commitsLast30Days },
                { label: 'Lines Added', value: data.linesAdded },
                { label: 'Lines Deleted', value: data.linesDeleted },
                { label: 'Churn Rate', value: data.churnRate + ' lines/commit' },
                { label: 'Avg Commit Size', value: data.avgCommitSize + ' lines' },
                { label: 'Most Active Day', value: data.mostActiveDay || 'N/A' }
            ];
            metrics.forEach(metric => {
                const p = document.createElement('p');
                const strong = document.createElement('strong');
                strong.textContent = metric.label + ':';
                p.appendChild(strong);
                p.appendChild(document.createTextNode(' ' + metric.value));
                churnContent.appendChild(p);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No git repository detected.';
            churnContent.appendChild(p);
        }
    }

    function updateProductivity(data) {
        const prodContent = document.getElementById('productivity-content');
        prodContent.innerHTML = '';
        if (data) {
            const insights = [
                { label: 'TODO Resolution Rate', value: (data.todoResolutionRate * 100).toFixed(1) + '%' },
                { label: 'Avg Time to Resolve TODO', value: data.avgTimeToResolveTodo + ' days' },
                { label: 'Commit Frequency', value: data.commitFrequency + ' commits/day' },
                { label: 'Active Days (30d)', value: data.activeDays },
                { label: 'Memory Size', value: data.memorySize + ' KB' },
                { label: 'Logs Size', value: data.logsSize + ' KB' }
            ];
            insights.forEach(insight => {
                const p = document.createElement('p');
                const strong = document.createElement('strong');
                strong.textContent = insight.label + ':';
                p.appendChild(strong);
                p.appendChild(document.createTextNode(' ' + insight.value));
                prodContent.appendChild(p);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No productivity data available.';
            prodContent.appendChild(p);
        }
    }

    function updateHealth(data) {
        const healthContent = document.getElementById('health-content');
        healthContent.innerHTML = '';
        if (data) {
            const indicators = [
                { label: 'Total Files', value: data.totalFiles, showBar: false },
                { label: 'Source Files', value: data.sourceFiles, showBar: false },
                { label: 'Open TODOs', value: data.openTodos, showBar: false },
                { label: 'Uncommitted Changes', value: data.uncommittedChanges, showBar: false },
                { label: 'Stale Changes Age', value: data.staleChangesHours + ' hours', showBar: false },
                { label: 'Memory Completeness', value: data.memoryCompleteness + '%', showBar: true, percent: data.memoryCompleteness },
                { label: 'Adapter Coverage', value: data.adapterCoverage + '%', showBar: true, percent: data.adapterCoverage }
            ];
            indicators.forEach(indicator => {
                const item = document.createElement('div');
                item.className = 'metric-item';

                const label = document.createElement('span');
                label.className = 'metric-label';
                label.textContent = indicator.label;

                const value = document.createElement('span');
                value.className = 'metric-value';
                value.textContent = indicator.value;

                item.appendChild(label);
                item.appendChild(value);

                if (indicator.showBar) {
                    const bar = document.createElement('div');
                    bar.className = 'progress-bar';
                    const fill = document.createElement('div');
                    fill.className = 'progress-fill';
                    if (indicator.percent < 50) fill.classList.add('error');
                    else if (indicator.percent < 80) fill.classList.add('warning');
                    fill.style.width = indicator.percent + '%';
                    bar.appendChild(fill);
                    item.appendChild(bar);
                }

                healthContent.appendChild(item);
            });
        } else {
            const p = document.createElement('p');
            p.textContent = 'No health data available.';
            healthContent.appendChild(p);
        }
    }
    
    // Request initial data
    vscode.postMessage({ command: 'getInitialData' });
})();
