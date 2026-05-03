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
import { runDoctor, renderReport, renderReportJson } from './doctor';
import type { DoctorReport, DoctorVscodeShim } from './doctor';
import { buildSnapshot } from './snapshot';
import {
  tick as autobuildTick,
  discoverWorkflows,
  runWorkflow,
  getRunsDir,
  findLatestRunLog
} from './autobuild';
import {
  generatePlan,
  DEFAULT_PLANNER_CONFIG,
  writeYAMLFile,
  writeStateFile,
  readStateFile,
  toYAML,
  writeAgentRegistry,
  evaluateConsensus,
  DEFAULT_CONSENSUS_CONFIG,
} from './orchestrate';
import type { Manifest, PlannerConfig, PlanResult, ValidationVote, AgentRegistryEntry } from './orchestrate';
import { registerChatParticipant } from './chatparticipant';
import {
  readCommsLog, getAgentStatuses, readRegistry, writeHeartbeat,
  cleanupOldMessages, type CommsLogEntry,
} from './comms';
import { readSnapshots, type Snapshot } from './timetravel';
import {
  startBridge, stopBridge, createRemoteAgentToken,
  type BridgeState, type BridgeConfig,
} from './bridge';

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

  // Skill launcher — quick pick that copies a skill prompt to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.launchSkill', async () => {
      const appName = vscode.env.appName || '';
      const isKiro = /kiro/i.test(appName);
      const isClaudeCode = !!vscode.extensions.getExtension('Anthropic.claude-code');

      // Route to the correct skill file based on the active IDE/extension host.
      // Kiro: .kiro/steering/  |  everything else: .clinerules/ (installed by KiloCode + Cline adapters)
      const sp = (skill: string) => isKiro ? `.kiro/steering/${skill}.md` : `.clinerules/${skill}.md`;

      const skills = [
        { label: '🌙 KDream — Start', detail: 'Start the persistent background agent', prompt: `Follow the instructions in ${sp('kdream')} — run kdream start` },
        { label: '🌙 KDream — Status', detail: 'Check background agent status', prompt: `Follow the instructions in ${sp('kdream')} — run kdream ps` },
        { label: '🌙 KDream — Add Task', detail: 'Add a follow-up task', prompt: `Follow the instructions in ${sp('kdream')} — run kdream add "` },
        { label: '🔨 AutoBuild — Schedule', detail: 'Schedule a build workflow', prompt: `Follow the instructions in ${sp('autobuild')} — run autobuild schedule` },
        { label: '🔨 AutoBuild — Run', detail: 'Run a workflow now', prompt: `Follow the instructions in ${sp('autobuild')} — run autobuild run` },
        { label: '👥 MAteam — Launch', detail: 'Spawn a multi-agent team', prompt: `Follow the instructions in ${sp('mateam')} — run mateam launch "` },
        { label: '🎯 Orchestrate — Init', detail: 'Initialize orchestrator', prompt: `Follow the instructions in ${sp('orchestrate')} — run orchestrate init` },
        { label: '🎯 Orchestrate — Plan', detail: 'Generate sprint plans', prompt: `Follow the instructions in ${sp('orchestrate')} — run orchestrate plan` },
        { label: '🎯 Orchestrate — Status', detail: 'Show sprint progress', prompt: `Follow the instructions in ${sp('orchestrate')} — run orchestrate status` },
        { label: '🎯 Orchestrate — Assign', detail: 'Assign next sprint', prompt: `Follow the instructions in ${sp('orchestrate')} — run orchestrate next` },
        { label: '📬 Check Inbox', detail: 'Check cross-agent messages', prompt: `Read ${sp('cross-agent')} for the protocol. Check your inbox at .autoclaw/orchestrator/comms/inboxes/ for new messages and process them.` },
      ];

      const pick = await vscode.window.showQuickPick(skills, {
        placeHolder: 'Select an AutoClaw skill to launch (copies prompt to clipboard)',
        matchOnDetail: true,
      });

      if (pick) {
        await vscode.env.clipboard.writeText(pick.prompt);
        const hint = isClaudeCode
          ? `Copied "${pick.label}" prompt. Claude Code users can also type the skill command directly in chat.`
          : `Copied "${pick.label}" prompt to clipboard. Paste into any AI chat.`;
        vscode.window.showInformationMessage(hint, 'Open Chat').then(action => {
          if (action === 'Open Chat') {
            vscode.commands.executeCommand('workbench.action.chat.open');
          }
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.doctor', async () => {
      await runDoctorCommand(context.extensionPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.doctorJson', async () => {
      await runDoctorCommand(context.extensionPath, 'json');
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

  // Orchestrate commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.plan', async () => {
      await orchestratePlanCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.status', async () => {
      await orchestrateStatusCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.assign', async () => {
      await orchestrateAssignNextCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.review', async () => {
      await orchestrateReviewCommand();
    })
  );

  // Bridge commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.bridge.start', async () => {
      await bridgeStartCommand();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.bridge.stop', async () => {
      await bridgeStopCommand();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.bridge.addAgent', async () => {
      await bridgeAddAgentCommand();
    })
  );

  // Orchestrator Dashboard commands — redirect to unified panel
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showDashboard', async () => {
      await vscode.commands.executeCommand('kdreamDashboard.focus');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.refreshDashboard', async () => {
      if (kdreamView) { await refreshOrchestratorData(kdreamView); }
    })
  );

  // Auto-start bridge if enabled
  const bridgeConfig = vscode.workspace.getConfiguration('autoclaw.bridge');
  if (bridgeConfig.get<boolean>('enabled', false)) {
    bridgeStartCommand().catch(e => console.error('bridge auto-start failed:', e));
  }

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

  // Auto-provision cross-agent comms infrastructure
  provisionCrossAgentComms().catch(e =>
    console.error('cross-agent comms provisioning failed:', e)
  );

  // Start heartbeat ticker — writes real heartbeats for detected agents
  startHeartbeatTicker(context);

  // Watch shared inbox for task_complete messages — notify and auto-refresh
  startInboxWatcher(context);

  // Register @autoclaw chat participant (VS Code 1.90+; degrades on older builds / other IDEs)
  registerChatParticipant(
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );

  // First-run welcome with IDE-specific guidance
  showWelcomeIfNeeded(context);
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

  // KiloCode — workspace .kilocodemodes + .clinerules/
  if (vscode.extensions.getExtension('kilocode.kilo-code')) {
    const src = path.join(adaptersDir, 'kilocode', 'autoclaw-modes.yaml');
    const dest = path.join(workspaceRoot, '.kilocodemodes');
    mergeKiloModes(src, dest);
    // Also copy Cline-format rules to .clinerules/ since KiloCode reads them
    // as system instructions (works in all IDEs including Kiro where custom modes may not load)
    const clinerulesDest = path.join(workspaceRoot, '.clinerules');
    copyDir(path.join(adaptersDir, 'cline'), clinerulesDest);
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
    // Memory size — ENOENT is normal (file not yet created).
    const memoryPath = getMemoryPath(workspaceRoot);
    let memorySize = 0;
    try {
      const stats = await fsPromises.stat(memoryPath);
      memorySize = Math.round(stats.size / 1024); // KB
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`AutoClaw: stat failed for ${memoryPath}:`, (e as Error).message);
      }
    }

    // Logs size - estimate from today's log
    const logPath = getTodayLogPath(workspaceRoot);
    let logsSize = 0;
    try {
      const stats = await fsPromises.stat(logPath);
      logsSize = Math.round(stats.size / 1024); // KB
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`AutoClaw: stat failed for ${logPath}:`, (e as Error).message);
      }
    }

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

    // Memory completeness - check if sections exist (ENOENT = no MEMORY.md yet).
    const memoryPath = getMemoryPath(workspaceRoot);
    let memoryCompleteness = 0;
    try {
      const content = await fsPromises.readFile(memoryPath, 'utf8');
      const sections = ['## Follow-ups', '## Facts', '## Observations'];
      const presentSections = sections.filter(s => content.includes(s)).length;
      memoryCompleteness = Math.round((presentSections / sections.length) * 100);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`AutoClaw: read failed for ${memoryPath}:`, (e as Error).message);
      }
    }

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
  const adapters: { name: string; id: string | null }[] =
    config.get('adapters', DEFAULT_ADAPTERS);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const isAntigravityHost = /antigravity/i.test(vscode.env.appName || '');

  const extensionResults = adapters.map(adapter => {
    if (adapter.id) {
      const extension = vscode.extensions.getExtension(adapter.id);
      return getAdapterHealthEntry(adapter.name, !!extension);
    }
    // Standalone host adapters — detected via filesystem markers / appName.
    if (adapter.name === 'Cursor') {
      const detected = !!workspaceRoot && hasCursorConfig(workspaceRoot);
      return getAdapterHealthEntry(adapter.name, detected);
    }
    if (adapter.name === 'Antigravity') {
      const detected = isAntigravityHost ||
        (!!workspaceRoot && fs.existsSync(path.join(workspaceRoot, '.agent')));
      return getAdapterHealthEntry(adapter.name, detected);
    }
    // Unknown standalone adapter — report as not detected rather than crashing.
    return getAdapterHealthEntry(adapter.name, false);
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
        const files = await vscode.workspace.findFiles(pattern, '{**/node_modules/**,**/.vscode-test/**,**/out/**,**/dist/**,**/.autoclaw/**,**/*.min.js,**/*.bundle.js}');
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
          await refreshOrchestratorData(webviewView);
          break;
        case 'getInitialData':
          await refreshDashboardData(webviewView);
          await refreshOrchestratorData(webviewView);
          break;
        case 'launchSkill':
          await vscode.commands.executeCommand('autoclaw.launchSkill');
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
    refreshOrchestratorData(webviewView);
    
    // Set up periodic refresh interval as fallback for file watcher
    const config = vscode.workspace.getConfiguration('autoclaw.kdream');
    const refreshIntervalSeconds = config.get<number>('refreshInterval', 30);
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(async () => {
      if (kdreamView) {
        await refreshDashboardData(kdreamView);
        await refreshOrchestratorData(kdreamView);
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
    <title>AutoClaw</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div id="panel-root" role="main">
        <!-- Quick Actions bar — always visible -->
        <div class="quick-actions" role="toolbar" aria-label="Quick actions">
            <button id="btn-launch-skill" class="primary" type="button" aria-label="Launch Skill">&#9889; Launch Skill</button>
            <button id="btn-refresh" type="button" aria-label="Refresh">&#8635; Refresh</button>
            <button id="btn-export" type="button" aria-label="Export Snapshot">&#128230; Export</button>
        </div>

        <!-- Agents section -->
        <div class="panel-section open" id="agents-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="true" aria-controls="agents-body">
                <span class="section-chevron"></span>
                Agents
                <span class="section-badge" id="agents-badge">0</span>
            </div>
            <div class="section-body" id="agents-body">
                <div id="agents-content"><p class="empty">Loading...</p></div>
                <div id="status-content"></div>
            </div>
        </div>

        <!-- Sprints section -->
        <div class="panel-section" id="sprints-section" style="display:none">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="sprints-body">
                <span class="section-chevron"></span>
                Sprints
                <span class="section-badge" id="sprints-badge"></span>
            </div>
            <div class="section-body" id="sprints-body">
                <div id="sprints-content"><p class="empty">Loading...</p></div>
            </div>
        </div>

        <!-- Messages section -->
        <div class="panel-section" id="messages-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="messages-body">
                <span class="section-chevron"></span>
                Messages
                <span class="section-badge" id="messages-badge">0</span>
            </div>
            <div class="section-body" id="messages-body">
                <div id="messages-content"><p class="empty">Loading...</p></div>
            </div>
        </div>

        <!-- Tasks section -->
        <div class="panel-section" id="tasks-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="tasks-body">
                <span class="section-chevron"></span>
                Tasks
                <span class="section-badge" id="tasks-badge">0</span>
            </div>
            <div class="section-body" id="tasks-body">
                <div id="tasks-content"><p class="empty">Loading...</p></div>
                <div id="todos-content"></div>
            </div>
        </div>

        <!-- Activity section -->
        <div class="panel-section" id="activity-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="activity-body">
                <span class="section-chevron"></span>
                Activity
            </div>
            <div class="section-body" id="activity-body">
                <div id="logs-content"><p class="empty">Loading...</p></div>
                <div id="timeline-content"></div>
            </div>
        </div>

        <!-- Health section -->
        <div class="panel-section" id="health-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="health-body">
                <span class="section-chevron"></span>
                Health
            </div>
            <div class="section-body" id="health-body">
                <div id="adapter-health-content"><p class="empty">Loading...</p></div>
                <div id="code-churn-content"></div>
                <div id="productivity-content"></div>
                <div id="health-content"></div>
            </div>
        </div>
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

async function runDoctorCommand(
  extensionPath: string,
  format: 'text' | 'json' = 'text'
): Promise<void> {
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
  doctorOutputChannel.appendLine(
    format === 'json' ? renderReportJson(report) : renderReport(report)
  );
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

// ---------------------------------------------------------------------------
// Welcome / Onboarding
// ---------------------------------------------------------------------------

async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const WELCOME_KEY = 'autoclaw.welcomeShown.2.0.0';
  if (context.globalState.get<boolean>(WELCOME_KEY)) { return; }

  const ide = vscode.env.appName || 'VS Code';
  const isKiro = /kiro/i.test(ide);
  const isCursor = /cursor/i.test(ide);

  let tip: string;
  if (isKiro) {
    tip = 'In Kiro chat: use # to attach steering files (kdream, orchestrate, etc.). In Kilo Code: type skill names naturally (e.g. "kdream start").';
  } else if (isCursor) {
    tip = 'Skills are loaded from .cursor/rules/. Type skill commands in chat (e.g. "kdream start", "orchestrate plan").';
  } else {
    tip = 'Use /kdream, /autobuild, /mateam, /orchestrate in VS Code chat. Or run "AutoClaw: Launch Skill" from the command palette.';
  }

  const action = await vscode.window.showInformationMessage(
    `AutoClaw v2.0.0 ready (${ide}). ${tip}`,
    'Launch Skill',
    'Dismiss'
  );

  if (action === 'Launch Skill') {
    await vscode.commands.executeCommand('autoclaw.launchSkill');
  }

  await context.globalState.update(WELCOME_KEY, true);
}

// ---------------------------------------------------------------------------
// Cross-Agent Comms Auto-Provisioning
// ---------------------------------------------------------------------------

interface DetectedAgent {
  id: string;
  name: string;
  extensionId: string | null;
  detected: boolean;
  rulesFormat: string;
  rulesDir: string;
  hooksSupported: boolean;
}

const AGENT_DEFINITIONS: Omit<DetectedAgent, 'detected'>[] = [
  { id: 'kiro', name: 'Kiro', extensionId: 'amazon.kiro', rulesFormat: 'kiro-steering', rulesDir: '.kiro/steering', hooksSupported: true },
  { id: 'kilocode', name: 'Kilo Code', extensionId: 'kilocode.kilo-code', rulesFormat: 'clinerules', rulesDir: '.clinerules', hooksSupported: false },
  { id: 'cline', name: 'Cline', extensionId: 'saoudrizwan.claude-dev', rulesFormat: 'clinerules', rulesDir: '.clinerules', hooksSupported: false },
  { id: 'claude-code', name: 'Claude Code', extensionId: 'Anthropic.claude-code', rulesFormat: 'claude-rules', rulesDir: '.claude/rules', hooksSupported: false },
  { id: 'continue', name: 'Continue', extensionId: 'Continue.continue', rulesFormat: 'continue-prompts', rulesDir: '.continue/prompts', hooksSupported: false },
  { id: 'codex', name: 'Codex', extensionId: 'openai.codex', rulesFormat: 'codex-instructions', rulesDir: '.codex', hooksSupported: false },
  { id: 'cursor', name: 'Cursor', extensionId: null, rulesFormat: 'cursor-rules', rulesDir: '.cursor/rules', hooksSupported: false },
  { id: 'windsurf', name: 'Windsurf', extensionId: 'codeium.windsurf', rulesFormat: 'windsurf-rules', rulesDir: '.windsurf/rules', hooksSupported: false },
  { id: 'antigravity', name: 'Antigravity', extensionId: null, rulesFormat: 'antigravity-rules', rulesDir: '.agent/rules', hooksSupported: false },
];

function detectAgents(workspaceRoot: string): DetectedAgent[] {
  const isAntigravityHost = /antigravity/i.test(vscode.env.appName || '');
  const isKiroHost = /kiro/i.test(vscode.env.appName || '');
  const isCursorHost = /cursor/i.test(vscode.env.appName || '');
  const isWindsurfHost = /windsurf/i.test(vscode.env.appName || '');

  return AGENT_DEFINITIONS.map(def => {
    let detected = false;
    if (def.extensionId) {
      detected = !!vscode.extensions.getExtension(def.extensionId);
    }
    // Host IDE is always detected as an agent even without its own extension ID
    if (def.id === 'kiro' && isKiroHost) { detected = true; }
    if (def.id === 'cursor' && (isCursorHost || hasCursorConfig(workspaceRoot))) { detected = true; }
    if (def.id === 'windsurf' && isWindsurfHost) { detected = true; }
    if (def.id === 'antigravity' && (isAntigravityHost || fs.existsSync(path.join(workspaceRoot, '.agent')))) { detected = true; }
    return { ...def, detected };
  });
}

function generateCrossAgentRules(agentId: string, agentName: string, allAgents: DetectedAgent[]): string {
  const otherAgents = allAgents.filter(a => a.detected && a.id !== agentId);
  const otherNames = otherAgents.map(a => a.name).join(', ');
  const inboxLines = otherAgents
    .map(a => `- To ${a.name}: \`.autoclaw/orchestrator/comms/inboxes/${a.id}/\``)
    .join('\n');

  return `# Cross-Agent Coordination Protocol — ${agentName}

## Multi-Agent Team

You (${agentName}) are part of a multi-agent team. Other active agents: ${otherNames || 'none detected'}.
All agents coordinate through the AutoClaw Orchestrator.

## Your Mailbox

Check at the START of every task and AFTER completing work:
- **Inbox**: \`.autoclaw/orchestrator/comms/inboxes/${agentId}/\`
- **Shared**: \`.autoclaw/orchestrator/comms/inboxes/shared/\`

Message types: review_request, review_response, consensus_vote, task_claim,
task_complete, finding_report, question, answer.

## Send Messages

Write JSON to target inbox. Filename: \`{timestamp}-{type}-${agentId}.json\`
${inboxLines}
- Broadcast: \`.autoclaw/orchestrator/comms/inboxes/shared/\`

## On Task Completion

1. Broadcast task_complete to shared/
2. Write review_request to other agents' inboxes
3. Check YOUR inbox for pending reviews

## Consensus

Tasks require 2/3 majority approval. Security findings require unanimous.
Write votes to \`consensus/active/{task_id}-${agentId}.json\`.

## Scope

Check \`.autoclaw/orchestrator/sprints/plan-summary.yaml\` for assignments.
Stay in your assigned scope. Coordinate via messages for cross-scope changes.
`;
}

// ---------------------------------------------------------------------------
// Heartbeat Ticker — writes real heartbeats for detected agents based on
// actual VS Code signals (extension installed + active, visible editors,
// recent file saves, running tasks).
// ---------------------------------------------------------------------------

let heartbeatIntervalId: NodeJS.Timeout | undefined;
/** Tracks the last file-save timestamp per workspace folder. */
let lastFileSaveTimestamp: number = 0;

function startHeartbeatTicker(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  // Track file saves as a proxy for "an agent is actively editing"
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => {
    lastFileSaveTimestamp = Date.now();
  });
  context.subscriptions.push(saveWatcher);

  // Write heartbeats immediately, then every 30s
  writeAgentHeartbeats(workspaceRoot, commsDir).catch(() => {});

  heartbeatIntervalId = setInterval(() => {
    writeAgentHeartbeats(workspaceRoot, commsDir).catch(() => {});
  }, 30_000);

  context.subscriptions.push({
    dispose: () => {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = undefined;
      }
    }
  });
}

async function writeAgentHeartbeats(workspaceRoot: string, commsDir: string): Promise<void> {
  const agents = detectAgents(workspaceRoot);
  const detectedAgents = agents.filter(a => a.detected);
  const now = new Date().toISOString();
  const nowMs = Date.now();

  // A file save within the last 2 minutes means something is actively editing
  const recentSave = (nowMs - lastFileSaveTimestamp) < 2 * 60 * 1000;

  // Check if there are visible text editors (someone is working)
  const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0;

  // Check active editor for a hint about what's being worked on
  const activeFile = vscode.window.activeTextEditor?.document.fileName;
  const currentTask = activeFile
    ? path.relative(workspaceRoot, activeFile).replace(/\\/g, '/')
    : null;

  for (const agent of detectedAgents) {
    // Determine agent status from real signals
    let status: 'active' | 'idle' = 'idle';

    if (agent.extensionId) {
      const ext = vscode.extensions.getExtension(agent.extensionId);
      if (ext?.isActive) {
        // Extension is loaded and activated
        status = recentSave || hasVisibleEditors ? 'active' : 'idle';
      }
    } else {
      // Agents without extension IDs (Cursor, Antigravity) — detected by host
      status = recentSave || hasVisibleEditors ? 'active' : 'idle';
    }

    const hb: import('./comms').Heartbeat = {
      agent_id: agent.id,
      timestamp: now,
      status,
      current_task: status === 'active' ? currentTask : null,
      sprint: null,
    };

    // Try to read sprint assignment from plan-summary
    try {
      const planPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints', 'plan-summary.yaml');
      if (fs.existsSync(planPath)) {
        const planContent = await fsPromises.readFile(planPath, 'utf8');
        // Look for in_progress or assigned sprints
        const inProgress = planContent.match(/- number: (\d+)[\s\S]*?status: in_progress/);
        const assigned = planContent.match(/- number: (\d+)[\s\S]*?status: assigned/);
        if (inProgress) {
          hb.sprint = parseInt(inProgress[1]);
        } else if (assigned) {
          hb.sprint = parseInt(assigned[1]);
        }
      }
    } catch { /* no plan, that's fine */ }

    await writeHeartbeat(commsDir, hb);
  }
}

async function provisionCrossAgentComms(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const registryPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'registry.json');
  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  const agents = detectAgents(workspaceRoot);
  const detectedAgents = agents.filter(a => a.detected);

  if (detectedAgents.length < 2) { return; }

  // Skip if already provisioned with same agent set
  try {
    const existing = JSON.parse(await fsPromises.readFile(registryPath, 'utf8'));
    const existingIds = new Set((existing.agents || []).map((a: { id: string }) => a.id));
    const currentIds = new Set(detectedAgents.map(a => a.id));
    if (existingIds.size === currentIds.size && [...currentIds].every(id => existingIds.has(id))) {
      return;
    }
  } catch { /* proceed */ }

  // Create directories
  const dirs = [
    path.join(commsDir, 'inboxes', 'shared'),
    path.join(commsDir, 'consensus', 'active'),
    path.join(commsDir, 'consensus', 'resolved'),
    path.join(commsDir, 'reviews', 'pending'),
    path.join(commsDir, 'reviews', 'completed'),
    path.join(commsDir, 'heartbeats'),
    ...detectedAgents.map(a => path.join(commsDir, 'inboxes', a.id)),
  ];
  for (const dir of dirs) {
    await fsPromises.mkdir(dir, { recursive: true });
  }

  // Write cross-agent rules for each agent
  for (const agent of detectedAgents) {
    const rulesContent = generateCrossAgentRules(agent.id, agent.name, agents);
    const rulesDir = path.join(workspaceRoot, agent.rulesDir);
    await fsPromises.mkdir(rulesDir, { recursive: true });

    const isKiro = agent.rulesFormat === 'kiro-steering';
    const isCodex = agent.rulesFormat === 'codex-instructions';
    const filename = isCodex ? 'instructions.md' : isKiro ? 'cross-agent.md' : 'cross-agent-protocol.md';
    const content = isKiro ? '---\ninclusion: auto\n---\n\n' + rulesContent : rulesContent;
    const rulesPath = path.join(rulesDir, filename);

    if (!fs.existsSync(rulesPath)) {
      await fsPromises.writeFile(rulesPath, content, 'utf8');
    }
  }

  // Write registry
  const registry = {
    agents: detectedAgents.map(a => ({
      id: a.id, name: a.name, extension_id: a.extensionId, detected: true,
      rules_path: path.join(a.rulesDir, a.rulesFormat === 'codex-instructions' ? 'instructions.md' : a.rulesFormat === 'kiro-steering' ? 'cross-agent.md' : 'cross-agent-protocol.md'),
      inbox_path: `.autoclaw/orchestrator/comms/inboxes/${a.id}/`,
      hooks_supported: a.hooksSupported, last_heartbeat: null, status: 'detected',
    })),
    ide: vscode.env.appName || 'unknown',
    provisioned_at: new Date().toISOString(),
  };
  await fsPromises.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');

  // Initialize comms log
  const logPath = path.join(commsDir, 'comms-log.jsonl');
  if (!fs.existsSync(logPath)) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(), type: 'system', from: 'autoclaw',
      message: `Comms provisioned. Agents: ${detectedAgents.map(a => a.name).join(', ')}`,
    }) + '\n';
    await fsPromises.writeFile(logPath, entry, 'utf8');
  }

  console.log(`AutoClaw: cross-agent comms provisioned for ${detectedAgents.length} agents`);
}

// ---------------------------------------------------------------------------
// Orchestrate Commands
// ---------------------------------------------------------------------------

let orchestrateOutputChannel: vscode.OutputChannel | undefined;

function getOrchestrateOutputChannel(): vscode.OutputChannel {
  if (!orchestrateOutputChannel) {
    orchestrateOutputChannel = vscode.window.createOutputChannel('AutoClaw Orchestrate');
  }
  return orchestrateOutputChannel;
}

async function orchestratePlanCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Orchestrate: open a workspace first.');
    return;
  }

  const manifestDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'manifests');
  if (!fs.existsSync(manifestDir)) {
    vscode.window.showErrorMessage(
      'Orchestrate: no manifests/ directory found. Run /orchestrate init first.'
    );
    return;
  }

  // Find manifest files
  const manifestFiles = fs.readdirSync(manifestDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  if (manifestFiles.length === 0) {
    vscode.window.showErrorMessage('Orchestrate: no manifest YAML files found in manifests/.');
    return;
  }

  let manifestFile = manifestFiles[0];
  if (manifestFiles.length > 1) {
    const pick = await vscode.window.showQuickPick(
      manifestFiles.map(f => ({ label: f })),
      { placeHolder: 'Select a task manifest' }
    );
    if (!pick) { return; }
    manifestFile = pick.label;
  }

  const channel = getOrchestrateOutputChannel();
  channel.show(true);
  channel.appendLine(`[orchestrate] Planning from manifest: ${manifestFile}`);

  // Read config for planner settings
  const config = vscode.workspace.getConfiguration('autoclaw.orchestrate');
  const plannerConfig: PlannerConfig = {
    work_agents: config.get<number>('workAgents', DEFAULT_PLANNER_CONFIG.work_agents),
    max_tasks_per_agent: config.get<number>('maxTasksPerAgent', DEFAULT_PLANNER_CONFIG.max_tasks_per_agent),
    max_subtasks_per_sprint: config.get<number>('maxSubtasksPerSprint', DEFAULT_PLANNER_CONFIG.max_subtasks_per_sprint),
    migration_range_size: config.get<number>('migrationRangeSize', DEFAULT_PLANNER_CONFIG.migration_range_size),
    branch_prefix: config.get<string>('branchPrefix', DEFAULT_PLANNER_CONFIG.branch_prefix),
  };

  // Note: actual YAML parsing of the manifest is done by the skill prompt
  // (the AI reads the YAML and constructs the Manifest object).
  // The extension command provides the infrastructure; the skill provides the intelligence.
  channel.appendLine(`[orchestrate] Config: ${plannerConfig.work_agents} agents, max ${plannerConfig.max_tasks_per_agent} tasks/agent`);
  channel.appendLine(`[orchestrate] Manifest path: ${path.join(manifestDir, manifestFile)}`);
  channel.appendLine(`[orchestrate] Use /orchestrate plan in chat to generate sprint plans from this manifest.`);

  if (shouldShowNotification('info')) {
    vscode.window.showInformationMessage(
      `Orchestrate: manifest "${manifestFile}" ready. Use /orchestrate plan in chat to generate sprints.`
    );
  }
}

async function orchestrateStatusCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Orchestrate: open a workspace first.');
    return;
  }

  const statePath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json');
  const state = await readStateFile(statePath);

  const channel = getOrchestrateOutputChannel();
  channel.show(true);

  if (!state) {
    channel.appendLine('[orchestrate] No orchestration state found. Run /orchestrate plan first.');
    return;
  }

  channel.appendLine(`[orchestrate] Project: ${state.project}`);
  channel.appendLine(`[orchestrate] Progress: ${state.tasks_complete}/${state.tasks_total} tasks`);
  channel.appendLine(`[orchestrate] Current sprint: ${state.current_sprint ?? 'none'}`);
  channel.appendLine(`[orchestrate] Total sprints: ${state.total_sprints}`);
  for (const [agentId, agentState] of Object.entries(state.agents)) {
    channel.appendLine(`[orchestrate]   ${agentId}: ${agentState.status} (sprint ${agentState.sprint ?? '-'}, tasks: ${agentState.tasks.join(', ') || 'none'})`);
  }
}

async function orchestrateAssignNextCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Orchestrate: open a workspace first.');
    return;
  }

  const channel = getOrchestrateOutputChannel();
  channel.show(true);

  // Detect active agents and write registry so comms can route by WA-N → platform
  const detected = detectAgents(workspaceRoot);
  if (detected.length > 0) {
    const registryPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'agents.json');
    const state = await readStateFile(path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json'));
    const sprint = state?.current_sprint ?? null;

    const entries: AgentRegistryEntry[] = detected.map((a, i) => ({
      id: `WA-${i + 1}`,
      platform: a.id,
      inbox: `.autoclaw/orchestrator/comms/inboxes/${a.id}/`,
      sprint,
      assigned_at: new Date().toISOString(),
    }));

    await writeAgentRegistry(registryPath, entries);
    channel.appendLine(`[orchestrate] Agent registry written (${entries.length} agents): ${entries.map(e => `${e.id}=${e.platform}`).join(', ')}`);
  }

  channel.appendLine('[orchestrate] Use /orchestrate next in chat to assign the next available sprint.');

  if (shouldShowNotification('info')) {
    vscode.window.showInformationMessage(
      'Orchestrate: use /orchestrate next in chat to assign the next sprint.'
    );
  }
}

async function orchestrateReviewCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Orchestrate: open a workspace first.');
    return;
  }

  const channel = getOrchestrateOutputChannel();
  channel.show(true);
  channel.appendLine('[orchestrate] Running consensus review...');

  const consensusDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active');
  if (!fs.existsSync(consensusDir)) {
    channel.appendLine('[orchestrate] No consensus votes found. Agents have not yet submitted votes.');
    vscode.window.showInformationMessage('Orchestrate: no consensus votes found yet. Wait for agents to complete their work.');
    return;
  }

  // Load all vote files, group by task_id
  const voteFiles = fs.readdirSync(consensusDir).filter(f => f.endsWith('.json'));
  if (voteFiles.length === 0) {
    channel.appendLine('[orchestrate] No vote files in consensus/active/.');
    return;
  }

  const votesByTask = new Map<string, ValidationVote[]>();
  for (const f of voteFiles) {
    try {
      const raw = await fsPromises.readFile(path.join(consensusDir, f), 'utf8');
      const vote = JSON.parse(raw) as ValidationVote;
      const taskId = f.split('-')[0] ?? 'unknown';
      if (!votesByTask.has(taskId)) { votesByTask.set(taskId, []); }
      votesByTask.get(taskId)!.push(vote);
    } catch {
      channel.appendLine(`[orchestrate] Warning: could not parse vote file ${f}`);
    }
  }

  let allApproved = true;
  for (const [taskId, votes] of votesByTask) {
    const result = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG);
    const icon = result.status === 'consensus_reached' ? '✅' : result.status === 'deadlocked' ? '🔴' : '⏳';
    channel.appendLine(`${icon} Task ${taskId}: ${result.status} — verdict: ${result.final_verdict} (${votes.length} vote${votes.length === 1 ? '' : 's'})`);

    if (result.unresolved_findings.length > 0) {
      for (const f of result.unresolved_findings.slice(0, 5)) {
        channel.appendLine(`   [${f.severity}] ${f.category}: ${f.description}${f.file ? ` (${f.file}:${f.line ?? ''})` : ''}`);
      }
    }

    if (result.status !== 'consensus_reached') { allApproved = false; }
  }

  if (allApproved && votesByTask.size > 0) {
    channel.appendLine('[orchestrate] All tasks approved. Run /orchestrate merge to integrate the sprint branch.');
    vscode.window.showInformationMessage(
      `Orchestrate: consensus reached on ${votesByTask.size} task(s). Ready to merge.`,
      'Assign Next Sprint'
    ).then(action => {
      if (action === 'Assign Next Sprint') {
        vscode.commands.executeCommand('autoclaw.orchestrate.assign');
      }
    });
  } else {
    vscode.window.showWarningMessage(
      `Orchestrate: ${votesByTask.size} task(s) reviewed — not all approved. Check the AutoClaw Orchestrate output for details.`
    );
  }
}

// ---------------------------------------------------------------------------
// Bridge Commands
// ---------------------------------------------------------------------------

let activeBridge: BridgeState | null = null;

async function bridgeStartCommand(): Promise<void> {
  if (activeBridge?.running) {
    vscode.window.showInformationMessage(`Bridge already running on ${activeBridge.config.host}:${activeBridge.config.port}`);
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Bridge: open a workspace first.'); return; }
  const cfg = vscode.workspace.getConfiguration('autoclaw.bridge');
  const config: BridgeConfig = {
    port: cfg.get<number>('port', 9876), host: cfg.get<string>('host', '127.0.0.1'),
    commsDir: path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms'),
    tokensPath: path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'tokens.json'),
  };
  try {
    activeBridge = await startBridge(config);
    vscode.window.showInformationMessage(`OpenClaw bridge started on ${config.host}:${config.port}`);
  } catch (e) { vscode.window.showErrorMessage(`Bridge failed: ${(e as Error).message}`); }
}

async function bridgeStopCommand(): Promise<void> {
  if (!activeBridge?.running) { vscode.window.showInformationMessage('Bridge not running.'); return; }
  await stopBridge(activeBridge);
  activeBridge = null;
  vscode.window.showInformationMessage('OpenClaw bridge stopped.');
}

async function bridgeAddAgentCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Open a workspace first.'); return; }
  const agentId = await vscode.window.showInputBox({ prompt: 'Remote agent ID', placeHolder: 'openclaw-worker-1' });
  if (!agentId) { return; }
  const tokensPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'tokens.json');
  await fsPromises.mkdir(path.dirname(tokensPath), { recursive: true });
  const token = await createRemoteAgentToken(tokensPath, agentId);
  await fsPromises.mkdir(path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', agentId), { recursive: true });
  const ch = getOrchestrateOutputChannel();
  ch.show(true);
  ch.appendLine(`[bridge] Registered: ${agentId} | Token: ${token.token} | Expires: ${token.expires_at}`);
  vscode.window.showInformationMessage(`Remote agent "${agentId}" registered. Token in output channel.`);
}

// ---------------------------------------------------------------------------
// Orchestrator Dashboard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestrator data refresh — sends agent/sprint/message/timeline data to the
// unified panel webview (formerly a separate OrchestratorViewProvider).
// ---------------------------------------------------------------------------

async function refreshOrchestratorData(view: vscode.WebviewView): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { return; }
  const commsDir = path.join(wr, '.autoclaw', 'orchestrator', 'comms');
  try { view.webview.postMessage({ command: 'updateAgents', data: await getAgentStatuses(commsDir) }); } catch {}
  try { view.webview.postMessage({ command: 'updateMessages', data: await readCommsLog(commsDir, { limit: 50 }) }); } catch {}
  try {
    const sp = path.join(wr, '.autoclaw', 'orchestrator', 'sprints', 'plan-summary.yaml');
    if (fs.existsSync(sp)) {
      const c = await fsPromises.readFile(sp, 'utf8');
      const m = c.match(/- number: \d+[\s\S]*?(?=\n  - number:|\nnotes:|\n\n|$)/g);
      if (m) {
        const sprints = m.map(b => ({
          number: parseInt(b.match(/number: (\d+)/)?.[1] || '0'),
          tasks: parseInt(b.match(/tasks: (\d+)/)?.[1] || '0'),
          status: b.match(/status: (\w+)/)?.[1] || 'pending',
        }));
        view.webview.postMessage({ command: 'updateSprints', data: sprints });
      }
    }
  } catch {}
  try { view.webview.postMessage({ command: 'updateTimeline', data: await readSnapshots(commsDir) }); } catch {}
}

// ---------------------------------------------------------------------------
// Inbox watcher — event-driven task_complete detection
// ---------------------------------------------------------------------------

function startInboxWatcher(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const pattern = new vscode.RelativePattern(
    workspaceRoot,
    '.autoclaw/orchestrator/comms/inboxes/shared/*.json'
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(async (uri) => {
    try {
      const raw = await fsPromises.readFile(uri.fsPath, 'utf8');
      const msg = JSON.parse(raw) as Record<string, unknown>;

      if (msg.type === 'task_complete') {
        const agentId = String(msg.from ?? 'an agent');
        const taskId = String((msg.payload as Record<string, unknown>)?.task_id ?? 'a task');
        const action = await vscode.window.showInformationMessage(
          `AutoClaw: ${agentId} completed ${taskId}.`,
          'Run Consensus Review',
          'Show Status'
        );
        if (action === 'Run Consensus Review') {
          vscode.commands.executeCommand('autoclaw.orchestrate.review');
        } else if (action === 'Show Status') {
          vscode.commands.executeCommand('autoclaw.orchestrate.status');
        }
      } else if (msg.type === 'finding_report') {
        const from = String(msg.from ?? 'agent');
        const payload = msg.payload as Record<string, unknown> | undefined;
        const sev = String(payload?.severity ?? 'info');
        if (sev === 'critical' || sev === 'major') {
          vscode.window.showWarningMessage(
            `AutoClaw: ${from} reported a ${sev} finding — ${String(payload?.description ?? '').slice(0, 80)}`,
            'Show Inbox'
          ).then(a => {
            if (a === 'Show Inbox') { vscode.commands.executeCommand('workbench.action.chat.open'); }
          });
        }
      }

      // Refresh dashboard on any new shared message
      if (kdreamView) { refreshOrchestratorData(kdreamView).catch(() => {}); }
    } catch {
      // Malformed JSON — ignore silently
    }
  });

  context.subscriptions.push(watcher);
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
  if (orchestrateOutputChannel) {
    orchestrateOutputChannel.dispose();
    orchestrateOutputChannel = undefined;
  }
  if (activeBridge?.running) {
    stopBridge(activeBridge).catch(() => {});
    activeBridge = null;
  }
}
