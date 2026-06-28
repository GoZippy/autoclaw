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
  isAdapterDetected,
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
  findLatestRunLog,
  writeSchedulerHeartbeat
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
  consensusConfigForTask,
  runAcceptanceChecks,
  applyAcceptanceGate,
  readManifestTaskGates,
  broadcastCapabilityQueries,
  resolveCapabilityOffers,
} from './orchestrate';
import type { Manifest, PlannerConfig, PlanResult, ValidationVote, AgentRegistryEntry, CapabilityPendingTask, GateCheckResult } from './orchestrate';
import { classifyConsensusActive, type ConsensusActiveEntry } from './orchestrator/consensusActiveScan';
import { registerChatParticipant } from './chatparticipant';
import { registerIntelligenceCommands } from './intelligence-commands';
import { registerWorkflowLabCommands } from './workflows/command';
import { startIntelligenceRefreshService, type RefreshServiceHandle } from './intelligence';
import { startIndexWatchService, loadConfig as loadIntelligenceConfig, type IndexWatchHandle } from './intelligence';
import { registerIntelligenceDashboard } from './views/intelligenceDashboard';
import { registerIntelligenceHealthSurface } from './intelligence/healthSurface';
import { registerManagerPanel } from './manager/managerPanel';
import { registerSupport } from './support/support';
import { registerLicensing } from './licensing/licensing';
import { GateService } from './licensing/gateService';
import type { FeatureId } from './licensing/features';
import { createPremiumApi } from './premium';
import { buildAdvancedInput } from './premium/advancedInput';
import {
  readCommsLog, getAgentStatuses, readRegistry, writeRegistry, writeHeartbeat, readHeartbeat,
  cleanupOldMessages, sendMessage, getInboxSummary, readInbox, readMessageState,
  markMessageReplied, detectAutoclawHostAgent, readClaimAuthor,
  type CommsLogEntry, type Message, type Heartbeat, type AgentStatus, type RegisteredAgent,
} from './comms';
import {
  CloudRelay, forwardHeartbeats, forwardInbox, applyFetchedToInboxes, fetchAndCacheHeartbeats,
  readRelayConfig, writeRelayConfig, endpointIsSecure, defaultRelayConfig,
} from './cloud';
import { createDefaultRunnerRegistry, BUILTIN_RUNNER_IDS, dispatchViaRegistry } from './runners';
import { recordDispatchCost, gatherFleetData } from './panel/fleetData';
import {
  buildFleetDigest,
  serializeFleetDigest,
  FLEET_STATUS_REL_PATH,
  type FleetDigestModel,
} from './fleet/fleetDigest';
// Agent-fabric taxonomy via explicit subpaths (keeps the message-bus + bridge
// out of modules that only need the taxonomy).
import { onboardPlatform } from './fabric/onboarding';
import { defaultAgentTypeForRunner, agentTypeProfile, AGENT_TYPES, type AgentType } from './fabric/agentTypes';
// Trigger hooks + fleet HALT kill switch (HKS-1..3, agent-trigger-hooks spec).
import { setFleetHalted, startTriggerHooksRuntime } from './hooks/triggerHooks';
// Track-record ledger (REP-1) — record reviewed-task outcomes for reputation routing.
import { recordTaskOutcome } from './reputation';
import {
  renderAgentList, renderAwaitingYou, payloadExcerpt, filterAwaitingYou,
  renderFabricHealth, renderPanelFooter, renderStatusLegend,
  readExtensionVersionFromDisk, readGitBranchFromDisk,
  type FabricHealth, type InboxSummary, type AwaitingYouRow, type AgentWithLive,
  type AwaitingHistoryEntry,
} from './webview-render';
import {
  renderBoard, renderMessageFeed, buildThreads, boardTaskCount, inferRoleFromActivity,
  type BoardSnapshot, type BoardRenderContext, type ThreadMessage, type AgentSessionRef,
} from './webview-render-board';
import { normalizeRole, ROLE_ORDER, ROLE_META, type CanonicalRole } from './roles';
import {
  resolveFleet, parseFleetManifest, type FleetManifest, type AgentSignal,
} from './fleet/architecture';
import { readAllBeacons, isDiscoveredUntrusted, type BeaconRow } from './fleet/beacons';
import {
  LanDiscovery, shouldStartLanDiscovery, parseSeeds, LAN_DEFAULT_PORT, type LanMode,
} from './fleet/lanDiscovery';
import { LanGossipRelay, LAN_GOSSIP_DEFAULT_PORT } from './fleet/lanGossipRelay';
import { createInvite, listInvites, revokeInvite, type AdmitPolicy } from './fleet/invites';
import { computePendingAgents, admitAgent } from './fleet/pending';
import { renderJoinPromptForInvite, JOIN_TARGETS } from './fleet/joinPrompt';
import { agentTypeForRole } from './fleet/roleType';
import { TEAM_TEMPLATES, getTeamTemplate, recommendedTemplate, seatSummary } from './fleet/teamTemplates';
import { scaffoldAgent, keepaliveProfileFor } from './fleet/scaffold';
import { scaffoldFleetManifest, setManifestOrchestrator, generateNeedsFile, type DetectedAgent as ManifestAgent } from './fleet/authoring';
import { appendTaskCompletion, readTaskLedger, summarizeByAgent, recentCompletions } from './taskLedger';
import { setAllowWrites, isWritesAllowed } from './mcp/allowWritesConfig';
import { readAgentCosts } from './agentCost';
// LANE C: per-agent LLM-cost metrics (tokens in/out, $, dispatches). The reader
// is fs-only + swallows errors; the builder is pure. See src/fleet/fleetMetrics.ts.
import {
  readLlmLedgerRows, buildAgentMetrics, type MetricsAttribution,
} from './fleet/fleetMetrics';
// LANE B: per-agent command & control. evictAgent() is the SAFE CORE eviction
// transaction (local single-operator only — the §5 cross-machine signing gate
// is not built); the typed errors map to user-facing modals / scope-violations.
import {
  evictAgent, intentsDir,
  EvictAuthError, EvictHardOnFreshError, EvictRemoteBlockedError,
} from './fleet/evict';
import { buildPending } from './views/fleetViewModelBuilders';
import { readSessionHeartbeats } from './comms/heartbeat';
import { readSnapshots, type Snapshot } from './timetravel';
import {
  startBridge, stopBridge, createRemoteAgentToken, revokeToken, readTokens,
  type BridgeState, type BridgeConfig,
} from './bridge';
import {
  detectIde, allocatePorts, releasePorts, getIdePorts, getIDEPortBlock,
  type IdeId,
} from './ide-ports';
import {
  registerWorker, unregisterWorker,
} from './workspace-registry';
import {
  createFabricBus,
  type BusDriver, type FabricBus,
} from './fabric';
import { buildAgentCard } from './agent-card';
import {
  HOST_SKILL_CONVENTIONS,
  renderSkillPrompt,
  renderInboxPrompt,
  type LaunchAction,
  type LaunchGoal,
} from './skillLauncher';
import {
  startKgDaemon, stopKgDaemon, fetchKgHealth,
  type KgState,
} from './kg';
import { getKnowledgeGraph, closeKnowledgeGraph } from './intelligence/kg/service';
import {
  startOrchestratorLoop,
  LOOP_INSTANCE_ID,
  dispatchWork,
  type OrchestratorLoopHandle,
} from './orchestratorLoop';
import {
  startBoardRefreshService,
  refreshBoardNow,
  DEFAULT_BOARD_REFRESH_DEBOUNCE_MS,
} from './orchestrator/boardRefresh';
import {
  buildPackage,
  commitPackage,
  ccTask,
  type CommitResult,
  type PackageResult,
  type DispatchContext,
} from './handoff_factory';
import { hasOrchestratorManifest } from './manifest-probe';
import { runReconcile } from './reconcile';
import {
  listPrograms, createProgram, joinProgram, leaveProgram,
  readProgramLink, touchParticipant, fanInCommsLog,
} from './program-plane';
import { stopSvidRefresh } from './svid';
import { getFleetMetrics, recordTaskDuration, resetMetrics } from './metrics';
export { recordTaskDuration }; // allow reconcile and other callers to import directly
import { writeConsensusVote } from './orchestrator/voteWriter';
import { reapDeadClaims } from './orchestrator/claimReaper';
import { declareScope, releaseScope, readLeases, detectConflicts, type ScopeConflict } from './orchestrator/scopeLease';
import { announceSession } from './orchestrator/announce';
import { archiveSharedInbox } from './orchestrator/commsGc';
import { writeFleetBrief } from './orchestrator/fleetBrief';
import { syncVoidSpecCommand } from './voidspec/dispatch';

const fsPromises = fs.promises;
let doctorOutputChannel: vscode.OutputChannel | undefined;
let autobuildOutputChannel: vscode.OutputChannel | undefined;
let autobuildIntervalId: NodeJS.Timeout | undefined;
let kgOutputChannel: vscode.OutputChannel | undefined;
let activeKg: KgState | null = null;
let activeRefreshService: RefreshServiceHandle | null = null;
/**
 * Module-level FabricBus handle. Created during activate() based on
 * autoclaw.fabric.busDriver and closed in deactivate(). Best-effort: an
 * activation that fails to spin up the bus logs and continues — the
 * filesystem mailbox always remains the canonical durable record.
 */
let activeFabric: FabricBus | null = null;
let currentIde: IdeId = 'other';
let currentWorkspace: string = '';

function getKgOutputChannel(): vscode.OutputChannel {
  if (!kgOutputChannel) {
    kgOutputChannel = vscode.window.createOutputChannel('AutoClaw KG');
  }
  return kgOutputChannel;
}

/**
 * Best-effort FabricBus initializer. Reads autoclaw.fabric.busDriver and
 * autoclaw.fabric.natsUrl, instantiates the bus, and stashes it in
 * `activeFabric` for later close in deactivate(). Any error is logged and
 * swallowed — activation must not fail because the optional fast-path
 * transport is unavailable.
 */
async function initFabricBus(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration('autoclaw.fabric');
    const driver = cfg.get<BusDriver>('busDriver', 'fs');
    const natsUrl = cfg.get<string>('natsUrl', 'nats://127.0.0.1:4222');
    activeFabric = await createFabricBus({ driver, natsUrl });
    console.log(`AutoClaw FabricBus: driver=${activeFabric.driver}`);
  } catch (e) {
    console.warn(`AutoClaw FabricBus: initialization failed (${(e as Error).message}); continuing without fast-path bus`);
    activeFabric = null;
  }
}

/**
 * Spawn the kg-daemon if `autoclaw.kg.enabled` is true. Best-effort —
 * never throws. If deps aren't installed or the entrypoint is missing
 * we log a one-liner and skip the spawn.
 */
async function maybeStartKgDaemon(extensionPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('autoclaw.kg');
  if (!cfg.get<boolean>('enabled', false)) { return; }
  if (activeKg?.child && activeKg.child.exitCode === null) { return; }
  const userKgPort = cfg.get<number>('port', 0);
  const dbPath = cfg.get<string>('dbPath', '');
  const channel = getKgOutputChannel();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const idePorts = getIdePorts(currentIde, workspaceRoot || undefined);
  const kgPort = userKgPort > 0 ? userKgPort : idePorts.kgPort;

  const result = await startKgDaemon({ extensionPath, port: kgPort, dbPath, logger: channel });
  if (result.ok) {
    activeKg = result.state;
  } else {
    channel.appendLine(`[kg] ${result.message}`);
    console.log(`AutoClaw KG: ${result.message}`);
  }
}

/**
 * Start the standalone per-host context refresh service when
 * `autoclaw.intelligence.autoRefresh.enabled` is true. Best-effort — never
 * throws. Idempotent: a running service is left in place. The service only
 * rewrites digests that already exist, so enabling it can never create files.
 */
function maybeStartRefreshService(): void {
  const cfg = vscode.workspace.getConfiguration('autoclaw.intelligence.autoRefresh');
  if (!cfg.get<boolean>('enabled', false)) { return; }
  if (activeRefreshService?.running) { return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }
  const minutes = cfg.get<number>('intervalMinutes', 30);
  try {
    activeRefreshService = startIntelligenceRefreshService({
      workspaceRoot,
      intervalMs: Math.max(1, minutes) * 60_000,
      log: (m) => console.log(`AutoClaw intelligence: ${m}`),
    });
  } catch (e) {
    console.error('AutoClaw intelligence refresh service failed to start:', e);
  }
}

/** Stop the refresh service if running. Best-effort. */
function stopRefreshService(): void {
  if (activeRefreshService) {
    try { activeRefreshService.stop(); } catch { /* ignore */ }
    activeRefreshService = null;
  }
}

let activeIndexWatch: { handle: IndexWatchHandle; watcher: vscode.FileSystemWatcher } | null = null;

/**
 * Start the always-on incremental code re-index watcher when
 * `autoclaw.intelligence.watch.enabled` is true. Best-effort, idempotent. The
 * service's path filter excludes `.autoclaw/` + ignored dirs, so the index's own
 * writes can't re-trigger it.
 */
function maybeStartIndexWatch(): void {
  const cfg = vscode.workspace.getConfiguration('autoclaw.intelligence.watch');
  if (!cfg.get<boolean>('enabled', false)) { return; }
  if (activeIndexWatch) { return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }
  const seconds = cfg.get<number>('debounceSeconds', 5);
  try {
    const intelConfig = loadIntelligenceConfig(workspaceRoot);
    const handle = startIndexWatchService({
      workspaceRoot,
      debounceMs: Math.max(1, seconds) * 1000,
      config: intelConfig,
      log: (m) => console.log(`AutoClaw intelligence: ${m}`),
    });
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onChange = (uri: vscode.Uri) => handle.notifyChange(uri.fsPath);
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    activeIndexWatch = { handle, watcher };
  } catch (e) {
    console.error('AutoClaw intelligence index watch failed to start:', e);
  }
}

/** Stop the index watch service + dispose its watcher. Best-effort. */
function stopIndexWatch(): void {
  if (activeIndexWatch) {
    try { activeIndexWatch.handle.stop(); } catch { /* ignore */ }
    try { activeIndexWatch.watcher.dispose(); } catch { /* ignore */ }
    activeIndexWatch = null;
  }
}

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
  isAdapterDetected,
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
// L2: consumer-side watcher — refresh the visible sidebar the instant board.json lands.
let boardWatcher: vscode.FileSystemWatcher | undefined = undefined;
let refreshIntervalId: NodeJS.Timeout | undefined = undefined;

/**
 * Run a paid-feature command behind the licensing gate. First meaningful use
 * starts the 7-day Pro trial; during trial or with a license `runPaid` runs;
 * otherwise `gate.require` shows ONE polite upgrade prompt and `runFallback`
 * (if any) runs. Never throws/blocks — local-first, graceful degradation.
 */
async function withGate(
  context: vscode.ExtensionContext,
  feature: FeatureId,
  reason: string,
  runPaid: () => Promise<void> | void,
  runFallback?: () => Promise<void> | void,
): Promise<void> {
  const gate = new GateService(context);
  const result = await gate.require(feature, { startTrial: true, reason });
  if (result.allowed) {
    await runPaid();
  } else if (runFallback) {
    await runFallback();
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('AutoClaw activated — skills ready');

  currentIde = detectIde(vscode.env.appName || '');
  currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  console.log(`AutoClaw: detected IDE=${currentIde}, workspace=${currentWorkspace || '(none)'}`);

  const adaptersDir = path.join(context.extensionPath, 'adapters');

  // Spin up the cross-agent message bus per autoclaw.fabric.busDriver.
  // Best-effort: the FS mailbox is the canonical durable record so a bus
  // failure never blocks activation.
  void initFabricBus();

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

  // LLM provider install — wires optional routers/local providers into the workspace.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.llm.install', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before running LLM install.');
        return;
      }
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: 'ZippyMesh + Ollama',
            description: 'Recommended',
            detail: 'Optional router plus local fallback. Skips unreachable providers without failing.',
            zippymesh: true,
            ollama: true,
          },
          {
            label: 'Ollama only',
            description: 'Local LLM',
            detail: 'Uses a local Ollama server on OLLAMA_HOST or http://127.0.0.1:11434.',
            zippymesh: false,
            ollama: true,
          },
          {
            label: 'ZippyMesh only',
            description: 'Optional router',
            detail: 'Adds the router when it is running; AutoClaw still works without it.',
            zippymesh: true,
            ollama: false,
          },
        ],
        { placeHolder: 'Choose optional LLM provider wiring. LM Studio is auto-detected on localhost:1234.' },
      );
      if (!choice) return;
      const { installLlm, formatLlmInstallReport } = await import('./llm');
      const report = await installLlm({
        workspaceRoot,
        zippymesh: choice.zippymesh,
        ollama: choice.ollama,
      });
      const text = formatLlmInstallReport(report);
      const channel = vscode.window.createOutputChannel('AutoClaw — LLM Install');
      channel.appendLine(text);
      channel.show(true);
      if (report.ok) {
        vscode.window.showInformationMessage('LLM install completed. See output channel.');
      } else {
        vscode.window.showErrorMessage('LLM install completed with errors. See output channel.');
      }
    })
  );

  // Skill launcher — quick pick that copies a skill prompt to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.launchSkill', async () => {
      // Resolve which host's conventions to target, then render every prompt for
      // it. Forks (Cursor/Kiro/Windsurf/Antigravity) are detected by appName; in
      // stock VS Code an explicit autoclaw.hostAgentId wins, else we prefer an
      // installed Claude Code, else the one installed agent extension.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const hostId = resolveLauncherHost(workspaceRoot);
      const isSlashHost = HOST_SKILL_CONVENTIONS[hostId]?.style === 'slash';

      // ONB-2: Goal-oriented skill catalog — grouped by user intent, not a flat
      // command list. Each action names a shipped skill + the command phrase
      // (which begins with the skill name); the prompt is rendered for `hostId`
      // at selection time so it always points at THIS IDE's installed adapter.
      const skillCatalog: LaunchGoal[] = [
        {
          label: '🚀 Start a New Project',
          detail: 'Initialize orchestration, set up manifests, and plan your first sprint',
          actions: [
            { label: 'Initialize + Plan', skill: 'orchestrate', command: 'orchestrate init, then orchestrate plan' },
          ],
        },
        {
          label: '▶️ Run / Resume Orchestration',
          detail: 'Assign work, check progress, and manage active sprints',
          actions: [
            { label: 'Assign Next Sprint', skill: 'orchestrate', command: 'orchestrate next' },
            { label: 'Check Status', skill: 'orchestrate', command: 'orchestrate status' },
            { label: 'Review + Merge', skill: 'orchestrate', command: 'orchestrate review, then orchestrate merge' },
          ],
        },
        {
          label: '👥 Spawn a Multi-Agent Team',
          detail: 'Launch a team of parallel agents to work on a feature or fix',
          actions: [
            { label: 'Launch Team', skill: 'mateam', command: 'mateam launch "' },
          ],
        },
        {
          label: '🔨 Automate Builds & Workflows',
          detail: 'Schedule or run CI/CD workflows, lint fixes, and automated tasks',
          actions: [
            { label: 'Schedule Workflow', skill: 'autobuild', command: 'autobuild schedule' },
            { label: 'Run Now', skill: 'autobuild', command: 'autobuild run' },
          ],
        },
        {
          label: '🌙 Background Agent (KDream)',
          detail: 'Start, monitor, or task the persistent background agent',
          actions: [
            { label: 'Start KDream', skill: 'kdream', command: 'kdream start' },
            { label: 'Check Status', skill: 'kdream', command: 'kdream ps' },
            { label: 'Add Task', skill: 'kdream', command: 'kdream add "' },
          ],
        },
        {
          label: '📬 Check Inbox',
          detail: 'Read cross-agent messages, review requests, and task completions',
          actions: [
            { label: 'Check Inbox', inbox: true },
          ],
        },
        {
          label: '🛡️ Security Audit',
          detail: 'Audit a module for security defects before merging or GA',
          actions: [
            { label: 'Run Audit', skill: 'security-auditor', command: 'security-auditor "audit <path>"' },
          ],
        },
        {
          label: '📝 Write Documentation',
          detail: 'Generate docs, READMEs, or API references from code',
          actions: [
            { label: 'Write Docs', skill: 'doc-writer', command: 'doc-writer "' },
          ],
        },
      ];

      // Two-step picker: first pick a goal, then pick an action within it.
      const goalPick = await vscode.window.showQuickPick(skillCatalog, {
        placeHolder: 'What do you want to do? (select a goal)',
        matchOnDetail: true,
      });

      if (!goalPick) return;

      // If only one action, use it directly; otherwise let the user pick the specific action.
      let action: LaunchAction;
      if (goalPick.actions.length === 1) {
        action = goalPick.actions[0];
      } else {
        const actionPick = await vscode.window.showQuickPick(goalPick.actions, {
          placeHolder: `${goalPick.label} — select an action`,
          matchOnDetail: true,
        });
        if (!actionPick) return;
        action = actionPick;
      }

      // Render the prompt for the ACTIVE host — correct rules dir, file
      // extension, and invocation modality (slash command vs. rule-file path).
      let selectedPrompt: string;
      if (action.inbox) {
        selectedPrompt = renderInboxPrompt(hostId);
      } else {
        selectedPrompt = renderSkillPrompt(hostId, action.skill!, action.command!);
        // Don't hand the user a path to a file that isn't installed for this
        // host — offer to install the adapters first.
        if (!isSkillInstalled(hostId, action.skill!, workspaceRoot)) {
          const choice = await vscode.window.showWarningMessage(
            `The "${action.skill}" skill isn't installed for ${hostId} yet.`,
            'Install Adapters', 'Copy Anyway'
          );
          if (!choice) { return; }
          if (choice === 'Install Adapters') {
            await installAdapters(adaptersDir, context.extensionPath, false);
          }
        }
      }

      await vscode.env.clipboard.writeText(selectedPrompt);
      const hint = isSlashHost
        ? `Copied "${goalPick.label}" — paste into ${hostId} chat (skills run as slash commands).`
        : `Copied "${goalPick.label}" — paste into your AI chat (points at this IDE's installed rule file).`;
      vscode.window.showInformationMessage(hint, 'Open Chat').then(sel => {
        if (sel === 'Open Chat') {
          vscode.commands.executeCommand('workbench.action.chat.open');
        }
      });
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
    // Gated (Pro): scheduled/automated AutoBuild. First use starts the trial.
    vscode.commands.registerCommand('autoclaw.autobuild.runNow', () =>
      withGate(context, 'pro.autobuild.schedule', 'Scheduled AutoBuild', autobuildRunNowCommand),
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.autobuild.tail', async () => {
      await autobuildTailCommand();
    })
  );

  // Orchestrate commands
  context.subscriptions.push(
    // Gated (Pro): advanced multi-agent orchestration planning. First use starts
    // the trial. TODO: gate the rest of the pro/team commands from the refactor
    // spec Step 11 (orchestrate.assign/review/merge, autobuild.tail, fleet.metrics,
    // voidspec.sync, program.*, cloud.*, bridge.*) using this same withGate helper.
    vscode.commands.registerCommand('autoclaw.orchestrate.plan', () =>
      withGate(context, 'pro.orchestrate.advanced', 'Advanced Orchestration', orchestratePlanCommand),
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.status', async () => {
      await orchestrateStatusCommand();
    })
  );

  // Gated (Pro): the orchestrate *action* commands, consistent with plan. NOTE:
  // orchestrate.status (read-only) stays free, and core-coordination commands
  // (bridge.*, cloud.*, program.*) are deliberately NOT gated — gating those
  // would break cross-agent coordination for non-Team users.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.assign', () =>
      withGate(context, 'pro.orchestrate.advanced', 'Advanced Orchestration', orchestrateAssignNextCommand),
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.review', () =>
      withGate(context, 'pro.orchestrate.advanced', 'Advanced Orchestration', orchestrateReviewCommand),
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.merge', () =>
      withGate(context, 'pro.orchestrate.advanced', 'Advanced Orchestration', orchestrateMergeCommand),
    )
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
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.bridge.revokeToken', async () => {
      await bridgeRevokeTokenCommand();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.agentCard.show', async () => {
      await agentCardShowCommand();
    })
  );

  // KG-daemon commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.openOutput', () => {
      getKgOutputChannel().show(true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.healthCheck', async () => {
      await kgHealthCheckCommand();
    })
  );
  // RV-3: the panel's KG fabric-health chip dispatches to these three commands
  // (startKgDaemon / restartKgDaemon / openKgDashboard). Before v3.2 they were
  // referenced but never registered, so the chip click fell through to a docs
  // prompt. Register them so the chip actually controls the daemon.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.start', async () => {
      await kgStartCommand(context.extensionPath);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.restart', async () => {
      await kgRestartCommand(context.extensionPath);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.kg.openDashboard', async () => {
      await kgOpenDashboardCommand();
    })
  );

  // Program-plane commands (Phase 4 cross-repo registry)
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.program.create', async () => {
      await programCreateCommand(context);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.program.join', async () => {
      await programJoinCommand(context);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.program.leave', async () => {
      await programLeaveCommand();
    })
  );

  // Fleet metrics command
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fleet.metrics', async () => {
      const m = getFleetMetrics();
      if (!m) {
        vscode.window.showInformationMessage('AutoClaw Fleet Metrics: No task samples recorded yet.');
        return;
      }
      const lines = [
        `AutoClaw Fleet Metrics (${m.sample_count} tasks in window)`,
        `  p50: ${Math.round(m.p50_ms / 1000)}s  p95: ${Math.round(m.p95_ms / 1000)}s  p99: ${Math.round(m.p99_ms / 1000)}s`,
        `  min: ${Math.round(m.min_ms / 1000)}s  max: ${Math.round(m.max_ms / 1000)}s  mean: ${Math.round(m.mean_ms / 1000)}s`,
        `  throughput: ${m.throughput_per_hour.toFixed(1)} tasks/hr`,
        ...Object.entries(m.by_agent).map(([id, s]) => `  ${id}: p50=${Math.round(s.p50_ms / 1000)}s (${s.count} tasks)`),
      ];
      vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
    })
  );

  // VoidSpec sync command — thin VS Code wrapper around the headless
  // syncVoidSpecCommand() in src/voidspec/dispatch.ts (no vscode import there,
  // so the core sync logic stays unit-testable). This layer resolves the
  // workspace root and surfaces the summary to the user.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.voidspec.sync', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('AutoClaw: open a workspace folder before syncing VoidSpec tasks.');
        return;
      }
      try {
        const r = await syncVoidSpecCommand({ workspaceRoot: root });
        vscode.window.showInformationMessage(r.summary);
      } catch (err) {
        vscode.window.showErrorMessage(`AutoClaw: VoidSpec sync failed — ${String(err)}`);
      }
    })
  );

  // Cloud relay consent commands (RELAY-WIRE / SEC-2)
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.cloud.enableRelay', () => cloudEnableRelayCommand()),
    vscode.commands.registerCommand('autoclaw.cloud.disableRelay', () => cloudDisableRelayCommand())
  );

  // Fabric onboarding (AF-4b)
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fabric.onboard', () => fabricOnboardCommand())
  );

  // Declarative agent roles — assign a panel role to a detected agent.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.setAgentRole', () => setAgentRoleCommand())
  );

  // Fleet architecture — let the user designate who coordinates the team.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.designateOrchestrator', () => designateOrchestratorCommand())
  );

  // Fleet manifest authoring — CREATE fleet.json + needs.json from detected
  // agents (the per-agent setAgentRole/designateOrchestrator commands above only
  // edit an existing manifest; this scaffolds it in the first place).
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fleet.scaffoldManifest', () => fleetScaffoldManifestCommand()),
    vscode.commands.registerCommand('autoclaw.fleet.pickOrchestrator', () => fleetPickOrchestratorCommand())
  );

  // Fleet federation (FF-3) — invite outside agents, admit/decline the pending tray.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fleet.invite', () => fleetInviteCommand()),
    vscode.commands.registerCommand('autoclaw.fleet.admit', () => fleetAdmitCommand()),
    vscode.commands.registerCommand('autoclaw.fleet.decline', () => fleetDeclineCommand()),
    // Generate a ready-to-paste join prompt for a chosen tool (Codex/Claude
    // Desktop/OpenClaw/Hermes/…), bundling a fresh invite token + lane steps.
    vscode.commands.registerCommand('autoclaw.fleet.joinPrompt', () => fleetJoinPromptCommand()),
    // Add a whole agent team from a ready-made template (gallery → preview → fan-out).
    vscode.commands.registerCommand('autoclaw.fleet.addTeam', () => fleetAddTeamCommand()),
    // Open the "Build your first agent team" getting-started walkthrough.
    vscode.commands.registerCommand('autoclaw.openWalkthrough', () => openGettingStartedWalkthrough()),
    // Wire an arbitrary (non-extension) agent id into the comms tree.
    vscode.commands.registerCommand('autoclaw.fleet.scaffoldAgent', () => fleetScaffoldAgentCommand()),
    // Toggle the MCP server's allowWrites gate (lets MCP-lane agents claim/vote).
    vscode.commands.registerCommand('autoclaw.mcp.allowWrites', () => mcpAllowWritesToggleCommand()),
    // CL-3: manually release dead-session, expired claims (safe, release-only).
    vscode.commands.registerCommand('autoclaw.fleet.reapClaims', () => fleetReapClaimsCommand()),
    // CL-4: file-scope leases — declare/release the globs this window is editing,
    // and surface overlaps with other sessions as scope_violation findings.
    vscode.commands.registerCommand('autoclaw.fleet.declareScope', () => fleetDeclareScopeCommand()),
    vscode.commands.registerCommand('autoclaw.fleet.releaseScope', () => fleetReleaseScopeCommand()),
    vscode.commands.registerCommand('autoclaw.fleet.scopeStatus', () => fleetScopeStatusCommand()),
    // CL-5: one-read situational awareness (write fleet-brief.json + summary).
    vscode.commands.registerCommand('autoclaw.fleet.brief', () => fleetBriefCommand()),
    // CL-2: archive shared-inbox telemetry so it returns to being signal.
    vscode.commands.registerCommand('autoclaw.fleet.archiveTelemetry', () => fleetArchiveTelemetryCommand())
  );

  // LANE B — per-agent Command & Control. Each accepts a {agentId, sessionId}
  // arg (posted by the panel action buttons) or prompts when invoked bare from
  // the palette. evict shows a REQUIRED modal confirm before calling evictAgent;
  // all of these are LOCAL single-operator only (no relay path).
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fleet.messageAgent', (arg?: unknown) => fleetMessageAgentCommand(arg)),
    vscode.commands.registerCommand('autoclaw.fleet.pauseAgent', (arg?: unknown) => fleetPauseAgentCommand(arg)),
    vscode.commands.registerCommand('autoclaw.fleet.resumeAgent', (arg?: unknown) => fleetResumeAgentCommand(arg)),
    vscode.commands.registerCommand('autoclaw.fleet.reassignAgent', (arg?: unknown) => fleetReassignAgentCommand(arg)),
    vscode.commands.registerCommand('autoclaw.fleet.evict', (arg?: unknown) => fleetEvictAgentCommand(arg))
  );

  // Fleet HALT kill switch + trigger hooks (HKS-1..3, agent-trigger-hooks spec).
  // HALT is a file (`.autoclaw/orchestrator/HALT`): while present, neither the
  // orchestrator loop nor trigger hooks dispatch anything in this workspace.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.fleet.halt', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
      const reason = await vscode.window.showInputBox({
        prompt: 'Reason for halting the fleet (written to the HALT file)',
        placeHolder: 'manual fleet halt',
      });
      await setFleetHalted(root, true, reason || undefined);
      vscode.window.showWarningMessage('AutoClaw: fleet HALTED — all auto-dispatch and trigger hooks are paused. Run "AutoClaw: Resume Fleet" to release.');
    }),
    vscode.commands.registerCommand('autoclaw.fleet.resume', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
      await setFleetHalted(root, false);
      vscode.window.showInformationMessage('AutoClaw: fleet resumed — dispatch and trigger hooks are active again.');
    })
  );
  {
    // Zero-config no-op: startTriggerHooksRuntime returns an inert handle when
    // .autoclaw/orchestrator/hooks.yaml is absent or has no valid rules.
    const hooksRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (hooksRoot) {
      // Relay client for the `relay` hook action — inert no-op unless the user
      // has enabled + consented to the cloud relay (same contract as elsewhere).
      const hookRelay = new CloudRelay({ autoclawDir: path.join(hooksRoot, '.autoclaw') });
      startTriggerHooksRuntime({
        workspaceRoot: hooksRoot,
        log: (line) => console.log(`[autoclaw] ${line}`),
        notify: (m) => { vscode.window.showInformationMessage(m); },
        // HKS-4: launch_skill — render the skill prompt for the target host and
        // copy it to the clipboard (the documented "open a session" mechanism),
        // surfacing a toast the operator can paste into the agent's chat.
        launchSkill: async (decision) => {
          const host = decision.target || 'claude-code';
          const skill = decision.rule.skill || 'orchestrate';
          const prompt = decision.rule.prompt || renderSkillPrompt(host, skill, skill);
          try { await vscode.env.clipboard.writeText(prompt); } catch { /* clipboard best-effort */ }
          vscode.window.showInformationMessage(`AutoClaw hook "${decision.rule.id}": ${skill} prompt copied for ${host} — paste into the agent.`);
        },
        // HKS-4: spawn_runner — confirm the target is a known runner, then wake it
        // via the existing dispatch path (the established way runners start work).
        spawnRunner: async (decision) => {
          const target = decision.target ?? '';
          const known = (BUILTIN_RUNNER_IDS as readonly string[]).includes(target);
          if (!known) { throw new Error(`unknown runner "${target}"`); }
          vscode.window.showInformationMessage(`AutoClaw hook "${decision.rule.id}": spawning runner ${target}.`);
          // Opt-in direct dispatch through the runner contract (§5.5 preference
          // order + Runner.dispatch). Off by default because it can launch a real
          // host process; the default path below wakes via the work queue. When
          // enabled, a completed dispatch auto-feeds the per-agent cost ledger.
          if (process.env.AUTOCLAW_RUNNER_DIRECT_DISPATCH === 'true') {
            const outcome = await dispatchViaRegistry(createDefaultRunnerRegistry(), {
              runnerId: target,
              prompt: `[AutoClaw hook "${decision.rule.id}"] Resume assigned work (trigger: ${decision.rule.on}).`,
              workingDir: hooksRoot,
              trust: 'auto',
              onResult: (runnerId, result) =>
                recordDispatchCost(hooksRoot, runnerId, result, {
                  sprint: Number(decision.event.payload.sprint ?? 1) || 1,
                }),
            });
            if (outcome === null) { throw new Error(`runner "${target}" not detected or disabled`); }
            if (!outcome.result.ok) { throw new Error(`runner ${target} dispatch failed (exit ${outcome.result.exitCode})`); }
            return;
          }
          const pkg = {
            type: 'work_package' as const,
            taskId: `next-${target}`,
            taskName: `Hook spawn_runner: ${decision.rule.id}`,
            description: `Runner wake by trigger hook "${decision.rule.id}" on ${decision.rule.on}. via_hook:${decision.rule.id}`,
            filePaths: [] as string[],
            successCriteria: ['Start the registered runner and begin assigned work'],
            sprint: Number(decision.event.payload.sprint ?? 1) || 1,
            assignToVendor: 'other' as const,
            priority: 'low' as const,
            timeBudgetMs: 0,
          };
          const res = await dispatchWork(hooksRoot, pkg);
          if (res === null) { throw new Error('runner dispatch gated or halted'); }
        },
        // HKS-5: relay — forward the wake to the target machine's inbox over the
        // cloud relay. Inert no-op unless the relay is enabled + consented.
        relay: async (decision) => {
          const target = decision.target ?? '';
          const r = await hookRelay.sendInbox([{
            id: `hook-${decision.rule.id}-${Date.now()}`,
            to: target,
            from: 'trigger-hooks',
            type: 'wake',
            timestamp: new Date().toISOString(),
            payload: { via_hook: decision.rule.id, on: decision.rule.on, event: decision.event.payload },
          }]);
          if (!r.ok) { throw new Error(`relay send failed: ${r.detail ?? 'unknown'}`); }
        },
      }).then(runtime => {
        if (runtime.ruleCount > 0) {
          context.subscriptions.push({ dispose: () => { void runtime.stop(); } });
        }
      }).catch(e => console.error('trigger-hooks runtime failed to start:', e));
    }
  }

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

  // Auto-start bridge: default-on when at least one orchestrator manifest
  // exists in the workspace. The legacy `autoclaw.bridge.enabled` setting
  // (default false) acts as an explicit override — if a user has flipped
  // it to true we still start regardless of manifest presence. Setting
  // `autoStart` to false disables manifest-based auto-start; an explicit
  // `enabled = true` still wins.
  const bridgeConfig = vscode.workspace.getConfiguration('autoclaw.bridge');
  const bridgeAutoStart = bridgeConfig.get<boolean>('autoStart', true);
  const bridgeEnabledOverride = bridgeConfig.get<boolean>('enabled', false);
  if (bridgeEnabledOverride) {
    bridgeStartCommand().catch(e => console.error('bridge auto-start failed:', e));
  } else if (bridgeAutoStart) {
    const probeRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (probeRoot) {
      hasOrchestratorManifest(probeRoot).then(found => {
        if (found) {
          bridgeStartCommand().catch(e => console.error('bridge auto-start failed:', e));
        }
      }).catch(e => console.error('bridge auto-start probe failed:', e));
    }
  }

  // Knowledge Graph: the default KG is now an IN-PROCESS store (lazily opened
  // on first use via getKnowledgeGraph / closed in deactivate). We deliberately
  // do NOT auto-spawn the standalone child daemon on activation. The optional
  // daemon stays available behind the explicit `autoclaw.kg.start` command.
  // (Set autoclaw.kg.spawnDaemonOnActivate to opt back into the legacy spawn.)
  if (vscode.workspace.getConfiguration('autoclaw.kg').get<boolean>('spawnDaemonOnActivate', false)) {
    maybeStartKgDaemon(context.extensionPath).catch(e => {
      console.error('kg-daemon auto-start failed:', e);
    });
  }

  // Intelligence refresh service: standalone tick that keeps opted-in per-host
  // context digests current (gated on autoclaw.intelligence.autoRefresh.enabled).
  maybeStartRefreshService();
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.startRefreshService', () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.');
        return;
      }
      if (activeRefreshService?.running) {
        void vscode.window.showInformationMessage('AutoClaw: intelligence refresh service is already running.');
        return;
      }
      const minutes = vscode.workspace
        .getConfiguration('autoclaw.intelligence.autoRefresh')
        .get<number>('intervalMinutes', 30);
      activeRefreshService = startIntelligenceRefreshService({
        workspaceRoot,
        intervalMs: Math.max(1, minutes) * 60_000,
        log: (m) => console.log(`AutoClaw intelligence: ${m}`),
      });
      void vscode.window.showInformationMessage(
        `AutoClaw: intelligence refresh service started (every ${Math.max(1, minutes)} min). It refreshes only host digests you've already created.`,
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.stopRefreshService', () => {
      if (!activeRefreshService?.running) {
        void vscode.window.showInformationMessage('AutoClaw: intelligence refresh service is not running.');
        return;
      }
      stopRefreshService();
      void vscode.window.showInformationMessage('AutoClaw: intelligence refresh service stopped.');
    }),
  );
  // Honor live toggling of the setting without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('autoclaw.intelligence.autoRefresh.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('autoclaw.intelligence.autoRefresh')
          .get<boolean>('enabled', false);
        if (enabled) { maybeStartRefreshService(); } else { stopRefreshService(); }
      }
    }),
  );

  // Intelligence index watch: incremental re-index as you work
  // (gated on autoclaw.intelligence.watch.enabled, default off).
  maybeStartIndexWatch();
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.startWatch', () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.');
        return;
      }
      if (activeIndexWatch) {
        void vscode.window.showInformationMessage('AutoClaw: intelligence index watch is already running.');
        return;
      }
      const seconds = vscode.workspace
        .getConfiguration('autoclaw.intelligence.watch')
        .get<number>('debounceSeconds', 5);
      const intelConfig = loadIntelligenceConfig(workspaceRoot);
      const handle = startIndexWatchService({
        workspaceRoot,
        debounceMs: Math.max(1, seconds) * 1000,
        config: intelConfig,
        log: (m) => console.log(`AutoClaw intelligence: ${m}`),
      });
      const watcher = vscode.workspace.createFileSystemWatcher('**/*');
      const onChange = (uri: vscode.Uri) => handle.notifyChange(uri.fsPath);
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      activeIndexWatch = { handle, watcher };
      void vscode.window.showInformationMessage(
        `AutoClaw: intelligence index watch started (incremental re-index, ${Math.max(1, seconds)}s debounce).`,
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.intelligence.stopWatch', () => {
      if (!activeIndexWatch) {
        void vscode.window.showInformationMessage('AutoClaw: intelligence index watch is not running.');
        return;
      }
      stopIndexWatch();
      void vscode.window.showInformationMessage('AutoClaw: intelligence index watch stopped.');
    }),
  );
  // Honor live toggling of the setting without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('autoclaw.intelligence.watch.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('autoclaw.intelligence.watch')
          .get<boolean>('enabled', false);
        if (enabled) { maybeStartIndexWatch(); } else { stopIndexWatch(); }
      }
    }),
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
    // retainContextWhenHidden keeps the DOM (and the user's expand/collapse
    // state) alive when the view is hidden — otherwise switching VS Code tabs
    // and back reloads the webview from scratch, collapsing every panel.
    // The Intelligence dashboard and fleet panel already do this.
    vscode.window.registerWebviewViewProvider(
      KDreamViewProvider.viewType,
      kdreamViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    )
  );

  // Set up file system watcher for state.json
  stateWatcher = vscode.workspace.createFileSystemWatcher('**/.autoclaw/kdream/state.json');
  stateWatcher.onDidChange(async (uri) => {
    if (kdreamView) {
      await refreshDashboardData(kdreamView);
    }
  });
  context.subscriptions.push(stateWatcher);

  // L2 consumer: refresh the visible KDream sidebar the instant board.json is
  // (re)written, instead of waiting for the slow backstop poll. Gated by the same
  // `cluster.boardWatch` flag as the producer (so turning it off = 30s tick only),
  // scoped to THIS workspace (a nested/sibling project's board never drives a
  // spurious refresh), and gated on visibility so a hidden panel does zero work.
  const kdreamBoardWatchEnabled = vscode.workspace
    .getConfiguration('autoclaw').get<boolean>('cluster.boardWatch', true);
  const kdreamWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (kdreamBoardWatchEnabled && kdreamWorkspaceRoot) {
    boardWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(kdreamWorkspaceRoot, '.autoclaw/orchestrator/board.json'),
    );
    const onBoardChange = (): void => {
      if (kdreamView?.visible) { refreshOrchestratorData(kdreamView).catch(() => {}); }
    };
    boardWatcher.onDidChange(onBoardChange);
    boardWatcher.onDidCreate(onBoardChange);
    context.subscriptions.push(boardWatcher);
  }

  // Check if .autoclaw/ is in .gitignore
  checkAndOfferGitignoreUpdate().catch(e => console.error('gitignore check failed:', e));

  // Auto-install adapters silently on activation if enabled
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const autoInstall = config.get<boolean>('autoInstallAdapters', true);
  if (autoInstall) {
    installAdapters(adaptersDir, context.extensionPath, true);
  }

  // Auto-provision cross-agent comms infrastructure, then CL-1 auto-announce this
  // session (self-describing fleet) + CL-2 one-time telemetry sweep of the shared
  // inbox so it starts as signal. Both best-effort — never block activation.
  provisionCrossAgentComms()
    .then(async () => {
      const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wr) { return; }
      let branch: string | undefined;
      try {
        branch = (await fsPromises.readFile(path.join(wr, '.git', 'HEAD'), 'utf8'))
          .trim().replace(/^ref:\s*refs\/heads\//, '') || undefined;
      } catch { /* not a git checkout / detached — omit branch */ }
      await announceSession(wr, {
        agent_id: activeHostAgentId() ?? 'claude-code',
        session_id: extScopeSession(),
        branch,
      });
      await archiveSharedInbox(wr).catch(() => { /* best-effort */ });
    })
    .catch(e => console.error('cross-agent comms provisioning failed:', e));

  // Start heartbeat ticker — writes real heartbeats for detected agents
  startHeartbeatTicker(context);

  // Watch shared inbox for task_complete messages — notify and auto-refresh
  startInboxWatcher(context);

  // Periodic reconciliation sweep — detects drift between tasks.md / sprint YAML / comms-log
  startReconcileTicker(context);

  // Orchestrator perpetual loop: health → inbox → work → dispatch → log
  startOrchestratorLoopTick(context);

  // Register @autoclaw chat participant (VS Code 1.90+; degrades on older builds / other IDEs)
  registerChatParticipant(
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );

  // Register Intelligence Layer commands (registration only — no I/O at activation)
  registerIntelligenceCommands(
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );

  // Register Workflow Lab commands (WL-1.4)
  registerWorkflowLabCommands(
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );

  // Intelligence metrics dashboard (webview view + refresh command + metrics
  // file watcher). Registration only — no I/O until the view is opened.
  registerIntelligenceDashboard(context);

  // Always-on Intelligence health surface (Theme 3): a status-bar rollup, a
  // one-shot toast when the layer is in a red state, and the auto-detect
  // "learn from other tools' sessions" consent prompt. Registration only; the
  // probe + detection are deferred + best-effort (never block activation).
  registerIntelligenceHealthSurface(
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );

  // Full-tab Manager Surface (autoclaw.manager.open) — roomy single pane for
  // overseeing the fleet. Command registration only; no I/O until opened.
  registerManagerPanel(context);

  // First-run welcome with IDE-specific guidance
  showWelcomeIfNeeded(context);

  // Support surface: register the Support/Donate panel + rate commands, count
  // today's activity, and (deferred) show a non-invasive milestone prompt.
  registerSupport(context);

  // Commercial licensing + BYO-key + 7-day Pro trial + status bar. Registers
  // commands only; local features degrade gracefully. Hosted features opt in via
  // requireHosted(); tiered local features gate via GateService.
  registerLicensing(context);

  // PR Evidence Report — the worked example of the gate + trial + premium stack.
  // During trial/license it runs the (premium) engine; otherwise it generates a
  // basic free fallback report and offers an upgrade. Never blocks.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.reports.prEvidence', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before generating a report.');
        return;
      }
      const gate = new GateService(context);
      const access = await gate.require('pro.reports.prEvidence', {
        startTrial: true,
        reason: 'PR Evidence Report',
        silent: true, // we surface our own tailored upgrade prompt below
      });
      const premium = createPremiumApi({ extensionPath: context.extensionPath });
      const report = await premium.generatePrEvidenceReport({ workspaceRoot });
      const doc = await vscode.workspace.openTextDocument({ content: report.markdown, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
      if (!access.allowed) {
        void vscode.window.showInformationMessage(
          'Generated a basic free report. Unlock Pro for full evidence reports with tests, risks, changed files, agent history, and reviewer verdicts.',
          'Compare Plans', 'Enter License',
        ).then(choice => {
          if (choice === 'Compare Plans') { void vscode.commands.executeCommand('autoclaw.license.comparePlans'); }
          if (choice === 'Enter License') { void vscode.commands.executeCommand('autoclaw.license.enter'); }
        });
      }
    }),
  );

  // Agent Scorecards — second premium engine, same gate+trial+fallback pattern.
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.reports.agentScorecard', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before generating scorecards.');
        return;
      }
      const gate = new GateService(context);
      const access = await gate.require('pro.agentScorecards', {
        startTrial: true,
        reason: 'Agent Scorecards',
        silent: true,
      });
      const premium = createPremiumApi({ extensionPath: context.extensionPath });
      const result = (await premium.generateAgentScorecard?.({ workspaceRoot })) as { markdown?: string } | undefined;
      const markdown = result?.markdown ?? '# Agent Scorecards\n\nNo scorecard available.';
      const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
      if (!access.allowed) {
        void vscode.window.showInformationMessage(
          'Generated a basic scorecard. Unlock Pro for full per-agent scorecards (actions, tokens, wall time, token share, last active).',
          'Compare Plans', 'Enter License',
        ).then(choice => {
          if (choice === 'Compare Plans') { void vscode.commands.executeCommand('autoclaw.license.comparePlans'); }
          if (choice === 'Enter License') { void vscode.commands.executeCommand('autoclaw.license.enter'); }
        });
      }
    }),
  );

  // Advanced Orchestration — third premium engine. Same gate+trial+fallback
  // pattern. Reads a dependency-free `advanced-input.json` ({objective?, tasks[],
  // agents[]}); agents fall back to the orchestrator registry. Writes/opens an
  // optimised plan (critical path, weighted assignment, scope-conflict-free).
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.orchestrate.advancedPlan', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('Open a workspace folder before planning.');
        return;
      }
      const orchDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
      const inputPath = path.join(orchDir, 'advanced-input.json');
      const registryPath = path.join(orchDir, 'comms', 'registry.json');
      const readIf = (p: string): string | undefined => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } };

      const built = buildAdvancedInput({
        workspaceRoot,
        inputJson: readIf(inputPath),
        registryJson: readIf(registryPath),
      });
      if (!built.ok) {
        // Seed a starter descriptor the first time so the command is discoverable.
        if (built.reason === 'no_input') {
          fs.mkdirSync(orchDir, { recursive: true });
          if (!fs.existsSync(inputPath)) { fs.writeFileSync(inputPath, built.template, 'utf8'); }
          const doc = await vscode.workspace.openTextDocument(inputPath);
          await vscode.window.showTextDocument(doc);
          void vscode.window.showInformationMessage(
            'Created advanced-input.json — fill in tasks (and optionally agents), then run Advanced Orchestration again.',
          );
        } else {
          void vscode.window.showWarningMessage(
            `Advanced Orchestration: ${built.reason.replace(/_/g, ' ')} in advanced-input.json (need tasks, and agents or a registry).`,
          );
        }
        return;
      }

      const gate = new GateService(context);
      const access = await gate.require('pro.orchestrate.advanced', {
        startTrial: true,
        reason: 'Advanced Orchestration',
        silent: true,
      });
      const premium = createPremiumApi({ extensionPath: context.extensionPath });
      const result = await premium.runAdvancedOrchestration?.(built.input);
      const markdown = result?.markdown ?? '# Advanced Orchestration\n\nNo plan produced.';
      const outPath = path.join(orchDir, 'advanced-plan.md');
      fs.mkdirSync(orchDir, { recursive: true });
      fs.writeFileSync(outPath, markdown, 'utf8');
      const doc = await vscode.workspace.openTextDocument(outPath);
      await vscode.window.showTextDocument(doc);
      if (!access.allowed) {
        void vscode.window.showInformationMessage(
          'Generated a basic plan. Unlock Pro for the optimising planner: critical-path analysis, capability/reputation/cost-aware assignment, scope-conflict-free packing, and risk-tiered review hints.',
          'Compare Plans', 'Enter License',
        ).then(choice => {
          if (choice === 'Compare Plans') { void vscode.commands.executeCommand('autoclaw.license.comparePlans'); }
          if (choice === 'Enter License') { void vscode.commands.executeCommand('autoclaw.license.enter'); }
        });
      }
    }),
  );
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

  // FF-3: pending tray — agents that joined via a fresh beacon but are not yet
  // admitted to fleet.json. Best-effort; an empty list simply hides the tray.
  let pending: Awaited<ReturnType<typeof readPendingTray>> = [];
  try {
    pending = await readPendingTray(path.join(workspaceRoot, '.autoclaw'));
  } catch { /* best-effort — leave empty */ }

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
    view.webview.postMessage({ command: 'updatePending', data: buildPending(pending) });
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
  // Host IDEs (Cursor/Kiro/Windsurf/Antigravity) are VS Code forks, not
  // extensions loaded inside another editor — detect them via the running app
  // name. `getExtension('amazon.kiro')` is always undefined inside Kiro itself,
  // so an extension-id lookup alone wrongly reports the host fork as missing.
  const hostId = detectIde(vscode.env.appName || '');
  const hasExtension = (id: string): boolean => !!vscode.extensions.getExtension(id);

  const extensionResults = adapters.map(adapter =>
    getAdapterHealthEntry(
      adapter.name,
      isAdapterDetected(adapter, hostId, hasExtension, workspaceRoot)
    )
  );

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
        case 'replyAwaiting': {
          await handleReplyAwaiting(webviewView, {
            messageId: message.messageId,
            from: message.from,
            type: message.type,
            body: message.body,
          });
          break;
        }
        case 'castVote': {
          // RV-1: the review-decision Approve / Request changes / Reject
          // buttons. Writes this host's own consensus vote file end-to-end.
          await handleCastVote(webviewView, {
            taskId: message.taskId,
            vote: message.vote,
            comment: message.comment,
          });
          break;
        }
        case 'openAwaitingFile': {
          // RV-2: drill-in source links in the review-decision panel.
          await handleOpenAwaitingFile(message.file);
          break;
        }
        case 'openSession': {
          // Session-tracking ph1: jump from a panel session row to the chat.
          await handleOpenSession({
            sessionId: message.sessionId,
            source: message.source,
            rawRef: message.rawRef,
          });
          break;
        }
        case 'persistFilterState': {
          // UI-6: per-section filter state persistence (Memento)
          if (message.sectionId && message.state) {
            try {
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (ws) {
                const filterDir = path.join(ws, '.autoclaw', 'orchestrator', 'filters');
                await fsPromises.mkdir(filterDir, { recursive: true });
                const filterFile = path.join(filterDir, message.sectionId + '.json');
                await fsPromises.writeFile(filterFile, JSON.stringify(message.state, null, 2), 'utf8');
              }
            } catch (_) { /* best-effort */ }
          }
          break;
        }
        case 'getFilterState': {
          // UI-6: restore persisted filter state
          if (message.sectionId) {
            try {
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (ws) {
                const filterFile = path.join(ws, '.autoclaw', 'orchestrator', 'filters', message.sectionId + '.json');
                const raw = await fsPromises.readFile(filterFile, 'utf8');
                const state = JSON.parse(raw);
                webviewView.webview.postMessage({ command: 'restoreFilterState', sectionId: message.sectionId, state });
              }
            } catch (_) { /* no persisted state — ignore */ }
          }
          break;
        }
        case 'openBridgeDoc': {
          await vscode.env.openExternal(vscode.Uri.parse('https://github.com/GoZippy/autoclaw/blob/master/docs/rfc/runner-bridge-contract.md'));
          break;
        }
        case 'enableKg': {
          // KG chip clicked while disabled — enable the in-process store and
          // surface the setting so the user sees the toggle they flipped.
          try {
            await vscode.workspace.getConfiguration('autoclaw.kg')
              .update('enabled', true, vscode.ConfigurationTarget.Workspace);
          } catch { /* fall through to opening settings */ }
          await vscode.commands.executeCommand('workbench.action.openSettings', 'autoclaw.kg.enabled');
          vscode.window.showInformationMessage('AutoClaw Knowledge Graph enabled (in-process store — no install needed).');
          break;
        }
        case 'openKgDoctor': {
          // KG chip clicked while degraded — run doctor so the user can see the
          // KG section (driver/caps) and the KG output channel for warnings.
          getKgOutputChannel().show(true);
          await vscode.commands.executeCommand('autoclaw.doctor');
          break;
        }
        case 'openManagerWide':
          // Pop the sidebar board into the roomy editor-tab Manager surface.
          await vscode.commands.executeCommand('autoclaw.manager.open');
          break;
        case 'inviteAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.invite');
          break;
        case 'addTeam':
          await vscode.commands.executeCommand('autoclaw.fleet.addTeam');
          break;
        case 'generateJoinPrompt':
          await vscode.commands.executeCommand('autoclaw.fleet.joinPrompt');
          break;
        case 'admitAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.admit');
          break;
        case 'declineAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.decline');
          break;
        // LANE B — per-agent Command & Control. The card detail buttons post
        // {command, agentId, sessionId}; forward that arg straight to the
        // matching command (which prompts/confirms as needed). evict opens a
        // REQUIRED modal inside its command.
        case 'messageAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.messageAgent', { agentId: message.agentId, sessionId: message.sessionId });
          break;
        case 'pauseAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.pauseAgent', { agentId: message.agentId, sessionId: message.sessionId });
          break;
        case 'resumeAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.resumeAgent', { agentId: message.agentId, sessionId: message.sessionId });
          break;
        case 'reassignAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.reassignAgent', { agentId: message.agentId, sessionId: message.sessionId });
          break;
        case 'evictAgent':
          await vscode.commands.executeCommand('autoclaw.fleet.evict', { agentId: message.agentId, sessionId: message.sessionId });
          break;
        case 'startKgDaemon':
        case 'restartKgDaemon':
        case 'openKgDashboard': {
          const cmd = 'autoclaw.kg.openDashboard';
          const all = await vscode.commands.getCommands(true);
          if (all.includes(cmd)) {
            await vscode.commands.executeCommand(cmd);
          } else {
            getKgOutputChannel().show(true);
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
      // Clear the module-level handle so visibility checks (incl. the L2 board
      // watcher's onBoardChange) short-circuit after the view is destroyed.
      kdreamView = undefined;
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const cssPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'kdream-dashboard.css');
    const jsPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'kdream-dashboard.js');

    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);
    const sectionSearchCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'section-search.css')
    );
    const sectionSearchJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'section-search.js')
    );

    // UI-2: version footer (pure FS reads — no spawn).
    const version = readExtensionVersionFromDisk(this._extensionUri.fsPath);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const branch = wsRoot ? readGitBranchFromDisk(wsRoot) : null;
    const footerHtml = renderPanelFooter(version, branch);

    // UI-3: status-dot legend popover, injected in the Agents section header.
    const legendHtml = renderStatusLegend();

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
    <link rel="stylesheet" href="${sectionSearchCssUri}">
</head>
<body>
    <div id="panel-root" role="main">
        <!-- Quick Actions bar — always visible -->
        <div class="quick-actions" role="toolbar" aria-label="Quick actions">
            <button id="btn-launch-skill" class="primary" type="button" aria-label="Launch Skill">&#9889; Launch Skill</button>
            <button id="btn-refresh" type="button" aria-label="Refresh">&#8635; Refresh</button>
            <button id="btn-export" type="button" aria-label="Export Snapshot">&#128230; Export</button>
        </div>

        <!-- Fabric health badges (bridge + kg-daemon) -->
        <div class="fabric-health-bar" id="fabric-health-bar" role="status" aria-live="polite" aria-label="Fabric health">
            <span class="health-badge bridge-poll">bridge: poll</span>
            <span class="health-badge kg-off">kg: off</span>
        </div>

        <!-- Awaiting You section (per COORDINATION_IMPROVEMENTS §2.7) -->
        <div class="panel-section" id="awaiting-you-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="awaiting-you-body" data-section="awaiting-you">
                <span class="section-chevron"></span>
                Awaiting You
                <span class="section-badge" id="awaiting-you-badge">0</span>
            </div>
            <div class="section-body" id="awaiting-you-body">
                <div id="awaiting-you-content" aria-live="polite"><p class="empty">Loading...</p></div>
            </div>
        </div>

        <!-- Pending agents tray (FF-3) — joined via beacon, not yet admitted -->
        <div class="panel-section" id="pending-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="pending-body" data-section="pending">
                <span class="section-chevron"></span>
                Agents
                <span class="section-badge" id="pending-badge">0</span>
                <button id="btn-join-prompt" class="pending-invite-btn" type="button" aria-label="Generate join prompt">&#128203; Join prompt&#8230;</button>
                <button id="btn-invite-agent" class="pending-invite-btn" type="button" aria-label="Invite agent">&#10133; Invite&#8230;</button>
            </div>
            <div class="section-body" id="pending-body">
                <div id="pending-content" aria-live="polite"></div>
            </div>
        </div>

        <!-- Board section (kanban: backlog → in progress → review → blocked) -->
        <div class="panel-section open" id="board-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="true" aria-controls="board-body" data-section="board">
                <span class="section-chevron"></span>
                Board
                <span class="section-badge" id="board-badge">0</span>
                <button id="btn-board-open-wide" class="pending-invite-btn" type="button" aria-label="Open the board in the roomy Manager tab" title="Pop the board into the full editor-tab Manager">&#10530; Open Wide</button>
            </div>
            <div class="section-body" id="board-body">
                <div id="board-content"><p class="empty">Loading...</p></div>
            </div>
        </div>

        <!-- Agents section -->
        <div class="panel-section open" id="agents-section">
            <div class="section-header" role="button" tabindex="0" aria-expanded="true" aria-controls="agents-body" data-section="agents">
                <span class="section-chevron"></span>
                Team
                <span class="section-badge" id="agents-badge">0</span>
            </div>
            <div class="section-body" id="agents-body">
                <div id="agents-content"><p class="empty">Loading...</p></div>
                <div id="status-content"></div>
            </div>
        </div>

        <!-- Sprints section -->
        <div class="panel-section" id="sprints-section" style="display:none">
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="sprints-body" data-section="sprints">
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
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="messages-body" data-section="messages">
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
            <div class="section-header" role="button" tabindex="0" aria-expanded="false" aria-controls="tasks-body" data-section="tasks">
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
    ${footerHtml}
    <script nonce="${nonce}" src="${jsUri}"></script>
    <script nonce="${nonce}" src="${sectionSearchJsUri}"></script>
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
    hostAppName: vscode.env.appName,
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

  const kgCfg = vscode.workspace.getConfiguration('autoclaw.kg');
  // The KG is an in-process store; `enabled` defaults on. `port`/`dbPath` are
  // passed through so the doctor reflects the configured settings (port only
  // governs the optional standalone daemon).
  const kgEnabled = kgCfg.get<boolean>('enabled', true);
  const kgConfiguredPort = kgCfg.get<number>('port', 9877);
  const kgDbPath = kgCfg.get<string>('dbPath', '');

  const report: DoctorReport = await runDoctor(extensionPath, {
    workspaceRoot,
    isExtensionInstalled: (id: string) => !!vscode.extensions.getExtension(id),
    isAntigravityHost,
    hostAppName: vscode.env.appName,
    zippymeshUrl,
    kg: {
      enabled: kgEnabled,
      port: kgConfiguredPort,
      dbPath: kgDbPath,
    }
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
      // Stamp the scheduler heartbeat so `list`/the panel can tell live
      // automation from dormant — a registered cron is inert without us.
      await writeSchedulerHeartbeat(workspaceRoot, intervalSeconds);
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

/**
 * Open the AutoClaw getting-started walkthrough. Best-effort: VS Code forks /
 * non-Microsoft hosts may not support `workbench.action.openWalkthrough`, so a
 * failure is swallowed rather than surfaced. Exposed as `autoclaw.openWalkthrough`
 * so the first-run nudge, the panel, and the docs can all link to it.
 */
async function openGettingStartedWalkthrough(): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'ZippyTechnologiesLLC.autoclaw#autoclaw.fleet.getStarted',
      false,
    );
  } catch { /* host doesn't support walkthroughs — non-fatal */ }
}

async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  // Bump the key suffix whenever this message changes so existing installs see
  // the new onboarding exactly once (the old `.2.0.0` key is intentionally left
  // behind). Promotes the team-onboarding flow that is now the headline feature.
  const WELCOME_KEY = 'autoclaw.welcomeShown.3.6';
  if (context.globalState.get<boolean>(WELCOME_KEY)) { return; }

  const ide = vscode.env.appName || 'VS Code';
  const isKiro = /kiro/i.test(ide);
  const isCursor = /cursor/i.test(ide);

  let tip: string;
  if (isKiro) {
    tip = 'In Kiro chat, use # to attach steering files (kdream, orchestrate).';
  } else if (isCursor) {
    tip = 'Skills load from .cursor/rules/ — type commands in chat (e.g. "orchestrate plan").';
  } else {
    tip = 'Or use /kdream, /orchestrate, or "AutoClaw: Launch Skill" in chat.';
  }

  const ADD_TEAM = 'Add a team';
  const WALKTHROUGH = 'Open walkthrough';
  const action = await vscode.window.showInformationMessage(
    `AutoClaw is ready (${ide}). Put a small team of AI agents on this repo — start with "Solo + Reviewer". ${tip}`,
    ADD_TEAM,
    WALKTHROUGH,
    'Dismiss',
  );

  if (action === ADD_TEAM) {
    await vscode.commands.executeCommand('autoclaw.fleet.addTeam');
  } else if (action === WALKTHROUGH) {
    await openGettingStartedWalkthrough();
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

/**
 * `detected: true` means the agent is REGISTERED in this workspace — either
 * its extension is installed OR its rules directory exists (.cursor, .agent,
 * etc.) — NOT that it is actually running right now. Distinguish the two:
 *
 *   - Cross-agent rules generation: use `detected` so peer-agent inboxes are
 *     wired up even when an agent isn't loaded at the moment.
 *   - Heartbeat ticker / presence reporting: ALSO check
 *     `vscode.extensions.getExtension(id)?.isActive` or `isHost`. The mere
 *     presence of `.agent/` in the workspace does NOT mean Antigravity is
 *     running — see writeAgentHeartbeats() for the presence gate.
 */
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

/**
 * Resolve which host the "Launch Skill" picker should target. Forks are
 * unambiguous via appName (currentIde); in stock VS Code we honor an explicit
 * `autoclaw.hostAgentId`, else prefer an installed Claude Code, else the single
 * installed agent extension. Falls back to claude-code.
 */
function resolveLauncherHost(workspaceRoot: string): string {
  if (currentIde === 'cursor' || currentIde === 'kiro' || currentIde === 'windsurf' || currentIde === 'antigravity') {
    return currentIde;
  }
  const explicit = vscode.workspace.getConfiguration('autoclaw').get<string>('hostAgentId');
  if (explicit && HOST_SKILL_CONVENTIONS[explicit]) { return explicit; }
  const installed = detectAgents(workspaceRoot).filter(a => a.detected && HOST_SKILL_CONVENTIONS[a.id]);
  if (installed.some(a => a.id === 'claude-code')) { return 'claude-code'; }
  if (installed.length >= 1) { return installed[0].id; }
  return 'claude-code';
}

/**
 * True if `skill`'s adapter is actually installed for `hostId` — a global Claude
 * Code skill dir (~/.claude/skills/<skill>/SKILL.md), or the host's workspace
 * rule file. Used to warn before copying a prompt that points at nothing.
 */
function isSkillInstalled(hostId: string, skill: string, workspaceRoot: string): boolean {
  const conv = HOST_SKILL_CONVENTIONS[hostId];
  if (!conv) { return false; }
  if (conv.style === 'slash') {
    return fs.existsSync(path.join(os.homedir(), '.claude', 'skills', skill, 'SKILL.md'));
  }
  if (!workspaceRoot) { return false; }
  return fs.existsSync(path.join(workspaceRoot, conv.dir!, `${skill}${conv.ext}`));
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
// Cloud relay consent (SEC-2 / RELAY-WIRE) — explicit opt-in before any
// cross-machine forwarding. Writes relay-config.json with tier:ga + consentAckAt.
// ---------------------------------------------------------------------------

async function cloudEnableRelayCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('AutoClaw: open a workspace first.'); return; }
  const autoclawDir = path.join(workspaceRoot, '.autoclaw');
  const current = await readRelayConfig(autoclawDir);

  const endpoint = await vscode.window.showInputBox({
    title: 'Enable AutoClaw Cloud Relay',
    prompt: 'Relay endpoint URL for cross-machine fleet coordination. Must be https.',
    value: current.endpoint || 'https://',
    ignoreFocusOut: true,
    validateInput: (v) => endpointIsSecure(v.trim()) ? undefined : 'Must be an https:// URL (plain http allowed only for localhost).',
  });
  if (!endpoint) { return; }
  const ep = endpoint.trim();

  // Explicit consent — name exactly what leaves the machine and to where.
  const choice = await vscode.window.showWarningMessage(
    `Enable the AutoClaw cloud relay?\n\n` +
    `When enabled AND you are logged in, AutoClaw forwards to:\n${ep}\n\n` +
    `• Inbox message bodies are encrypted before leaving this machine.\n` +
    `• Heartbeats (agent status / current task) are sent in clear.\n` +
    `• Nothing is sent until you also log in (cloud login).\n\n` +
    `You can disable this at any time.`,
    { modal: true },
    'Enable relay'
  );
  if (choice !== 'Enable relay') { return; }

  await writeRelayConfig(autoclawDir, {
    ...defaultRelayConfig(),
    endpoint: ep,
    enabled: true,
    tier: 'ga',
    consentAckAt: new Date().toISOString(),
    forward: { heartbeats: true, inbox: true },
  });
  vscode.window.showInformationMessage(
    'AutoClaw: cloud relay enabled. Run "AutoClaw: Cloud Login" to start forwarding.'
  );
}

async function cloudDisableRelayCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('AutoClaw: open a workspace first.'); return; }
  const autoclawDir = path.join(workspaceRoot, '.autoclaw');
  const current = await readRelayConfig(autoclawDir);
  await writeRelayConfig(autoclawDir, { ...current, enabled: false });
  vscode.window.showInformationMessage('AutoClaw: cloud relay disabled (inert). Your settings are kept — re-enable anytime.');
}

// ---------------------------------------------------------------------------
// Fabric onboarding (AF-4b) — register a platform agent as a typed fabric worker.
// ---------------------------------------------------------------------------

async function fabricOnboardCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('AutoClaw: open a workspace first.'); return; }
  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  const pick = await vscode.window.showQuickPick(
    BUILTIN_RUNNER_IDS.map(id => ({ label: id, description: `default type: ${defaultAgentTypeForRunner(id)}` })),
    { placeHolder: 'Onboard which platform agent into the fabric?' }
  );
  if (!pick) { return; }

  const registry = createDefaultRunnerRegistry();
  const entry = registry.get(pick.label);
  if (!entry) { vscode.window.showErrorMessage(`AutoClaw: unknown runner "${pick.label}".`); return; }

  try {
    const report = await onboardPlatform({
      runner: entry.runner,
      readRegistry: () => readRegistry(commsDir),
      writeRegistry: (reg) => writeRegistry(commsDir, reg),
    });
    if (report.registered) {
      vscode.window.showInformationMessage(`AutoClaw fabric: ${report.detail}`);
    } else {
      vscode.window.showWarningMessage(`AutoClaw fabric: ${report.platform} ${report.detail}`);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`AutoClaw fabric onboarding failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat Ticker — writes real heartbeats for detected agents based on
// actual VS Code signals (extension installed + active, visible editors,
// recent file saves, running tasks).
// ---------------------------------------------------------------------------

let heartbeatIntervalId: NodeJS.Timeout | undefined;
/** Tracks the last file-save timestamp per workspace folder. */
let lastFileSaveTimestamp: number = 0;
/** Stable per-extension-activation session UUID stamped into every heartbeat. */
const sessionId: string = (() => {
  // Node 19+ exposes crypto.randomUUID(); fall back to a hex random for older runtimes.
  const c = require('crypto') as typeof import('crypto');
  return typeof c.randomUUID === 'function' ? c.randomUUID() : c.randomBytes(16).toString('hex');
})();
/** Orchestrator perpetual loop handle — started in activate(), stopped in deactivate(). */
let activeOrchestratorLoopHandle: OrchestratorLoopHandle | null = null;

function startHeartbeatTicker(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
  const autoclawDir = path.join(workspaceRoot, '.autoclaw');
  // RELAY-WIRE: one relay client for the session. Every call is a safe no-op
  // unless the user has explicitly enabled + consented to the cloud relay AND
  // is logged in (relayIsActive + a stored token). Nothing transmits otherwise.
  const relay = new CloudRelay({ autoclawDir });

  // Track file saves as a proxy for "an agent is actively editing"
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => {
    lastFileSaveTimestamp = Date.now();
  });
  context.subscriptions.push(saveWatcher);

  let relayTickInFlight = false;
  const tick = async (): Promise<void> => {
    await writeAgentHeartbeats(workspaceRoot, commsDir).catch(() => {});
    // Forward heartbeats + inbox messages + drain the offline queue. Best-effort;
    // a relay failure must never disrupt the local heartbeat loop. The in-flight
    // guard stops a slow send from overlapping the next 30s tick.
    if (relayTickInFlight) { return; }
    relayTickInFlight = true;
    try {
      await forwardHeartbeats(autoclawDir, relay);
      await forwardInbox(autoclawDir, relay);
      await relay.flushQueue();
      // AF-7b/AF-10c: pull cross-machine messages + remote heartbeats.
      const fetched = await relay.fetchInbox();
      if (fetched.messages.length > 0) { await applyFetchedToInboxes(autoclawDir, fetched.messages); }
      await fetchAndCacheHeartbeats(autoclawDir, relay);
    } catch {
      /* relay is opt-in + best-effort */
    } finally {
      relayTickInFlight = false;
    }
  };

  // Write/forward immediately, then every 30s
  tick();
  heartbeatIntervalId = setInterval(() => { tick(); }, 30_000);

  context.subscriptions.push({
    dispose: () => {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = undefined;
      }
    }
  });
}

let reconcileIntervalId: NodeJS.Timeout | undefined;

function startReconcileTicker(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  const cfg = vscode.workspace.getConfiguration('autoclaw.orchestrate');
  const intervalSec = cfg.get<number>('reconcileIntervalSeconds', 300);
  if (intervalSec <= 0) { return; }  // disabled

  const tick = async (): Promise<void> => {
    try {
      const report = await runReconcile(workspaceRoot);
      const reportPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'reconcile-report.json');
      await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
      await fsPromises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

      const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
      if (report.mismatches.length > 0) {
        await sendMessage(commsDir, {
          id: '', from: 'orchestrator', to: 'shared', type: 'system',
          timestamp: new Date().toISOString(),
          payload: {
            kind: 'reconcile_report',
            mismatch_count: report.mismatches.length,
            mismatches: report.mismatches.slice(0, 25), // cap to keep message size sane
          },
          requires_response: false,
        }).catch(() => {});
      }

      // Capability resolution sweep — collect capability_pending tasks from
      // any sprint YAML files, broadcast queries for new ones, and resolve
      // offers for previously broadcast queries.
      await runCapabilityResolutionSweep(workspaceRoot, commsDir);

      // Program-plane heartbeat + fan-in
      const homeDir = require('os').homedir() as string;
      await touchParticipant(workspaceRoot, homeDir).catch(() => {});
      const link = await readProgramLink(workspaceRoot).catch(() => null);
      if (link) {
        const added = await fanInCommsLog(link.program_id, homeDir).catch(() => 0);
        if (added > 0) {
          console.log(`[autoclaw] program-plane fan-in: +${added} lines`);
        }
      }
    } catch (err) {
      console.error('reconcile sweep failed:', err);
    }
  };

  // Run once on startup, then on interval.
  tick();
  reconcileIntervalId = setInterval(tick, intervalSec * 1000);

  context.subscriptions.push({
    dispose: () => {
      if (reconcileIntervalId) {
        clearInterval(reconcileIntervalId);
        reconcileIntervalId = undefined;
      }
    },
  });
}

/**
 * Scans sprint YAML files for `capability_pending` tasks, broadcasts
 * `capability_query` messages for any not yet broadcast, and resolves
 * any received `capability_offer` messages by logging the winner.
 */
async function runCapabilityResolutionSweep(workspaceRoot: string, commsDir: string): Promise<void> {
  const sprintsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints');
  let pendingTasks: CapabilityPendingTask[] = [];
  try {
    const files = await fsPromises.readdir(sprintsDir);
    for (const file of files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const raw = await fsPromises.readFile(path.join(sprintsDir, file), 'utf8');
        // Extract capability_pending arrays from simple YAML (avoid heavy parser dep)
        const match = raw.match(/capability_pending:\s*\n([\s\S]*?)(?=\n\w|\n---|\Z)/);
        if (match) {
          // Use JSON-keyed sprint file if available (written by writePlanArtifacts)
          const jsonFile = file.replace(/\.ya?ml$/, '.json');
          try {
            const jsonRaw = await fsPromises.readFile(path.join(sprintsDir, jsonFile), 'utf8');
            const sprint = JSON.parse(jsonRaw);
            if (Array.isArray(sprint.capability_pending)) {
              pendingTasks.push(...(sprint.capability_pending as CapabilityPendingTask[]));
            }
          } catch { /* no JSON twin — skip */ }
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* sprints dir absent */ }

  if (pendingTasks.length === 0) { return; }

  // Deduplicate by query_id
  const seen = new Set<string>();
  pendingTasks = pendingTasks.filter(t => {
    if (seen.has(t.query_id)) { return false; }
    seen.add(t.query_id);
    return true;
  });

  await broadcastCapabilityQueries(commsDir, 'orchestrator', pendingTasks).catch(() => {});

  const resolutions = await resolveCapabilityOffers(commsDir, 'orchestrator', pendingTasks).catch(() => []);
  if (resolutions.length > 0) {
    const resolvedPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'capability-resolutions.json');
    await fsPromises.writeFile(resolvedPath, JSON.stringify(resolutions, null, 2), 'utf8').catch(() => {});
    console.log(`[autoclaw] capability resolution: ${resolutions.length} task(s) matched to remote agents`);
  }
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

  // The HOST agent — only one agent legitimately gets stamped with the host's
  // sessionId. Peer agents own their own session_id and the daemon must not
  // overwrite it. Fixes session_id collision across all detected agents.
  const hostAgentId = detectAutoclawHostAgent(vscode.env.appName ?? '');

  for (const agent of detectedAgents) {
    // PRESENCE GATE — three classes of agent, only two get live heartbeats:
    //   (a) extension-backed agent whose extension is currently activated
    //   (b) the host IDE itself (Antigravity in Antigravity IDE, Cursor in
    //       Cursor, etc.)
    //   (c) "registered but absent" — workspace has the agent's rules dir
    //       (.agent, .cursor) but the agent isn't actually loaded. We skip
    //       writing a heartbeat for (c) so host-side activity (file saves,
    //       visible editors) doesn't get falsely attributed to an agent
    //       that isn't running.
    const isHost = agent.id === hostAgentId;
    const ext = agent.extensionId ? vscode.extensions.getExtension(agent.extensionId) : undefined;
    const extActive = !!ext?.isActive;
    const isRegisteredButAbsent = !isHost && !extActive;

    if (isRegisteredButAbsent) {
      // Do not fabricate a heartbeat. Leave the previous file in place so
      // operators can see when it last legitimately ticked; downstream
      // consumers should compare timestamp to wall clock + treat stale
      // heartbeats as "presence unknown."
      continue;
    }

    // Status now only reflects activity we can ACTUALLY attribute to this
    // agent: either the host IDE shell or its own active extension.
    const status: 'active' | 'idle' = (recentSave || hasVisibleEditors) ? 'active' : 'idle';

    // Read existing heartbeat so agent-set fields survive the tick.
    // The tick owns timestamp + status; the AGENT owns session_id +
    // current_task + sprint.
    const existingHb = await readHeartbeat(commsDir, agent.id);

    const hb: import('./comms').Heartbeat = {
      agent_id: agent.id,
      timestamp: now,
      status,
      // current_task is OWNED BY THE AGENT. vscode.window.activeTextEditor is
      // HOST UI state (which file the user has open), not agent task state.
      // Stamping it overwrites real claims (e.g. UI-4) with junk like ".env"
      // or AikidoSecurity output channel paths. Preserve the agent's value.
      current_task: existingHb?.current_task ?? null,
      sprint: existingHb?.sprint ?? null,
      // session_id is OWNED BY THE AGENT. claude-code's session_id is NOT
      // kilocode's session_id. Only stamp the host's sessionId on the host's
      // own heartbeat; for peer agents preserve whatever they wrote.
      session_id: isHost ? sessionId : existingHb?.session_id,
    };

    // Try to read sprint assignment from plan-summary — overrides agent-set value when found.
    try {
      const planPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints', 'plan-summary.yaml');
      if (fs.existsSync(planPath)) {
        const planContent = await fsPromises.readFile(planPath, 'utf8');
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

  // A single detected agent still gets a comms tree so a newcomer (or a
  // scaffolded peer) can be wired into it later. Only bail when none are found.
  if (detectedAgents.length < 1) { return; }

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
      // loop_mechanism + keepalive_template so `/orchestrate revive <id>` resolves
      // a shipped template (codex.md, cursor.md, …) for this agent.
      ...keepaliveProfileFor(a.id),
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

/**
 * startOrchestratorLoopTick — one-shot entry point for the eternal loop.
 * Reads the workspace, computes the health check, and dispatches work every
 * 30 s without any LLM call.
 *
 * Lifecycle:
 *  1. checkHealth   — reads heartbeat files, builds the agent health grid
 *  2. nextWork      — discovers assignable work for idle agents
 *  3. workNow       — dispatches work packages
 *  4. checkProgress — compares health changes to expected actor outcomes
 *  5. loop          — re-evaluate; repeat while actor is active
 */
function startOrchestratorLoopTick(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  // Start the perpetual health→work→dispatch→log loop.
  // The loop is headless (no vscode API calls in the hot path).
  activeOrchestratorLoopHandle = startOrchestratorLoop({
    workspaceRoot,
    tickMs: 30_000, // 30 s between ticks
    // Follow-up #3: opt-in self-healing, OFF by default. When the operator
    // enables it, the loop's HEAL phase performs bounded, reversible recovery
    // (act-then-report) each tick; otherwise the loop only detects/reports.
    selfHealingEnabled: vscode.workspace
      .getConfiguration('autoclaw')
      .get<boolean>('selfHealing.enabled', false),
    // CL-3: opt-in dead-session claim reaper, OFF by default. Release-only —
    // frees tasks whose owning session is dead and whose claim is expired.
    reapDeadClaims: vscode.workspace
      .getConfiguration('autoclaw')
      .get<boolean>('selfHealing.reapDeadClaims', false),
    // L1: single-active manager, ON by default. Only the active supervisor host
    // writes the board / dispatches / tallies each tick; standbys defer to it.
    singleActive: vscode.workspace
      .getConfiguration('autoclaw')
      .get<boolean>('cluster.singleActive', true),
    // E1c: opt-in fencing (wx-lock-serialized acquire + live epoch/term + deposed
    // -holder fencing), OFF by default — a solo host stays byte-identical to E1b.
    fencing: vscode.workspace
      .getConfiguration('autoclaw')
      .get<boolean>('cluster.fencing', false),
    // E3b: opt-in WAKE-ONLY cluster-map gossip (publish/read peer map-beats; advisory
    // only — never elects), OFF by default. Builds on fencing.
    gossip: vscode.workspace
      .getConfiguration('autoclaw')
      .get<boolean>('cluster.gossip', false),
    onTick(result) {
      // Surface health/dispatch alerts in the output channel.
      const unhealthy = result.health.stalledIds.length + result.health.deadIds.length;
      if (unhealthy > 0 || result.dispatched > 0 || result.errors > 0) {
        getOrchestrateOutputChannel().appendLine(
          `[loop tick ${result.tick}] agents=${result.health.entries.length} ` +
          `healthy=${result.health.healthyCount} stalled=${result.health.stalledIds.length} ` +
          `dead=${result.health.deadIds.length} dispatched=${result.dispatched} ` +
          `errors=${result.errors} (${result.durationMs}ms)`
        );
      }
      if (result.health.deadIds.length > 0) {
        console.warn(`[autoclaw-loop] dead agents: ${result.health.deadIds.join(', ')}`);
      }
    },
  });

  context.subscriptions.push({
    dispose: () => {
      activeOrchestratorLoopHandle?.stop();
      activeOrchestratorLoopHandle = null;
      console.log('[autoclaw] orchestrator loop stopped');
    },
  });

  // L2 producer: watch the board's INPUTS and refresh the board within a debounce
  // window (sub-second) instead of waiting up to 30s. The 30s tick stays as the
  // backstop. Single-active safe: refreshBoardNow reuses the L1 lease gate under
  // the loop's holder id, so a standby host writes nothing.
  startBoardWatch(context, workspaceRoot);

  // T0b: opt-in LAN peer discovery. OFF by default — binds NO socket unless the
  // autoclaw.cluster.lan flag is on AND the user acknowledged the one-time network
  // consent. Discovered peers arrive as origin-'lan' (untrusted) beacons.
  void startLanDiscovery(context, workspaceRoot);

  // T1: opt-in LAN relay of cluster-map gossip. OFF by default — binds NO socket
  // unless cluster.lan AND cluster.lan.gossip are on AND its own consent is acked.
  // Advisory only: relayed peer beats are wake-only (the E3b consumer never elects
  // on them); they never grant trust to an unauthenticated LAN peer (T2 does).
  void startLanGossipRelay(context, workspaceRoot);

  console.log(`[autoclaw] orchestrator loop started – tickMs=30000 workspace="${workspaceRoot}"`);
}

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
    const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

    // Tier-aware routing (B): mirror each agent's advertised llms_available
    // from the comms registry (registered-agent-v2) onto its WA-N row so the
    // planner's scoreAgent can weigh model tier against task phase. Agents
    // that advertise no models are written unchanged (tierFactor stays 1.0).
    const commsReg = await readRegistry(commsDir);
    const llmsByAgent = new Map<string, string[]>();
    for (const a of commsReg?.agents ?? []) {
      if (a.llms_available && a.llms_available.length > 0) { llmsByAgent.set(a.id, a.llms_available); }
    }

    const entries: AgentRegistryEntry[] = detected.map((a, i) => {
      const entry: AgentRegistryEntry = {
        id: `WA-${i + 1}`,
        platform: a.id,
        inbox: `.autoclaw/orchestrator/comms/inboxes/${a.id}/`,
        sprint,
        assigned_at: new Date().toISOString(),
      };
      const llms = llmsByAgent.get(a.id);
      if (llms) { entry.llms_available = llms; }
      return entry;
    });

    await writeAgentRegistry(registryPath, entries);
    channel.appendLine(`[orchestrate] Agent registry written (${entries.length} agents): ${entries.map(e => `${e.id}=${e.platform}`).join(', ')}`);

    // Heartbeat-aware: skip WA-N slots whose mapped agent has stalled or
    // never beat. Writes the exclusion set to a stalled-slots.json sidecar
    // so the skill-side /orchestrate next command can read it without
    // re-deriving heartbeat ages itself.
    const cfg = vscode.workspace.getConfiguration('autoclaw.orchestrate');
    const stallSeconds = cfg.get<number>('heartbeatStallSeconds', 300);
    const liveStatuses = await getAgentStatuses(commsDir);
    const stalled: string[] = [];
    for (const e of entries) {
      const live = liveStatuses.find(s => s.id === e.platform);
      if (!live) { stalled.push(e.id); continue; }
      if (live.live_status === 'offline' || live.live_status === 'stalled') {
        stalled.push(e.id);
        continue;
      }
      const hbAge = live.heartbeat
        ? Math.max(0, (Date.now() - new Date(live.heartbeat.timestamp).getTime()) / 1000)
        : Number.POSITIVE_INFINITY;
      if (hbAge > stallSeconds) { stalled.push(e.id); }
    }
    if (stalled.length > 0) {
      channel.appendLine(`[orchestrate] Heartbeat-aware: skipping stalled slots: ${stalled.join(', ')} (>${stallSeconds}s since last beat)`);
    } else {
      channel.appendLine(`[orchestrate] Heartbeat-aware: all ${entries.length} slot(s) live within ${stallSeconds}s threshold.`);
    }
    // Persist the exclusion set so the skill-side `generatePlan` call can
    // read it without re-deriving — written as a plain JSON sidecar.
    const sprintLabel = sprint ?? 'next';
    const sidecarPath = path.join(
      workspaceRoot, '.autoclaw', 'orchestrator',
      `sprint-${sprintLabel}-stalled.json`
    );
    await fsPromises.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsPromises.writeFile(
      sidecarPath,
      JSON.stringify({
        sprint: sprintLabel,
        stalled,
        computed_at: new Date().toISOString(),
        stall_seconds: stallSeconds,
      }, null, 2),
      'utf8'
    );
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

  // consensus/active holds TWO file kinds: review STUBS (`<task>.json`, no
  // top-level `vote`) and per-agent VOTES (`<task>-<voter>.json`, string `vote`).
  // Classify by CONTENT and take task_id from the file — filenames can't be
  // split on '-' because ids like `RV-1` contain dashes (this was the perennial
  // "No vote files in consensus/active/" bug). See consensusActiveScan.ts.
  const allFiles = fs.readdirSync(consensusDir).filter(f => f.endsWith('.json'));
  const entries: ConsensusActiveEntry[] = [];
  for (const f of allFiles) {
    try {
      const raw = await fsPromises.readFile(path.join(consensusDir, f), 'utf8');
      entries.push({ name: f, json: JSON.parse(raw) });
    } catch {
      channel.appendLine(`[orchestrate] Warning: could not parse ${f}`);
    }
  }
  const scan = classifyConsensusActive(entries);
  const votesByTask = scan.votesByTask as unknown as Map<string, ValidationVote[]>;
  const awaitingReview = scan.awaitingReview;

  if (votesByTask.size === 0) {
    if (awaitingReview.length > 0) {
      channel.appendLine(
        `[orchestrate] ${awaitingReview.length} task(s) in peer review, awaiting agent votes: ${awaitingReview.join(', ')}.`,
      );
      vscode.window.showInformationMessage(
        `Orchestrate: ${awaitingReview.length} task(s) in review, awaiting votes. Agents must vote (consensus.vote / vote files) to resolve.`,
      );
    } else {
      channel.appendLine('[orchestrate] No consensus activity in consensus/active/ (no review stubs or votes yet).');
      vscode.window.showInformationMessage('Orchestrate: no consensus activity yet.');
    }
    return;
  }
  if (awaitingReview.length > 0) {
    channel.appendLine(`[orchestrate] Note: ${awaitingReview.length} task(s) still awaiting votes: ${awaitingReview.join(', ')}.`);
  }

  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  // Gate/routing fields (criticality, acceptance) for the tasks under review,
  // read straight from the manifests. Missing manifest or unknown task ⇒
  // votes-only with the default config, exactly as before.
  const manifestDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'manifests');
  const { tasks: gateFields, warnings: gateWarnings } = await readManifestTaskGates(manifestDir);
  for (const w of gateWarnings) {
    channel.appendLine(`[orchestrate] Manifest warning: ${w}`);
  }

  let allApproved = true;
  for (const [taskId, votes] of votesByTask) {
    const taskDef = gateFields.get(taskId);

    // Acceptance gate (C): run the task's declared checks orchestrator-side
    // BEFORE evaluating — votes cannot approve over a red check.
    let gateChecks: GateCheckResult[] | undefined;
    if (taskDef?.acceptance && taskDef.acceptance.length > 0) {
      channel.appendLine(`[orchestrate] Task ${taskId}: running ${taskDef.acceptance.length} acceptance check(s)...`);
      gateChecks = await runAcceptanceChecks(taskDef.acceptance, { cwd: workspaceRoot });
      for (const g of gateChecks) {
        channel.appendLine(`   ${g.passed ? '✅' : '❌'} acceptance: ${g.command} → exit ${g.exit_code} (${g.duration_ms}ms)`);
      }
    }

    // Verifier independence: drop the task author's self-vote from the tally.
    const author = await readClaimAuthor(commsDir, taskId);
    // Criticality-aware threshold: unanimous for tier 1, simple majority for
    // tier 3; unknown task / no criticality ⇒ the default 2/3 config.
    const result = evaluateConsensus(votes, 1, consensusConfigForTask(taskDef?.criticality), { author_agent_id: author });
    result.task_id = taskId;
    if (gateChecks) {
      // Attaches gate_checks to the result (the consensus_result broadcast
      // below spreads it along) and forces a non-overridable block on any red check.
      applyAcceptanceGate(result, gateChecks, { criticality: taskDef?.criticality });
    }
    const icon = result.status === 'consensus_reached' ? '✅' : result.status === 'deadlocked' ? '🔴' : '⏳';
    channel.appendLine(`${icon} Task ${taskId}: ${result.status} — verdict: ${result.final_verdict} (${votes.length} vote${votes.length === 1 ? '' : 's'})`);

    if (result.unresolved_findings.length > 0) {
      for (const f of result.unresolved_findings.slice(0, 5)) {
        channel.appendLine(`   [${f.severity}] ${f.category}: ${f.description}${f.file ? ` (${f.file}:${f.line ?? ''})` : ''}`);
      }
    }

    // Broadcast the consensus result so all agents can react in real time.
    try {
      await sendMessage(commsDir, {
        id: '', from: 'orchestrator', to: 'shared', type: 'consensus_result',
        timestamp: new Date().toISOString(), task_id: taskId,
        payload: { ...result }, requires_response: false,
      });
    } catch (e) {
      channel.appendLine(`[orchestrate] consensus broadcast failed for ${taskId}: ${(e as Error).message}`);
    }

    // REP-1: record the reviewed-task outcome for the claiming agent's track
    // record (best-effort; never blocks the review). Skip 'abstain' — that is
    // "not enough voters yet", not a decision about the agent's work.
    if (author && result.final_verdict !== 'abstain') {
      try {
        await recordTaskOutcome(workspaceRoot, {
          task_id: taskId,
          agent_id: author,
          phase: taskDef?.phase,
          verdict: result.final_verdict,
          gate_passed: gateChecks ? gateChecks.every(g => g.passed) : undefined,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        channel.appendLine(`[orchestrate] reputation record failed for ${taskId}: ${(e as Error).message}`);
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

async function orchestrateMergeCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Orchestrate: open a workspace first.'); return; }

  const sprintsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints');
  const channel = getOrchestrateOutputChannel();
  channel.show(true);

  const input = await vscode.window.showInputBox({ prompt: 'Sprint number to merge', placeHolder: '1' });
  if (!input) { return; }
  const sprintNum = parseInt(input, 10);
  if (isNaN(sprintNum)) { vscode.window.showErrorMessage('Orchestrate: invalid sprint number.'); return; }

  const sprintPath = path.join(sprintsDir, `sprint-${sprintNum}.yaml`);
  if (!fs.existsSync(sprintPath)) {
    vscode.window.showErrorMessage(`Orchestrate: sprint-${sprintNum}.yaml not found.`);
    return;
  }

  const content = await fsPromises.readFile(sprintPath, 'utf8');
  const statusMatch = content.match(/^status:\s*(\w+)\s*$/m);
  const status = statusMatch?.[1];
  if (status !== 'approved') {
    vscode.window.showErrorMessage(`Orchestrate: Sprint ${sprintNum} must be 'approved' before merging (current: ${status ?? 'unknown'}).`);
    return;
  }

  // Extract all branch names from the sprint YAML
  const branchMatches = [...content.matchAll(/branch:\s*"?([^"\n]+)"?/g)];
  const branches = branchMatches.map(m => m[1].trim()).filter(Boolean);
  if (branches.length === 0) {
    vscode.window.showErrorMessage(`Orchestrate: no branches found in sprint-${sprintNum}.yaml.`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('autoclaw.orchestrate');
  const baseBranch = cfg.get<string>('baseBranch', 'main');

  channel.appendLine(`[orchestrate] Merging Sprint ${sprintNum} branches into ${baseBranch}: ${branches.join(', ')}`);

  // Checkout base branch and merge each sprint branch
  const checkoutOut = await runGit(workspaceRoot, ['checkout', baseBranch]);
  if (checkoutOut === '' && !(await runGit(workspaceRoot, ['rev-parse', '--verify', baseBranch]))) {
    vscode.window.showErrorMessage(`Orchestrate: could not checkout base branch '${baseBranch}'.`);
    return;
  }

  let allMerged = true;
  for (const branch of branches) {
    channel.appendLine(`[orchestrate]   git merge --no-ff ${branch}`);
    const mergeOut = await runGit(workspaceRoot, ['merge', '--no-ff', branch, '-m', `chore: merge Sprint ${sprintNum} — ${branch}`]);
    if (mergeOut === '' && !fs.existsSync(path.join(workspaceRoot, '.git', 'MERGE_HEAD'))) {
      // runGit returns '' on error — check if HEAD advanced
      const headCheck = await runGit(workspaceRoot, ['log', '--oneline', '-1']);
      if (!headCheck.includes(branch.split('/').pop() ?? '')) {
        channel.appendLine(`[orchestrate]   WARNING: merge of ${branch} may have failed. Resolve manually.`);
        allMerged = false;
      }
    }
  }

  if (!allMerged) {
    vscode.window.showWarningMessage(`Sprint ${sprintNum}: one or more branches had merge issues. Resolve conflicts, then re-run merge.`);
    return;
  }

  // Update sprint YAML status → merged
  const mergedContent = content.replace(/^status:\s*approved\s*$/m, 'status: merged');
  await fsPromises.writeFile(sprintPath, mergedContent, 'utf8');

  // Update downstream sprints: find all pending sprints at a higher level and mark dependencies_met
  await updateDownstreamDependencies(workspaceRoot, sprintsDir, sprintNum);

  // Update state.json
  const statePath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json');
  const state = await readStateFile(statePath);
  if (state) {
    for (const agentState of Object.values(state.agents)) {
      if (agentState.sprint === sprintNum && agentState.status === 'review') {
        agentState.status = 'done';
      }
    }
    state.last_updated = new Date().toISOString();
    await writeStateFile(statePath, state);
  }

  channel.appendLine(`[orchestrate] Sprint ${sprintNum} merged into ${baseBranch}. Downstream dependencies updated.`);
  vscode.window.showInformationMessage(
    `Sprint ${sprintNum} merged. Downstream sprints unblocked.`,
    'Assign Next Sprint'
  ).then(action => {
    if (action === 'Assign Next Sprint') {
      vscode.commands.executeCommand('autoclaw.orchestrate.assign');
    }
  });
}

async function updateDownstreamDependencies(
  workspaceRoot: string,
  sprintsDir: string,
  mergedSprintNum: number
): Promise<void> {
  // Determine the level of the merged sprint
  const mergedPath = path.join(sprintsDir, `sprint-${mergedSprintNum}.yaml`);
  const mergedContent = await fsPromises.readFile(mergedPath, 'utf8');
  const mergedLevelMatch = mergedContent.match(/^level:\s*(\d+)\s*$/m);
  const mergedLevel = mergedLevelMatch ? parseInt(mergedLevelMatch[1], 10) : -1;
  if (mergedLevel < 0) { return; }

  // Collect all sprint YAML files
  let files: string[];
  try {
    files = (await fsPromises.readdir(sprintsDir)).filter(f => /^sprint-\d+\.yaml$/.test(f));
  } catch { return; }

  // Read all sprint statuses and levels
  const sprintInfos: Array<{ file: string; num: number; level: number; status: string; depsMet: boolean }> = [];
  for (const file of files) {
    const c = await fsPromises.readFile(path.join(sprintsDir, file), 'utf8');
    const numMatch = c.match(/^sprint:\s*(\d+)\s*$/m);
    const levelMatch = c.match(/^level:\s*(\d+)\s*$/m);
    const statusMatch = c.match(/^status:\s*(\w+)\s*$/m);
    const depsMatch = c.match(/^dependencies_met:\s*(true|false)\s*$/m);
    if (numMatch && levelMatch && statusMatch) {
      sprintInfos.push({
        file,
        num: parseInt(numMatch[1], 10),
        level: parseInt(levelMatch[1], 10),
        status: statusMatch[1],
        depsMet: depsMatch?.[1] === 'true',
      });
    }
  }

  // For each pending sprint at level > mergedLevel, check if ALL sprints at lower levels are merged
  for (const sprint of sprintInfos) {
    if (sprint.level <= mergedLevel) { continue; }
    if (sprint.status !== 'pending' && sprint.status !== 'assigned') { continue; }
    if (sprint.depsMet) { continue; }

    const lowerLevelSprints = sprintInfos.filter(s => s.level < sprint.level);
    const allLowerMerged = lowerLevelSprints.every(s => s.status === 'merged');
    if (allLowerMerged) {
      const filePath = path.join(sprintsDir, sprint.file);
      const c = await fsPromises.readFile(filePath, 'utf8');
      const updated = c.replace(/^dependencies_met:\s*false\s*$/m, 'dependencies_met: true');
      if (updated !== c) {
        await fsPromises.writeFile(filePath, updated, 'utf8');
        getOrchestrateOutputChannel().appendLine(
          `[orchestrate] Sprint ${sprint.num} (level ${sprint.level}) unblocked — all lower-level sprints merged.`
        );
      }
    }
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
  const userPort = cfg.get<number>('port', 0);
  const host = cfg.get<string>('host', '127.0.0.1');

  const allocated = await allocatePorts(
    currentIde,
    workspaceRoot,
    userPort > 0 ? userPort : undefined,
    undefined
  );

  const block = getIDEPortBlock(currentIde);
  const config: BridgeConfig = {
    port: allocated.bridgePort, host,
    portBlockBase: block.bridgeBase,
    commsDir: path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms'),
    tokensPath: path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'tokens.json'),
    workspaceRoot,
  };
  try {
    activeBridge = await startBridge(config);
    registerWorker({
      id: `${currentIde}-${process.pid}`,
      ide: currentIde,
      workspace: workspaceRoot,
      bridgeHost: host,
      bridgePort: allocated.bridgePort,
      bridgeUrl: `http://${host}:${allocated.bridgePort}`,
      pid: process.pid,
      status: 'online',
      capabilities: ['bridge', 'orchestrate'],
      lastHeartbeat: new Date().toISOString(),
      assignedTasks: [],
    });
    vscode.window.showInformationMessage(`OpenClaw bridge started on ${host}:${allocated.bridgePort} [${currentIde}]`);
  } catch (e) {
    releasePorts(currentIde, workspaceRoot);
    vscode.window.showErrorMessage(`Bridge failed: ${(e as Error).message}`);
  }
}

async function bridgeStopCommand(): Promise<void> {
  if (!activeBridge?.running) { vscode.window.showInformationMessage('Bridge not running.'); return; }
  const port = activeBridge.config.port;
  await stopBridge(activeBridge);
  activeBridge = null;
  unregisterWorker(process.pid, currentIde);
  if (currentWorkspace) { releasePorts(currentIde, currentWorkspace); }
  vscode.window.showInformationMessage(`OpenClaw bridge stopped (was on ${port}).`);
}

async function kgHealthCheckCommand(): Promise<void> {
  const channel = getKgOutputChannel();
  const livePid = activeKg?.child && activeKg.child.exitCode === null ? activeKg.child.pid : null;
  const daemonLive = !!(activeKg && livePid !== undefined && livePid !== null && activeKg.port > 0);

  // Only probe over HTTP when the OPTIONAL standalone daemon is genuinely
  // running on a real port. The default is the IN-PROCESS KG (node:sqlite) —
  // probing a non-existent daemon on port 0 just spams ECONNREFUSED:80.
  if (daemonLive) {
    const port = activeKg!.port;
    channel.appendLine(`[kg] healthCheck (daemon) → http://127.0.0.1:${port}/api/v1/health`);
    const result = await fetchKgHealth(port);
    if (result.ok) {
      const summary = typeof result.body === 'object' ? JSON.stringify(result.body) : String(result.body);
      channel.appendLine(`[kg] ${result.status} ${summary}`);
      vscode.window.showInformationMessage(`AutoClaw KG (daemon): ${result.status} OK — ${summary.slice(0, 120)}`);
    } else {
      const detail = result.error ?? `status=${result.status ?? 'n/a'}`;
      channel.appendLine(`[kg!] daemon healthCheck failed: ${detail}`);
      vscode.window.showWarningMessage(`AutoClaw KG: daemon health check failed (${detail}).`, 'Open KG Output')
        .then(a => { if (a === 'Open KG Output') { channel.show(true); } });
    }
    return;
  }

  // In-process KG: report status directly from the store handle — no HTTP.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    channel.appendLine('[kg] healthCheck: no workspace open.');
    return;
  }
  try {
    const h = getKnowledgeGraph({ workspaceRoot });
    const summary = {
      mode: 'in-process',
      ok: !h.degraded,
      degraded: h.degraded,
      sqlite: h.caps.sqlite, vec: h.caps.vec, fts: h.caps.fts,
      driver: h.driverKind,
      embedding: `${h.embedding.provider}/${h.embedding.model}@${h.embedding.dimension}`,
    };
    channel.appendLine(`[kg] healthCheck (in-process) → ${JSON.stringify(summary)}`);
    if (h.degraded) {
      vscode.window.showWarningMessage(
        'AutoClaw KG: in-process store is DEGRADED (no SQLite driver). Run "AutoClaw: Intelligence — Install Vector Backend" or check Diagnostics.',
        'Open KG Output',
      ).then(a => { if (a === 'Open KG Output') { channel.show(true); } });
    } else {
      vscode.window.showInformationMessage(
        `AutoClaw KG: in-process OK — sqlite=${h.caps.sqlite} vec=${h.caps.vec} fts=${h.caps.fts} (${summary.embedding}).`,
      );
    }
  } catch (e) {
    channel.appendLine(`[kg!] in-process health check failed: ${(e as Error).message}`);
    vscode.window.showWarningMessage(`AutoClaw KG: health check failed — ${(e as Error).message}`);
  }
}

/**
 * RV-3: explicit `autoclaw.kg.start` — spawn the kg-daemon on demand. Unlike
 * maybeStartKgDaemon (auto-start, gated on `autoclaw.kg.enabled`), an explicit
 * user/panel action starts the daemon regardless of the enabled flag. A
 * no-op + toast if it is already running.
 */
async function kgStartCommand(extensionPath: string): Promise<void> {
  if (activeKg?.child && activeKg.child.exitCode === null) {
    vscode.window.showInformationMessage(`AutoClaw KG: daemon already running on port ${activeKg.port}.`);
    return;
  }
  const cfg = vscode.workspace.getConfiguration('autoclaw.kg');
  const userKgPort = cfg.get<number>('port', 0);
  const dbPath = cfg.get<string>('dbPath', '');
  const channel = getKgOutputChannel();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const idePorts = getIdePorts(currentIde, workspaceRoot || undefined);
  const kgPort = userKgPort > 0 ? userKgPort : idePorts.kgPort;

  const result = await startKgDaemon({ extensionPath, port: kgPort, dbPath, logger: channel });
  if (result.ok) {
    activeKg = result.state;
    vscode.window.showInformationMessage(`AutoClaw KG: daemon started on port ${result.state.port}.`);
  } else {
    channel.appendLine(`[kg] ${result.message}`);
    vscode.window.showWarningMessage(
      `AutoClaw KG: could not start daemon — ${result.message}`,
      'Open KG Output'
    ).then(a => { if (a === 'Open KG Output') { channel.show(true); } });
  }
}

/**
 * RV-3: explicit `autoclaw.kg.restart` — stop the running daemon (if any),
 * then start a fresh one.
 */
async function kgRestartCommand(extensionPath: string): Promise<void> {
  const channel = getKgOutputChannel();
  if (activeKg?.child && activeKg.child.exitCode === null) {
    channel.appendLine('[kg] restart → stopping current daemon');
    try { await stopKgDaemon(activeKg); } catch (e) { channel.appendLine(`[kg] stop warning: ${(e as Error).message}`); }
    activeKg = null;
  }
  await kgStartCommand(extensionPath);
}

/**
 * RV-3: explicit `autoclaw.kg.openDashboard` — focus the AutoClaw panel where
 * the KG (kg:) fabric-health badge lives, then surface a live health line so
 * the user can see daemon status. There is no separate KG webview; the unified
 * dashboard is the surface.
 */
async function kgOpenDashboardCommand(): Promise<void> {
  try { await vscode.commands.executeCommand('kdreamDashboard.focus'); } catch { /* panel may be unavailable in headless */ }
  await kgHealthCheckCommand();
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

/**
 * Revoke a previously-issued remote agent token. Presents a quick-pick of
 * still-active (non-revoked) tokens; on selection, stamps `revoked_at` via
 * the bridge helper and posts a `system` message to inboxes/shared/ so
 * other agents can react (e.g. drop cached credentials).
 */
async function bridgeRevokeTokenCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Open a workspace first.'); return; }
  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
  const tokensPath = path.join(commsDir, 'tokens.json');
  const tokens = await readTokens(tokensPath);
  const active = tokens.filter(t => !t.revoked_at);
  if (active.length === 0) {
    vscode.window.showInformationMessage('No active remote agent tokens to revoke.');
    return;
  }
  const items = active.map(t => ({
    label: t.agent_id,
    description: `expires ${t.expires_at}`,
    detail: `created ${t.created_at} • token ${t.token.slice(0, 12)}…`,
    token: t.token,
    agentId: t.agent_id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a remote agent token to revoke',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) { return; }
  const ok = await revokeToken(tokensPath, pick.token);
  if (!ok) {
    vscode.window.showErrorMessage(`Token for ${pick.agentId} could not be revoked (already removed?).`);
    return;
  }
  const timestamp = new Date().toISOString();
  // Best-effort broadcast — fire-and-forget so revocation always succeeds
  // even if the inboxes/shared dir is somehow unwriteable.
  await sendMessage(commsDir, {
    id: '', from: 'orchestrator', to: 'shared', type: 'system',
    timestamp,
    payload: {
      kind: 'token_revoked',
      agent_id: pick.agentId,
      revoked_at: timestamp,
      message: `agent ${pick.agentId}'s token revoked at ${timestamp}`,
    },
    requires_response: false,
  }).catch(() => { /* swallow — revocation already persisted */ });
  const ch = getOrchestrateOutputChannel();
  ch.appendLine(`[bridge] Revoked token for ${pick.agentId} at ${timestamp}`);
  vscode.window.showInformationMessage(`Token for "${pick.agentId}" revoked.`);
}

/**
 * Render the current host agent's A2A Agent Card as JSON in an Untitled
 * editor. Useful for debugging agent-card-schema.md / x-autoclaw mirroring.
 *
 * Picks the first registered agent from the workspace registry (or a
 * synthetic fallback when none is registered yet) and feeds its
 * RegisteredAgent fields into {@link buildAgentCard}.
 */
async function agentCardShowCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cfg = vscode.workspace.getConfiguration('autoclaw.bridge');
  const port = cfg.get<number>('port', 9876);
  const host = cfg.get<string>('host', '127.0.0.1');
  const baseUrl = `http://${host}:${port}/a2a`;

  let agentName = 'AutoClaw Host Agent';
  let agentId = 'autoclaw-host';
  const autoclawFields: Parameters<typeof buildAgentCard>[0]['autoclaw'] = {
    machine_id: 'unknown',
  };

  if (workspaceRoot) {
    try {
      const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
      const reg = await readRegistry(commsDir);
      const first = reg?.agents[0];
      if (first) {
        agentId = first.id;
        agentName = first.name;
        autoclawFields.machine_id = first.machine_id ?? `local-${first.id}`;
        if (first.machine_ip) { autoclawFields.machine_ip = first.machine_ip; }
        if (first.llms_available) { autoclawFields.llms_available = first.llms_available; }
        if (typeof first.context_window === 'number') { autoclawFields.context_window = first.context_window; }
        if (first.tools_supported) { autoclawFields.tools_supported = first.tools_supported; }
        if (first.trust_level) { autoclawFields.trust_level = first.trust_level; }
        if (first.cost_budget) { autoclawFields.cost_budget = first.cost_budget; }
        if (typeof first.max_parallel_tasks === 'number') { autoclawFields.max_parallel_tasks = first.max_parallel_tasks; }
        if (first.skills_loaded) { autoclawFields.skills_loaded = first.skills_loaded; }
        if (typeof first.human_in_loop_required === 'boolean') { autoclawFields.human_in_loop_required = first.human_in_loop_required; }
        if (first.capabilities) { autoclawFields.capabilities = first.capabilities; }
      }
    } catch { /* fall through to synthetic card */ }
  }

  const card = buildAgentCard({
    name: agentName,
    description: `Agent Card for ${agentId} (rendered locally for debugging).`,
    url: baseUrl,
    version: '2.4.0',
    autoclaw: autoclawFields,
  });

  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(card, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
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
  let agents: Awaited<ReturnType<typeof getAgentStatuses>> = [];
  try { agents = await getAgentStatuses(commsDir); } catch {}
  try { view.webview.postMessage({ command: 'updateAgents', data: agents }); } catch {}

  // Attach per-session heartbeats so cards can break a single agent process
  // into its individual chat sessions.
  const agentsWithSessions: AgentWithLive[] = [];
  for (const a of agents) {
    let sessions: Awaited<ReturnType<typeof readSessionHeartbeats>> = [];
    try { sessions = await readSessionHeartbeats(commsDir, a.id); } catch { /* none */ }
    agentsWithSessions.push({ ...(a as AgentWithLive), sessions });
  }

  // Board snapshot — read once and reused for role inference, the kanban, and
  // the section badge.
  let board: BoardSnapshot | null = null;
  try {
    const boardPath = path.join(wr, '.autoclaw', 'orchestrator', 'board.json');
    if (fs.existsSync(boardPath)) {
      board = JSON.parse((await fsPromises.readFile(boardPath, 'utf8')).replace(/^﻿/, '')) as BoardSnapshot;
    }
  } catch { board = null; }

  // Durable task ledger + live claims → per-agent workload rollups and the
  // board's Done lane (Slice B). Best-effort; missing files degrade to empty.
  const ledger = (() => { try { return readTaskLedger(commsDir); } catch { return []; } })();
  const claims: Array<{ task_id: string; claimed_by?: string; agent?: string }> = [];
  try {
    const claimsDir = path.join(commsDir, 'claims');
    if (fs.existsSync(claimsDir)) {
      for (const f of await fsPromises.readdir(claimsDir)) {
        if (!f.endsWith('.json')) { continue; }
        try {
          const c = JSON.parse((await fsPromises.readFile(path.join(claimsDir, f), 'utf8')).replace(/^﻿/, ''));
          claims.push({ task_id: c.task_id ?? path.basename(f, '.json'), claimed_by: c.claimed_by, agent: c.agent });
        } catch { /* skip malformed claim */ }
      }
    }
  } catch { /* no claims dir */ }
  const workloadByAgent = summarizeByAgent(ledger, claims, board, { now: new Date(), recentLimit: 5 });
  // Follow-up #4: per-agent cost rollup (tokens / $ / dispatches) from the LLM
  // cost ledger. Best-effort; missing ledger degrades to empty.
  const costByAgent = (() => { try { return readAgentCosts(wr); } catch { return {}; } })();

  // Merge in agents that checked in from OTHER tools/IDEs/runners via beacons
  // (other-IDE AutoClaw, Hermes, openclaw, …). Local registry agents win on id
  // collision. See docs/FLEET_ARCHITECTURE.md §4.
  let beaconRows: BeaconRow[] = [];
  try { beaconRows = await readAllBeacons({ commsDir, now: Date.now() }); } catch { /* none */ }
  const knownIds = new Set(agentsWithSessions.map(a => a.id));
  const fleetAgents: AgentWithLive[] = [...agentsWithSessions];
  for (const b of beaconRows) {
    // T0 trust ceiling: a LAN-DISCOVERED peer (origin 'lan') is observe-only,
    // unauthenticated telemetry — never promote it into the TRUSTED fleet roster
    // (beaconToAgent would launder its 'lan' marker to a 'beacon'/'joined' card
    // indistinguishable from a real agent). Symmetric with pending.ts / needs.ts.
    if (isDiscoveredUntrusted(b)) { continue; }
    if (knownIds.has(b.agent_id)) { continue; }
    knownIds.add(b.agent_id);
    fleetAgents.push(beaconToAgent(b));
  }

  // LANE C: per-agent LLM-cost metrics. The LLM ledger (.autoclaw/llm/) carries
  // NO agentId, so we attribute each row via session_id → agent. Build the
  // bridge from every agent's primary heartbeat session_id plus its sidecar
  // session heartbeats (a single agent process can host several sessions); the
  // known-agent set lets a row whose callerPersonaId IS an agent id resolve
  // directly. Best-effort + swallowed — a missing ledger ⇒ no metrics attached
  // ⇒ cards render exactly as before. Mirrors the workload read above.
  const metricsByAgent: Record<string, import('./fleet/fleetMetrics').AgentMetrics> = {};
  try {
    const bySession: Record<string, string> = {};
    for (const a of fleetAgents) {
      const primary = a.heartbeat?.session_id;
      if (primary) { bySession[primary] = a.id; }
      for (const s of a.sessions ?? []) {
        if (s?.session_id) { bySession[s.session_id] = a.id; }
      }
    }
    const attribution: MetricsAttribution = {
      bySession,
      knownAgents: fleetAgents.map(a => a.id),
    };
    const rows = await readLlmLedgerRows(wr);
    const fleetMetrics = buildAgentMetrics(rows, attribution, Date.now());
    for (const m of fleetMetrics.perAgent) { metricsByAgent[m.agentId] = m; }
  } catch { /* no llm ledger / unreadable ⇒ no metrics */ }

  // Resolve each agent's role + the single orchestrator via the
  // user-authoritative chain: fleet.json manifest → autoclaw.agentRoles setting
  // → registry role/agent_type/can_orchestrate → live board activity →
  // generalist. The user has ultimate control (the manifest overrides all).
  const manifest = readFleetManifest(wr);
  const declaredRoles = readDeclaredAgentRoles();
  const governancePrimary = readGovernancePrimary(wr);
  const signals: AgentSignal[] = fleetAgents.map(a => ({
    id: a.id,
    role: (a as { role?: string }).role,
    agent_type: a.agent_type,
    can_orchestrate: a.can_orchestrate,
  }));
  const resolvedFleet = resolveFleet(signals, {
    manifest,
    settingRoles: declaredRoles,
    governancePrimary,
    inferRole: (id) => inferRoleFromActivity(id, board),
  });

  const roleOf: Record<string, CanonicalRole> = {};
  const nameOf: Record<string, string> = {};
  const modelOf: Record<string, string> = {};
  // Lane A: agentId → freshest deep-linkable chat session, so board cards can
  // offer an "Open chat ↗" button for their owner/author/agent (cards know the
  // owner id but not that agent's session id). Built from the same session
  // heartbeats the agent cards use; absent for an agent ⇒ no button (graceful).
  const sessionOf: Record<string, AgentSessionRef> = {};
  // Lane A: agentId → task ids it is actively driving on the board right now,
  // for the agent card's "Current task(s)" line.
  const currentTasksByAgent: Record<string, string[]> = {};
  for (const t of board?.in_flight ?? []) {
    if (!t.claimed_by) { continue; }
    (currentTasksByAgent[t.claimed_by] ??= []).push(t.task_id);
  }
  for (const a of fleetAgents) {
    const rr = resolvedFleet.roles[a.id];
    roleOf[a.id] = rr.canonical;
    // Stamp the resolved canonical role back so the agent cards + team summary
    // (which call agentRole() internally) agree with the board's coloring.
    (a as { role?: string }).role = rr.canonical;
    // Slice B: attach the per-agent workload rollup (undefined ⇒ card unchanged).
    (a as AgentWithLive).workload = workloadByAgent[a.id];
    // Follow-up #4: attach per-agent cost rollup (undefined ⇒ card unchanged).
    (a as AgentWithLive).cost = costByAgent[a.id];
    // LANE C: attach the per-agent LLM-cost metrics (undefined ⇒ card unchanged).
    (a as AgentWithLive).metrics = metricsByAgent[a.id];
    // Lane A: attach the agent's live tasks (undefined/empty ⇒ no card line).
    (a as AgentWithLive).currentTasks = currentTasksByAgent[a.id];
    nameOf[a.id] = a.name || a.id;
    const model = a.heartbeat?.current_llm
      || (a.llms_available && a.llms_available.length === 1 ? a.llms_available[0] : undefined);
    if (model) { modelOf[a.id] = model; }
    // Lane A: pick the agent's freshest session heartbeat carrying a session_id
    // for the board's Open-chat deep link. `source` keys the host ladder
    // (claude-code → resume URI), falling back to the agent id.
    const withSessions = a.sessions ?? [];
    let freshest: Heartbeat | undefined;
    for (const sh of withSessions) {
      if (!sh.session_id) { continue; }
      if (!freshest || new Date(sh.timestamp).getTime() > new Date(freshest.timestamp).getTime()) {
        freshest = sh;
      }
    }
    if (freshest?.session_id) {
      sessionOf[a.id] = {
        session_id: freshest.session_id,
        source: freshest.adapterId || a.id,
        rawRef: freshest.rawRef,
      };
    }
  }

  // v2.5: per-agent inbox summaries (local agents only) + server-rendered cards
  const summaries: Record<string, InboxSummary> = {};
  for (const a of agents) {
    try {
      summaries[a.id] = await getInboxSummary(commsDir, a.id);
    } catch { /* skip */ }
  }
  try {
    // Pass the active host identity AND this window's own session id so the card
    // list can mark "your agent" + flag the exact session running in this window
    // (deterministic when the host session id is among the rows; else the card
    // falls back to the freshest live session). Makes the self-scoped "Awaiting
    // You" section legible — same data, only the highlight differs per window.
    const selfId = activeHostAgentId();
    view.webview.postMessage({
      command: 'updateAgentCards',
      data: {
        html: renderAgentList(fleetAgents, summaries, Date.now(), selfId, sessionId),
        count: fleetAgents.length,
      },
    });
  } catch {}

  // v2.5: Awaiting You list — uses the active host agent as "me".
  try {
    const me = activeHostAgentId();
    if (me) {
      const messages = await readInbox(commsDir, me);
      const stateById: Record<string, { replied_at: string | null }> = {};
      for (const m of messages) {
        const s = await readMessageState(commsDir, me, m.id);
        if (s) { stateById[m.id] = { replied_at: s.replied_at }; }
      }
      const awaiting = filterAwaitingYou(messages, me, stateById);
      const rows: AwaitingYouRow[] = awaiting.map(m => ({
        message: m,
        excerpt: payloadExcerpt(m.payload as Record<string, unknown>),
        history: buildAwaitingHistory(m, messages, me),
      }));
      view.webview.postMessage({
        command: 'updateAwaitingYou',
        data: {
          html: renderAwaitingYou(rows),
          count: rows.length,
        },
      });
    } else {
      view.webview.postMessage({
        command: 'updateAwaitingYou',
        data: { html: renderAwaitingYou([]), count: 0 },
      });
    }
  } catch {}

  // Comms log → role-colored message feed + per-task threads for the board.
  let commsLog: CommsLogEntry[] = [];
  try { commsLog = await readCommsLog(commsDir, { limit: 200 }); } catch {}
  const threadEntries: ThreadMessage[] = commsLog.map(e => ({
    timestamp: e.timestamp, type: e.type, from: e.from, to: e.to,
    task_id: e.task_id, message: e.message,
  }));
  const boardCtx: BoardRenderContext = {
    roleOf, nameOf, modelOf, threads: buildThreads(threadEntries),
    // Lane A: per-agent session map so a card's detail can deep-link its owner's chat.
    sessionOf,
  };
  try {
    view.webview.postMessage({
      command: 'updateMessages',
      data: { html: renderMessageFeed(threadEntries.slice(-60), boardCtx), count: commsLog.length },
    });
  } catch {}

  // Task board (kanban) — board.json was read once above and is reused here.
  // The Done lane is reconstructed from the durable ledger (board.json drops
  // completed work); the section badge still counts open work only.
  const boardWithDone: BoardSnapshot | null = board
    ? { ...board, done: recentCompletions(ledger, 30).map(e => ({
        task_id: e.task_id, agent_id: e.agent_id, title: e.title,
        sprint: e.sprint, completed_at: e.completed_at, review_status: e.review_status,
      })) }
    : (ledger.length
        ? { done: recentCompletions(ledger, 30).map(e => ({
            task_id: e.task_id, agent_id: e.agent_id, title: e.title,
            sprint: e.sprint, completed_at: e.completed_at, review_status: e.review_status,
          })) }
        : null);
  try {
    view.webview.postMessage({
      command: 'updateBoard',
      data: { html: renderBoard(boardWithDone, boardCtx), count: boardTaskCount(board) },
    });
  } catch {}

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

  // v2.5: Fabric (push-channel + kg-daemon) health.
  try {
    const health = await probeFabricHealth();
    view.webview.postMessage({
      command: 'updateFabricHealth',
      data: { html: renderFabricHealth(health) },
    });
  } catch {}

  // FF-3: pending tray — agents with a fresh beacon not yet admitted to
  // fleet.json. Mapped to the webview's render shape (PendingAgentView).
  try {
    const pending = await readPendingTray(path.join(wr, '.autoclaw'));
    view.webview.postMessage({
      command: 'updatePending',
      data: pending.map(p => ({
        agentId: p.agent_id,
        sessionId: p.session_id,
        host: p.host,
        suggestedRole: p.suggested_role,
        suggestedType: p.suggested_agent_type,
        viaInvite: !!p.via_invite,
        trust: p.trust,
      })),
    });
  } catch {}

  // FLEET-DIGEST — collapse the same fleet picture into one small, canonical
  // artifact (`fleet-status.json`) every agent reads each SYNC instead of
  // re-walking the whole comms tree. Best-effort: piggybacks this refresh
  // cadence (no new timer), derives from the SAME render model the panel uses
  // (no second data path), and NEVER throws into the refresh path.
  try {
    const selfId = activeHostAgentId() ?? 'claude-code';
    const fleetModel = await gatherFleetData({ workspaceRoot: wr, selfAgentId: selfId });
    // The board snapshot was already read once above; attach it the same way
    // the Manager panel does (`{ ...model, board }`).
    const digestModel: FleetDigestModel = board
      ? { ...fleetModel, board: board as unknown as FleetDigestModel['board'] }
      : fleetModel;
    const digest = buildFleetDigest(digestModel, new Date().toISOString());
    const serialized = serializeFleetDigest(digest);
    const outPath = path.join(wr, ...FLEET_STATUS_REL_PATH.split('/'));
    await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
    // Atomic write: tmp file in the same dir, then rename over the target so a
    // reader never sees a half-written digest.
    const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmpPath, serialized, 'utf8');
    await fsPromises.rename(tmpPath, outPath);
  } catch { /* best-effort; digest write never breaks the refresh */ }
}

// ---------------------------------------------------------------------------
// v2.5 helpers — host-agent identity, fabric health, and reply orchestration.
// ---------------------------------------------------------------------------

/** Read the user-declared agentId → canonical role overrides from settings
 *  (`autoclaw.agentRoles`). Values are normalized through the role taxonomy,
 *  so synonyms ("dev", "qa", "security-auditor") resolve correctly. Unknown
 *  values fall through to 'generalist' and are ignored by the caller. */
function readDeclaredAgentRoles(): Record<string, CanonicalRole> {
  const out: Record<string, CanonicalRole> = {};
  try {
    const cfg = vscode.workspace.getConfiguration('autoclaw');
    const raw = cfg.get<Record<string, string>>('agentRoles', {});
    if (raw && typeof raw === 'object') {
      for (const [agentId, roleStr] of Object.entries(raw)) {
        if (typeof roleStr === 'string') { out[agentId] = normalizeRole(roleStr); }
      }
    }
  } catch { /* no config — empty overrides */ }
  return out;
}

/** Read the user-authoritative fleet manifest (`.autoclaw/orchestrator/fleet.json`).
 *  Returns null when absent or malformed — callers fall back to detection. */
function readFleetManifest(wr: string): FleetManifest | null {
  try {
    const p = path.join(wr, '.autoclaw', 'orchestrator', 'fleet.json');
    if (!fs.existsSync(p)) { return null; }
    return parseFleetManifest(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

/** Read the informational orchestrator from state.json governance.primary. */
function readGovernancePrimary(wr: string): string | null {
  try {
    const p = path.join(wr, '.autoclaw', 'orchestrator', 'state.json');
    if (!fs.existsSync(p)) { return null; }
    const s = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as
      { governance?: { primary?: { agent_id?: string } } };
    return s.governance?.primary?.agent_id ?? null;
  } catch { return null; }
}

/** Turn a beacon check-in (other IDE / runner / workspace) into a panel agent
 *  row so cross-tool agents appear in the fleet view, grouped by host. */
function beaconToAgent(b: BeaconRow): AgentWithLive {
  const live: AgentStatus = b.stale ? 'stalled' : (b.status === 'active' ? 'active' : 'idle');
  const hb: Heartbeat = {
    agent_id: b.agent_id,
    timestamp: b.timestamp,
    status: b.status === 'active' ? 'active' : 'idle',
    current_task: b.current_task ?? null,
    sprint: null,
    session_id: b.session_id,
    current_llm: b.current_llm,
  };
  return {
    id: b.agent_id,
    name: b.agent_id,
    extension_id: null,
    detected: true,
    inbox_path: '',
    hooks_supported: false,
    last_heartbeat: b.timestamp,
    status: live,
    live_status: live,
    heartbeat: hb,
    sessions: [hb],
    role: b.role,
    agent_type: (b.agent_type as RegisteredAgent['agent_type']),
    origin: 'beacon',
    host: b.host || b.workspace_id || 'external',
    machine_id: b.machine_id,
  } as AgentWithLive;
}

/**
 * Command: designate the fleet orchestrator. Writes the chosen agent id to
 * `.autoclaw/orchestrator/fleet.json` (the user-authoritative manifest), which
 * the panel reads with top precedence over state.json governance + detection.
 */
async function designateOrchestratorCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const commsDir = path.join(wr, '.autoclaw', 'orchestrator', 'comms');

  let agentId: string | undefined;
  try {
    const reg = await readRegistry(commsDir);
    const items = (reg?.agents ?? []).map(a => ({ label: a.name || a.id, description: a.id, id: a.id }));
    if (items.length > 0) {
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Designate fleet orchestrator', placeHolder: 'Who coordinates the team?',
      });
      agentId = pick?.id;
    }
  } catch { /* fall through to manual entry */ }
  if (!agentId) {
    agentId = await vscode.window.showInputBox({ title: 'Designate fleet orchestrator', prompt: 'Agent id', ignoreFocusOut: true });
  }
  if (!agentId) { return; }

  try {
    const p = path.join(wr, '.autoclaw', 'orchestrator', 'fleet.json');
    const existing = readFleetManifest(wr) ?? { schema_version: '1.0' as const };
    const next: FleetManifest = { ...existing, orchestrator: agentId };
    await fsPromises.mkdir(path.dirname(p), { recursive: true });
    await fsPromises.writeFile(p, JSON.stringify(next, null, 2), 'utf8');
    vscode.window.showInformationMessage(`AutoClaw: ${agentId} is now the fleet orchestrator.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not write fleet.json — ${(e as Error).message}`);
  }
}

/**
 * Command: assign a panel role to a detected agent. Pick an agent, pick a role
 * from the canonical taxonomy, and persist it to `autoclaw.agentRoles` in
 * workspace settings. The panel reflects it on the next refresh.
 */
async function setAgentRoleCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const commsDir = path.join(wr, '.autoclaw', 'orchestrator', 'comms');

  // Offer detected agents; fall back to a free-text id if the registry is empty.
  let agentId: string | undefined;
  try {
    const reg = await readRegistry(commsDir);
    const ids = (reg?.agents ?? []).map(a => ({ label: a.name || a.id, description: a.id, id: a.id }));
    if (ids.length > 0) {
      const pick = await vscode.window.showQuickPick(ids, { title: 'Set agent role — choose an agent', placeHolder: 'Detected agents' });
      agentId = pick?.id;
    }
  } catch { /* registry unreadable — fall through to manual entry */ }
  if (!agentId) {
    agentId = await vscode.window.showInputBox({ title: 'Set agent role', prompt: 'Agent id (e.g. claude-code)', ignoreFocusOut: true });
  }
  if (!agentId) { return; }

  const roleItems = ROLE_ORDER.map(r => ({ label: `${ROLE_META[r].glyph}  ${ROLE_META[r].label}`, description: r, role: r }));
  const rolePick = await vscode.window.showQuickPick(roleItems, { title: `Role for ${agentId}`, placeHolder: 'Pick a role' });
  if (!rolePick) { return; }

  try {
    const cfg = vscode.workspace.getConfiguration('autoclaw');
    const current = { ...(cfg.get<Record<string, string>>('agentRoles', {}) ?? {}) };
    current[agentId] = rolePick.role;
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await cfg.update('agentRoles', current, target);
    vscode.window.showInformationMessage(`AutoClaw: ${agentId} is now ${ROLE_META[rolePick.role].label}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not save role — ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Fleet federation commands (FF-3) — invite / admit / decline outside agents
// ---------------------------------------------------------------------------

/** A QuickPick item carrying the resolved value behind a self-documenting row. */
type FleetPickItem = vscode.QuickPickItem & { value?: string };

/** A non-selectable section header for a QuickPick list. */
function pickSeparator(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

/** Short, glanceable lane name (shown inline as item.description). */
const LANE_SHORT: Record<string, string> = {
  mcp: 'MCP lane', http: 'HTTP bridge', fs: 'filesystem', slash: 'native /loop',
};

/** One-line consequence of a tool's join lane (shown as the wrapped item.detail). */
function laneConsequence(conv: { lane: string; fallbackLane?: string }): string {
  const base = ((): string => {
    switch (conv.lane) {
      case 'mcp':   return 'Mounts the autoclaw-mcp server and calls its tools directly; will ask to enable repo writes.';
      case 'http':  return 'Heartbeat, claim, and report over REST + SSE through the AutoClaw bridge.';
      case 'slash': return 'Joins in-window using the native /loop skill — no extra setup.';
      case 'fs':
      default:      return 'Writes a beacon + message files under the shared comms folder.';
    }
  })();
  return conv.fallbackLane ? `${base} Falls back to the ${LANE_SHORT[conv.fallbackLane] ?? conv.fallbackLane}.` : base;
}

/**
 * Build the target-tool picker items, grouped by federation peers vs in-extension
 * IDE hosts, each row surfacing its join lane (description) + consequence (detail).
 */
function buildTargetItems(): FleetPickItem[] {
  const federation = ['codex', 'claude-desktop', 'openclaw', 'hermes'];
  const toItem = (key: string): FleetPickItem => {
    const c = JOIN_TARGETS[key];
    return { label: c.label, description: LANE_SHORT[c.lane] ?? c.lane, detail: laneConsequence(c), value: key };
  };
  const items: FleetPickItem[] = [pickSeparator('Federation peers')];
  for (const k of federation) { if (JOIN_TARGETS[k]) { items.push(toItem(k)); } }
  items.push(pickSeparator('In-extension IDE hosts'));
  for (const k of Object.keys(JOIN_TARGETS)) { if (!federation.includes(k)) { items.push(toItem(k)); } }
  return items;
}

/**
 * Build the role picker items, grouped by tier (leadership / build & verify /
 * support). Each row carries the role's glanceable hint (description) + one-line
 * explanation (detail), sourced from ROLE_META so the picker can never drift.
 */
function buildRoleItems(): FleetPickItem[] {
  const tiers: ReadonlyArray<readonly [string, readonly CanonicalRole[]]> = [
    ['Leadership', ['orchestrator', 'architect', 'product']],
    ['Build & verify', ['coder', 'reviewer', 'tester', 'security']],
    ['Support', ['designer', 'creative', 'docs', 'researcher', 'ops', 'generalist']],
  ];
  const items: FleetPickItem[] = [];
  for (const [title, roles] of tiers) {
    items.push(pickSeparator(title));
    for (const r of roles) {
      const m = ROLE_META[r];
      items.push({ label: `${m.glyph}  ${m.label}`, description: m.hint, detail: m.description, value: r });
    }
  }
  return items;
}

/**
 * Build the behavioral-type picker items, data-driven from agentTypeProfile so the
 * trust/consensus/human-in-loop consequences (description) and the plain-language
 * meaning (detail) can never drift from the policy module. When a `suggested` type
 * is given (derived from the chosen role) it is listed FIRST under a "Suggested"
 * header so the user can usually just take the top row.
 */
function buildAgentTypeItems(suggested?: AgentType): FleetPickItem[] {
  const toItem = (t: AgentType): FleetPickItem => {
    const p = agentTypeProfile(t);
    const bits = [`trust: ${p.defaultTrust}`, `review: ${p.consensusRule}`];
    if (p.humanInLoop) { bits.push('human-in-loop'); }
    if (p.canOrchestrate) { bits.push('can orchestrate'); }
    return { label: t, description: bits.join(' · '), detail: p.description, value: t };
  };
  if (!suggested) {
    return AGENT_TYPES.map(toItem);
  }
  const rest = AGENT_TYPES.filter(t => t !== suggested);
  return [
    pickSeparator('Suggested for this role'),
    toItem(suggested),
    pickSeparator('Or choose another behavioral type'),
    ...rest.map(toItem),
  ];
}

/** Build the admit-policy picker items (auto-preapproved recommended first). */
function buildAdmitItems(): FleetPickItem[] {
  return [
    { label: 'auto-preapproved', description: 'recommended', value: 'auto-preapproved', detail: 'Admits the agent automatically if its behavioral type is pre-approved; otherwise it waits in the tray.' },
    { label: 'manual', value: 'manual', detail: 'Every join waits for you to approve it before the agent becomes active.' },
    { label: 'open', value: 'open', detail: 'Anyone holding this invite joins right away, no approval — use only for trusted, short-lived invites.' },
  ];
}

/** Issue a scoped, single-use invite token an outside agent can use to join. */
async function fleetInviteCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }

  const rolePick = await vscode.window.showQuickPick(buildRoleItems(), {
    title: 'Invite agent — role',
    placeHolder: 'What does this agent work on? (its role — shown on the board)',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!rolePick?.value) { return; }
  const role = rolePick.value;

  // Behavioral type is DERIVED from the role and offered first; the user overrides
  // it only for the legitimate divergent cases (e.g. a draft-only docs agent).
  const suggestedType = agentTypeForRole(role as CanonicalRole);
  const typePick = await vscode.window.showQuickPick(buildAgentTypeItems(suggestedType), {
    title: `Invite agent — behavioral type (suggested: ${suggestedType})`,
    placeHolder: 'How is this agent trusted + reviewed? Take the suggested row unless you need to change it.',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!typePick?.value) { return; }
  const agentType = typePick.value;

  const policyPick = await vscode.window.showQuickPick(buildAdmitItems(), {
    title: 'Invite agent — admit policy',
    placeHolder: 'How should a consuming agent be admitted?',
    matchOnDetail: true,
  });
  if (!policyPick?.value) { return; }
  const admitPolicy = policyPick.value as AdmitPolicy;

  const scopeRaw = await vscode.window.showInputBox({
    title: 'Invite agent — path scope (optional)',
    prompt: 'Comma-separated globs the agent may touch (seeds a scope-lease). Blank = whole repo.',
    placeHolder: 'src/test/**, docs/**',
    ignoreFocusOut: true,
  });
  const scope = (scopeRaw ?? '').split(',').map(s => s.trim()).filter(Boolean);

  try {
    const project = path.basename(wr);
    const invite = await createInvite({
      issued_by: activeHostAgentId() ?? 'claude-code',
      project,
      workspace: wr,
      suggested_role: role,
      suggested_agent_type: agentType,
      admit_policy: admitPolicy,
      preapproved_types: admitPolicy === 'auto-preapproved' ? [agentType] : undefined,
      ...(scope.length ? { scope } : {}),
      transports: ['fs', 'mcp', 'http'],
    });
    await vscode.env.clipboard.writeText(invite.token);
    const pick = await vscode.window.showInformationMessage(
      `AutoClaw: invite created for a ${role} (${agentType}) on "${project}". Token copied to clipboard — hand it to the agent.\n\n${invite.token}`,
      { modal: false }, 'Copy token again',
    );
    if (pick === 'Copy token again') { await vscode.env.clipboard.writeText(invite.token); }
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not create invite — ${(e as Error).message}`);
  }
}

/**
 * Issue a single-use invite AND render a ready-to-paste "join this project"
 * prompt tailored to a chosen tool's join lane (MCP / HTTP / filesystem / slash).
 * Closes the bare-token gap: the human gets a full prompt to paste into Codex,
 * Claude Desktop, OpenClaw, Hermes, or any in-extension IDE host.
 */
async function fleetJoinPromptCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }

  // 1. Target tool — drives the join lane + announced agent_id. Grouped by
  // federation peers vs IDE hosts; each row surfaces its lane + consequence.
  const targetPick = await vscode.window.showQuickPick(buildTargetItems(), {
    title: 'Generate join prompt — target tool',
    placeHolder: 'Which tool is joining? (its lane is shown on each row)',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!targetPick?.value) { return; }
  const targetKey = targetPick.value;

  // 2. Role — the only required taxonomy choice (the board-facing job).
  const rolePick = await vscode.window.showQuickPick(buildRoleItems(), {
    title: 'Join prompt — role',
    placeHolder: 'What does this agent work on? (its role — shown on the board)',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!rolePick?.value) { return; }
  const role = rolePick.value;

  // 3. Behavioral type — DERIVED from the role and offered first; override only
  // for the legitimate divergent cases. Drives trust / consensus / auto-admit.
  const suggestedType = agentTypeForRole(role as CanonicalRole);
  const typePick = await vscode.window.showQuickPick(buildAgentTypeItems(suggestedType), {
    title: `Join prompt — behavioral type (suggested: ${suggestedType})`,
    placeHolder: 'How is this agent trusted + reviewed? Take the suggested row unless you need to change it.',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!typePick?.value) { return; }
  const agentType = typePick.value;

  // 4. Optional path scope.
  const scopeRaw = await vscode.window.showInputBox({
    title: 'Join prompt — path scope (optional)',
    prompt: 'Comma-separated globs the agent may touch (seeds a scope-lease). Blank = whole repo.',
    placeHolder: 'src/test/**, docs/**',
    ignoreFocusOut: true,
  });
  const scope = (scopeRaw ?? '').split(',').map(s => s.trim()).filter(Boolean);

  const target = JOIN_TARGETS[targetKey];

  // 4b. Admit policy — unified with the Invite command (was hard-coded here).
  const policyPick = await vscode.window.showQuickPick(buildAdmitItems(), {
    title: 'Join prompt — admit policy',
    placeHolder: 'How should this agent be admitted once it consumes the invite?',
    matchOnDetail: true,
  });
  if (!policyPick?.value) { return; }
  const admitPolicy = policyPick.value as AdmitPolicy;

  // 5. MCP-lane peers are READ-ONLY until allowWrites is enabled. Offer to flip
  // the file flag now — enabling writes is a TRUST decision, so it is explicit
  // opt-in, never silent.
  if ((target.lane === 'mcp' || target.fallbackLane === 'mcp') && !isWritesAllowed(wr)) {
    const enable = await vscode.window.showWarningMessage(
      'Enable MCP writes for this project? Required for MCP-lane agents (Codex, ' +
      'Claude Desktop) to claim tasks / vote. Writes stay gated per-tool by ' +
      '.autoclaw/mcp/config.json.',
      { modal: true },
      'Enable writes', 'Keep read-only',
    );
    if (enable === 'Enable writes') {
      try {
        await setAllowWrites(wr, true);
        vscode.window.showInformationMessage('AutoClaw: MCP writes enabled (.autoclaw/mcp/config.json).');
      } catch (e) {
        vscode.window.showWarningMessage(`AutoClaw: could not enable MCP writes — ${(e as Error).message}`);
      }
    }
  }

  // 6. Optional REST bridge URL — only meaningful for the HTTP lane (e.g. Hermes).
  let bridgeUrl: string | undefined;
  if (target.lane === 'http' || target.fallbackLane === 'http') {
    bridgeUrl = (await vscode.window.showInputBox({
      title: 'Join prompt — REST bridge URL (optional)',
      prompt: 'Base URL of the AutoClaw HTTP bridge for this project (HTTP-lane tools only).',
      placeHolder: 'http://127.0.0.1:7878',
      ignoreFocusOut: true,
    }))?.trim() || undefined;
  }

  try {
    const project = path.basename(wr);
    const invite = await createInvite({
      issued_by: activeHostAgentId() ?? 'claude-code',
      project,
      workspace: wr,
      suggested_role: role,
      suggested_agent_type: agentType,
      admit_policy: admitPolicy,
      preapproved_types: admitPolicy === 'auto-preapproved' ? [agentType] : undefined,
      ...(scope.length ? { scope } : {}),
      transports: ['fs', 'mcp', 'http'],
    });
    // Pre-create the comms tree + a registry row so the joining agent arrives to a
    // writable inbox even in a project that has never run orchestrate (fixes the
    // "comms/claims does not exist" case). Idempotent + best-effort: a failure must
    // never block handing over the prompt — the fs-lane prompt also tells the agent
    // to create the tree itself.
    try {
      const commsRoot = path.join(wr, '.autoclaw', 'orchestrator', 'comms');
      await scaffoldAgent(commsRoot, { agentId: target.agentId });
    } catch { /* non-fatal — the prompt's own ensure-tree step covers it */ }
    const prompt = renderJoinPromptForInvite(targetKey, invite, bridgeUrl ? { bridgeUrl } : {});
    await vscode.env.clipboard.writeText(prompt);
    const pick = await vscode.window.showInformationMessage(
      `AutoClaw: join prompt for ${target.label} copied — paste it into that tool's chat.`,
      'Copy again',
    );
    if (pick === 'Copy again') { await vscode.env.clipboard.writeText(prompt); }
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not generate join prompt — ${(e as Error).message}`);
  }
}

/**
 * Add a whole AGENT TEAM from a ready-made template (autoclaw.fleet.addTeam).
 *
 * Closes the "every agent is built from a blank picker" gap: the user picks one of
 * the {@link TEAM_TEMPLATES} recipes, previews the squad (preview-before-mint — no
 * token is created until they confirm), and the command fans out one scoped invite
 * per seat, then opens a single ready-to-paste document with each seat's tailored
 * join prompt. The headline onboarding affordance.
 */
async function fleetAddTeamCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }

  // 1. Gallery — recommended starter first, each row showing its seat lineup.
  const rec = recommendedTemplate();
  const ordered = [rec, ...TEAM_TEMPLATES.filter(t => t.id !== rec.id)];
  const galleryItems = ordered.map(t => ({
    label: t.recommended ? `${t.name}  $(star-full)` : t.name,
    description: t.recommended ? 'recommended' : `${t.seats.length} agents`,
    detail: `${t.seats.map(seatSummary).join('   ·   ')} — ${t.whenToUse}`,
    id: t.id,
  }));
  const pick = await vscode.window.showQuickPick(galleryItems, {
    title: 'Add an agent team — pick a template',
    placeHolder: 'Start from a ready-made squad (you can adjust each seat after)',
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!pick) { return; }
  const tpl = getTeamTemplate(pick.id);
  if (!tpl) { return; }

  // 2. Preview-before-mint — show the full squad and confirm BEFORE any token is
  // created, so a cancel never burns invites.
  const lineup = tpl.seats
    .map((s, i) => `  ${i + 1}. ${s.role} / ${s.agentType} → ${JOIN_TARGETS[s.tool]?.label ?? s.tool}  (admit: ${s.admit})`)
    .join('\n');
  const confirm = await vscode.window.showInformationMessage(
    `Create the "${tpl.name}" team?\n\n${lineup}\n\n${tpl.consensusNote}\n\n` +
    `This mints ${tpl.seats.length} single-use invite${tpl.seats.length === 1 ? '' : 's'} (24h TTL) and opens a document with each seat's join prompt.`,
    { modal: true },
    'Create team',
  );
  if (confirm !== 'Create team') { return; }

  // 3. MCP-lane seats need writes enabled to claim/vote. Offer once if any seat
  // joins on the MCP lane and writes are still off (a trust decision → explicit).
  const needsMcpWrites = tpl.seats.some(s => {
    const lane = JOIN_TARGETS[s.tool]?.lane;
    const fb = JOIN_TARGETS[s.tool]?.fallbackLane;
    return (lane === 'mcp' || fb === 'mcp');
  });
  if (needsMcpWrites && !isWritesAllowed(wr)) {
    const enable = await vscode.window.showWarningMessage(
      'This team has MCP-lane agents (e.g. Codex, Claude Desktop). Enable MCP writes so they can claim tasks / vote? Writes stay gated per-tool by .autoclaw/mcp/config.json.',
      { modal: true }, 'Enable writes', 'Keep read-only',
    );
    if (enable === 'Enable writes') {
      try { await setAllowWrites(wr, true); } catch { /* non-fatal — surfaced in the doc */ }
    }
  }

  // 4. Fan out: one scoped invite per seat, render its tailored join prompt.
  const project = path.basename(wr);
  const issuedBy = activeHostAgentId() ?? 'claude-code';
  const commsRoot = path.join(wr, '.autoclaw', 'orchestrator', 'comms');
  const sections: string[] = [];
  let minted = 0;
  for (let i = 0; i < tpl.seats.length; i++) {
    const seat = tpl.seats[i];
    const seatAgentId = JOIN_TARGETS[seat.tool]?.agentId ?? seat.tool;
    try {
      const invite = await createInvite({
        issued_by: issuedBy,
        project,
        workspace: wr,
        suggested_role: seat.role,
        suggested_agent_type: seat.agentType,
        admit_policy: seat.admit,
        preapproved_types: seat.admit === 'auto-preapproved' ? [seat.agentType] : undefined,
        transports: ['fs', 'mcp', 'http'],
      });
      // Pre-create the comms tree + a roster row per seat so each teammate arrives
      // to a writable inbox even in a never-orchestrated project. Idempotent + best-effort.
      try { await scaffoldAgent(commsRoot, { agentId: seatAgentId }); } catch { /* non-fatal */ }
      const prompt = renderJoinPromptForInvite(seat.tool, invite);
      const toolLabel = JOIN_TARGETS[seat.tool]?.label ?? seat.tool;
      sections.push(
        `## Seat ${i + 1} — ${seat.role} / ${seat.agentType} → ${toolLabel}\n\n` +
        `- **Why:** ${seat.rationale}\n` +
        `- **Suggested scope:** ${seat.scope}\n` +
        (seat.verifyHint ? `- **Verify with:** ${seat.verifyHint}\n` : '') +
        `- **Admit:** ${seat.admit}\n\n` +
        `Paste this into ${toolLabel}:\n\n` +
        '````text\n' + prompt + '\n````\n',
      );
      minted++;
    } catch (e) {
      sections.push(`## Seat ${i + 1} — ${seat.role} / ${seat.agentType} → ${seat.tool}\n\n` +
        `> Could not mint this invite: ${(e as Error).message}\n`);
    }
  }

  const doc = `# Join your "${tpl.name}" team\n\n` +
    `${tpl.description}\n\n` +
    `**How review works:** ${tpl.consensusNote}\n\n` +
    `Each section below is one teammate. Open the suggested tool and paste its prompt into the chat. ` +
    `Tokens are single-use and expire in 24 hours — re-run **Add agent team** to mint fresh ones if any expire. ` +
    `Scopes below are suggestions; tighten them when you generate the prompt or in the agent's first message.\n\n` +
    `---\n\n${sections.join('\n---\n\n')}`;

  const td = await vscode.workspace.openTextDocument({ content: doc, language: 'markdown' });
  await vscode.window.showTextDocument(td, { preview: false });
  vscode.window.showInformationMessage(
    `AutoClaw: created the "${tpl.name}" team — ${minted}/${tpl.seats.length} invites minted. Paste each seat's prompt into its tool.`,
  );
  if (kdreamView) { await refreshOrchestratorData(kdreamView); }
}

/**
 * Scaffold an arbitrary (non-extension) agent id into the comms tree: create its
 * inbox, ensure a registry row (with keepalive mapping), and write a bootstrap
 * rules file. Lets a brand-new tool join even when it isn't an auto-detected
 * extension.
 */
async function fleetScaffoldAgentCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const agentId = await vscode.window.showInputBox({
    title: 'Scaffold agent into project',
    prompt: 'Agent id to wire into this project (e.g. codex, hermes, my-bot)',
    placeHolder: 'codex',
    ignoreFocusOut: true,
    validateInput: v => /^[a-z0-9][a-z0-9._-]*$/i.test(v.trim()) ? null : 'Use letters, digits, dot, dash or underscore (no slashes).',
  });
  if (!agentId) { return; }
  try {
    const commsRoot = path.join(wr, '.autoclaw', 'orchestrator', 'comms');
    const res = await scaffoldAgent(commsRoot, { agentId: agentId.trim() });
    vscode.window.showInformationMessage(
      `AutoClaw: scaffolded "${res.agentId}" (${res.keepalive.loop_mechanism}). ` +
      `${res.registryRowAdded ? 'Registry row added' : 'Registry row refreshed'}; inbox + bootstrap ready.`,
    );
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not scaffold agent — ${(e as Error).message}`);
  }
}

/**
 * Toggle the MCP server's coarse `allowWrites` gate in .autoclaw/mcp/config.json.
 * MCP-lane peers (Codex, Claude Desktop) are read-only until this is on —
 * enabling it lets them claim tasks / vote. A trust decision, so it's explicit.
 */
async function mcpAllowWritesToggleCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const currently = isWritesAllowed(wr);
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(check) Enable MCP writes', description: 'Let MCP-lane agents claim tasks / vote (trust decision)', val: true },
      { label: '$(circle-slash) Disable MCP writes', description: 'Make the MCP server read-only again', val: false },
    ],
    { title: `MCP writes are currently ${currently ? 'ENABLED' : 'disabled'}`, placeHolder: 'Toggle the .autoclaw/mcp/config.json allowWrites flag' },
  );
  if (!pick) { return; }
  try {
    await setAllowWrites(wr, pick.val);
    vscode.window.showInformationMessage(`AutoClaw: MCP writes ${pick.val ? 'enabled' : 'disabled'}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not update MCP writes — ${(e as Error).message}`);
  }
}

/**
 * Scaffold or refresh fleet.json (and needs.json) from the currently-detected
 * agents. Preserves any hand-set entries; only adds missing agents — so role
 * election finally has a live manifest to read.
 */
async function fleetScaffoldManifestCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const autoclawDir = path.join(wr, '.autoclaw');
  const commsDir = path.join(autoclawDir, 'orchestrator', 'comms');
  try {
    const statuses = await getAgentStatuses(commsDir);
    if (statuses.length === 0) {
      vscode.window.showWarningMessage('AutoClaw: no agents detected yet — provision the comms tree first.');
      return;
    }
    const agents: ManifestAgent[] = statuses.map(s => ({
      id: s.id,
      role: (s as { role?: string }).role,
      agent_type: s.agent_type ?? null,
      can_orchestrate: s.can_orchestrate ?? false,
    }));
    const res = await scaffoldFleetManifest(autoclawDir, agents);
    await generateNeedsFile(autoclawDir);
    vscode.window.showInformationMessage(`AutoClaw fleet manifest: ${res.summary}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: scaffold failed — ${(e as Error).message}`);
  }
}

/** Pick the fleet orchestrator from the detected agents (writes fleet.json). */
async function fleetPickOrchestratorCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const autoclawDir = path.join(wr, '.autoclaw');
  try {
    const statuses = await getAgentStatuses(path.join(autoclawDir, 'orchestrator', 'comms'));
    if (statuses.length === 0) { vscode.window.showWarningMessage('AutoClaw: no agents detected.'); return; }
    const pick = await vscode.window.showQuickPick(statuses.map(s => s.id), { placeHolder: 'Choose the fleet orchestrator' });
    if (!pick) { return; }
    await setManifestOrchestrator(autoclawDir, pick);
    vscode.window.showInformationMessage(`AutoClaw: orchestrator set to ${pick}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not set orchestrator — ${(e as Error).message}`);
  }
}

/**
 * CL-3: manually release dead-session, expired claims. Safe and release-only —
 * archives each abandoned claim to claims/_reaped/ and frees the task; never
 * touches live work or git. Available on demand regardless of the auto-reap
 * setting (which only governs the background loop).
 */
async function fleetReapClaimsCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  try {
    const report = await reapDeadClaims(wr, { apply: true });
    if (report.reaped.length === 0) {
      vscode.window.showInformationMessage(`AutoClaw: no abandoned claims to reap (${report.scanned} scanned — all owners live or claims unexpired).`);
    } else {
      vscode.window.showInformationMessage(
        `AutoClaw: reaped ${report.reaped.length} dead-session claim(s) of ${report.scanned} scanned — tasks released (archived to claims/_reaped/): ${report.reaped.map(r => r.task_id).join(', ')}`,
      );
    }
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not reap claims — ${(e as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  CL-4: file-scope leases                                                   */
/* -------------------------------------------------------------------------- */

/** Stable per-window session id so two windows of the same agent are distinct. */
let scopeSessionId: string | undefined;
function extScopeSession(): string {
  if (!scopeSessionId) { scopeSessionId = crypto.randomUUID(); }
  return scopeSessionId;
}

function summarizeScopeConflicts(conflicts: ScopeConflict[]): string {
  return conflicts
    .map(c => `${c.b.agent_id}/${String(c.b.session_id).slice(0, 8)} holds "${c.glob_b}" (vs your "${c.glob_a}")`)
    .join('; ');
}

/** Declare the globs this window is editing; warn on overlap with other sessions. */
async function fleetDeclareScopeCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const raw = await vscode.window.showInputBox({
    title: 'Declare file-scope lease',
    prompt: 'Comma-separated globs this window is editing (others see a scope_violation if they overlap).',
    placeHolder: 'src/extension.ts, src/orchestrator/**',
    ignoreFocusOut: true,
  });
  const globs = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (globs.length === 0) { return; }
  try {
    const res = await declareScope(wr, {
      agent_id: activeHostAgentId() ?? 'claude-code',
      session_id: extScopeSession(),
      globs,
    });
    if (res.conflicts.length === 0) {
      vscode.window.showInformationMessage(`AutoClaw: scope lease declared for ${globs.length} glob(s). No overlaps.`);
    } else {
      vscode.window.showWarningMessage(
        `AutoClaw: scope OVERLAP — ${summarizeScopeConflicts(res.conflicts)}. Coordinate before editing; a scope_violation was posted to the board.`,
      );
    }
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not declare scope — ${(e as Error).message}`);
  }
}

/** Release this window's scope lease. */
async function fleetReleaseScopeCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const released = await releaseScope(wr, activeHostAgentId() ?? 'claude-code', extScopeSession());
  vscode.window.showInformationMessage(released ? 'AutoClaw: scope lease released.' : 'AutoClaw: no active scope lease for this window.');
  if (kdreamView) { await refreshOrchestratorData(kdreamView); }
}

/** Show active scope leases across the fleet + any overlaps. */
async function fleetScopeStatusCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const leases = await readLeases(wr);
  const live = leases.filter(l => !l.expires_at || Date.parse(l.expires_at) > Date.now());
  if (live.length === 0) { vscode.window.showInformationMessage('AutoClaw: no active file-scope leases.'); return; }
  const conflicts = detectConflicts(live, Date.now());
  const lines = live.map(l => `• ${l.agent_id}/${l.session_id.slice(0, 8)}: ${l.globs.join(', ')}`);
  const head = conflicts.length ? `⚠ ${conflicts.length} scope overlap(s) — ` : `${live.length} active scope lease(s):\n`;
  vscode.window.showInformationMessage(head + lines.join('\n'), { modal: conflicts.length > 0 });
}

/** CL-5: write fleet-brief.json + show a one-line situational-awareness summary. */
async function fleetBriefCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  try {
    const dest = await writeFleetBrief(wr);
    const brief = JSON.parse(await fsPromises.readFile(dest, 'utf8'));
    const live = (brief.sessions ?? []).filter((s: { live: boolean }) => s.live).length;
    const summary =
      `Fleet brief: ${live}/${(brief.sessions ?? []).length} live · ` +
      `${(brief.claimable_top ?? []).length} claimable · ${brief.in_flight_count ?? 0} in flight · ` +
      `${brief.awaiting_review_count ?? 0} in review · ${brief.stuck_count ?? 0} stuck` +
      ((brief.scope_conflicts ?? []).length ? ` · ⚠ ${brief.scope_conflicts.length} scope overlap(s)` : '');
    vscode.window.showInformationMessage(summary, { modal: (brief.scope_conflicts ?? []).length > 0 });
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not build fleet brief — ${(e as Error).message}`);
  }
}

/** CL-2: archive aged telemetry / over-cap signals out of the shared inbox. */
async function fleetArchiveTelemetryCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  try {
    const r = await archiveSharedInbox(wr);
    vscode.window.showInformationMessage(
      `AutoClaw: archived ${r.archivedTelemetry} telemetry + ${r.archivedAgedSignals} aged/over-cap signals ` +
      `(scanned ${r.scanned}). Shared inbox is signal again.`,
    );
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: archive failed — ${(e as Error).message}`);
  }
}

/** Read the pending tray: agents with a fresh beacon not yet in fleet.json. */
async function readPendingTray(autoclawDir: string) {
  const commsDir = path.join(autoclawDir, 'orchestrator', 'comms');
  const [beacons, manifestRaw, invitesM, invitesW] = await Promise.all([
    readAllBeacons({ commsDir }),
    fsPromises.readFile(path.join(autoclawDir, 'orchestrator', 'fleet.json'), 'utf8').then(parseFleetManifest).catch(() => null),
    listInvites({}).catch(() => []),
    listInvites({ scope: 'workspace', commsDir }).catch(() => []),
  ]);
  return computePendingAgents(beacons, manifestRaw, [...invitesM, ...invitesW]);
}

/** Admit a pending agent into fleet.json with an authoritative role. */
async function fleetAdmitCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const autoclawDir = path.join(wr, '.autoclaw');

  const pending = await readPendingTray(autoclawDir);
  if (pending.length === 0) { vscode.window.showInformationMessage('AutoClaw: no agents are waiting to be admitted.'); return; }

  const pick = await vscode.window.showQuickPick(
    pending.map(p => ({
      label: p.agent_id,
      description: `${p.suggested_role ?? 'generalist'}${p.host ? ' · ' + p.host : ''}${p.via_invite ? ' · invited' : ''}`,
      agent: p,
    })),
    { title: 'Admit agent', placeHolder: 'Pick a pending agent to admit' },
  );
  if (!pick) { return; }

  const roleItems = ROLE_ORDER.map(r => ({ label: `${ROLE_META[r].glyph}  ${ROLE_META[r].label}`, description: r, role: r as string }));
  const rolePick = await vscode.window.showQuickPick(roleItems, {
    title: `Role for ${pick.agent.agent_id}`,
    placeHolder: pick.agent.suggested_role ? `Suggested: ${pick.agent.suggested_role}` : 'Pick a role',
  });
  if (!rolePick) { return; }

  try {
    await admitAgent(autoclawDir, pick.agent.agent_id, {
      role: rolePick.role,
      ...(pick.agent.suggested_agent_type ? { agent_type: pick.agent.suggested_agent_type } : {}),
    });
    vscode.window.showInformationMessage(`AutoClaw: admitted ${pick.agent.agent_id} as ${ROLE_META[rolePick.role as CanonicalRole].label}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not admit — ${(e as Error).message}`);
  }
}

/** Decline a pending agent: revoke its invite (its beacon then ages out). */
async function fleetDeclineCommand(): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return; }
  const autoclawDir = path.join(wr, '.autoclaw');
  const commsDir = path.join(autoclawDir, 'orchestrator', 'comms');

  const pending = await readPendingTray(autoclawDir);
  if (pending.length === 0) { vscode.window.showInformationMessage('AutoClaw: no agents are waiting.'); return; }

  const pick = await vscode.window.showQuickPick(
    pending.map(p => ({ label: p.agent_id, description: p.via_invite ? 'invited' : 'uninvited beacon', agent: p })),
    { title: 'Decline agent', placeHolder: 'Pick a pending agent to decline' },
  );
  if (!pick) { return; }

  if (pick.agent.via_invite) {
    await revokeInvite(pick.agent.via_invite, {}).catch(() => false);
    await revokeInvite(pick.agent.via_invite, { scope: 'workspace', commsDir }).catch(() => false);
  }
  vscode.window.showInformationMessage(`AutoClaw: declined ${pick.agent.agent_id}. Its invite was revoked; the beacon will age out.`);
  if (kdreamView) { await refreshOrchestratorData(kdreamView); }
}

// ---------------------------------------------------------------------------
// LANE B — per-agent Command & Control (message / pause / resume / reassign /
// evict). The panel posts {command, agentId, sessionId}; these commands accept
// that arg so a button click drives them directly (a palette invocation prompts
// for the agent id instead). All of these are LOCAL single-operator only — the
// cross-machine signing gate (evict §5) is not built, so nothing here is wired
// to the relay/HTTP path.
// ---------------------------------------------------------------------------

/** The workspace comms dir (`.autoclaw/orchestrator/comms`), or null if no ws. */
function workspaceCommsDir(): string | null {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { vscode.window.showWarningMessage('AutoClaw: open a workspace folder first.'); return null; }
  return path.join(wr, '.autoclaw', 'orchestrator', 'comms');
}

/** Resolve the target agent id: prefer the panel-supplied arg, else prompt. */
async function resolveTargetAgentId(arg: unknown): Promise<string | undefined> {
  if (arg && typeof arg === 'object' && typeof (arg as { agentId?: unknown }).agentId === 'string') {
    return (arg as { agentId: string }).agentId;
  }
  if (typeof arg === 'string' && arg.length > 0) { return arg; }
  return vscode.window.showInputBox({
    title: 'Target agent id', prompt: 'Agent id to act on', placeHolder: 'kilocode',
    ignoreFocusOut: true,
  });
}

/** Pull an optional session id out of the panel-supplied arg. */
function argSessionId(arg: unknown): string | undefined {
  if (arg && typeof arg === 'object' && typeof (arg as { sessionId?: unknown }).sessionId === 'string') {
    const s = (arg as { sessionId: string }).sessionId;
    return s.length > 0 ? s : undefined;
  }
  return undefined;
}

/**
 * Send a single typed doorbell into a target agent's inbox. Reuses the existing
 * `sendMessage` delivery path (writes inboxes/<to>/ + appends the comms log) —
 * no new transport. `requires_response` is true only for the free-text message
 * (so it lands in the peer's "Awaiting You").
 */
async function sendAgentDoorbell(
  commsDir: string,
  to: string,
  type: Message['type'],
  payload: Record<string, unknown>,
  requiresResponse: boolean,
): Promise<void> {
  await sendMessage(commsDir, {
    id: '', from: activeHostAgentId() ?? 'claude-code', to, type,
    timestamp: new Date().toISOString(),
    payload, requires_response: requiresResponse,
  });
}

/** Per-agent: send a free-text message (a `question`) to the agent's inbox. */
async function fleetMessageAgentCommand(arg?: unknown): Promise<void> {
  const commsDir = workspaceCommsDir();
  if (!commsDir) { return; }
  const agentId = await resolveTargetAgentId(arg);
  if (!agentId) { return; }
  const body = await vscode.window.showInputBox({
    title: `Message ${agentId}`,
    prompt: 'Send a message to this agent (lands in its inbox / Awaiting You).',
    placeHolder: 'Can you pick up task B3 next?',
    ignoreFocusOut: true,
  });
  if (body == null || body.trim().length === 0) { return; }
  try {
    await sendAgentDoorbell(commsDir, agentId, 'question', { message: body.trim() }, true);
    vscode.window.showInformationMessage(`AutoClaw: message sent to ${agentId}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not message ${agentId} — ${(e as Error).message}`);
  }
}

/** Per-agent: ask a cooperating agent to PAUSE (stop claiming new work). */
async function fleetPauseAgentCommand(arg?: unknown): Promise<void> {
  const commsDir = workspaceCommsDir();
  if (!commsDir) { return; }
  const agentId = await resolveTargetAgentId(arg);
  if (!agentId) { return; }
  const sessionId = argSessionId(arg);
  try {
    await sendAgentDoorbell(commsDir, agentId, 'pause', {
      pause: true,
      ...(sessionId ? { session_id: sessionId } : {}),
      reason: 'Operator requested pause — finish your current claim, then stop claiming new work.',
    }, false);
    vscode.window.showInformationMessage(`AutoClaw: pause sent to ${agentId}. It should stop claiming new work after its current task.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not pause ${agentId} — ${(e as Error).message}`);
  }
}

/** Per-agent: tell a paused agent it may RESUME claiming work. */
async function fleetResumeAgentCommand(arg?: unknown): Promise<void> {
  const commsDir = workspaceCommsDir();
  if (!commsDir) { return; }
  const agentId = await resolveTargetAgentId(arg);
  if (!agentId) { return; }
  const sessionId = argSessionId(arg);
  try {
    await sendAgentDoorbell(commsDir, agentId, 'resume', {
      resume: true,
      ...(sessionId ? { session_id: sessionId } : {}),
      reason: 'Operator cleared the pause — you may claim work again.',
    }, false);
    vscode.window.showInformationMessage(`AutoClaw: resume sent to ${agentId}.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not resume ${agentId} — ${(e as Error).message}`);
  }
}

/**
 * Per-agent: RELEASE a claim the agent holds so the board can re-dispatch it.
 * The SAFE half — deleting a `comms/claims/<task>.json` file IS the mutex
 * release (the same path the orchestrator's expired-claim sweep uses); we then
 * broadcast a `reassign` doorbell so the fleet picks the freed task back up. We
 * never rewrite the DAG or force-assign to a specific agent (Hard Rule 5).
 */
async function fleetReassignAgentCommand(arg?: unknown): Promise<void> {
  const commsDir = workspaceCommsDir();
  if (!commsDir) { return; }
  const agentId = await resolveTargetAgentId(arg);
  if (!agentId) { return; }

  // List the claims this agent currently holds so the operator picks one.
  const claimsDirPath = path.join(commsDir, 'claims');
  let claimFiles: string[] = [];
  try { claimFiles = (await fsPromises.readdir(claimsDirPath)).filter(f => f.endsWith('.json')); } catch { /* none */ }
  const held: Array<{ taskId: string; file: string }> = [];
  for (const name of claimFiles) {
    try {
      const claim = JSON.parse((await fsPromises.readFile(path.join(claimsDirPath, name), 'utf8')).replace(/^﻿/, '')) as { claimed_by?: string; task_id?: string };
      if (claim.claimed_by === agentId) {
        held.push({ taskId: claim.task_id ?? name.replace(/\.json$/, ''), file: path.join(claimsDirPath, name) });
      }
    } catch { /* skip malformed */ }
  }
  if (held.length === 0) {
    vscode.window.showInformationMessage(`AutoClaw: ${agentId} holds no claims to reassign.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    held.map(h => ({ label: h.taskId, description: 'release this claim back to the board', held: h })),
    { title: `Reassign — release a claim held by ${agentId}`, placeHolder: 'Pick a task to release for re-dispatch' },
  );
  if (!pick) { return; }
  try {
    await fsPromises.unlink(pick.held.file).catch(() => { /* already gone → idempotent */ });
    // Broadcast that the task is free again so the fleet re-claims it. We do NOT
    // pin it to another agent — the board's normal claim path owns assignment.
    await sendAgentDoorbell(commsDir, 'shared', 'reassign', {
      reassign: true, task_id: pick.held.taskId, released_from: agentId,
      reason: `Operator released ${pick.held.taskId} from ${agentId} — open for re-claim.`,
    }, false);
    vscode.window.showInformationMessage(`AutoClaw: released ${pick.held.taskId} from ${agentId}; it is open for re-claim.`);
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    vscode.window.showWarningMessage(`AutoClaw: could not reassign — ${(e as Error).message}`);
  }
}

/**
 * Per-agent: EVICT — the one destructive org primitive (releases claims, revokes
 * trust + invite, tears down presence, retires). A REQUIRED confirmation modal
 * gates it; hard mode is refused on a fresh heartbeat (evict.ts gate). Local
 * single-operator only — the cross-machine signing gate (§5) is not built, so
 * this never touches the relay path. Delegates the whole transaction to the
 * tested SAFE-CORE `evictAgent()`.
 */
async function fleetEvictAgentCommand(arg?: unknown): Promise<void> {
  const commsDir = workspaceCommsDir();
  if (!commsDir) { return; }
  const agentId = await resolveTargetAgentId(arg);
  if (!agentId) { return; }
  const sessionId = argSessionId(arg);

  const operator = activeHostAgentId() ?? 'claude-code';
  // REQUIRED confirmation — eviction removes a running participant. Modal so it
  // can't be dismissed by a stray Escape on the toast.
  const scopeNote = sessionId ? ` (session ${sessionId.slice(0, 8)}…)` : ' (all sessions)';
  const choice = await vscode.window.showWarningMessage(
    `Evict ${agentId}${scopeNote}? This releases its claims, revokes its trust + invite, tears down its presence, and retires it. Its work history is kept.`,
    { modal: true, detail: 'Graceful drains its current work first. Local single-operator action only — cross-machine evict is blocked.' },
    'Evict (graceful)',
  );
  if (choice !== 'Evict (graceful)') { return; }

  try {
    const intent = await evictAgent(
      {
        agentId, ...(sessionId ? { sessionId } : {}),
        mode: 'graceful', operator, commsDir,
      },
      // authorizedOperators omitted ⇒ single-operator in-IDE default (the local
      // human is the only filesystem writer). The intent record lands under
      // comms/intents/ so the Manager can show requested→acting→done.
      {},
    );
    const released = intent.released_tasks.length;
    const blocked = intent.blocked_dependents.length;
    vscode.window.showInformationMessage(
      `AutoClaw: evicted ${agentId} (${intent.state}). Released ${released} claim${released === 1 ? '' : 's'}` +
      `${blocked ? `, ${blocked} dependent${blocked === 1 ? '' : 's'} left blocked (see findings)` : ''}. ` +
      `Intent ${intent.intent_id} recorded in ${path.relative(commsDir, intentsDir(commsDir))}/.`,
    );
    if (kdreamView) { await refreshOrchestratorData(kdreamView); }
  } catch (e) {
    // Map the typed evict errors to clear operator-facing messages.
    if (e instanceof EvictRemoteBlockedError) {
      vscode.window.showErrorMessage('AutoClaw: cross-machine evict is blocked (the §5 signing gate is not built). Evict only agents on this machine.');
    } else if (e instanceof EvictHardOnFreshError) {
      vscode.window.showWarningMessage(`AutoClaw: ${agentId} has a fresh heartbeat — a forced evict was refused. Use graceful, or wait for the heartbeat to go stale.`);
    } else if (e instanceof EvictAuthError) {
      vscode.window.showErrorMessage(`AutoClaw: evict refused — ${(e as Error).message}`);
    } else {
      vscode.window.showWarningMessage(`AutoClaw: evict of ${agentId} failed — ${(e as Error).message}`);
    }
  }
}

/** Best-effort "who am I?" for the host running this extension instance.
 *  Used to populate the "Awaiting You" filter. Falls back to undefined. */
function activeHostAgentId(): string | undefined {
  if (currentIde !== 'other' && currentIde !== 'vscode') { return currentIde; }
  const cfg = vscode.workspace.getConfiguration('autoclaw');
  const explicit = cfg.get<string>('hostAgentId');
  if (explicit && explicit.length > 0) { return explicit; }
  return 'claude-code';
}

/** Probe the local bridge `/api/v1/health` and the kg-daemon to label header
 *  badges. Always resolves — never throws. */
async function probeFabricHealth(): Promise<FabricHealth> {
  const out: FabricHealth = { bridge: 'off', kg: 'disabled' };

  // Bridge state — only meaningful if the extension actually started one.
  if (activeBridge?.running) {
    try {
      const cfg = activeBridge.config;
      const body = await httpGetJson(`http://${cfg.host}:${cfg.port}/api/v1/health`, 1000);
      const sse = typeof body?.sse_clients === 'number' ? body.sse_clients : 0;
      const ws = typeof body?.ws_clients === 'number' ? body.ws_clients : 0;
      out.bridge_port = cfg.port;
      out.sse_clients = sse;
      out.ws_clients = ws;
      if (ws > 0) { out.bridge = 'ws'; }
      else if (sse > 0) { out.bridge = 'sse'; }
      else { out.bridge = 'poll'; }
    } catch {
      out.bridge = 'poll';
    }
  } else {
    out.bridge = 'off';
  }

  // Knowledge Graph — in-process store on the Intelligence Layer's ABI-proof
  // node:sqlite driver (no child process). `disabled` when opted out; else open
  // the lazily-cached handle and reflect whether a driver loaded.
  const kgCfg = vscode.workspace.getConfiguration('autoclaw.kg');
  if (!kgCfg.get<boolean>('enabled', true)) {
    out.kg = 'disabled';
  } else {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined;
      const h = getKnowledgeGraph({ workspaceRoot });
      out.kg = h.degraded ? 'degraded' : 'ready';
      out.kg_detail = {
        driverKind: h.driverKind,
        caps: h.caps,
        embeddingProvider: h.embedding.provider,
      };
    } catch {
      out.kg = 'degraded';
    }
  }

  return out;
}

/** Tiny GET-JSON helper — uses node http. Resolves null on any failure. */
function httpGetJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const http = require('http') as typeof import('http');
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

/** Handle a Reply click from the Awaiting You panel: prompt user for body
 *  text, write a `review_response` or `answer` message back to the sender's
 *  inbox, and mark the original message replied. */
/**
 * Build a compact prior-turn history for an awaiting message so the user sees the
 * context they're replying to: earlier inbox messages in the same task/thread or
 * from the same sender, oldest→newest, last 5. (One-sided for now — received
 * turns only; including the user's own sent replies is a future enhancement.)
 */
function buildAwaitingHistory(m: Message, inbox: readonly Message[], me: string): AwaitingHistoryEntry[] {
  const mTime = new Date(m.timestamp).getTime();
  const prior = inbox
    .filter(x =>
      x.id !== m.id
      && ((m.task_id && x.task_id === m.task_id) || x.from === m.from)
      && new Date(x.timestamp).getTime() <= mTime,
    )
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return prior.slice(-5).map(x => ({
    from: x.from,
    type: x.type,
    text: payloadExcerpt(x.payload as Record<string, unknown>),
    ts: x.timestamp,
    mine: x.from === me,
  }));
}

async function handleReplyAwaiting(
  view: vscode.WebviewView,
  args: { messageId?: string; from?: string; type?: string; body?: string }
): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr || !args.messageId || !args.from) { return; }
  const commsDir = path.join(wr, '.autoclaw', 'orchestrator', 'comms');
  const me = activeHostAgentId();
  if (!me) { return; }

  // Prefer the inline reply box; fall back to a modal prompt only if it's empty.
  let body = (args.body ?? '').trim();
  if (!body) {
    body = (await vscode.window.showInputBox({
      prompt: `Reply to ${args.from} (${args.type ?? 'message'})`,
      placeHolder: 'Type your reply…',
      ignoreFocusOut: true,
    }))?.trim() ?? '';
  }
  if (!body) { return; }

  const responseType: Message['type'] = args.type === 'question' ? 'answer' : 'review_response';

  try {
    await sendMessage(commsDir, {
      id: '',
      from: me,
      to: args.from,
      type: responseType,
      timestamp: '',
      payload: { in_reply_to: args.messageId, body },
      requires_response: false,
    });
    await markMessageReplied(commsDir, me, args.messageId);
    vscode.window.showInformationMessage(`Reply sent to ${args.from}.`);
    await refreshOrchestratorData(view);
  } catch (e) {
    vscode.window.showWarningMessage(`Reply failed: ${(e as Error).message}`);
  }
}

/**
 * RV-1: handle a `castVote` message from the review-decision UI. Writes this
 * host agent's own consensus vote file (`<task>-<agent>.json`) under
 * comms/consensus/active/ via the vscode-free voteWriter, then refreshes the
 * panel so the consensus tally reflects the new vote immediately.
 */
async function handleCastVote(
  view: vscode.WebviewView,
  args: { taskId?: string; vote?: string; comment?: string }
): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { return; }
  const me = activeHostAgentId();
  if (!me) { return; }
  if (!args.taskId || !args.vote) {
    vscode.window.showWarningMessage('Vote ignored: missing task id or vote value.');
    return;
  }

  const consensusActiveDir = path.join(
    wr, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active'
  );
  const result = await writeConsensusVote({
    consensusActiveDir,
    taskId: args.taskId,
    voter: me,
    sessionId,
    vote: args.vote,
    comment: args.comment ?? '',
  });

  if (result.ok) {
    const label = args.vote.replace('_', ' ');
    vscode.window.showInformationMessage(`Vote recorded: ${label} on ${args.taskId}.`);
    await refreshOrchestratorData(view);
  } else {
    vscode.window.showWarningMessage(`Vote failed: ${result.error}`);
  }
}

/**
 * RV-2: handle an `openAwaitingFile` message from a review-decision drill-in
 * link. Opens the referenced file in the editor. Paths are resolved relative
 * to the workspace root and rejected if they escape it (a referenced ref
 * could be attacker-influenced bus data). A missing file (post-rebase drift)
 * surfaces a friendly toast instead of an unhandled rejection.
 */
async function handleOpenAwaitingFile(file?: string): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr || !file) { return; }

  const root = path.resolve(wr);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    vscode.window.showWarningMessage(`Refusing to open '${file}' — outside the workspace.`);
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    vscode.window.showWarningMessage(`Could not open '${file}' — it may have moved or been removed.`);
  }
}

/**
 * Session-tracking ph1 — "Open chat" deep-link ladder for a panel session row.
 * Attempts the highest rung the source supports and tells the user which fired:
 *   1. Claude Code resume-by-id  (`vscode://anthropic.claude-code/open?session=`)
 *   3. Copy `claude --resume <id>` to the clipboard (when the URI is declined)
 *   4. Reveal the raw transcript file/dir (any tool, when `rawRef` is present)
 *   floor. An honest "no deep link for <tool>" notice.
 *
 * The session rows come from THIS workspace's session heartbeats, so a
 * claude-code resume targets the open workspace and won't spawn a blank chat.
 */
async function handleOpenSession(msg: { sessionId?: string; source?: string; rawRef?: string }): Promise<void> {
  const sessionId = (msg.sessionId || '').trim();
  if (!sessionId) { return; }
  const source = (msg.source || '').toLowerCase();
  const rawRef = (msg.rawRef || '').trim();
  const isClaudeCode = source === 'claude-code' || source === 'claudecode' || source === 'claude';

  // Rung 1 — Claude Code resume-by-id.
  if (isClaudeCode) {
    const uri = vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`);
    let opened = false;
    try { opened = await vscode.env.openExternal(uri); } catch { opened = false; }
    if (opened) { return; }
    // Rung 3 — copy a resume command the user can paste in a terminal.
    try {
      await vscode.env.clipboard.writeText(`claude --resume ${sessionId}`);
      vscode.window.showInformationMessage(`Copied resume command: claude --resume ${sessionId.slice(0, 8)}…`);
    } catch {
      vscode.window.showInformationMessage(`Resume this session: claude --resume ${sessionId}`);
    }
    return;
  }

  // Rung 4 — reveal the transcript file/dir for tools without a resume deep link.
  if (rawRef && await openTranscriptRef(rawRef)) { return; }

  // Floor — honest notice.
  vscode.window.showInformationMessage(
    `No deep link for ${msg.source || 'this tool'} — session ${sessionId.slice(0, 8)}…` +
    (rawRef ? ' (transcript not in a known store).' : '.'),
  );
}

/**
 * Open/reveal a transcript reference, but only when it lives under a known
 * adapter store root — transcripts live OUTSIDE the workspace (e.g. `~/.claude`),
 * so the workspace-confined guard in `handleOpenAwaitingFile` can't be reused.
 * A directory (e.g. a Kilo task dir) is revealed in the OS file explorer; a file
 * is opened read-only. Returns true when something was shown.
 */
async function openTranscriptRef(rawRef: string): Promise<boolean> {
  let target: string;
  try { target = path.resolve(rawRef); } catch { return false; }
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.config'),
    path.join(home, '.autoclaw'),
    path.join(home, 'AppData', 'Roaming'),   // VS Code globalStorage (Windows)
    path.join(home, 'Library', 'Application Support'), // macOS
    path.join(home, '.local', 'share'),      // Linux
  ];
  const within = (root: string): boolean => {
    const rel = path.relative(path.resolve(root), target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (!roots.some(within)) {
    vscode.window.showWarningMessage(`Refusing to open '${rawRef}' — outside known transcript stores.`);
    return false;
  }
  try {
    const stat = await fsPromises.stat(target);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    } else {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return true;
  } catch {
    vscode.window.showWarningMessage(`Could not open transcript '${rawRef}' — it may have moved.`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inbox watcher — event-driven task_complete detection
// ---------------------------------------------------------------------------

// Transitions a sprint to 'review' status once all assigned agents have sent task_complete.
// Uses a regex replace against the YAML string — safe because toYAML() writes `status: <word>` on its own line.
async function transitionSprintToReview(
  workspaceRoot: string,
  sprintNum: number,
  completedAgents: Set<string>
): Promise<void> {
  const sprintPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints', `sprint-${sprintNum}.yaml`);
  if (!fs.existsSync(sprintPath)) { return; }
  const content = await fsPromises.readFile(sprintPath, 'utf8');

  const agentLines = content.match(/^\s*- agent:/gm);
  const expectedCount = agentLines?.length ?? 0;
  if (expectedCount === 0 || completedAgents.size < expectedCount) { return; }
  if (/^status:\s*(review|approved|merged)\s*$/m.test(content)) { return; }

  const updated = content.replace(/^status:\s*(pending|assigned|in_progress)\s*$/m, 'status: review');
  if (updated === content) { return; }
  await fsPromises.writeFile(sprintPath, updated, 'utf8');

  const statePath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json');
  const state = await readStateFile(statePath);
  if (state) {
    for (const agentId of completedAgents) {
      if (state.agents[agentId]) { state.agents[agentId].status = 'review'; }
    }
    state.last_updated = new Date().toISOString();
    await writeStateFile(statePath, state);
  }

  getOrchestrateOutputChannel().appendLine(
    `[orchestrate] Sprint ${sprintNum} → review (${completedAgents.size}/${expectedCount} agents complete)`
  );
}

/**
 * L2 producer-side board watcher. Watches the board's INPUTS (claims, consensus,
 * heartbeats, shared inbox, state.json) and, after a short debounce, refreshes
 * board.json — so cross-IDE state lands sub-second instead of on the 30s tick.
 *
 * Loop-safe: the glob is `*.json` only (the high-churn loop-journal/comms-log are
 * `.jsonl` and never match), and the service's allow-list predicate rejects the
 * producer's own outputs (board.json/board.md/.tmp-*, supervisor.lock, loop-state,
 * dispatch sidecars). `refreshBoardNow` writes only board.json/board.md, which the
 * predicate excludes — so a refresh can never retrigger the watcher.
 *
 * Single-active safe: the injected action reuses the L1 lease gate under the
 * loop's holder id, so only the active supervisor writes; standbys no-op.
 * Off-switchable via `autoclaw.cluster.boardWatch` (default ON).
 */
function startBoardWatch(context: vscode.ExtensionContext, workspaceRoot: string): void {
  const cfg = vscode.workspace.getConfiguration('autoclaw');
  if (!cfg.get<boolean>('cluster.boardWatch', true)) { return; }
  const singleActive = cfg.get<boolean>('cluster.singleActive', true);
  const fencing = cfg.get<boolean>('cluster.fencing', false);
  const debounceMs = cfg.get<number>('cluster.boardWatchDebounceMs', DEFAULT_BOARD_REFRESH_DEBOUNCE_MS);

  const service = startBoardRefreshService({
    debounceMs,
    refresh: () => refreshBoardNow({ workspaceRoot, holderId: LOOP_INSTANCE_ID, singleActive, fencing }),
  });

  // Two scoped watchers — the comms subtree (board inputs) + the root state.json.
  // Scoped to `*.json` so `.jsonl` bookkeeping never fires; the service predicate
  // is the second line of defense (rejects supervisor.lock / loop-state / sidecars).
  for (const glob of [
    '.autoclaw/orchestrator/comms/**/*.json',
    '.autoclaw/orchestrator/state.json',
  ]) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, glob),
    );
    const onChange = (uri: vscode.Uri): void => service.notifyChange(uri.fsPath);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push({ dispose: () => service.stop() });
}

/** globalState key for the one-time LAN-discovery network-consent acknowledgement. */
const LAN_CONSENT_KEY = 'autoclaw.cluster.lan.consentAckAt';

/**
 * T0b: start opt-in LAN peer discovery. NETWORK OFF BY DEFAULT — this binds NO
 * socket unless BOTH gates pass: the `autoclaw.cluster.lan` flag is on AND the user
 * has acknowledged the one-time consent modal (persisted in globalState). Turning the
 * flag on but declining consent leaves it inert. The discovered peers are written as
 * origin-'lan' (DISCOVERED, UNTRUSTED) beacons that the existing presence layer
 * already excludes from every trust sink (beacons.isDiscoveredUntrusted).
 *
 * Lifecycle mirrors startBoardWatch: a dispose() on the extension subscriptions
 * stops the socket + announce timer on deactivate.
 */
async function startLanDiscovery(context: vscode.ExtensionContext, workspaceRoot: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('autoclaw');
  const enabled = cfg.get<boolean>('cluster.lan', false);
  if (!enabled) { return; } // gate 1: flag off ⇒ never bind.

  // Whole body is best-effort — a rejected modal / globalState write (the call site
  // uses `void startLanDiscovery`) must never surface as an unhandledRejection, and a
  // discovery failure must never break activation. Mirrors startBoardWatch's posture.
  try {
  // gate 2: one-time consent. If not yet acknowledged, ask once — naming exactly what
  // goes on the wire and what is recorded. Decline ⇒ no bind (and no nagging again).
  let consentAckAt = context.globalState.get<string>(LAN_CONSENT_KEY) ?? null;
  if (!consentAckAt) {
    const port = cfg.get<number>('cluster.lan.port', LAN_DEFAULT_PORT);
    const mode = cfg.get<LanMode>('cluster.lan.mode', 'seed');
    const choice = await vscode.window.showWarningMessage(
      `Enable AutoClaw LAN peer discovery?\n\n` +
      `This window will bind a UDP socket on port ${port} (${mode} mode) to:\n` +
      `• Broadcast this machine's presence — only an opaque machine id, an IDE label, and this port. ` +
      `NEVER your workspace path, tasks, files, or tokens.\n` +
      `• Listen for other hosts on your LAN and record them as DISCOVERED, UNTRUSTED peers ` +
      `(observe-only — they cannot join, dispatch, or be admitted until a future secure-channel step).\n\n` +
      `Nothing is shared until you enable this. You can turn it off anytime via the autoclaw.cluster.lan setting.`,
      { modal: true },
      'Enable LAN discovery',
    );
    if (choice !== 'Enable LAN discovery') { return; }
    consentAckAt = new Date().toISOString();
    await context.globalState.update(LAN_CONSENT_KEY, consentAckAt);
  }

  if (!shouldStartLanDiscovery({ enabled, consentAckAt })) { return; }

  const port = cfg.get<number>('cluster.lan.port', LAN_DEFAULT_PORT);
  const mode = cfg.get<LanMode>('cluster.lan.mode', 'seed');
  const seeds = parseSeeds(cfg.get<string[]>('cluster.lan.seeds', []), port);
  const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
  // host = a recognizable but non-sensitive LABEL (the wire allowlist bounds it).
  const hostLabel = (os.hostname() || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'host';

  let machineId = 'unknown';
  try { machineId = vscode.env.machineId; } catch { /* keep fallback */ }

  const discovery = new LanDiscovery({
    enabled, consentAckAt, // re-enforced inside start() (defense-in-depth gate)
    machineId, host: hostLabel, commsDir, port, mode, seeds,
    log: (m) => getOrchestrateOutputChannel().appendLine(m),
  });
  discovery.start();
  context.subscriptions.push({ dispose: () => discovery.stop() });
  console.log(`[autoclaw] LAN discovery started – mode=${mode} port=${port} seeds=${seeds.length}`);
  } catch (err) {
    console.warn(`[autoclaw] LAN discovery failed to start: ${String(err)}`);
  }
}

/** globalState key for the one-time LAN cluster-map-gossip network-consent ack. */
const LAN_GOSSIP_CONSENT_KEY = 'autoclaw.cluster.lan.gossip.consentAckAt';

/**
 * T1: start opt-in LAN relay of cluster-map gossip. NETWORK OFF BY DEFAULT — binds NO
 * socket unless BOTH cluster.lan and cluster.lan.gossip are on AND the user
 * acknowledged a DISTINCT one-time consent (the relay puts cluster TOPOLOGY/membership
 * ids on the wire — more than the T0 discovery consent covered — so it asks separately).
 * Relayed peer beats are advisory/wake-only (the E3b consumer never elects on them) and
 * grant NO trust to an unauthenticated LAN peer (T2 authenticates). Mirrors
 * startLanDiscovery's lifecycle (dispose stops the socket + broadcast timer).
 */
async function startLanGossipRelay(context: vscode.ExtensionContext, workspaceRoot: string): Promise<void> {
  // Whole body try-wrapped — neither the gate reads nor the awaited modal/globalState
  // (the call site uses `void`) may surface as an unhandledRejection or break activation.
  try {
    const cfg = vscode.workspace.getConfiguration('autoclaw');
    const enabled = cfg.get<boolean>('cluster.lan', false) && cfg.get<boolean>('cluster.lan.gossip', false);
    if (!enabled) { return; } // gate 1: either flag off ⇒ never bind.

    const port = cfg.get<number>('cluster.lan.gossip.port', LAN_GOSSIP_DEFAULT_PORT);
    const discoveryPort = cfg.get<number>('cluster.lan.port', LAN_DEFAULT_PORT);
    // The relay + discovery are independent sockets in ONE process; the same UDP port
    // would fight for datagrams. Refuse rather than double-bind (don't even prompt).
    if (port === discoveryPort) {
      vscode.window.showWarningMessage(
        `AutoClaw: LAN gossip relay not started — autoclaw.cluster.lan.gossip.port (${port}) must differ ` +
        `from autoclaw.cluster.lan.port (${discoveryPort}). Set distinct ports and reload.`,
      );
      return;
    }

    // gate 2: a SEPARATE one-time consent — the relay puts cluster topology on the wire,
    // which the T0 discovery consent did not name. Decline ⇒ no bind, no nagging.
    let consentAckAt = context.globalState.get<string>(LAN_GOSSIP_CONSENT_KEY) ?? null;
    if (!consentAckAt) {
      const choice = await vscode.window.showWarningMessage(
        `Enable AutoClaw LAN cluster-map gossip relay?\n\n` +
        `This shares this project's COORDINATION TOPOLOGY with discovered LAN hosts. ` +
        `On UDP port ${port}, this window will:\n` +
        `• Broadcast the cluster map — which window is the active orchestrator, the standby/monitor ` +
        `instance ids, epoch/term. Only opaque ids + timestamps. NEVER your workspace path, tasks, files, or tokens.\n` +
        `• Accept peer cluster maps as ADVISORY only — they accelerate awareness of a takeover but ` +
        `can NEVER elect, dispatch, or be trusted here (a future secure-channel step authenticates peers).\n\n` +
        `Requires LAN discovery (autoclaw.cluster.lan) already on. Turn off anytime via autoclaw.cluster.lan.gossip.`,
        { modal: true },
        'Enable gossip relay',
      );
      if (choice !== 'Enable gossip relay') { return; }
      consentAckAt = new Date().toISOString();
      await context.globalState.update(LAN_GOSSIP_CONSENT_KEY, consentAckAt);
    }

    const seeds = parseSeeds(cfg.get<string[]>('cluster.lan.seeds', []), discoveryPort);
    const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

    const relay = new LanGossipRelay({
      enabled, consentAckAt, // re-enforced inside start() (defense-in-depth gate)
      workspaceRoot, commsDir, port, seeds, selfOrigin: LOOP_INSTANCE_ID,
      log: (m) => getOrchestrateOutputChannel().appendLine(m),
    });
    relay.start();
    context.subscriptions.push({ dispose: () => relay.stop() });
    console.log(`[autoclaw] LAN gossip relay started – port=${port} seeds=${seeds.length}`);
  } catch (err) {
    console.warn(`[autoclaw] LAN gossip relay failed to start: ${String(err)}`);
  }
}

function startInboxWatcher(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  // Tracks which agents have sent task_complete, keyed by sprint number.
  const sprintCompletions = new Map<number, Set<string>>();

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
        const payload = (msg.payload as Record<string, unknown>) ?? {};
        const taskId = String(payload.task_id ?? 'a task');
        const sprintNum = typeof msg.sprint === 'number' ? msg.sprint : null;

        // Durable completed-work ledger (Slice B): claims are deleted and
        // board.json is a live snapshot, so this append is the only durable
        // record the panel's Done lane + per-agent history read. Best-effort —
        // recording must never break the watcher.
        try {
          const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
          appendTaskCompletion(commsDir, {
            task_id: taskId,
            agent_id: agentId,
            session_id: typeof msg.session_id === 'string' ? msg.session_id : undefined,
            completed_at: typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString(),
            sprint: sprintNum ?? undefined,
            title: typeof payload.title === 'string' ? payload.title : undefined,
            review_status: typeof payload.review_status === 'string' ? payload.review_status : undefined,
            branch: typeof payload.branch === 'string' ? payload.branch : undefined,
            gates: Array.isArray(payload.gates) ? payload.gates.filter((g: unknown) => typeof g === 'string') : undefined,
            tests_run: typeof payload.tests_run === 'number' ? payload.tests_run : undefined,
            task_ids: Array.isArray(payload.task_ids) ? payload.task_ids.filter((t: unknown) => typeof t === 'string') : undefined,
            summary: typeof payload.summary === 'string' ? payload.summary : undefined,
          });
        } catch { /* ledger is best-effort */ }

        if (sprintNum !== null) {
          if (!sprintCompletions.has(sprintNum)) { sprintCompletions.set(sprintNum, new Set()); }
          sprintCompletions.get(sprintNum)!.add(agentId);
          await transitionSprintToReview(workspaceRoot, sprintNum, sprintCompletions.get(sprintNum)!).catch(() => {});
        }

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
  if (boardWatcher) {
    boardWatcher.dispose();
    boardWatcher = undefined;
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
  stopRefreshService();
  stopIndexWatch();
  unregisterWorker(process.pid, currentIde);
  if (currentWorkspace) {
    releasePorts(currentIde, currentWorkspace);
  }
  if (activeFabric) {
    activeFabric.close().catch(() => {});
    activeFabric = null;
  }
  // Close the in-process Knowledge Graph store (releases the SQLite handle).
  try { closeKnowledgeGraph(); } catch { /* ignore */ }
  if (activeKg && activeKg.child && activeKg.child.exitCode === null) {
    stopKgDaemon(activeKg).catch(() => {});
    activeKg = null;
  }
  if (kgOutputChannel) {
    kgOutputChannel.dispose();
    kgOutputChannel = undefined;
  }
  stopSvidRefresh();
  resetMetrics();
}

// ---------------------------------------------------------------------------
// Program-plane commands (Phase 4)
// ---------------------------------------------------------------------------

async function programCreateCommand(context: vscode.ExtensionContext): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Program name (e.g. "My Zippy stack")',
    placeHolder: 'My multi-repo program',
  });
  if (!name) { return; }

  const homeDir = require('os').homedir() as string;
  const reg = await createProgram({ programName: name, homeDir });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const addSelf = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: `Add current workspace (${path.basename(workspaceRoot)}) as a participant?`,
    });
    if (addSelf === 'Yes') {
      await joinProgram({ programId: reg.program_id, repoPath: workspaceRoot, homeDir });
    }
  }
  vscode.window.showInformationMessage(`Program "${name}" created (ID: ${reg.program_id})`);
}

async function programJoinCommand(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Open a workspace first.'); return; }

  const homeDir = require('os').homedir() as string;
  const programs = await listPrograms(homeDir);
  if (programs.length === 0) {
    vscode.window.showWarningMessage('No programs found. Use "AutoClaw: Create Program…" first.');
    return;
  }

  const items = programs.map(p => ({ label: p.program_name, description: p.program_id, detail: `${p.participants.length} participant(s)` }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a program to join' });
  if (!picked) { return; }

  const roleItem = await vscode.window.showQuickPick(
    [{ label: 'orchestrator', description: 'Receives task assignments' }, { label: 'observer', description: 'Read-only; watches without receiving tasks' }],
    { placeHolder: 'Role for this workspace' }
  );
  const role = (roleItem?.label ?? 'orchestrator') as 'orchestrator' | 'observer';
  await joinProgram({ programId: picked.description!, repoPath: workspaceRoot, homeDir, role });
  vscode.window.showInformationMessage(`Joined program "${picked.label}" as ${role}.`);
}

async function programLeaveCommand(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('Open a workspace first.'); return; }

  const homeDir = require('os').homedir() as string;
  const link = await readProgramLink(workspaceRoot);
  if (!link) {
    vscode.window.showInformationMessage('This workspace is not joined to any program.');
    return;
  }
  const confirm = await vscode.window.showQuickPick(['Yes, leave', 'Cancel'], {
    placeHolder: `Leave program ${link.program_id}?`,
  });
  if (!confirm?.startsWith('Yes')) { return; }
  await leaveProgram(workspaceRoot, homeDir);
  vscode.window.showInformationMessage('Left the program. The backref has been removed.');
}
