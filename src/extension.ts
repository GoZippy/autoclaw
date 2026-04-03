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
   shouldShowNotificationHelper,
   getTodayDate,
   getMemoryPath,
   getStatePath,
   getTodayLogPath,
   checkZippyMeshHealth,
   parseTagsFromContent,
   addTagsToMemory,
   getMemoriesByTags,
   suggestTagsForTask,
   getFileCommitInfo,
   getHealthDirPath,
   getAdapterHealthHistoryPath,
   getAlertsPath,
   recordAdapterHealth,
    getAdapterHealthHistory,
    checkZMLRAvailability,
    getZMLRAIHelp
 } from './kdream-helpers';
import type { ParsedTask, AdapterHealthExtended, TodoItem } from './kdream-helpers';
import {
  explainError,
  extractErrorContext,
  formatAIHelpPrompt,
  showHelpfulErrorNotification
} from './error-help';
import { MemoryHistoryManager } from './memory-history';
import {
  getRoutingEngine,
  resetRoutingEngine,
  DEFAULT_MODELS,
  buildRoutingContextBlock,
} from './routing-engine';
import type { TaskType, ModelTier } from './routing-engine';
import { getSessionHealer, resetSessionHealer } from './session-healer';

const fsPromises = fs.promises;

interface AutoClawQuickPickItem extends vscode.QuickPickItem {
  command: string;
}

interface WorkflowTemplate {
  name: string;
  displayName: string;
  description: string;
  variables: Record<string, string>;
  workflow: WorkflowDefinition;
}

interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
  dependsOn?: string[];
}

interface WorkflowStep {
  name: string;
  command: string;
  workingDirectory: string;
  continueOnError: boolean;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
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
  DEFAULT_ADAPTERS,
  generateNonce,
  shouldShowNotificationHelper,
  getTodayDate,
  getMemoryPath,
  getStatePath,
  getTodayLogPath,
  checkZippyMeshHealth,
  parseTagsFromContent,
  addTagsToMemory,
  getMemoriesByTags,
  suggestTagsForTask,
  explainError,
  extractErrorContext,
  showHelpfulErrorNotification
};
export type { ParsedTask, AdapterHealthExtended as AdapterHealth, TodoItem };

let kdreamView: vscode.WebviewView | undefined = undefined;
let stateWatcher: vscode.FileSystemWatcher | undefined = undefined;
let refreshIntervalId: NodeJS.Timeout | undefined = undefined;
let todoScanDebounceTimer: NodeJS.Timeout | undefined = undefined;
let pendingScanPromise: Promise<ParsedTask[]> | undefined = undefined;
let statusBar: vscode.StatusBarItem | undefined = undefined;
let fileDecorationProvider: AutoClawFileDecorationProvider | undefined = undefined;

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
    vscode.commands.registerCommand('autobuild.list', async () => {
      const templates = await loadWorkflowTemplates();
      const templateList = templates.map(t => `${t.displayName}: ${t.description}`).join('\n');
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          `Available AutoBuild templates:\n${templateList}`,
          'Schedule Workflow'
        ).then(action => {
          if (action === 'Schedule Workflow') {
            vscode.commands.executeCommand('autobuild.schedule');
          }
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.dryRun', async () => {
      const workflowName = await vscode.window.showInputBox({
        prompt: 'Enter workflow name for dry-run',
        placeHolder: 'build-and-test'
      });

      if (!workflowName) return;

      const workflow = await loadWorkflowByName(workflowName);
      if (!workflow) {
        vscode.window.showErrorMessage(`Workflow not found: ${workflowName}`);
        return;
      }

      const steps = workflow.steps.map((step, i) =>
        `${i + 1}. ${step.name}: ${step.command}${step.retry ? ` (retry: ${step.retry.maxAttempts}x)` : ''}`
      ).join('\n');

      const depInfo = workflow.dependsOn && workflow.dependsOn.length > 0
        ? `\nDependencies: ${workflow.dependsOn.join(', ')}`
        : '';

      await vscode.window.showInformationMessage(
        `Dry Run: ${workflow.name}${depInfo}\n\nSteps that would execute:\n${steps}`,
        { modal: true }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.run', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workflowsDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'workflows');
      try {
        const files = await fsPromises.readdir(workflowsDir);
        const workflowFiles = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

        if (workflowFiles.length === 0) {
          vscode.window.showInformationMessage('No workflows found. Schedule one first with AutoBuild: Schedule Workflow.');
          return;
        }

        const choice = await vscode.window.showQuickPick(workflowFiles, {
          placeHolder: 'Select a workflow to run'
        });

        if (!choice) return;

        await executeWorkflowWithDependencies(choice);
      } catch {
        vscode.window.showErrorMessage('No workflows directory found. Schedule a workflow first.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.history', async () => {
      const history = await loadWorkflowHistory();

      if (history.length === 0) {
        vscode.window.showInformationMessage('No workflow execution history found.');
        return;
      }

      const historyItems = history.slice(-20).reverse().map(record => ({
        label: record.workflowName,
        description: record.status,
        detail: `${new Date(record.startTime).toLocaleString()} — ${record.steps.length} steps${record.endTime ? ` (${Math.round((new Date(record.endTime).getTime() - new Date(record.startTime).getTime()) / 1000)}s)` : ''}`
      }));

      await vscode.window.showQuickPick(historyItems, {
        placeHolder: 'Workflow Execution History',
        matchOnDescription: true,
        matchOnDetail: true
      });

      if (kdreamView) {
        await refreshDashboardData(kdreamView);
      }
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
     vscode.commands.registerCommand('kdream.focusDashboard', async () => {
       if (kdreamView) {
         kdreamView.show(true);
       } else {
         await vscode.commands.executeCommand('kdream.showDashboard');
       }
     })
   );

   context.subscriptions.push(
     vscode.commands.registerCommand('kdream.toggleSection', async (direction) => {
       if (!kdreamView) return;
       
       // Send message to webview to handle section toggling
       kdreamView.webview.postMessage({
         command: 'toggleDashboardSection',
         direction: direction || 'next'
       });
     })
   );

   context.subscriptions.push(
     vscode.commands.registerCommand('kdream.searchDashboard', async () => {
       if (!kdreamView) return;
       
       kdreamView.webview.postMessage({
         command: 'focusSearchInput'
       });
     })
   );

   context.subscriptions.push(
     vscode.commands.registerCommand('kdream.helpDashboard', async () => {
       if (!kdreamView) return;
       
       kdreamView.webview.postMessage({
         command: 'openHelp'
       });
     })
   );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.addTask', async () => {
      const task = await vscode.window.showInputBox({
        prompt: 'Enter task for KDream',
        placeHolder: 'e.g., Review PR #123'
      });
      if (task) {
        // Priority selection
        const priorityChoice = await vscode.window.showQuickPick(
          [
            { label: '🔴 High Priority', value: 'high' as const },
            { label: '🟡 Medium Priority', value: 'medium' as const },
            { label: '🔵 Low Priority', value: 'low' as const }
          ],
          { placeHolder: 'Select priority level (optional)' }
        );
        const priority = priorityChoice?.value ?? undefined;

        // Due date selection
        const today = new Date();
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const thisWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const nextWeek = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
        
        const dueDateOptions = [
          { label: 'Today', value: today.toISOString().slice(0, 10) },
          { label: 'Tomorrow', value: tomorrow.toISOString().slice(0, 10) },
          { label: 'This Week', value: thisWeek.toISOString().slice(0, 10) },
          { label: 'Next Week', value: nextWeek.toISOString().slice(0, 10) },
          { label: 'Custom Date...', value: 'custom' },
          { label: 'No Due Date', value: undefined }
        ];

        const dueDateChoice = await vscode.window.showQuickPick(dueDateOptions, { placeHolder: 'Set due date (optional)' });

        let dueDate: string | undefined = undefined;
        if (dueDateChoice?.value === 'custom') {
          const customDate = await vscode.window.showInputBox({
            prompt: 'Enter due date (YYYY-MM-DD)',
            placeHolder: '2026-04-15'
          });
          dueDate = customDate ?? undefined;
        } else {
          dueDate = dueDateChoice?.value;
        }

        const suggestedTags = suggestTagsForTask(task);
        let taggedTask = task;

        if (suggestedTags.length > 0) {
          const addTags = await vscode.window.showQuickPick(
            ['No tags', ...suggestedTags.map(tag => `#${tag}`)],
            {
              canPickMany: true,
              placeHolder: 'Select tags for this task (optional)'
            }
          );

          if (addTags && addTags.length > 0 && !addTags.includes('No tags')) {
            taggedTask += ' ' + addTags.join(' ');
          }
        }

        await addTaskToMemory(taggedTask, undefined, { priority, dueDate });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.openZmlrDownload', async () => {
      await vscode.env.openExternal(vscode.Uri.parse('https://zippymesh.com'));
    })
  );

  // AutoBuild Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.schedule', async () => {
      // Load available templates
      const templates = await loadWorkflowTemplates();

      // Let user choose template
      const templateChoice = await vscode.window.showQuickPick(
        templates.map(t => ({
          label: t.displayName,
          description: t.description,
          detail: `Variables: ${Object.keys(t.variables).join(', ')}`,
          template: t
        })),
        { placeHolder: 'Choose a workflow template' }
      );

      if (!templateChoice) return;

      const template = templateChoice.template;

      // Collect variable values
      const variables: Record<string, string> = {};
      for (const [key, defaultValue] of Object.entries(template.variables)) {
        const value = await vscode.window.showInputBox({
          prompt: `Enter value for ${key}`,
          value: defaultValue as string,
          placeHolder: `e.g., ${defaultValue}`
        });

        if (value === undefined) return; // Cancelled
        variables[key] = value;
      }

      // Generate workflow from template
      const workflow = generateWorkflowFromTemplate(template, variables);

      // Save and schedule the workflow
      const workflowPath = await saveWorkflowToFile(workflow);

      if (shouldShowNotification('info')) {
        const action = await vscode.window.showInformationMessage(
          `Workflow "${workflow.name}" created and scheduled.`,
          'View Status'
        );

        if (action === 'View Status') {
          await vscode.commands.executeCommand('autobuild.status');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.status', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open');
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          'AutoBuild status requested via chat. Check the chat for current workflow status.'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.list', async () => {
      const templates = await loadWorkflowTemplates();
      const templateList = templates.map(t => `${t.displayName}: ${t.description}`).join('\n');
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          `Available AutoBuild templates:\n${templateList}`,
          'Schedule Workflow'
        ).then(action => {
          if (action === 'Schedule Workflow') {
            vscode.commands.executeCommand('autobuild.schedule');
          }
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.dryRun', async () => {
      const workflowName = await vscode.window.showInputBox({
        prompt: 'Enter workflow name for dry-run',
        placeHolder: 'build-and-test'
      });

      if (!workflowName) return;

      const workflow = await loadWorkflowByName(workflowName);
      if (!workflow) {
        vscode.window.showErrorMessage(`Workflow not found: ${workflowName}`);
        return;
      }

      const steps = workflow.steps.map((step, i) =>
        `${i + 1}. ${step.name}: ${step.command}${step.retry ? ` (retry: ${step.retry.maxAttempts}x)` : ''}`
      ).join('\n');

      const depInfo = workflow.dependsOn && workflow.dependsOn.length > 0
        ? `\nDependencies: ${workflow.dependsOn.join(', ')}`
        : '';

      await vscode.window.showInformationMessage(
        `Dry Run: ${workflow.name}${depInfo}\n\nSteps that would execute:\n${steps}`,
        { modal: true }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.run', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workflowsDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'workflows');
      try {
        const files = await fsPromises.readdir(workflowsDir);
        const workflowFiles = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

        if (workflowFiles.length === 0) {
          vscode.window.showInformationMessage('No workflows found. Schedule one first with AutoBuild: Schedule Workflow.');
          return;
        }

        const choice = await vscode.window.showQuickPick(workflowFiles, {
          placeHolder: 'Select a workflow to run'
        });

        if (!choice) return;

        await executeWorkflowWithDependencies(choice);
      } catch {
        vscode.window.showErrorMessage('No workflows directory found. Schedule a workflow first.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autobuild.history', async () => {
      const history = await loadWorkflowHistory();

      if (history.length === 0) {
        vscode.window.showInformationMessage('No workflow execution history found.');
        return;
      }

      const historyItems = history.slice(-20).reverse().map(record => ({
        label: record.workflowName,
        description: record.status,
        detail: `${new Date(record.startTime).toLocaleString()} — ${record.steps.length} steps${record.endTime ? ` (${Math.round((new Date(record.endTime).getTime() - new Date(record.startTime).getTime()) / 1000)}s)` : ''}`
      }));

      await vscode.window.showQuickPick(historyItems, {
        placeHolder: 'Workflow Execution History',
        matchOnDescription: true,
        matchOnDetail: true
      });

      if (kdreamView) {
        await refreshDashboardData(kdreamView);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mateam.launch', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open');
      if (shouldShowNotification('info')) {
        vscode.window.showInformationMessage(
          'MAteam session requested via chat. Check the chat for multi-agent coordination.'
        );
      }
    })
  );

  // Error Help System Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.askAIHelp', async () => {
      await openAIHelpChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.openFAQ', async (_section?: string) => {
      await openFAQ(_section as string | undefined);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.openGitignore', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        try {
          await fsPromises.access(gitignorePath);
          await vscode.window.showTextDocument(vscode.Uri.file(gitignorePath));
        } catch {
          vscode.window.showInformationMessage('No .gitignore found in workspace root.');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.searchMemory', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Search KDream memory',
        placeHolder: 'Enter search terms...'
      });
      if (query && kdreamView) {
        await searchMemory(query, kdreamView);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kdream.showMemoryHistory', async () => {
      const historyManager = new MemoryHistoryManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!);
      await historyManager.initialize();

      // Get last 7 days of history
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const history = await historyManager.getHistoryRange(startDate, endDate);

      // Send to dashboard
      kdreamView?.webview.postMessage({
        command: 'showMemoryHistory',
        data: history
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.showCommands', async () => {
      const commands = getAutoClawCommands();
      const selected = await vscode.window.showQuickPick(commands, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Search AutoClaw commands...'
      });

      if (selected) {
        await vscode.commands.executeCommand((selected as AutoClawQuickPickItem).command);
      }
    })
  );

  // Context menu commands
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.addSelectionToTask', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText.trim()) {
        vscode.window.showWarningMessage('Please select some text first.');
        return;
      }

      const relativePath = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        editor.document.uri.fsPath
      );

      const sourceInfo: { file: string; line: number; commit?: string; date?: string } = {
        file: relativePath,
        line: selection.start.line + 1
      };

      // Get commit info
      const commitInfo = await getFileCommitInfo(relativePath);
      if (commitInfo) {
        sourceInfo.commit = commitInfo.commit;
        sourceInfo.date = commitInfo.date;
      }

      const task = `Review/Handle: "${selectedText.trim()}"`;
      await addTaskToMemory(task, sourceInfo);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.addTodoFromContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const currentLine = editor.selection.active.line;
      const lineText = editor.document.lineAt(currentLine).text;

      // Check if line contains TODO or FIXME
      const todoMatch = lineText.match(/(TODO|FIXME)\s*[:\-]?\s*(.*)/i);
      if (!todoMatch) {
        vscode.window.showWarningMessage('Current line does not contain a TODO or FIXME comment.');
        return;
      }

      const relativePath = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        editor.document.uri.fsPath
      );

      const sourceInfo: { file: string; line: number; commit?: string; date?: string } = {
        file: relativePath,
        line: currentLine + 1
      };

      // Get commit info
      const commitInfo = await getFileCommitInfo(relativePath);
      if (commitInfo) {
        sourceInfo.commit = commitInfo.commit;
        sourceInfo.date = commitInfo.date;
      }

      const task = `${todoMatch[1].toUpperCase()}: ${todoMatch[2].trim()}`;
      await addTaskToMemory(task, sourceInfo);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.addFileToTask', async (uri: vscode.Uri) => {
      if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          uri = editor.document.uri;
        } else {
          vscode.window.showWarningMessage('No file selected.');
          return;
        }
      }

      const relativePath = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        uri.fsPath
      );

      const task = `Review file: ${relativePath}`;
      await addTaskToMemory(task);
    })
  );

  // Terminal integration
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.openTerminal', async () => {
      const terminal = vscode.window.createTerminal('AutoClaw');
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('autoclaw.terminal', new AutoClawTerminalProfileProvider())
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
    updateStatusBar();
  });
  context.subscriptions.push(stateWatcher);

  // Set up status bar item
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'autoclaw.statusBarClick';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.statusBarClick', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '$(terminal) AutoClaw: Open Terminal', command: 'autoclaw.openTerminal' },
        { label: '$(tools) AutoBuild: Schedule', command: 'autobuild.schedule' },
        { label: '$(graph) AutoBuild: Status', command: 'autobuild.status' },
        { label: '$(dashboard) KDream: Dashboard', command: 'kdream.showDashboard' },
        { label: '$(add) KDream: Add Task', command: 'kdream.addTask' },
        { label: '$(refresh) KDream: Refresh', command: 'kdream.refreshDashboard' },
        { label: '$(search) KDream: Search', command: 'kdream.searchMemory' },
        { label: '$(history) KDream: Memory History', command: 'kdream.showMemoryHistory' },
        { label: '$(play) Start KDream', command: 'autoclaw.startKdream' },
        { label: '$(list-unordered) Show Commands', command: 'autoclaw.showCommands' }
      ]);
      if (choice) {
        await vscode.commands.executeCommand(choice.command);
      }
    })
  );

  updateStatusBar();

  // Check if .autoclaw/ is in .gitignore
  checkAndOfferGitignoreUpdate().catch(e => console.error('gitignore check failed:', e));

  // Auto-install adapters silently on activation if enabled
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const autoInstall = config.get<boolean>('autoInstallAdapters', true);
  if (autoInstall) {
    installAdapters(adaptersDir, context.extensionPath, true).catch(e => console.error('adapter install failed:', e));
  }

  // Register TODO/FIXME Code Lens Provider
  const todoLensProvider = new TodoCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'python' },
        { scheme: 'file', language: 'markdown' }
      ],
      todoLensProvider
    )
  );

  // Register File Decoration Provider
  fileDecorationProvider = new AutoClawFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider)
  );

  // Initial decoration refresh
  const kdreamConfig = vscode.workspace.getConfiguration('autoclaw.kdream');
  const enableDecorations = kdreamConfig.get<boolean>('enableFileDecorations', true);
  if (enableDecorations) {
    fileDecorationProvider.refreshDecorations();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.refreshDecorations', () => {
      if (fileDecorationProvider) {
        fileDecorationProvider.refreshDecorations();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.addTodoAsTask', async (todoText: string, filePath: string, line: number) => {
      const relativePath = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath);
      const sourceInfo: { file: string; line: number; commit?: string; date?: string } = { file: relativePath, line };

      // Get commit info
      const commitInfo = await getFileCommitInfo(relativePath);
      if (commitInfo) {
        sourceInfo.commit = commitInfo.commit;
        sourceInfo.date = commitInfo.date;
      }

      await addTaskToMemory(todoText, sourceInfo);
    })
  );

  // ── Intelligent Routing commands ──────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.healSessions', async () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) {
        vscode.window.showWarningMessage('AutoClaw: No workspace open.');
        return;
      }
      const healer = getSessionHealer(wsRoot);
      if (!healer) { return; }
      await healer.startWatching();
      const results = await healer.healAllStalledSessions();
      if (results.length === 0) {
        vscode.window.showInformationMessage('AutoClaw: All sessions appear healthy — no healing needed.');
      } else {
        const summary = results.map(r => `${r.sessionId}: ${r.action}`).join(', ');
        vscode.window.showInformationMessage(`AutoClaw Healer: ${summary}`);
      }
      // Refresh dashboard
      if (kdreamView) { await refreshDashboardData(kdreamView); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.routingDecide', async () => {
      const engine = getRoutingEngine();
      const taskTypes: vscode.QuickPickItem[] = [
        { label: 'research', description: 'Codebase exploration, fact gathering' },
        { label: 'coding', description: 'Implementation, bug fixes' },
        { label: 'review', description: 'Code review, security audit' },
        { label: 'planning', description: 'Architecture, task decomposition' },
        { label: 'final-review', description: 'SOTA model final quality gate' },
        { label: 'general', description: 'General purpose' },
      ];
      const picked = await vscode.window.showQuickPick(taskTypes, { placeHolder: 'Select task type' });
      if (!picked) { return; }
      try {
        const decision = await engine.decide(picked.label as TaskType);
        vscode.window.showInformationMessage(
          `Routing: ${decision.model} ${decision.viaZMLR ? '(via ZMLR)' : '(direct)'} — ${decision.reason}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Routing decision failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.recheckZMLR', async () => {
      const engine = getRoutingEngine();
      const online = await engine.recheckZMLR();
      vscode.window.showInformationMessage(
        online ? 'AutoClaw: ZMLR is online and healthy.' : 'AutoClaw: ZMLR is not reachable at the configured URL.'
      );
      if (kdreamView) { await refreshDashboardData(kdreamView); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.resetRouting', () => {
      resetRoutingEngine();
      resetSessionHealer();
      vscode.window.showInformationMessage('AutoClaw: Routing engine and session healer reset.');
    })
  );

  // Start session healer in the background
  const wsRootForHealer = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRootForHealer) {
    const healer = getSessionHealer(wsRootForHealer);
    healer?.startWatching().catch(e => console.error('[AutoClaw] Session healer start error:', e));
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
    await copySkillDir(path.join(adaptersDir, 'claude-code'), dest);
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
    await copyDir(path.join(adaptersDir, 'cline'), dest);
    installed.push('Cline');
  }

  // KiloCode — workspace .kilocodemodes
  if (vscode.extensions.getExtension('kilocode.kilo-code')) {
    const src = path.join(adaptersDir, 'kilocode', 'autoclaw-modes.yaml');
    const dest = path.join(workspaceRoot, '.kilocodemodes');
    await mergeKiloModes(src, dest);
    installed.push('KiloCode');
  }

  // Cursor — workspace .cursor/rules/
  const cursorDir = path.join(workspaceRoot, '.cursor', 'rules');
  const cursorDirExists = await fsPromises.access(path.join(workspaceRoot, '.cursor')).then(() => true).catch(() => false);
  if (cursorDirExists || await hasCursorConfig(workspaceRoot)) {
    fs.mkdirSync(cursorDir, { recursive: true });
    await copyDir(path.join(adaptersDir, 'cursor'), cursorDir);
    installed.push('Cursor');
  }

  // Kiro — workspace .kiro/steering/
  const kiroDir = path.join(workspaceRoot, '.kiro');
  const kiroDirExists = await fsPromises.access(kiroDir).then(() => true).catch(() => false);
  if (kiroDirExists || vscode.extensions.getExtension('amazon.kiro')) {
    const dest = path.join(workspaceRoot, '.kiro', 'steering');
    await copyDir(path.join(adaptersDir, 'kiro'), dest);
    installed.push('Kiro');
  }

  // Windsurf — workspace .windsurf/rules/
  const windsurfDir = path.join(workspaceRoot, '.windsurf');
  const windsurfDirExists = await fsPromises.access(windsurfDir).then(() => true).catch(() => false);
  if (windsurfDirExists || vscode.extensions.getExtension('codeium.windsurf')) {
    const dest = path.join(workspaceRoot, '.windsurf', 'rules');
    await copyDir(path.join(adaptersDir, 'windsurf'), dest);
    installed.push('Windsurf');
  }

  // Continue — workspace .continue/prompts/
  if (vscode.extensions.getExtension('Continue.continue')) {
    const dest = path.join(workspaceRoot, '.continue', 'prompts');
    await copyDir(path.join(adaptersDir, 'continue'), dest);
    installed.push('Continue');
  }

  // ZippyMesh LLM Router — drop setup guide if ZMLR is running
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
        const zmlrDestDir = path.join(workspaceRoot, '.autoclaw', 'zippymesh');
        await copyDir(path.join(adaptersDir, 'zippymesh'), zmlrDestDir);
        installed.push('ZippyMesh LLM Router');

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

async function copyDir(src: string, dest: string): Promise<void> {
  const exists = await fsPromises.access(src).then(() => true).catch(() => false);
  if (!exists) { return; }
  await fsPromises.mkdir(dest, { recursive: true });
  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcFile = path.join(src, entry.name);
    const destFile = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcFile, destFile);
    } else {
      await fsPromises.copyFile(srcFile, destFile);
    }
  }
}

async function copySkillDir(src: string, dest: string): Promise<void> {
  const exists = await fsPromises.access(src).then(() => true).catch(() => false);
  if (!exists) { return; }
  await fsPromises.mkdir(dest, { recursive: true });
  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const skillSrc = path.join(src, entry.name);
    const skillDest = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(skillSrc, skillDest);
    }
  }
}

async function mergeKiloModes(src: string, dest: string): Promise<void> {
  const srcExists = await fsPromises.access(src).then(() => true).catch(() => false);
  if (!srcExists) { return; }
  const destExists = await fsPromises.access(dest).then(() => true).catch(() => false);
  if (!destExists) {
    await fsPromises.copyFile(src, dest);
    return;
  }
  const existing = await fsPromises.readFile(dest, 'utf8');
  if (existing.includes('slug: kdream')) { return; }
  const addition = '\n# AutoClaw modes\n' + await fsPromises.readFile(src, 'utf8');
  await fsPromises.appendFile(dest, addition);
}

async function hasCursorConfig(workspaceRoot: string): Promise<boolean> {
  const indicators = ['.cursorrules', '.cursor'];
  for (const f of indicators) {
    const exists = await fsPromises.access(path.join(workspaceRoot, f)).then(() => true).catch(() => false);
    if (exists) { return true; }
  }
  return false;
}

async function offerZippyMeshMcpSetup(adaptersDir: string): Promise<void> {
  const mcpPath = path.join(os.homedir(), '.claude', 'mcp.json');

  try {
    const existing = await fsPromises.readFile(mcpPath, 'utf8');
    if (existing.includes('zippymesh')) {
      return;
    }
  } catch {
    // File doesn't exist yet
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

  const zmlrPaths = [
    path.join(os.homedir(), 'zippymesh-router'),
    path.join(os.homedir(), 'Downloads', 'zippymesh-router'),
    'C:/zippymesh-router',
    'C:/Program Files/zippymesh-router'
  ];

  let defaultZmlrPath = '';
  for (const p of zmlrPaths) {
    const exists = await fsPromises.access(p).then(() => true).catch(() => false);
    if (exists) { defaultZmlrPath = p; break; }
  }

  const zmlrPath = await vscode.window.showInputBox({
    prompt: 'Enter the path to your ZippyMesh LLM Router installation',
    placeHolder: 'e.g., C:/zippymesh-router or ~/zippymesh-router',
    value: defaultZmlrPath
  });

  if (!zmlrPath) { return; }

  let mcpConfig: Record<string, unknown> = { mcpServers: {} };
  try {
    const existing = await fsPromises.readFile(mcpPath, 'utf8');
    mcpConfig = JSON.parse(existing);
    if (!mcpConfig.mcpServers) { (mcpConfig as Record<string, unknown>).mcpServers = {}; }
  } catch {
    // Start fresh
  }

  (mcpConfig.mcpServers as Record<string, unknown>).zippymesh = {
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

  const statePath = getStatePath(workspaceRoot);
  let stateData: unknown = null;
  try {
    await fsPromises.access(statePath);
    const content = await fsPromises.readFile(statePath, 'utf8');
    stateData = JSON.parse(content);
  } catch {
    // File doesn't exist or can't be read
  }

  const memoryPath = getMemoryPath(workspaceRoot);
  let tasks: ParsedTask[] = [];
  try {
    await fsPromises.access(memoryPath);
    const memoryContent = await fsPromises.readFile(memoryPath, 'utf8');
    tasks = parseMemoryTasks(memoryContent);
  } catch {
    // File doesn't exist or can't be read
  }

  const logPath = getTodayLogPath(workspaceRoot);
  let logs: string[] = [];
  try {
    await fsPromises.access(logPath);
    const logContent = await fsPromises.readFile(logPath, 'utf8');
    logs = parseLogEntries(logContent);
  } catch {
    // File doesn't exist or can't be read
  }

  const adapterHealth = await getAdapterHealth();
  const todos = await scanWorkspaceForTodos();

  // Collect all unique tags from tasks
  const allTags = [...new Set(tasks.flatMap(task => parseTagsFromContent(task.description)))].sort();

    try {
      view.webview.postMessage({ command: 'updateStatus', data: stateData });
      view.webview.postMessage({ command: 'updateTasks', data: tasks, tags: allTags });
      view.webview.postMessage({ command: 'updateLogs', data: logs });
      view.webview.postMessage({ command: 'updateAdapterHealth', data: adapterHealth });
      view.webview.postMessage({ command: 'updateTodos', data: todos });

      const workflowHistory = await loadWorkflowHistory();
      view.webview.postMessage({ command: 'updateWorkflowHistory', data: workflowHistory });

      // Send health history data (last 24 hours by default)
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        getAdapterHealthHistory(workspaceRoot, 24).then(history => {
          view.webview.postMessage({ command: 'updateAdapterHealthHistory', data: history });
        }).catch(error => {
          console.error('Failed to get adapter health history:', error);
          view.webview.postMessage({ command: 'updateAdapterHealthHistory', data: [] });
        });

        // Push routing state
        const engine = getRoutingEngine();
        engine.recheckZMLR().then(online => {
          view.webview.postMessage({ command: 'routing:zmlrStatus', online });
          view.webview.postMessage({ command: 'routing:rateLimits', data: engine.getRateLimitStatus() });
        }).catch(() => {/* non-fatal */});

        const healer = getSessionHealer(workspaceRoot);
        if (healer) {
          healer.startWatching().then(() => {
            view.webview.postMessage({ command: 'routing:sessions', data: healer.getSessions() });
          }).catch(() => {/* non-fatal */});
        }

        // Push routing config
        const routingCfg = vscode.workspace.getConfiguration('autoclaw.routing');
        view.webview.postMessage({
          command: 'routing:config',
          zmlrUrl: routingCfg.get('zmlrUrl', 'http://localhost:20128'),
          failoverMode: routingCfg.get('failoverMode', 'ask'),
        });
      }
    } catch (e) {
     console.error('Error sending message to webview:', e);
   }

  // Refresh file decorations when dashboard is opened
  const kdreamConfig = vscode.workspace.getConfiguration('autoclaw.kdream');
  const enableDecorations = kdreamConfig.get<boolean>('enableFileDecorations', true);
  if (enableDecorations && fileDecorationProvider) {
    fileDecorationProvider.refreshDecorations();
  }
}

export async function getAdapterHealth(): Promise<AdapterHealthExtended[]> {
   const config = vscode.workspace.getConfiguration('autoclaw.kdream');
   const adapters: { name: string; id: string }[] = config.get('adapters', DEFAULT_ADAPTERS);

   const extensionResults = adapters.map(adapter => {
     const extension = vscode.extensions.getExtension(adapter.id);
     const healthEntry = getAdapterHealthEntry(adapter.name, !!extension);
     
     // Add mock metrics for demonstration - in a real implementation, these would come from actual adapter monitoring
     const extendedHealth: AdapterHealthExtended = {
       ...healthEntry,
       responseTime: Math.floor(Math.random() * 2000), // Mock response time in ms
       errorRate: Math.random() * 0.2 // Mock error rate (0-0.2)
     };
     
     return extendedHealth;
   });

   // ZMLR health check is optional — dashboard works fine without it
   try {
     const zmlrUrl = config.get<string>('zippymeshUrl', 'http://localhost:20128');
     const zmlrHealth = await checkZippyMeshHealth(zmlrUrl);
     // Add mock metrics for ZMLR
     const extendedZmlrHealth: AdapterHealthExtended = {
       ...zmlrHealth,
       responseTime: Math.floor(Math.random() * 1000),
       errorRate: Math.random() * 0.1
     };
     return [...extensionResults, extendedZmlrHealth];
   } catch {
     return extensionResults;
  }
}

/**
 * Opens the AutoClaw FAQ document, optionally scrolled to a specific section.
 */
async function openFAQ(section?: string): Promise<void> {
  const extensionPath = vscode.extensions.getExtension('ZippyTechnologiesLLC.autoclaw')?.extensionPath;
  if (!extensionPath) {
    vscode.window.showErrorMessage('Could not find AutoClaw extension path.');
    return;
  }

  const faqPath = path.join(extensionPath, 'docs', 'FAQ.md');
  try {
    await fsPromises.access(faqPath);
    const doc = await vscode.workspace.openTextDocument(faqPath);
    const editor = await vscode.window.showTextDocument(doc);

    if (section) {
      const text = doc.getText();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(section.toLowerCase().replace(/-/g, ' ')) ||
            lines[i].toLowerCase().includes(section.toLowerCase())) {
          const range = new vscode.Range(i, 0, i, lines[i].length);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          break;
        }
      }
    }
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/GoZippy/autoclaw/blob/master/docs/FAQ.md'));
  }
}

async function loadWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const extensionPath = vscode.extensions.getExtension('ZippyTechnologiesLLC.autoclaw')?.extensionPath;
  if (!extensionPath) return [];

  const templatesPath = path.join(extensionPath, 'templates', 'autobuild-workflows.json');

  try {
    const content = await fsPromises.readFile(templatesPath, 'utf8');
    const data = JSON.parse(content);
    return data.templates || [];
  } catch {
    console.warn('Could not load workflow templates');
    return [];
  }
}

function generateWorkflowFromTemplate(
  template: WorkflowTemplate,
  variables: Record<string, string>
): WorkflowDefinition {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

  const workflow: WorkflowDefinition = JSON.parse(JSON.stringify(template.workflow));
  workflow.name = workflow.name.replace('{{timestamp}}', timestamp);

  const replaceVars = (obj: any): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        let replaced = value;
        for (const [varKey, varValue] of Object.entries(variables)) {
          replaced = replaced.replace(new RegExp(`{{${varKey}}}`, 'g'), varValue);
        }
        obj[key] = replaced.replace('{{timestamp}}', timestamp);
      } else if (typeof value === 'object' && value !== null) {
        replaceVars(value);
      }
    }
  };

  replaceVars(workflow);
  return workflow;
}

async function saveWorkflowToFile(workflow: WorkflowDefinition): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) throw new Error('No workspace open');

  const workflowsDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'workflows');
  await fsPromises.mkdir(workflowsDir, { recursive: true });

  const workflowPath = path.join(workflowsDir, `${workflow.name}.json`);
  await fsPromises.writeFile(workflowPath, JSON.stringify(workflow, null, 2));

  return workflowPath;
}

interface WorkflowTemplate {
  name: string;
  displayName: string;
  description: string;
  variables: Record<string, string>;
  workflow: WorkflowDefinition;
}

interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
  dependsOn?: string[];
}

interface WorkflowStep {
  name: string;
  command: string;
  workingDirectory: string;
  continueOnError: boolean;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
}

async function scanWorkspaceForTodos(): Promise<ParsedTask[]> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return [];
  }

  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const patterns: string[] = config.get('scanPatterns', ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.md']);
  const results: ParsedTask[] = [];

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
        const CHUNK_SIZE = 10;
        for (let i = 0; i < files.length; i += CHUNK_SIZE) {
          const chunk = files.slice(i, i + CHUNK_SIZE);
          const chunkResults = await Promise.all(
            chunk.map(async (fileUri) => {
              const filePath = fileUri.fsPath;
              try {
                const content = await fsPromises.readFile(filePath, 'utf8');
                const relativePath = path.relative(workspaceRoot, filePath);
                const commitInfo = await getFileCommitInfo(relativePath);
                const lines = content.split('\n');

                const todos: ParsedTask[] = [];
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  const todoMatch = line.match(/(TODO|FIXME)\s*[:\-]?\s*(.*)/i);

                  if (todoMatch) {
                    todos.push({
                      description: `${todoMatch[1].toUpperCase()}: ${todoMatch[2].trim()}`,
                      completed: false,
                      source: {
                        file: relativePath,
                        line: i + 1,
                        commit: commitInfo?.commit,
                        date: commitInfo?.date
                      }
                    });
  }
}

/**
 * Opens the AutoClaw FAQ document, optionally scrolled to a specific section.
 */
async function openFAQ(section?: string): Promise<void> {
  const extensionPath = vscode.extensions.getExtension('ZippyTechnologiesLLC.autoclaw')?.extensionPath;
  if (!extensionPath) {
    vscode.window.showErrorMessage('Could not find AutoClaw extension path.');
    return;
  }

  const faqPath = path.join(extensionPath, 'docs', 'FAQ.md');
  try {
    await fsPromises.access(faqPath);
    const doc = await vscode.workspace.openTextDocument(faqPath);
    const editor = await vscode.window.showTextDocument(doc);

    if (section) {
      const text = doc.getText();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(section.toLowerCase().replace(/-/g, ' ')) ||
            lines[i].toLowerCase().includes(section.toLowerCase())) {
          const range = new vscode.Range(i, 0, i, lines[i].length);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          break;
        }
      }
    }
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/GoZippy/autoclaw/blob/master/docs/FAQ.md'));
  }
}

async function loadWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const extensionPath = vscode.extensions.getExtension('ZippyTechnologiesLLC.autoclaw')?.extensionPath;
  if (!extensionPath) return [];

  const templatesPath = path.join(extensionPath, 'templates', 'autobuild-workflows.json');

  try {
    const content = await fsPromises.readFile(templatesPath, 'utf8');
    const data = JSON.parse(content);
    return data.templates || [];
  } catch {
    console.warn('Could not load workflow templates');
    return [];
  }
}

function generateWorkflowFromTemplate(
  template: WorkflowTemplate,
  variables: Record<string, string>
): WorkflowDefinition {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

  const workflow: WorkflowDefinition = JSON.parse(JSON.stringify(template.workflow));
  workflow.name = workflow.name.replace('{{timestamp}}', timestamp);

  const replaceVars = (obj: any): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        let replaced = value;
        for (const [varKey, varValue] of Object.entries(variables)) {
          replaced = replaced.replace(new RegExp(`{{${varKey}}}`, 'g'), varValue);
        }
        obj[key] = replaced.replace('{{timestamp}}', timestamp);
      } else if (typeof value === 'object' && value !== null) {
        replaceVars(value);
      }
    }
  };

  replaceVars(workflow);
  return workflow;
}

async function saveWorkflowToFile(workflow: WorkflowDefinition): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) throw new Error('No workspace open');

  const workflowsDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'workflows');
  await fsPromises.mkdir(workflowsDir, { recursive: true });

  const workflowPath = path.join(workflowsDir, `${workflow.name}.json`);
  await fsPromises.writeFile(workflowPath, JSON.stringify(workflow, null, 2));

  return workflowPath;
}

interface WorkflowTemplate {
  name: string;
  displayName: string;
  description: string;
  variables: Record<string, string>;
  workflow: WorkflowDefinition;
}

interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
  dependsOn?: string[];
}

interface WorkflowStep {
  name: string;
  command: string;
  workingDirectory: string;
  continueOnError: boolean;
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
}
                return todos;
              } catch {
                return [];
              }
            })
          );
          results.push(...chunkResults.flat());
        }
      } catch {
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

export async function addTaskToMemory(task: string, source?: { file: string; line: number; commit?: string; date?: string }, metadata?: { priority?: 'high' | 'medium' | 'low'; dueDate?: string; created?: string }): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const memoryPath = getMemoryPath(workspaceRoot);
  const memoryDir = path.dirname(memoryPath);
  await fsPromises.mkdir(memoryDir, { recursive: true });

  let memoryContent = '';
  try {
    await fsPromises.access(memoryPath);
    memoryContent = await fsPromises.readFile(memoryPath, 'utf8');
  } catch {
    memoryContent = '# KDream Memory\n\n## Follow-ups\n\n';
  }

  // Add created timestamp if not provided
  const taskMetadata = {
    ...metadata,
    created: metadata?.created || new Date().toISOString()
  };

  memoryContent = addTaskToContent(memoryContent, task, taskMetadata);

  await fsPromises.writeFile(memoryPath, memoryContent);

  // Take history snapshot
  try {
    const historyManager = new MemoryHistoryManager(workspaceRoot);
    await historyManager.initialize();
    const memoryFiles = { 'MEMORY.md': memoryContent };
    await historyManager.takeSnapshot(memoryFiles);
  } catch (error) {
    console.warn('Failed to take memory snapshot:', error);
  }

  if (shouldShowNotification('info')) {
    vscode.window.showInformationMessage(`Task added to KDream memory: ${task}`);
  }

  if (kdreamView) {
    await refreshDashboardData(kdreamView);
  }

  // Refresh file decorations
  const kdreamConfig = vscode.workspace.getConfiguration('autoclaw.kdream');
  const enableDecorations = kdreamConfig.get<boolean>('enableFileDecorations', true);
  if (enableDecorations && fileDecorationProvider) {
    fileDecorationProvider.refreshDecorations();
  }
}

async function handleExportData(type: string, view: vscode.WebviewView): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    view.webview.postMessage({ command: 'exportResult', data: 'No workspace open.', type });
    return;
  }

  let markdown = '';

  if (type === 'tasks' || type === 'all') {
    const memoryPath = getMemoryPath(workspaceRoot);
    try {
      const content = await fsPromises.readFile(memoryPath, 'utf8');
      const tasks = parseMemoryTasks(content);
      markdown += `# Tasks & Follow-ups\n\n`;
      if (tasks.length > 0) {
        tasks.forEach(task => {
          const checkbox = task.completed ? '[x]' : '[ ]';
          markdown += `- ${checkbox} ${task.description}\n`;
        });
      } else {
        markdown += `No tasks found.\n`;
      }
      markdown += `\n`;
    } catch {
      markdown += `# Tasks & Follow-ups\n\nNo tasks file found.\n\n`;
    }
  }

  if (type === 'logs' || type === 'all') {
    const logPath = getTodayLogPath(workspaceRoot);
    try {
      const content = await fsPromises.readFile(logPath, 'utf8');
      const logs = parseLogEntries(content);
      markdown += `# Recent Activity\n\n`;
      if (logs.length > 0) {
        logs.forEach(log => {
          markdown += `- ${log}\n`;
        });
      } else {
        markdown += `No recent activity.\n`;
      }
      markdown += `\n`;
    } catch {
      markdown += `# Recent Activity\n\nNo log file found.\n\n`;
    }
  }

  if (type === 'todos' || type === 'all') {
    const todos = await scanWorkspaceForTodos();
    markdown += `# TODOs & FIXMEs\n\n`;
    if (todos.length > 0) {
      todos.forEach(todo => {
        const checkbox = '[ ]';
        const sourceInfo = todo.source ? ` (${todo.source.file}:${todo.source.line})` : '';
        markdown += `- ${checkbox} ${todo.description}${sourceInfo}\n`;
      });
    } else {
      markdown += `No TODOs or FIXMEs found.\n`;
    }
    markdown += `\n`;
  }

  view.webview.postMessage({ command: 'exportResult', data: markdown, type });
}

interface MemorySearchResult {
  file: string;
  line: number;
  text: string;
  context: string;
  matchIndex: number;
}

async function searchMemory(query: string, view: vscode.WebviewView): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    view.webview.postMessage({ command: 'memorySearchResults', data: [], query });
    return;
  }

  const memoryDir = path.join(workspaceRoot, '.autoclaw', 'kdream', 'memory');
  const results: MemorySearchResult[] = [];

  try {
    const files = await fsPromises.readdir(memoryDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(memoryDir, file);
      const content = await fsPromises.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.toLowerCase().includes(query.toLowerCase())) {
          // Get context (3 lines before and after)
          const start = Math.max(0, i - 3);
          const end = Math.min(lines.length, i + 4);
          const context = lines.slice(start, end).join('\n');

          results.push({
            file,
            line: i + 1,
            text: line.trim(),
            context: context,
            matchIndex: line.toLowerCase().indexOf(query.toLowerCase())
          });
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  view.webview.postMessage({ command: 'memorySearchResults', data: results, query });
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

interface WorkflowExecutionRecord {
  workflowName: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  steps: Array<{
    name: string;
    command: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    exitCode?: number;
    duration?: number;
    attempts?: number;
  }>;
}

async function recordWorkflowExecution(record: WorkflowExecutionRecord): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const historyDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'history');
  await fsPromises.mkdir(historyDir, { recursive: true });

  const historyFile = path.join(historyDir, 'executions.jsonl');
  await fsPromises.appendFile(historyFile, JSON.stringify(record) + '\n');
}

async function loadWorkflowHistory(): Promise<WorkflowExecutionRecord[]> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return [];

  const historyFile = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'history', 'executions.jsonl');
  try {
    const content = await fsPromises.readFile(historyFile, 'utf8');
    return content.trim().split('\n').filter(line => line).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function getWorkflowStatus(workflowName: string): Promise<string> {
  const history = await loadWorkflowHistory();
  const matching = history.filter(r => r.workflowName === workflowName);
  if (matching.length === 0) return 'unknown';
  const latest = matching[matching.length - 1];
  return latest.status;
}

async function executeStep(step: WorkflowStep): Promise<boolean> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return false;

  const terminal = vscode.window.createTerminal({
    name: `AutoBuild: ${step.name}`,
    cwd: path.isAbsolute(step.workingDirectory) ? step.workingDirectory : path.join(workspaceRoot, step.workingDirectory)
  });

  terminal.sendText(step.command);

  return new Promise((resolve) => {
    const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        disposable.dispose();
        resolve(closedTerminal.exitStatus?.code === 0);
      }
    });
  });
}

async function executeWorkflow(workflow: WorkflowDefinition, dryRun = false): Promise<WorkflowExecutionRecord> {
  const record: WorkflowExecutionRecord = {
    workflowName: workflow.name,
    startTime: new Date().toISOString(),
    status: 'running',
    steps: workflow.steps.map((step: WorkflowStep) => ({
      name: step.name,
      command: step.command,
      status: 'pending'
    }))
  };

  if (dryRun) {
    const steps = workflow.steps.map((step: WorkflowStep, i: number) =>
      `${i + 1}. ${step.name}: ${step.command}${step.retry ? ` (retry: ${step.retry.maxAttempts}x)` : ''}`
    ).join('\n');

    await vscode.window.showInformationMessage(
      `Dry Run: ${workflow.name}\n\nSteps that would execute:\n${steps}`,
      { modal: true }
    );

    record.status = 'success';
    record.endTime = new Date().toISOString();
    return record;
  }

  await recordWorkflowExecution(record);

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    record.steps[i].status = 'running';
    const stepStart = Date.now();
    let attempts = 0;

    try {
      let success = false;

      const retry = step.retry || { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 1 };

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        attempts = attempt;
        try {
          success = await executeStep(step);
          if (success) break;

          if (attempt < retry.maxAttempts) {
            const delay = retry.backoffMs * Math.pow(retry.backoffMultiplier, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch {
          if (attempt === retry.maxAttempts) throw new Error(`Step "${step.name}" failed after ${attempt} attempts`);

          const delay = retry.backoffMs * Math.pow(retry.backoffMultiplier, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      record.steps[i].status = success ? 'success' : 'failed';
      record.steps[i].duration = Date.now() - stepStart;
      record.steps[i].attempts = attempts;

      if (!success && !step.continueOnError) {
        record.status = 'failed';
        record.endTime = new Date().toISOString();
        await recordWorkflowExecution(record);
        return record;
      }
    } catch (error) {
      record.steps[i].status = 'failed';
      record.steps[i].duration = Date.now() - stepStart;
      record.steps[i].attempts = attempts;

      if (!step.continueOnError) {
        record.status = 'failed';
        record.endTime = new Date().toISOString();
        await recordWorkflowExecution(record);
        vscode.window.showErrorMessage(`Workflow "${workflow.name}" failed at step "${step.name}": ${error}`);
        return record;
      }
    }
  }

  record.status = 'success';
  record.endTime = new Date().toISOString();
  await recordWorkflowExecution(record);

  if (shouldShowNotification('info')) {
    vscode.window.showInformationMessage(`Workflow "${workflow.name}" completed successfully.`);
  }

  return record;
}

async function executeWorkflowWithDependencies(workflowName: string, dryRun = false): Promise<void> {
  const workflow = await loadWorkflowByName(workflowName);
  if (!workflow) {
    vscode.window.showErrorMessage(`Workflow not found: ${workflowName}`);
    return;
  }

  if (workflow.dependsOn) {
    for (const dep of workflow.dependsOn) {
      const depStatus = await getWorkflowStatus(dep);
      if (depStatus !== 'success') {
        vscode.window.showErrorMessage(`Dependency "${dep}" has not succeeded (current status: ${depStatus})`);
        return;
      }
    }
  }

  await executeWorkflow(workflow, dryRun);
}

async function loadWorkflowByName(workflowName: string): Promise<WorkflowDefinition | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return null;

  const workflowsDir = path.join(workspaceRoot, '.autoclaw', 'autobuild', 'workflows');
  const workflowPath = path.join(workflowsDir, `${workflowName}.json`);

  try {
    const content = await fsPromises.readFile(workflowPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

class AutoClawTerminalProfileProvider implements vscode.TerminalProfileProvider {
  provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
    return new vscode.TerminalProfile({
      name: 'AutoClaw',
      shellPath: vscode.env.shell,
      shellArgs: this.getShellArgs(),
      env: this.getEnvironmentVariables(),
      iconPath: new vscode.ThemeIcon('tools')
    });
  }

  private getShellArgs(): string[] {
    const shell = vscode.env.shell;
    if (shell.includes('bash') || shell.includes('zsh')) {
      return ['--rcfile', this.getRcFilePath()];
    } else if (shell.includes('fish')) {
      return ['--init-command', this.getFishInitCommand()];
    } else if (shell.includes('pwsh') || shell.includes('powershell')) {
      return ['-NoExit', '-Command', this.getPowerShellInitCommand()];
    }
    return [];
  }

  private getRcFilePath(): string {
    // Create a temporary rc file with AutoClaw aliases
    const rcContent = this.generateShellRc();
    const tempDir = require('os').tmpdir();
    const rcPath = path.join(tempDir, 'autoclaw-terminal-rc');
    require('fs').writeFileSync(rcPath, rcContent);
    return rcPath;
  }

  private getFishInitCommand(): string {
    return this.generateShellAliases('fish');
  }

  private getPowerShellInitCommand(): string {
    return this.generatePowerShellAliases();
  }

  private getEnvironmentVariables(): { [key: string]: string } {
    return {
      'AUTOCLAW_WORKSPACE': vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      'AUTOCLAW_VERSION': '1.3.0'
    };
  }

  private generateShellRc(): string {
    const aliases = this.generateShellAliases('bash');
    return `
# AutoClaw Terminal Profile
# Generated automatically - do not edit

${aliases}

# Welcome message
echo "🦞 AutoClaw Terminal Ready"
echo "Type 'autoclaw-help' for available commands"
echo ""
`;
  }

  private generateShellAliases(shell: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    if (shell === 'fish') {
      return `
# AutoClaw aliases for Fish shell
alias kdream-status 'code --command kdream.showDashboard'
alias kdream-add 'code --command kdream.addTask'
alias autobuild-list 'code --command autobuild.list'
alias autobuild-run 'code --command autobuild.schedule'
alias mateam-launch 'code --command mateam.launch'
alias autoclaw-commands 'code --command autoclaw.showCommands'
alias autoclaw-faq 'code --command autoclaw.openFAQ'
alias autoclaw-search 'code --command kdream.searchMemory'
`;
    } else {
      // Bash/Zsh
      return `
# AutoClaw aliases for Bash/Zsh
alias kdream-status='code --command kdream.showDashboard'
alias kdream-add='code --command kdream.addTask'
alias autobuild-list='code --command autobuild.list'
alias autobuild-run='code --command autobuild.schedule'
alias mateam-launch='code --command mateam.launch'
alias autoclaw-commands='code --command autoclaw.showCommands'
alias autoclaw-faq='code --command autoclaw.openFAQ'
alias autoclaw-search='code --command kdream.searchMemory'

# AutoClaw helper functions
autoclaw-help() {
    echo "🦞 AutoClaw Terminal Aliases:"
    echo "  kdream-status     - Show KDream dashboard"
    echo "  kdream-add        - Add new task"
    echo "  autobuild-list    - List workflows"
    echo "  autobuild-run     - Schedule workflow"
    echo "  mateam-launch     - Launch MAteam session"
    echo "  autoclaw-commands - Show all commands"
    echo "  autoclaw-faq      - Open FAQ"
    echo "  autoclaw-search   - Search memory"
    echo ""
    echo "Environment variables:"
    echo "  AUTOCLAW_WORKSPACE: $AUTOCLAW_WORKSPACE"
    echo "  AUTOCLAW_VERSION: $AUTOCLAW_VERSION"
}
`;
    }
  }

  private generatePowerShellAliases(): string {
    return `
# AutoClaw aliases for PowerShell
function kdream-status { code --command kdream.showDashboard }
function kdream-add { code --command kdream.addTask }
function autobuild-list { code --command autobuild.list }
function autobuild-run { code --command autobuild.schedule }
function mateam-launch { code --command mateam.launch }
function autoclaw-commands { code --command autoclaw.showCommands }
function autoclaw-faq { code --command autoclaw.openFAQ }
function autoclaw-search { code --command kdream.searchMemory }

function autoclaw-help {
    Write-Host "🦞 AutoClaw PowerShell Functions:"
    Write-Host "  kdream-status     - Show KDream dashboard"
    Write-Host "  kdream-add        - Add new task"
    Write-Host "  autobuild-list    - List workflows"
    Write-Host "  autobuild-run     - Schedule workflow"
    Write-Host "  mateam-launch     - Launch MAteam session"
    Write-Host "  autoclaw-commands - Show all commands"
    Write-Host "  autoclaw-faq      - Open FAQ"
    Write-Host "  autoclaw-search   - Search memory"
    Write-Host ""
    Write-Host "Environment variables:"
    Write-Host "  AUTOCLAW_WORKSPACE: $env:AUTOCLAW_WORKSPACE"
    Write-Host "  AUTOCLAW_VERSION: $env:AUTOCLAW_VERSION"
}

# Welcome message
Write-Host "🦞 AutoClaw Terminal Ready" -ForegroundColor Cyan
Write-Host "Type 'autoclaw-help' for available commands" -ForegroundColor Gray
Write-Host ""
`;
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
        case 'openZmlrDownload':
          await vscode.env.openExternal(vscode.Uri.parse('https://zippymesh.com'));
          break;
        case 'openHelp':
          await openAIHelpChat();
          break;
        case 'openFileAtLine': {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (wsRoot && message.file && message.line) {
            const uri = vscode.Uri.file(path.join(wsRoot, message.file));
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const range = new vscode.Range(message.line - 1, 0, message.line - 1, 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          }
          break;
        }
        case 'exportData':
          await handleExportData(message.type, webviewView);
          break;
        case 'openMemoryFile': {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (wsRoot && message.file) {
            const filePath = path.join(wsRoot, '.autoclaw', 'kdream', 'memory', message.file);
            const doc = await vscode.workspace.openTextDocument(filePath);
            const editor = await vscode.window.showTextDocument(doc);
            if (message.line) {
              const range = new vscode.Range(message.line - 1, 0, message.line - 1, 0);
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
          }
          break;
        }
        case 'loadMemoryHistory': {
          const historyManager = new MemoryHistoryManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!);
          await historyManager.initialize();

          // Get last 7 days of history
          const endDate = new Date().toISOString().slice(0, 10);
          const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

          const history = await historyManager.getHistoryRange(startDate, endDate);
          webviewView.webview.postMessage({
            command: 'showMemoryHistory',
            data: history
          });
          break;
        }

        // ── Intelligent Routing panel messages ────────────────────────────
        case 'routing:rankModels': {
          const engine = getRoutingEngine();
          const ranked = engine.getRankedModels(
            (message.taskType as TaskType) ?? 'general',
            message.maxTier as ModelTier | undefined
          );
          webviewView.webview.postMessage({ command: 'routing:modelList', data: ranked });
          break;
        }
        case 'routing:getRateLimits': {
          const engine = getRoutingEngine();
          const limits = engine.getRateLimitStatus();
          webviewView.webview.postMessage({ command: 'routing:rateLimits', data: limits });
          break;
        }
        case 'routing:recheckZMLR': {
          const engine = getRoutingEngine();
          const online = await engine.recheckZMLR();
          webviewView.webview.postMessage({ command: 'routing:zmlrStatus', online });
          break;
        }
        case 'routing:healSessions': {
          await vscode.commands.executeCommand('autoclaw.healSessions');
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (wsRoot) {
            const healer = getSessionHealer(wsRoot);
            const sessions = healer?.getSessions() ?? [];
            webviewView.webview.postMessage({ command: 'routing:sessions', data: sessions });
          }
          break;
        }
        case 'routing:getSessions': {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (wsRoot) {
            const healer = getSessionHealer(wsRoot);
            await healer?.startWatching();
            const sessions = healer?.getSessions() ?? [];
            webviewView.webview.postMessage({ command: 'routing:sessions', data: sessions });
          }
          break;
        }
        case 'routing:decide': {
          const engine = getRoutingEngine();
          try {
            const decision = await engine.decide(
              (message.taskType as TaskType) ?? 'general',
              { maxTier: message.maxTier as ModelTier | undefined }
            );
            webviewView.webview.postMessage({ command: 'routing:decision', data: decision });
          } catch (err) {
            webviewView.webview.postMessage({
              command: 'routing:decision',
              error: err instanceof Error ? err.message : String(err)
            });
          }
          break;
        }
        case 'routing:saveSettings': {
          const cfg = vscode.workspace.getConfiguration('autoclaw.routing');
          if (message.zmlrUrl) { await cfg.update('zmlrUrl', message.zmlrUrl, vscode.ConfigurationTarget.Workspace); }
          if (message.failoverMode) { await cfg.update('failoverMode', message.failoverMode, vscode.ConfigurationTarget.Workspace); }
          resetRoutingEngine();
          webviewView.webview.postMessage({ command: 'routing:settingsSaved' });
          break;
        }
      }
    });

    refreshDashboardData(webviewView);

     const config = vscode.workspace.getConfiguration('autoclaw.kdream');
     const refreshIntervalSeconds = config.get<number>('refreshInterval', 30);
     if (refreshIntervalId) {
       clearInterval(refreshIntervalId);
     }
     refreshIntervalId = setInterval(async () => {
       if (kdreamView) {
         await refreshDashboardData(kdreamView);
         
         // Record adapter health history
         const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
         if (workspaceRoot) {
           try {
             const adapterHealth = await getAdapterHealth();
             await recordAdapterHealth(workspaceRoot, adapterHealth);
           } catch (error) {
             console.error('Failed to record adapter health history:', error);
           }
         }
       }
     }, refreshIntervalSeconds * 1000);

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

    const nonce = this._generateNonce();

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
            <div class="header-actions">
                <button id="help-btn" title="Get Help" aria-label="Get Help">?</button>
                <button id="export-btn" title="Export Data" aria-label="Export Data">Export</button>
                <div id="export-dropdown" class="export-dropdown" style="display:none;">
                    <button data-export="tasks">Export Tasks</button>
                    <button data-export="logs">Export Logs</button>
                    <button data-export="todos">Export TODOs</button>
                    <button data-export="all">Export All</button>
                </div>
                <button id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">🌙</button>
                <button id="refresh-btn">Refresh</button>
            </div>
        </header>
        <div id="search-container">
            <input type="text" id="search-input" placeholder="Search tasks, logs, TODOs...">
            <button id="search-clear" title="Clear search">&#x2715;</button>
        </div>
        <main>
            <section id="status-section">
                <h2><button class="collapse-btn" data-section="status">▼</button>Status</h2>
                <div id="status-content">Loading...</div>
            </section>
<section id="tasks-section">
                 <div class="section-header">
                     <h2><button class="collapse-btn" data-section="tasks">▼</button>Tasks & Follow-ups</h2>
                     <div class="tag-filters">
                         <select id="tag-filter">
                             <option value="">All Tags</option>
                             <!-- Tags populated by JS -->
                         </select>
                         <select id="priority-filter">
                             <option value="">All Priorities</option>
                             <option value="high">🔴 High Priority</option>
                             <option value="medium">🟡 Medium Priority</option>
                             <option value="low">🔵 Low Priority</option>
                             <option value="overdue">⚠️ Overdue</option>
                         </select>
                     </div>
                     <span id="tasks-count" class="section-count"></span>
                 </div>
                <div id="tasks-content">Loading...</div>
            </section>
            <section id="logs-section">
                <div class="section-header">
                    <h2><button class="collapse-btn" data-section="logs">▼</button>Recent Activity</h2>
                    <span id="logs-count" class="section-count"></span>
                </div>
                <div id="logs-content">Loading...</div>
            </section>
<section id="adapter-health-section">
                 <h2><button class="collapse-btn" data-section="adapter-health">▼</button>Adapter Health</h2>
                 <div id="adapter-health-content">Loading...</div>
             </section>
             <section id="adapter-history-section">
                 <h2><button class="collapse-btn" data-section="adapter-history">▼</button>Adapter Health History</h2>
                 <div class="history-controls">
                     <select id="history-time-range">
                         <option value="6h">Last 6 Hours</option>
                         <option value="24h" selected>Last 24 Hours</option>
                         <option value="7d">Last 7 Days</option>
                     </select>
                     <button id="refresh-history-btn">Refresh</button>
                 </div>
                 <div id="health-chart-container">
                     <canvas id="health-chart" width="400" height="200"></canvas>
                 </div>
                 <div id="health-alerts">
                     <h3>Active Alerts</h3>
                     <div id="alerts-list"></div>
                 </div>
             </section>
             <section id="todos-section">
                <div class="section-header">
                    <h2><button class="collapse-btn" data-section="todos">▼</button>TODOs & FIXMEs</h2>
                    <span id="todos-count" class="section-count"></span>
                    <button id="copy-todos-btn" class="copy-btn" title="Copy all TODOs to clipboard">Copy All</button>
                </div>
                <div id="todos-content">Loading...</div>
            </section>
            <section id="memory-history-section">
                <h2><button class="collapse-btn" data-section="memory-history">▼</button>Memory History</h2>
                <div id="memory-history-content">
                    <button id="load-history-btn">Load History (Last 7 Days)</button>
                    <div id="history-timeline"></div>
                </div>
            </section>
             <section id="memory-search-section">
                 <h2><button class="collapse-btn" data-section="memory-search">▼</button>Memory Search</h2>
                 <div id="memory-search-content">Use Ctrl+Shift+P → "KDream: Search Memory" to search.</div>
             </section>
             <section id="workflow-history-section">
                 <h2><button class="collapse-btn" data-section="workflow-history">▼</button>Workflow History</h2>
                 <div id="workflow-history-content">
                     <div id="workflow-history-list"></div>
                 </div>
             </section>
             <section id="routing-section">
                 <h2><button class="collapse-btn" data-section="routing">▼</button>Intelligent Routing</h2>
                 <div id="routing-content">
                     <div class="routing-header">
                         <div id="routing-zmlr-status" class="routing-zmlr-badge">ZMLR: checking...</div>
                         <div class="routing-actions">
                             <button id="routing-heal-btn" title="Detect and heal stalled sessions">Heal Sessions</button>
                             <button id="routing-decide-btn" title="Show routing decision for current task">Decide Model</button>
                             <button id="routing-recheck-btn" title="Recheck ZMLR availability">Recheck ZMLR</button>
                         </div>
                     </div>
                     <div id="routing-sessions-list"></div>
                     <div class="routing-model-panel">
                         <h3>Model Ranking</h3>
                         <div class="routing-task-filter">
                             <label for="routing-task-type">Task type:</label>
                             <select id="routing-task-type">
                                 <option value="general">General</option>
                                 <option value="research">Research</option>
                                 <option value="coding">Coding</option>
                                 <option value="review">Review</option>
                                 <option value="planning">Planning</option>
                                 <option value="final-review">Final Review (SOTA)</option>
                             </select>
                             <label for="routing-max-tier">Max tier:</label>
                             <select id="routing-max-tier">
                                 <option value="sota">All (SOTA)</option>
                                 <option value="mid">Mid and below</option>
                                 <option value="low-cost">Low-cost and below</option>
                                 <option value="free">Free only</option>
                                 <option value="local">Local only</option>
                             </select>
                             <button id="routing-rank-btn">Rank Models</button>
                         </div>
                         <div id="routing-model-list"></div>
                     </div>
                     <div class="routing-rate-limits">
                         <h3>Rate Limit Status</h3>
                         <div id="routing-ratelimit-list"></div>
                     </div>
                     <div class="routing-failover-settings">
                         <h3>Failover Settings</h3>
                         <label>
                             <span>Auto-failover mode:</span>
                             <select id="routing-failover-mode">
                                 <option value="auto">Auto (no prompt)</option>
                                 <option value="ask">Ask before rerouting</option>
                                 <option value="disabled">Disabled</option>
                             </select>
                         </label>
                         <label>
                             <span>ZMLR URL:</span>
                             <input type="text" id="routing-zmlr-url" placeholder="http://localhost:20128" />
                         </label>
                         <button id="routing-save-settings-btn">Save Settings</button>
                     </div>
                 </div>
             </section>
        </main>
        <footer>
            <div class="zmlr-tip">
                <span class="icon">💡</span>
                <span>Boost your AI reliability with</span>
                <a href="#" id="zmlr-link">ZippyMesh LLM Router</a>
                <span>— private, local LLM routing with multi-provider failover.</span>
            </div>
        </footer>
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
  pendingScanPromise = undefined;
  if (statusBar) {
    statusBar.dispose();
    statusBar = undefined;
  }
}

export function updateStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    statusBar.text = '$(question) KDream: no workspace';
    return;
  }
  const statePath = getStatePath(workspaceRoot);
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(content);
    if (state.running) {
      const tick = state.tick ?? 0;
      statusBar.text = `🦞 KDream: running (tick ${tick})`;
    } else {
      statusBar.text = '🦞 KDream: stopped';
    }
  } catch {
    statusBar.text = '🦞 KDream: stopped';
  }
}

class TodoCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');
    const todoRegex = /(TODO|FIXME)\s*[:\-]?\s*(.*)/i;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(todoRegex);
      if (match) {
        const range = new vscode.Range(i, 0, i, lines[i].length);
        const lens = new vscode.CodeLens(range, {
          title: '🦞 Add to KDream',
          command: 'autoclaw.addTodoAsTask',
          arguments: [match[0].trim(), document.uri.fsPath, i + 1]
        });
        lenses.push(lens);
      }
    }
    return lenses;
  }
}

class AutoClawFileDecorationProvider implements vscode.FileDecorationProvider {
  private decorations = new Map<string, vscode.FileDecoration>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('autoclaw.kdream')) {
          this.refreshDecorations();
        }
      })
    );

    // Listen for file changes that might affect TODOs
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (this.isTrackedFile(e.document.uri)) {
          this.updateFileDecoration(e.document.uri);
        }
      })
    );

    // Listen for file deletions
    this.disposables.push(
      vscode.workspace.onDidDeleteFiles(e => {
        e.files.forEach(uri => {
          this.decorations.delete(uri.toString());
          this._onDidChangeFileDecorations.fire(uri);
        });
      })
    );
  }

  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.decorations.get(uri.toString());
  }

  private isTrackedFile(uri: vscode.Uri): boolean {
    const config = vscode.workspace.getConfiguration('autoclaw.kdream');
    const scanPatterns = config.get<string[]>('scanPatterns', ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.md']);

    const relativePath = vscode.workspace.asRelativePath(uri);
    return scanPatterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
      return regex.test(relativePath);
    });
  }

  async refreshDecorations(): Promise<void> {
    this.decorations.clear();

    // Scan for TODOs and apply decorations
    const todos = await scanWorkspaceForTodos();

    // Group todos by file
    const fileTodoCounts = new Map<string, { todos: ParsedTask[], urgent: number }>();

    todos.forEach(todo => {
      if (!fileTodoCounts.has(todo.source?.file || '')) {
        fileTodoCounts.set(todo.source?.file || '', { todos: [], urgent: 0 });
      }
      const fileData = fileTodoCounts.get(todo.source?.file || '')!;
      fileData.todos.push(todo);

      // Count urgent items (FIXMEs)
      if (todo.description.toUpperCase().includes('FIXME')) {
        fileData.urgent++;
      }
    });

    // Apply decorations
    for (const [relativePath, data] of fileTodoCounts) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) continue;

      const uri = vscode.Uri.file(path.join(workspaceRoot, relativePath));

      const decoration = this.createDecoration(data.todos, data.urgent);
      this.decorations.set(uri.toString(), decoration);
      this._onDidChangeFileDecorations.fire(uri);
    }
  }

  private createDecoration(todos: ParsedTask[], urgentCount: number): vscode.FileDecoration {
    const totalCount = todos.length;

    if (urgentCount > 0) {
      // Urgent items (FIXMEs) - red badge
      return {
        badge: urgentCount.toString(),
        color: new vscode.ThemeColor('notificationsErrorIcon.foreground'),
        tooltip: this.createTooltip(todos, 'Urgent fixes needed'),
        propagate: false
      };
    } else if (totalCount > 0) {
      // Regular TODOs - blue badge
      return {
        badge: totalCount.toString(),
        color: new vscode.ThemeColor('notificationsInfoIcon.foreground'),
        tooltip: this.createTooltip(todos, 'Tasks to complete'),
        propagate: false
      };
    }

    return {};
  }

  private createTooltip(todos: ParsedTask[], title: string): string {
    let tooltip = `${title}:\n`;

    todos.slice(0, 5).forEach(todo => {
      const type = todo.description.includes('FIXME') ? '🔴' : '🔵';
      const truncated = todo.description.length > 50 ?
        todo.description.substring(0, 47) + '...' :
        todo.description;
      tooltip += `${type} ${truncated}\n`;
    });

    if (todos.length > 5) {
      tooltip += `... and ${todos.length - 5} more`;
    }

    return tooltip.trim();
  }

  private async updateFileDecoration(uri: vscode.Uri): Promise<void> {
    // Quick update for a single file
    const relativePath = vscode.workspace.asRelativePath(uri);

    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString('utf8');
      const lines = text.split('\n');

      const todos: ParsedTask[] = [];
      let urgentCount = 0;

      lines.forEach((line, i) => {
        const todoMatch = line.match(/(TODO|FIXME)\s*[:\-]?\s*(.*)/i);
        if (todoMatch) {
          const todo: ParsedTask = {
            description: `${todoMatch[1].toUpperCase()}: ${todoMatch[2].trim()}`,
            completed: false,
            source: {
              file: relativePath,
              line: i + 1
            }
          };
          todos.push(todo);

          if (todoMatch[1].toUpperCase() === 'FIXME') {
            urgentCount++;
          }
        }
      });

      const decoration = todos.length > 0 ? this.createDecoration(todos, urgentCount) : {};
      this.decorations.set(uri.toString(), decoration);
      this._onDidChangeFileDecorations.fire(uri);

    } catch (error) {
      // File might be binary or inaccessible
      this.decorations.delete(uri.toString());
      this._onDidChangeFileDecorations.fire(uri);
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeFileDecorations.dispose();
  }
}

function getAutoClawCommands(): AutoClawQuickPickItem[] {
  return [
    // Terminal commands
    {
      label: '$(terminal) AutoClaw: Open Terminal',
      description: 'Open AutoClaw terminal with aliases',
      detail: 'Terminal with built-in AutoClaw command shortcuts',
      command: 'autoclaw.openTerminal'
    },

    // AutoBuild commands
    {
      label: '$(tools) AutoBuild: Schedule Workflow',
      description: 'Create and schedule a new workflow',
      detail: 'Choose from templates or create custom automated workflows',
      command: 'autobuild.schedule'
    },
    {
      label: '$(graph) AutoBuild: Show Status',
      description: 'View workflow status and results',
      detail: 'Check the status of scheduled and running workflows',
      command: 'autobuild.status'
    },
    {
      label: '$(play-circle) AutoBuild: Run Workflow',
      description: 'Run a saved workflow',
      detail: 'Select and execute a previously saved workflow',
      command: 'autobuild.run'
    },
    {
      label: '$(eye) AutoBuild: Dry Run',
      description: 'Preview workflow steps without executing',
      detail: 'See what commands would run without actually running them',
      command: 'autobuild.dryRun'
    },
    {
      label: '$(history) AutoBuild: Execution History',
      description: 'View workflow execution history',
      detail: 'See past workflow runs with success/failure status',
      command: 'autobuild.history'
    },
    {
      label: '$(play-circle) AutoBuild: Run Workflow',
      description: 'Run a saved workflow',
      detail: 'Select and execute a previously saved workflow',
      command: 'autobuild.run'
    },
    {
      label: '$(eye) AutoBuild: Dry Run',
      description: 'Preview workflow steps without executing',
      detail: 'See what commands would run without actually running them',
      command: 'autobuild.dryRun'
    },
    {
      label: '$(history) AutoBuild: Execution History',
      description: 'View workflow execution history',
      detail: 'See past workflow runs with success/failure status',
      command: 'autobuild.history'
    },

    // KDream commands
    {
      label: '$(dashboard) KDream: Show Dashboard',
      description: 'Open the KDream dashboard',
      detail: 'View tasks, memory, logs, and system status',
      command: 'kdream.showDashboard'
    },
    {
      label: '$(add) KDream: Add Task',
      description: 'Add a new task to KDream memory',
      detail: 'Store a task for the background agent to work on',
      command: 'kdream.addTask'
    },
    {
      label: '$(refresh) KDream: Refresh Dashboard',
      description: 'Refresh all dashboard data',
      detail: 'Reload tasks, logs, and system status',
      command: 'kdream.refreshDashboard'
    },
    {
      label: '$(search) KDream: Search Memory',
      description: 'Search across all memory files',
      detail: 'Find information in KDream memory',
      command: 'kdream.searchMemory'
    },
    {
      label: '$(history) KDream: Memory History',
      description: 'View memory consolidation history',
      detail: 'See how memory has evolved over time',
      command: 'kdream.showMemoryHistory'
    },
    {
      label: '$(play) KDream: Start Background Agent',
      description: 'Start the persistent background agent',
      detail: 'Begin autonomous task processing',
      command: 'autoclaw.startKdream'
    },

    // Help commands
    {
      label: '$(question) AutoClaw: Ask AI for Help',
      description: 'Get help with AutoClaw issues',
      detail: 'AI assistance with error resolution and troubleshooting',
      command: 'autoclaw.askAIHelp'
    },
    {
      label: '$(book) AutoClaw: Open FAQ',
      description: 'View the AutoClaw FAQ',
      detail: 'Comprehensive guide to errors and solutions',
      command: 'autoclaw.openFAQ'
    },

    // Setup commands
    {
      label: '$(package) AutoClaw: Install Adapters',
      description: 'Install AI extension adapters',
      detail: 'Set up integration with Claude, KiloCode, etc.',
      command: 'autoclaw.installAdapters'
    },
    {
      label: '$(gear) AutoClaw: Open Settings',
      description: 'Configure AutoClaw settings',
      detail: 'Access VS Code settings for AutoClaw',
      command: 'workbench.action.openSettings'
    },
    {
      label: '$(file-text) AutoClaw: Open .gitignore',
      description: 'Edit .gitignore file',
      detail: 'Add .autoclaw/ to version control exclusions',
      command: 'autoclaw.openGitignore'
    },
    {
      label: '$(info) KDream: Learn about ZippyMesh LLM Router',
      description: 'Learn about ZippyMesh LLM Router',
      detail: 'Advanced LLM routing with multi-provider failover',
      command: 'kdream.openZmlrDownload'
    }
  ];
}

/**
 * Opens an AI chat with error context for help.
 * Detects available AI providers and opens the best available one.
 * Uses ZMLR directly when available, falls back to clipboard method.
 */
async function openAIHelpChat(errorMessage?: string): Promise<void> {
  // Check if ZMLR is available for direct AI help
  try {
    const zmlrStatus = await checkZMLRAvailability();
    if (zmlrStatus.available) {
      try {
        // Try direct ZMLR integration first
        const context = await getErrorContextForHelp(errorMessage);
        const aiResponse = await getZMLRAIHelp(context);
        await showZMLRAIResponse(aiResponse);
        return;
      } catch (zmlrError) {
        console.warn('ZMLR direct integration failed, falling back to clipboard:', zmlrError);
      }
    }
  } catch {
    // ZMLR check failed, fall through to clipboard method
  }

  // Fall back to clipboard-based method
  await openAIHelpChatClipboardFallback(errorMessage);
}

/**
 * Gets error context for AI help requests.
 */
async function getErrorContextForHelp(errorMessage?: string): Promise<string> {
  const context = errorMessage
    ? await extractErrorContext(errorMessage)
    : await extractErrorContext('User requested AI help');

  const explanation = errorMessage ? explainError(errorMessage, context) : null;
  return explanation
    ? formatAIHelpPrompt(context, explanation)
    : `I need help with AutoClaw. Here is my current environment context:\n\n` +
      `- VS Code Version: ${context.vscodeVersion}\n` +
      `- AutoClaw Version: ${context.extensionVersion}\n` +
      `- Timestamp: ${context.timestamp}\n\n` +
      (context.kdreamState ? `KDream State: ${context.kdreamState}\n\n` : '') +
      (context.recentLogs && context.recentLogs.length > 0
        ? `Recent Logs:\n${context.recentLogs.join('\n')}\n\n`
        : '') +
      (context.mateamSessions ? `MAteam Sessions: ${context.mateamSessions}\n\n` : '') +
      `Please help me understand what's going on and what I should do.`;
}

/**
 * Shows AI response from ZMLR in a webview panel.
 */
async function showZMLRAIResponse(response: string): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'autoclawAIHelp',
    'AutoClaw AI Help',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
    pre { background: var(--vscode-editor-background); padding: 12px; border-radius: 4px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h2>🤖 AutoClaw AI Help Response</h2>
  <pre>${response}</pre>
</body>
</html>`;
}

/**
 * Clipboard-based fallback for AI help when ZMLR is unavailable.
 */
async function openAIHelpChatClipboardFallback(errorMessage?: string): Promise<void> {
  const prompt = await getErrorContextForHelp(errorMessage);
  await vscode.env.clipboard.writeText(prompt);

  const hasClaudeCode = !!vscode.extensions.getExtension('Anthropic.claude-code');
  const hasKiloCode = !!vscode.extensions.getExtension('kilocode.kilo-code');
  const hasCline = !!vscode.extensions.getExtension('saoudrizwan.claude-dev') ||
                   !!vscode.extensions.getExtension('rooveterinaryinc.roo-cline') ||
                   !!vscode.extensions.getExtension('cline.cline');
  const hasContinue = !!vscode.extensions.getExtension('Continue.continue');

  let chatCommand = '';
  let chatName = '';

  if (hasClaudeCode) {
    chatCommand = 'workbench.action.chat.open';
    chatName = 'Claude Code';
  } else if (hasKiloCode) {
    chatCommand = 'kilo-code.chat.new';
    chatName = 'KiloCode';
  } else if (hasCline) {
    chatCommand = 'cline.plusButtonClicked';
    chatName = 'Cline';
  } else if (hasContinue) {
    chatCommand = 'continue.continueGUIView.focus';
    chatName = 'Continue';
  }

  if (chatCommand) {
    await vscode.commands.executeCommand(chatCommand);
    vscode.window.showInformationMessage(
      `AI help prompt copied to clipboard. Paste it into the ${chatName} chat.`,
      'Open Chat'
    ).then(action => {
      if (action === 'Open Chat') {
        vscode.commands.executeCommand(chatCommand);
      }
    });
  } else {
    vscode.window.showInformationMessage(
      'No AI chat provider detected. Opening FAQ instead.',
      'View FAQ'
    ).then(async action => {
      if (action === 'View FAQ') {
        await openFAQ();
      }
    });
  }
}
