import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  parseMemoryTasks,
  addTaskToContent,
  createInitialMemoryContent,
  isAutoclawInGitignore,
  addAutoclawToGitignore,
  parseLogEntries,
  parseTodosFromContent,
  getAdapterHealthEntry,
  DEFAULT_ADAPTERS,
  generateNonce,
  shouldShowNotification as shouldShowNotificationHelper,
  getTodayDate,
  getMemoryPath,
  getStatePath,
  getTodayLogPath,
  checkZippyMeshHealth
} from './kdream-helpers';
import type { ParsedTask, AdapterHealth, TodoItem } from './kdream-helpers';

const fsPromises = fs.promises;

// Re-export helpers for external use (e.g., tests)
export {
  parseMemoryTasks,
  addTaskToContent,
  createInitialMemoryContent,
  isAutoclawInGitignore,
  addAutoclawToGitignore,
  parseLogEntries,
  parseTodosFromContent,
  getAdapterHealthEntry,
  DEFAULT_ADAPTERS,
  generateNonce,
  shouldShowNotificationHelper,
  getTodayDate,
  getMemoryPath,
  getStatePath,
  getTodayLogPath,
  checkZippyMeshHealth
};
export type { ParsedTask, AdapterHealth, TodoItem };

let kdreamView: vscode.WebviewView | undefined = undefined;
let stateWatcher: vscode.FileSystemWatcher | undefined = undefined;
let scanResults: { file: string; line: number; type: string; text: string }[] = [];
let refreshIntervalId: NodeJS.Timeout | undefined = undefined;
let todoScanDebounceTimer: NodeJS.Timeout | undefined = undefined;
let pendingTodoScan: boolean = false;

export function activate(context: vscode.ExtensionContext) {
  console.log('AutoClaw activated — skills ready');

  const adaptersDir = path.join(context.extensionPath, 'adapters');

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.enableAll', () => {
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          'AutoClaw: All skills loaded and ready. Try /kdream start or /autobuild schedule in any chat.'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.startKdream', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open');
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          'KDream background agent started via skill. Check chat for status.'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.installAdapters', async () => {
      await installAdapters(adaptersDir, context.extensionPath);
    })
  );

  // KDream Dashboard commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.showDashboard', async () => {
      await vscode.commands.executeCommand('kdreamDashboard.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.refreshDashboard', async () => {
      if (kdreamView) {
        await refreshDashboardData(kdreamView);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.addTask', async () => {
      const task = await vscode.window.showInputBox({
        prompt: 'Enter task for KDream',
        placeHolder: 'e.g., Review PR #123'
      });
      if (task) {
        await addTaskToMemory(task);
      }
    })
  );

  // Register KDream View Provider
  const kdreamViewProvider = new KDreamViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KDreamViewProvider.viewType, kdreamViewProvider)
  );

  // Set up file system watcher for state.json
  stateWatcher = vscode.workspace.createFileSystemWatcher('**/.autoclaw/kdream/state.json');
  stateWatcher.onDidChange(async (uri) => {
    if (kdreamView) {
      await refreshDashboardData(kdreamView);
    }
  });
  context.subscriptions.push(stateWatcher);

  // Check if .autoclaw/ is in .gitignore
  checkAndOfferGitignoreUpdate().catch(e => console.error('gitignore check failed:', e));

  // Auto-install adapters silently on activation if enabled
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const autoInstall = config.get<boolean>('autoInstallAdapters', true);
  if (autoInstall) {
    installAdapters(adaptersDir, context.extensionPath, true);
  }
}

async function installAdapters(
  adaptersDir: string,
  extensionPath: string,
  silent = false
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
  const installed: string[] = [];

  // Claude Code — global ~/.claude/skills/
  if (vscode.extensions.getExtension('Anthropic.claude-code')) {
    const dest = path.join(os.homedir(), '.claude', 'skills');
    copySkillDir(path.join(adaptersDir, 'claude-code'), dest);
    installed.push('Claude Code');
  }

  if (!workspaceRoot) {
    if (!silent && installed.length > 0 && shouldShowNotification('info')) {
      vscode.window.showInformationMessage(`AutoClaw: Installed adapters for ${installed.join(', ')}.`);
    }
    return;
  }

  // Cline — workspace .clinerules/
  const clineIds = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline', 'cline.cline'];
  if (clineIds.some(id => vscode.extensions.getExtension(id))) {
    const dest = path.join(workspaceRoot, '.clinerules');
    copyDir(path.join(adaptersDir, 'cline'), dest);
    installed.push('Cline');
  }

  // KiloCode — workspace .kilocodemodes
  if (vscode.extensions.getExtension('kilocode.kilo-code')) {
    const src = path.join(adaptersDir, 'kilocode', 'autoclaw-modes.yaml');
    const dest = path.join(workspaceRoot, '.kilocodemodes');
    mergeKiloModes(src, dest);
    installed.push('KiloCode');
  }

  // Cursor — workspace .cursor/rules/
  // Cursor is a standalone app; we write rules for it if the directory exists
  const cursorDir = path.join(workspaceRoot, '.cursor', 'rules');
  if (fs.existsSync(path.join(workspaceRoot, '.cursor')) || hasCursorConfig(workspaceRoot)) {
    fs.mkdirSync(cursorDir, { recursive: true });
    copyDir(path.join(adaptersDir, 'cursor'), cursorDir);
    installed.push('Cursor');
  }

  // Kiro — workspace .kiro/steering/
  const kiroDir = path.join(workspaceRoot, '.kiro');
  if (fs.existsSync(kiroDir) || vscode.extensions.getExtension('amazon.kiro')) {
    const dest = path.join(workspaceRoot, '.kiro', 'steering');
    copyDir(path.join(adaptersDir, 'kiro'), dest);
    installed.push('Kiro');
  }

  // Windsurf — workspace .windsurf/rules/
  const windsurfDir = path.join(workspaceRoot, '.windsurf');
  if (fs.existsSync(windsurfDir) || vscode.extensions.getExtension('codeium.windsurf')) {
    const dest = path.join(workspaceRoot, '.windsurf', 'rules');
    copyDir(path.join(adaptersDir, 'windsurf'), dest);
    installed.push('Windsurf');
  }

  // Continue — workspace .continue/prompts/
  if (vscode.extensions.getExtension('Continue.continue')) {
    const dest = path.join(workspaceRoot, '.continue', 'prompts');
    copyDir(path.join(adaptersDir, 'continue'), dest);
    installed.push('Continue');
  }

  // ZippyMesh LLM Router — drop setup guide if ZMLR is running or was recently detected
  let zmlrDetected = false;
  if (workspaceRoot) {
    try {
      const zippymeshUrl = vscode.workspace.getConfiguration('autoclaw.kdream').get('zippymeshUrl', 'http://localhost:20128');
      const zmlrRes = await fetch(zippymeshUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000)
      });
      if (zmlrRes.ok) {
        zmlrDetected = true;
        // Drop the setup guide and playbooks into .autoclaw/zippymesh/
        const zmlrDestDir = path.join(workspaceRoot, '.autoclaw', 'zippymesh');
        copyDir(path.join(adaptersDir, 'zippymesh'), zmlrDestDir);
        installed.push('ZippyMesh LLM Router');

        // Offer to open the setup guide
        if (!silent && shouldShowNotification('info')) {
          const action = await vscode.window.showInformationMessage(
            'ZippyMesh LLM Router detected! Setup guide copied to .autoclaw/zippymesh/README.md',
            'Open Setup Guide'
          );
          if (action === 'Open Setup Guide') {
            const setupPath = path.join(zmlrDestDir, 'README.md');
            vscode.window.showTextDocument(vscode.Uri.file(setupPath));
          }
        }
      }
    } catch {
      // ZMLR not running — skip silently
    }
  }

  // If both Claude Code AND ZippyMesh are detected, offer MCP setup
  const claudeCodeInstalled = !!vscode.extensions.getExtension('Anthropic.claude-code');
  if (claudeCodeInstalled && zmlrDetected) {
    await offerZippyMeshMcpSetup(adaptersDir);
  }

  if (!silent) {
    if (installed.length > 0 && shouldShowNotification('info')) {
      vscode.window.showInformationMessage(
        `AutoClaw: Adapters installed for ${installed.join(', ')}.`
      );
    } else if (shouldShowNotification('info')) {
      vscode.window.showInformationMessage(
        'AutoClaw: No supported AI extensions detected. Adapters are in the extension\'s adapters/ folder for manual use.'
      );
    }
  }
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) { return; }
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    if (fs.statSync(srcFile).isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}

function copySkillDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) { return; }
  fs.mkdirSync(dest, { recursive: true });
  for (const skillName of fs.readdirSync(src)) {
    const skillSrc = path.join(src, skillName);
    const skillDest = path.join(dest, skillName);
    if (fs.statSync(skillSrc).isDirectory()) {
      copyDir(skillSrc, skillDest);
    }
  }
}

function mergeKiloModes(src: string, dest: string): void {
  if (!fs.existsSync(src)) { return; }
  // If no existing modes file, just copy ours
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    return;
  }
  // Append our modes below a separator if the file already exists
  const existing = fs.readFileSync(dest, 'utf8');
  if (existing.includes('slug: kdream')) { return; } // already installed
  const addition = '\n# AutoClaw modes\n' + fs.readFileSync(src, 'utf8');
  fs.appendFileSync(dest, addition);
}

function hasCursorConfig(workspaceRoot: string): boolean {
  const indicators = ['.cursorrules', '.cursor'];
  return indicators.some(f => fs.existsSync(path.join(workspaceRoot, f)));
}

async function offerZippyMeshMcpSetup(adaptersDir: string): Promise<void> {
  const mcpPath = path.join(os.homedir(), '.claude', 'mcp.json');

  // Check if already configured
  try {
    const existing = await fsPromises.readFile(mcpPath, 'utf8');
    if (existing.includes('zippymesh')) {
      return; // Already configured
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  if (!shouldShowNotification('info')) { return; }

  const action = await vscode.window.showInformationMessage(
    'AutoClaw: Add ZippyMesh LLM Router as an MCP server in Claude Code? This enables live model recommendations in KDream.',
    'Yes, Add MCP Server',
    'No',
    'Show Setup Guide'
  );

  if (action === 'Show Setup Guide') {
    const guidePath = path.join(adaptersDir, 'zippymesh', 'mcp-setup.md');
    vscode.window.showTextDocument(vscode.Uri.file(guidePath));
    return;
  }

  if (action !== 'Yes, Add MCP Server') { return; }

  // Find ZMLR install path — check common locations
  const zmlrPaths = [
    path.join(os.homedir(), 'zippymesh-router'),
    path.join(os.homedir(), 'Downloads', 'zippymesh-router'),
    'C:/zippymesh-router',
    'C:/Program Files/zippymesh-router'
  ];

  // Ask user to confirm path
  const zmlrPath = await vscode.window.showInputBox({
    prompt: 'Enter the path to your ZippyMesh LLM Router installation',
    placeHolder: 'e.g., C:/zippymesh-router or ~/zippymesh-router',
    value: zmlrPaths.find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    }) ?? ''
  });

  if (!zmlrPath) { return; }

  // Read or create mcp.json
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mcpConfig: any = { mcpServers: {} };
  try {
    const existing = await fsPromises.readFile(mcpPath, 'utf8');
    mcpConfig = JSON.parse(existing);
    if (!mcpConfig.mcpServers) { mcpConfig.mcpServers = {}; }
  } catch {
    // Start fresh
  }

  // Add ZippyMesh MCP server
  mcpConfig.mcpServers.zippymesh = {
    command: 'node',
    args: [path.join(zmlrPath, 'mcp-server.js')],
    env: { ZMLR_BASE_URL: 'http://localhost:20128' }
  };

  await fsPromises.mkdir(path.dirname(mcpPath), { recursive: true });
  await fsPromises.writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2));

  vscode.window.showInformationMessage(
    'ZippyMesh MCP server added to ~/.claude/mcp.json. Restart Claude Code to activate.'
  );
}

export async function refreshDashboardData(view: vscode.WebviewView): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }
  
  // Read state.json
  const statePath = getStatePath(workspaceRoot);
  let stateData: any = null;
  try {
    await fsPromises.access(statePath);
    const content = await fsPromises.readFile(statePath, 'utf8');
    stateData = JSON.parse(content);
  } catch (e) {
    // File doesn't exist or can't be read - that's okay
  }
  
  // Read MEMORY.md for tasks
  const memoryPath = getMemoryPath(workspaceRoot);
  let tasks: ParsedTask[] = [];
  try {
    await fsPromises.access(memoryPath);
    const memoryContent = await fsPromises.readFile(memoryPath, 'utf8');
    tasks = parseMemoryTasks(memoryContent);
  } catch (e) {
    // File doesn't exist or can't be read - that's okay
  }
  
  // Read today's log
  const logPath = getTodayLogPath(workspaceRoot);
  let logs: string[] = [];
  try {
    await fsPromises.access(logPath);
    const logContent = await fsPromises.readFile(logPath, 'utf8');
    logs = parseLogEntries(logContent);
  } catch (e) {
    // File doesn't exist or can't be read - that's okay
  }
  
  // Get adapter health
  const adapterHealth = await getAdapterHealth();
  
  // Scan for TODOs/FIXMEs
  const todos = await scanWorkspaceForTodos();
  
  // Send data to webview
  try {
    view.webview.postMessage({ command: 'updateStatus', data: stateData });
    view.webview.postMessage({ command: 'updateTasks', data: tasks });
    view.webview.postMessage({ command: 'updateLogs', data: logs });
    view.webview.postMessage({ command: 'updateAdapterHealth', data: adapterHealth });
    view.webview.postMessage({ command: 'updateTodos', data: todos });
  } catch (e) {
    console.error('Error sending message to webview:', e);
  }
}

export async function getAdapterHealth(): Promise<AdapterHealth[]> {
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const adapters: { name: string; id: string }[] = config.get('adapters', DEFAULT_ADAPTERS);
  
  const extensionResults = adapters.map(adapter => {
    const extension = vscode.extensions.getExtension(adapter.id);
    return getAdapterHealthEntry(adapter.name, !!extension);
  });

  // Check ZippyMesh LLM Router (async network check)
  const zmlrUrl = config.get<string>('zippymeshUrl', 'http://localhost:20128');
  const zmlrHealth = await checkZippyMeshHealth(zmlrUrl);
  
  return [...extensionResults, zmlrHealth];
}

async function scanWorkspaceForTodos(): Promise<TodoItem[]> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return [];
  }

  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const patterns: string[] = config.get('scanPatterns', ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.md']);
  const results: TodoItem[] = [];

  // Show progress notification for large workspaces
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: 'Scanning for TODOs...',
    cancellable: false
  }, async (progress) => {
    let current = 0;
    const total = patterns.length;

    for (const pattern of patterns) {
      progress.report({ message: `Scanning ${pattern} (${current + 1}/${total})`, increment: (1 / total) * 100 });
      try {
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
        for (const fileUri of files) {
          const filePath = fileUri.fsPath;
          try {
            const content = await fsPromises.readFile(filePath, 'utf8');
            const relativePath = path.relative(workspaceRoot, filePath);
            results.push(...parseTodosFromContent(content, relativePath));
          } catch (e) {
            // Skip files that can't be read
          }
        }
      } catch (e) {
        // Skip patterns that don't match
      }
      current++;
    }
  });

  scanResults = results;
  return results;
}

/**
 * Debounced wrapper for scanWorkspaceForTodos.
 * Prevents rapid successive scans when files change quickly.
 */
function debouncedScanWorkspaceForTodos(delayMs: number = 1000): Promise<TodoItem[]> {
  return new Promise((resolve) => {
    if (todoScanDebounceTimer) {
      clearTimeout(todoScanDebounceTimer);
    }
    pendingTodoScan = true;
    todoScanDebounceTimer = setTimeout(async () => {
      pendingTodoScan = false;
      const results = await scanWorkspaceForTodos();
      resolve(results);
    }, delayMs);
  });
}

function getNotificationLevel(): string {
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  return config.get('notificationLevel', 'all');
}

export function shouldShowNotification(level: 'info' | 'warning' | 'error'): boolean {
  const notificationLevel = getNotificationLevel();
  return shouldShowNotificationHelper(notificationLevel, level);
}

export async function addTaskToMemory(task: string): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }
  
  const memoryPath = getMemoryPath(workspaceRoot);
  
  // Create directory if it doesn't exist
  const memoryDir = path.dirname(memoryPath);
  await fsPromises.mkdir(memoryDir, { recursive: true });
  
  // Read or create MEMORY.md
  let memoryContent = '';
  try {
    await fsPromises.access(memoryPath);
    memoryContent = await fsPromises.readFile(memoryPath, 'utf8');
  } catch {
    memoryContent = '# KDream Memory\n\n## Follow-ups\n\n';
  }
  
  // Add task using helper
  memoryContent = addTaskToContent(memoryContent, task);
  
  await fsPromises.writeFile(memoryPath, memoryContent);
  if (shouldShowNotification('info')) {
    vscode.window.showInformationMessage(`Task added to KDream memory: ${task}`);
  }
  
  // Refresh dashboard if open
  if (kdreamView) {
    await refreshDashboardData(kdreamView);
  }
}

export async function checkAndOfferGitignoreUpdate(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }
  
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  try {
    await fsPromises.access(gitignorePath);
  } catch {
    return;
  }
  
  const gitignoreContent = await fsPromises.readFile(gitignorePath, 'utf8');
  if (!isAutoclawInGitignore(gitignoreContent)) {
    if (!shouldShowNotification('info')) {
      return;
    }
    const response = await vscode.window.showInformationMessage(
      'AutoClaw: Add .autoclaw/ to .gitignore to prevent committing KDream data?',
      'Yes', 'No'
    );
    
    if (response === 'Yes') {
      const updatedContent = addAutoclawToGitignore(gitignoreContent);
      await fsPromises.writeFile(gitignorePath, updatedContent);
      vscode.window.showInformationMessage('Added .autoclaw/ to .gitignore');
    }
  }
}

export class KDreamViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kdreamDashboard';
  
  private _view?: vscode.WebviewView;
  
  constructor(private readonly _extensionUri: vscode.Uri) {}
  
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    kdreamView = webviewView;
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'refresh':
          await refreshDashboardData(webviewView);
          break;
        case 'getInitialData':
          await refreshDashboardData(webviewView);
          break;
      }
    });
    
    // Send initial data
    refreshDashboardData(webviewView);
    
    // Set up periodic refresh interval as fallback for file watcher
    const config = vscode.workspace.getConfiguration('autoclaw.kdream');
    const refreshIntervalSeconds = config.get<number>('refreshInterval', 30);
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(async () => {
      if (kdreamView) {
        await refreshDashboardData(kdreamView);
      }
    }, refreshIntervalSeconds * 1000);
    
    // Clean up interval when view is disposed
    webviewView.onDidDispose(() => {
      if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = undefined;
      }
    });
  }
  
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const cssPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'kdream-dashboard.css');
    const jsPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'kdream-dashboard.js');
    
    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);
    
    // Generate a nonce for CSP
    const nonce = this._generateNonce();
    
    // Content Security Policy - restrict sources to extension resources only
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KDream Dashboard</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div id="dashboard-container">
        <header>
            <h1>KDream Dashboard</h1>
            <button id="refresh-btn">Refresh</button>
        </header>
        <main>
            <section id="status-section">
                <h2>Status</h2>
                <div id="status-content">Loading...</div>
            </section>
            <section id="tasks-section">
                <h2>Tasks & Follow-ups</h2>
                <div id="tasks-content">Loading...</div>
            </section>
            <section id="logs-section">
                <h2>Recent Activity</h2>
                <div id="logs-content">Loading...</div>
            </section>
            <section id="adapter-health-section">
                <h2>Adapter Health</h2>
                <div id="adapter-health-content">Loading...</div>
            </section>
            <section id="todos-section">
                <h2>TODOs & FIXMEs</h2>
                <div id="todos-content">Loading...</div>
            </section>
        </main>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
  
  private _generateNonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}

export function deactivate() {
  if (stateWatcher) {
    stateWatcher.dispose();
  }
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = undefined;
  }
  if (todoScanDebounceTimer) {
    clearTimeout(todoScanDebounceTimer);
    todoScanDebounceTimer = undefined;
  }
}
