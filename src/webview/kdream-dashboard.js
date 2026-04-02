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
            data.forEach(task => {
                const taskItem = document.createElement('div');
                taskItem.className = 'task-item';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = task.completed;
                checkbox.disabled = true;
                
                const span = document.createElement('span');
                span.textContent = task.description;
                
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
    
    // Request initial data
    vscode.postMessage({ command: 'getInitialData' });
})();
