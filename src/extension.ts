import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Helper: run a git subcommand asynchronously in a workspace and return stdout.
 * Falls back to empty string on any error so callers can stay simple.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return stdout;
  } catch {
    return '';
  }
}
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
import type { ParsedTask, AdapterHealth, TodoItem, CodeChurnMetrics, ProductivityInsights, ProjectHealthIndicators } from './kdream-helpers';
import { runDoctor, renderReport } from './doctor';
import type { DoctorReport, DoctorVscodeShim } from './doctor';
import { buildSnapshot } from './snapshot';
import {
  tick as autobuildTick,
  discoverWorkflows,
  runWorkflow,
  getRunsDir,
  findLatestRunLog
} from './autobuild';

const fsPromises = fs.promises;
let doctorOutputChannel: vscode.OutputChannel | undefined;
let autobuildOutputChannel: vscode.OutputChannel | undefined;
let autobuildIntervalId: NodeJS.Timeout | undefined;

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
export type { ParsedTask, AdapterHealth, TodoItem, CodeChurnMetrics, ProductivityInsights, ProjectHealthIndicators };

let kdreamView: vscode.WebviewView | undefined = undefined;
let stateWatcher: vscode.FileSystemWatcher | undefined = undefined;
let refreshIntervalId: NodeJS.Timeout | undefined = undefined;

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

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.doctor', async () => {
      await runDoctorCommand(context.extensionPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.exportSnapshot', async () => {
      await runExportSnapshotCommand(context.extensionPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.autobuild.runNow', async () => {
      await autobuildRunNowCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.autobuild.tail', async () => {
      await autobuildTailCommand();
    })
  );

  // AutoBuild scheduler: single setInterval in the extension host.
  startAutobuildScheduler(context);

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

  // Antigravity — workspace .agent/rules/
  // Antigravity is a standalone IDE fork (not a VS Code extension), so detect via
  // the host app name or an existing .agent/ directory in the workspace.
  const agentDir = path.join(workspaceRoot, '.agent');
  const isAntigravityHost = /antigravity/i.test(vscode.env.appName || '');
  if (isAntigravityHost || fs.existsSync(agentDir)) {
    const dest = path.join(workspaceRoot, '.agent', 'rules');
    copyDir(path.join(adaptersDir, 'antigravity'), dest);
    installed.push('Antigravity');
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

/**
 * AutoClaw modes block marker — used to detect and replace previously installed
 * KiloCode modes content from any earlier AutoClaw release.
 */
const AUTOCLAW_MODES_MARKER = '# AutoClaw modes';
const AUTOCLAW_MODE_SLUGS = ['slug: kdream', 'slug: autobuild', 'slug: mateam'];

/**
 * Computes the merged content for a KiloCode `.kilocodemodes` file.
 *
 * Behavior:
 *   - No existing content      -> return new modes verbatim.
 *   - Existing has marker      -> replace from marker through EOF with the new
 *                                 marker block (upgrade path).
 *   - Existing has our slugs   -> previous install without a marker; prepend a
 *                                 warning comment and append a fresh marked
 *                                 block (don't auto-overwrite user data).
 *   - Otherwise                -> append a marked block.
 */
export function computeKiloModesContent(
  existingContent: string | null,
  newModesContent: string
): string {
  const block = '\n' + AUTOCLAW_MODES_MARKER + '\n' + newModesContent;

  if (existingContent === null || existingContent.length === 0) {
    return newModesContent;
  }

  const markerIdx = existingContent.indexOf(AUTOCLAW_MODES_MARKER);
  if (markerIdx !== -1) {
    // Replace from the marker comment line through the end of file.
    const before = existingContent.slice(0, markerIdx).replace(/\s+$/, '');
    return before + block;
  }

  const hasOurSlugs = AUTOCLAW_MODE_SLUGS.some(s => existingContent.includes(s));
  if (hasOurSlugs) {
    // Slugs present without our marker — keep user data, append a warning.
    const warning =
      '\n# WARNING: AutoClaw detected mode slugs (kdream/autobuild/mateam) ' +
      'in this file but no "# AutoClaw modes" marker. The block below was ' +
      'appended without removing the existing entries; please de-duplicate ' +
      'manually if needed.\n';
    return existingContent + warning + block;
  }

  return existingContent + block;
}

function mergeKiloModes(src: string, dest: string): void {
  if (!fs.existsSync(src)) { return; }
  const newContent = fs.readFileSync(src, 'utf8');
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  const merged = computeKiloModesContent(existing, newContent);
  fs.writeFileSync(dest, merged);
}

function hasCursorConfig(workspaceRoot: string): boolean {
  const indicators = ['.cursorrules', '.cursor'];
  return indicators.some(f => fs.existsSync(path.join(workspaceRoot, f)));
}

/**
 * Builds the ordered list of candidate paths to look for a ZippyMesh LLM Router
 * installation. Workspace-relative candidates come first, then $HOME-relative
 * ones, then any user-configured paths from `autoclaw.kdream.zippymeshSearchPaths`.
 * No hard-coded developer drives (K:/, S:/) are included by default.
 */
export function getZippyMeshCandidatePaths(
  workspaceRoot: string | undefined,
  homeDir: string,
  userPaths: string[] = []
): string[] {
  const candidates: string[] = [];
  if (workspaceRoot) {
    candidates.push(path.join(workspaceRoot, 'zippymesh-router'));
    candidates.push(path.join(workspaceRoot, '..', 'zippymesh-router'));
  }
  candidates.push(path.join(homeDir, 'zippymesh-router'));
  candidates.push(path.join(homeDir, 'Downloads', 'zippymesh-router'));
  candidates.push(path.join(homeDir, 'Projects', 'zippymesh-router'));
  for (const p of userPaths) {
    if (typeof p === 'string' && p.length > 0) {
      candidates.push(p);
    }
  }
  return candidates;
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

  // Find ZMLR install path — check workspace, then home dir, then user-configured paths.
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const userPaths = config.get<string[]>('zippymeshSearchPaths', []);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const zmlrPaths = getZippyMeshCandidatePaths(workspaceRoot, os.homedir(), userPaths);

  // Ask user to confirm path
  const zmlrPath = await vscode.window.showInputBox({
    prompt: 'Enter the path to your ZippyMesh LLM Router installation',
    placeHolder: 'e.g., ~/zippymesh-router',
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

export async function getCodeChurnMetrics(workspaceRoot: string): Promise<CodeChurnMetrics> {
  const defaultMetrics: CodeChurnMetrics = {
    totalCommits: 0,
    commitsLast7Days: 0,
    commitsLast30Days: 0,
    linesAdded: 0,
    linesDeleted: 0,
    churnRate: 0,
    avgCommitSize: 0,
    mostActiveDay: ''
  };

  if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
    return defaultMetrics;
  }

  try {
    // Commit counts
    const totalCommits = parseInt((await runGit(workspaceRoot, ['rev-list', '--count', 'HEAD'])).trim()) || 0;
    const commitsLast7Days = parseInt((await runGit(workspaceRoot, ['rev-list', '--count', 'HEAD', '--since=7 days ago'])).trim()) || 0;
    const commitsLast30Days = parseInt((await runGit(workspaceRoot, ['rev-list', '--count', 'HEAD', '--since=30 days ago'])).trim()) || 0;

    // Lines changed — aggregate over the last 30 days (B1 fix). Each shortstat
    // line looks like " 3 files changed, 17 insertions(+), 4 deletions(-)" with
    // either insertions OR deletions optional, so we parse them independently.
    const shortstatOut = await runGit(workspaceRoot, [
      'log', '--since=30 days ago', '--pretty=tformat:', '--shortstat'
    ]);
    let linesAdded = 0, linesDeleted = 0;
    for (const line of shortstatOut.split('\n')) {
      const ins = line.match(/(\d+)\s+insertions?\(\+\)/);
      const del = line.match(/(\d+)\s+deletions?\(-\)/);
      if (ins) { linesAdded += parseInt(ins[1]); }
      if (del) { linesDeleted += parseInt(del[1]); }
    }

    // Most active day + active-days count (used for churnRate)
    const logOutput = await runGit(workspaceRoot, ['log', '--pretty=format:%ai', '--since=30 days ago']);
    const dates = logOutput.split('\n').filter(line => line.trim()).map(line => line.split(' ')[0]);
    const dateCounts: { [key: string]: number } = {};
    dates.forEach(date => dateCounts[date] = (dateCounts[date] || 0) + 1);
    const mostActiveDay = Object.keys(dateCounts).reduce((a, b) => dateCounts[a] > dateCounts[b] ? a : b, '');

    // B2: distinct formulas.
    //   avgCommitSize = lines changed per commit (size of a typical commit)
    //   churnRate     = lines changed per day across the 30-day window
    const avgCommitSize = totalCommits > 0 ? (linesAdded + linesDeleted) / totalCommits : 0;
    const churnRate = (linesAdded + linesDeleted) / 30;

    return {
      totalCommits,
      commitsLast7Days,
      commitsLast30Days,
      linesAdded,
      linesDeleted,
      churnRate: Math.round(churnRate * 100) / 100,
      avgCommitSize: Math.round(avgCommitSize * 100) / 100,
      mostActiveDay
    };
  } catch (e) {
    console.error('Error collecting code churn metrics:', e);
    return defaultMetrics;
  }
}

export async function getProductivityInsights(workspaceRoot: string, logs: string[], todos: TodoItem[]): Promise<ProductivityInsights> {
  const defaultInsights: ProductivityInsights = {
    todoResolutionRate: 0,
    avgTimeToResolveTodo: 0,
    commitFrequency: 0,
    activeDays: 0,
    memorySize: 0,
    logsSize: 0
  };

  try {
    // Memory size
    const memoryPath = getMemoryPath(workspaceRoot);
    let memorySize = 0;
    try {
      const stats = await fsPromises.stat(memoryPath);
      memorySize = Math.round(stats.size / 1024); // KB
    } catch {}

    // Logs size - estimate from today's log
    const logPath = getTodayLogPath(workspaceRoot);
    let logsSize = 0;
    try {
      const stats = await fsPromises.stat(logPath);
      logsSize = Math.round(stats.size / 1024); // KB
    } catch {}

    // TODO resolution - simplified, assume resolved if not in current scan
    const openTodos = todos.length;
    // For resolution rate, we'd need historical data, placeholder
    const todoResolutionRate = 0; // Need better tracking

    // Commit frequency - commits per day last 30 days
    let commitFrequency = 0;
    if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
      const commits30d = (await runGit(workspaceRoot, ['rev-list', '--count', 'HEAD', '--since=30 days ago'])).trim();
      commitFrequency = Math.round((parseInt(commits30d) || 0) / 30 * 100) / 100;
    }

    // Active days - unique days with commits
    let activeDays = 0;
    if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
      const logOutput = await runGit(workspaceRoot, ['log', '--pretty=format:%ai', '--since=30 days ago']);
      const dates = logOutput.split('\n').filter(line => line.trim()).map(line => line.split(' ')[0]);
      const uniqueDates = new Set(dates);
      activeDays = uniqueDates.size;
    }

    return {
      todoResolutionRate,
      avgTimeToResolveTodo: 0, // Placeholder
      commitFrequency,
      activeDays,
      memorySize,
      logsSize
    };
  } catch (e) {
    console.error('Error collecting productivity insights:', e);
    return defaultInsights;
  }
}

export async function getProjectHealthIndicators(workspaceRoot: string, todos: TodoItem[], adapterHealth: AdapterHealth[]): Promise<ProjectHealthIndicators> {
  const defaultIndicators: ProjectHealthIndicators = {
    totalFiles: 0,
    sourceFiles: 0,
    openTodos: 0,
    uncommittedChanges: 0,
    staleChangesHours: 0,
    memoryCompleteness: 0,
    adapterCoverage: 0
  };

  try {
    // File counts - use findFiles for source files
    const sourceFiles = await vscode.workspace.findFiles('**/*.{ts,js,tsx,jsx,py,java,cpp,c,h,hpp,rs,go}', '**/node_modules/**');
    const totalFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**');

    // Open TODOs
    const openTodos = todos.length;

    // Uncommitted changes
    let uncommittedChanges = 0;
    let staleChangesHours = 0;
    if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
      const statusStr = await runGit(workspaceRoot, ['status', '--porcelain']);
      uncommittedChanges = statusStr.split('\n').filter(line => line.trim()).length;

      // Stale changes - time since last commit if uncommitted
      if (uncommittedChanges > 0) {
        const lastCommitTime = (await runGit(workspaceRoot, ['log', '-1', '--format=%ct'])).trim();
        const lastCommitSeconds = parseInt(lastCommitTime);
        if (!isNaN(lastCommitSeconds)) {
          staleChangesHours = Math.round((Date.now() / 1000 - lastCommitSeconds) / 3600);
        }
      }
    }

    // Memory completeness - check if sections exist
    const memoryPath = getMemoryPath(workspaceRoot);
    let memoryCompleteness = 0;
    try {
      const content = await fsPromises.readFile(memoryPath, 'utf8');
      const sections = ['## Follow-ups', '## Facts', '## Observations'];
      const presentSections = sections.filter(s => content.includes(s)).length;
      memoryCompleteness = Math.round((presentSections / sections.length) * 100);
    } catch {}

    // Adapter coverage
    const healthyAdapters = adapterHealth.filter(a => a.status === 'healthy').length;
    const adapterCoverage = adapterHealth.length === 0
      ? 0
      : Math.round((healthyAdapters / adapterHealth.length) * 100);

    return {
      totalFiles: totalFiles.length,
      sourceFiles: sourceFiles.length,
      openTodos,
      uncommittedChanges,
      staleChangesHours,
      memoryCompleteness,
      adapterCoverage
    };
  } catch (e) {
    console.error('Error collecting project health indicators:', e);
    return defaultIndicators;
  }
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
  
  // Collect analytics data
  const codeChurn = await getCodeChurnMetrics(workspaceRoot);
  const productivity = await getProductivityInsights(workspaceRoot, logs, todos);
  const health = await getProjectHealthIndicators(workspaceRoot, todos, adapterHealth);

  // Send data to webview
  try {
    view.webview.postMessage({ command: 'updateStatus', data: stateData });
    view.webview.postMessage({ command: 'updateTasks', data: tasks });
    view.webview.postMessage({ command: 'updateLogs', data: logs });
    view.webview.postMessage({ command: 'updateAdapterHealth', data: adapterHealth });
    view.webview.postMessage({ command: 'updateTodos', data: todos });
    view.webview.postMessage({ command: 'updateCodeChurn', data: codeChurn });
    view.webview.postMessage({ command: 'updateProductivity', data: productivity });
    view.webview.postMessage({ command: 'updateHealth', data: health });
  } catch (e) {
    console.error('Error sending message to webview:', e);
  }
}

// In-memory cache for ZippyMesh health probes to avoid hammering the router on
// every dashboard refresh (default refresh = 30 s; we cache for 60 s + jitter).
interface ZmlrHealthCacheEntry {
  url: string;
  expiresAt: number;
  result: AdapterHealth;
}
let zmlrHealthCache: ZmlrHealthCacheEntry | undefined;

/**
 * Test seam: clear the in-memory ZippyMesh health cache.
 */
export function _resetZmlrHealthCache(): void {
  zmlrHealthCache = undefined;
}

/**
 * Returns a cached ZippyMesh health probe if fresh, or runs a new probe.
 * Uses a 60 s TTL with ±5 s jitter to avoid synchronized fan-out across
 * multiple windows refreshing in lockstep.
 */
export async function getCachedZippyMeshHealth(
  zmlrUrl: string,
  now: number = Date.now(),
  probe: (url: string) => Promise<AdapterHealth> = checkZippyMeshHealth
): Promise<AdapterHealth> {
  if (
    zmlrHealthCache &&
    zmlrHealthCache.url === zmlrUrl &&
    zmlrHealthCache.expiresAt > now
  ) {
    return zmlrHealthCache.result;
  }
  const result = await probe(zmlrUrl);
  // 60 s TTL with ±5 s jitter
  const jitterMs = Math.round((Math.random() * 10000) - 5000);
  zmlrHealthCache = {
    url: zmlrUrl,
    expiresAt: now + 60000 + jitterMs,
    result
  };
  return result;
}

export async function getAdapterHealth(): Promise<AdapterHealth[]> {
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const adapters: { name: string; id: string }[] = config.get('adapters', DEFAULT_ADAPTERS);

  const extensionResults = adapters.map(adapter => {
    const extension = vscode.extensions.getExtension(adapter.id);
    return getAdapterHealthEntry(adapter.name, !!extension);
  });

  // Check ZippyMesh LLM Router (async network check, cached for 60 s)
  const zmlrUrl = config.get<string>('zippymeshUrl', 'http://localhost:20128');
  const zmlrHealth = await getCachedZippyMeshHealth(zmlrUrl);

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

  return results;
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
        case 'markTaskComplete': {
          // Mark a task as complete in the MEMORY.md file
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
            const memPath = getMemoryPath(workspaceRoot);
            try {
              const content = await fsPromises.readFile(memPath, 'utf8');
              // Replace "[ ] <taskDescription>" with "[x] <taskDescription>"
              const escaped = (message.taskDescription as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const updated = content.replace(
                new RegExp(`\\[ \\]\\s+${escaped}`, 'g'),
                `[x] ${message.taskDescription}`
              );
              if (updated !== content) {
                await fsPromises.writeFile(memPath, updated, 'utf8');
                await refreshDashboardData(webviewView);
                vscode.window.showInformationMessage(`Task marked complete: ${message.taskDescription}`);
              }
            } catch {
              vscode.window.showWarningMessage('Could not update MEMORY.md to mark task complete.');
            }
          }
          break;
        }
        case 'scanTodos': {
          // Trigger a TODO scan from the webview and refresh the dashboard
          try {
            const todos = await scanWorkspaceForTodos();
            webviewView.webview.postMessage({ command: 'updateTodos', data: todos });
            vscode.window.showInformationMessage(`Scan complete: ${todos.length} TODO/FIXME item(s) found.`);
          } catch {
            vscode.window.showWarningMessage('TODO scan failed. Check that a workspace is open.');
          }
          break;
        }
        case 'exportSnapshot': {
          // Route to the same logic as the autoclaw.exportSnapshot command so
          // the dashboard button and command palette stay in lockstep.
          try {
            await vscode.commands.executeCommand('autoclaw.exportSnapshot');
          } catch (e) {
            vscode.window.showWarningMessage(
              `Snapshot export failed: ${(e as Error).message}`
            );
          }
          break;
        }
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
            <button id="scan-todos-btn" title="Scan workspace for TODO and FIXME comments">Scan TODOs</button>
            <button id="export-snapshot-btn" title="Export a Markdown health snapshot (doctor + state + logs + follow-ups)">Export Snapshot</button>
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
            <section id="code-churn-section">
                <h2>Code Churn Metrics</h2>
                <div id="code-churn-content">Loading...</div>
            </section>
            <section id="productivity-section">
                <h2>Productivity Insights</h2>
                <div id="productivity-content">Loading...</div>
            </section>
            <section id="health-section">
                <h2>Project Health</h2>
                <div id="health-content">Loading...</div>
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

async function runExportSnapshotCommand(extensionPath: string): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage(
      'AutoClaw: open a workspace folder before exporting a snapshot.'
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const zippymeshUrl = config.get<string>('zippymeshUrl', 'http://localhost:20128');
  const isAntigravityHost = /antigravity/i.test(vscode.env.appName || '');

  const shim: DoctorVscodeShim = {
    workspaceRoot,
    isExtensionInstalled: (id: string) => !!vscode.extensions.getExtension(id),
    isAntigravityHost,
    zippymeshUrl
  };

  let snapshot: string;
  try {
    snapshot = await buildSnapshot(workspaceRoot, extensionPath, shim);
  } catch (e) {
    vscode.window.showErrorMessage(
      `AutoClaw: failed to build snapshot — ${(e as Error).message}`
    );
    return;
  }

  const today = getTodayDate();
  const defaultUri = vscode.Uri.file(
    path.join(workspaceRoot, `autoclaw-snapshot-${today}.md`)
  );
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { Markdown: ['md'] },
    saveLabel: 'Save Snapshot'
  });
  if (!target) {
    return; // user cancelled
  }

  try {
    await fsPromises.writeFile(target.fsPath, snapshot, 'utf8');
  } catch (e) {
    vscode.window.showErrorMessage(
      `AutoClaw: failed to write snapshot — ${(e as Error).message}`
    );
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Snapshot saved: ${target.fsPath}`,
    'Open'
  );
  if (action === 'Open') {
    await vscode.window.showTextDocument(target);
  }
}

async function runDoctorCommand(extensionPath: string): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const zippymeshUrl = config.get<string>('zippymeshUrl', 'http://localhost:20128');
  const isAntigravityHost = /antigravity/i.test(vscode.env.appName || '');

  const report: DoctorReport = await runDoctor(extensionPath, {
    workspaceRoot,
    isExtensionInstalled: (id: string) => !!vscode.extensions.getExtension(id),
    isAntigravityHost,
    zippymeshUrl
  });

  if (!doctorOutputChannel) {
    doctorOutputChannel = vscode.window.createOutputChannel('AutoClaw Doctor');
  }
  doctorOutputChannel.clear();
  doctorOutputChannel.appendLine(renderReport(report));
  doctorOutputChannel.show(true);
}

function getAutobuildOutputChannel(): vscode.OutputChannel {
  if (!autobuildOutputChannel) {
    autobuildOutputChannel = vscode.window.createOutputChannel('AutoClaw AutoBuild');
  }
  return autobuildOutputChannel;
}

function startAutobuildScheduler(context: vscode.ExtensionContext): void {
  if (autobuildIntervalId) {
    clearInterval(autobuildIntervalId);
    autobuildIntervalId = undefined;
  }
  const config = vscode.workspace.getConfiguration('autoclaw.autobuild');
  const enabled = config.get<boolean>('enabled', true);
  if (!enabled) {
    return;
  }
  const intervalSeconds = Math.max(10, config.get<number>('tickIntervalSeconds', 30));

  const runTick = async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      // Quietly no-op when no workspace is open.
      return;
    }
    try {
      const cfg = vscode.workspace.getConfiguration('autoclaw.autobuild');
      const report = await autobuildTick(workspaceRoot, new Date(), {
        enabled: cfg.get<boolean>('enabled', true),
        runner: runWorkflow
      });
      if (report.ranNow.length > 0) {
        getAutobuildOutputChannel().appendLine(
          `[${new Date().toISOString()}] tick fired: ${report.ranNow.join(', ')}`
        );
      }
      for (const err of report.errors) {
        getAutobuildOutputChannel().appendLine(
          `[${new Date().toISOString()}] error in workflow ${err.name}: ${err.message}`
        );
      }
    } catch (e) {
      console.error('autobuild tick failed:', e);
    }
  };

  autobuildIntervalId = setInterval(runTick, intervalSeconds * 1000);
  // Kick off an immediate tick so a freshly-activated extension picks up
  // due workflows without waiting a full interval.
  runTick().catch(() => { /* logged inside */ });

  context.subscriptions.push({
    dispose: () => {
      if (autobuildIntervalId) {
        clearInterval(autobuildIntervalId);
        autobuildIntervalId = undefined;
      }
    }
  });
}

async function autobuildRunNowCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('AutoBuild: open a workspace first.');
    return;
  }
  const discovered = discoverWorkflows(workspaceRoot);
  if (discovered.length === 0) {
    vscode.window.showInformationMessage(
      'AutoBuild: no workflows found in .autoclaw/autobuild/workflows/.'
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    discovered.map(d => ({
      label: d.workflow.name,
      description: d.workflow.cron,
      detail: d.filePath,
      filePath: d.filePath
    })),
    { placeHolder: 'Select an AutoBuild workflow to run now' }
  );
  if (!pick) { return; }
  const channel = getAutobuildOutputChannel();
  channel.show(true);
  channel.appendLine(`[runNow] starting ${pick.label}`);
  try {
    const result = await runWorkflow(pick.filePath, getRunsDir(workspaceRoot));
    channel.appendLine(`[runNow] ${result.workflow}: ${result.status} (log: ${result.logPath})`);
    if (shouldShowNotification('info')) {
      vscode.window.showInformationMessage(`AutoBuild ${result.workflow}: ${result.status}`);
    }
  } catch (e) {
    channel.appendLine(`[runNow] error: ${(e as Error).message}`);
    vscode.window.showErrorMessage(`AutoBuild run failed: ${(e as Error).message}`);
  }
}

async function autobuildTailCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('AutoBuild: open a workspace first.');
    return;
  }
  const discovered = discoverWorkflows(workspaceRoot);
  if (discovered.length === 0) {
    vscode.window.showInformationMessage('AutoBuild: no workflows found.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    discovered.map(d => ({ label: d.workflow.name, description: d.workflow.cron })),
    { placeHolder: 'Select a workflow to tail the most recent run log' }
  );
  if (!pick) { return; }
  const logPath = findLatestRunLog(workspaceRoot, pick.label);
  if (!logPath) {
    vscode.window.showInformationMessage(`AutoBuild: no run logs yet for ${pick.label}.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc);
}

export function deactivate() {
  if (stateWatcher) {
    stateWatcher.dispose();
  }
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = undefined;
  }
  if (autobuildIntervalId) {
    clearInterval(autobuildIntervalId);
    autobuildIntervalId = undefined;
  }
  if (doctorOutputChannel) {
    doctorOutputChannel.dispose();
    doctorOutputChannel = undefined;
  }
  if (autobuildOutputChannel) {
    autobuildOutputChannel.dispose();
    autobuildOutputChannel = undefined;
  }
}
