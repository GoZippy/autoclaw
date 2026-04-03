/**
 * Error Help System for AutoClaw
 *
 * Maps error patterns to human-readable explanations, suggested actions,
 * and FAQ references. Provides context extraction for AI-assisted help.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structured explanation for an error pattern
 */
export interface ErrorExplanation {
  /** Short title shown in notification */
  title: string;
  /** Full explanation of what the error means */
  explanation: string;
  /** Suggested actions the user can take */
  actions: ErrorAction[];
  /** FAQ anchor/section reference */
  faqSection?: string;
  /** Whether this error is non-critical (informational only) */
  isNonCritical?: boolean;
  /** Severity level of the error */
  severity: 'critical' | 'warning' | 'info';
}

/**
 * An action the user can take in response to an error
 */
export interface ErrorAction {
  label: string;
  /** Command ID to execute, or URL to open */
  target: string;
  type: 'command' | 'url' | 'faq' | 'dismiss';
  /** Whether this is the primary/recommended action */
  primary?: boolean;
}

/**
 * Known error patterns and their explanations
 */
const ERROR_PATTERNS: Array<{
  /** Regex pattern to match against error messages */
  pattern: RegExp;
  /** Factory function to generate the explanation */
  explanation: (match: RegExpMatchArray, context?: ErrorContext) => ErrorExplanation;
}> = [
  {
    pattern: /loop|continue execution|permission.*loop/i,
    explanation: () => ({
      title: 'Loop Permission Prompt',
      explanation:
        'Kilo detected that an agent or command is repeating the same action. ' +
        'This is a safety guardrail to prevent infinite loops from consuming resources. ' +
        'It may happen when an agent hits a transient error and retries, or when a file ' +
        'watcher triggers rapid successive updates.',
      actions: [
        { label: 'Continue', target: '', type: 'command', primary: false },
        { label: 'Stop Agent', target: 'kdream.stopKdream', type: 'command' },
        { label: 'Check Running Agents', target: 'kdream.showDashboard', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command', primary: true }
      ],
      faqSection: 'loop-permission-prompts',
      isNonCritical: true,
      severity: 'warning'
    })
  },
  {
    pattern: /no workspace folder open/i,
    explanation: () => ({
      title: 'No Workspace Open',
      explanation:
        'AutoClaw needs a workspace folder to operate. Open a folder or workspace ' +
        'in VS Code (File → Open Folder), then try again.',
      actions: [
        { label: 'Open Folder', target: 'vscode.openFolder', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'no-workspace-folder-open',
      severity: 'critical'
    })
  },
  {
    pattern: /gitignore.*failed|gitignore check/i,
    explanation: () => ({
      title: 'Gitignore Check Failed',
      explanation:
        'AutoClaw tried to check if .autoclaw/ is in your .gitignore but couldn\'t ' +
        'access the file. This is non-critical — you can manually add .autoclaw/ to ' +
        'your .gitignore file.',
      actions: [
        { label: 'Open .gitignore', target: 'autoclaw.openGitignore', type: 'command' },
        { label: 'Dismiss', target: '', type: 'command', primary: true }
      ],
      faqSection: 'gitignore-check-failed',
      isNonCritical: true,
      severity: 'info'
    })
  },
  {
    pattern: /adapter.*install.*failed|install.*adapter/i,
    explanation: () => ({
      title: 'Adapter Installation Failed',
      explanation:
        'Auto-installation of AI extension adapters failed. You can run the ' +
        'installation manually from the command palette.',
      actions: [
        { label: 'Install Adapters', target: 'autoclaw.installAdapters', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'adapter-install-failed',
      severity: 'warning'
    })
  },
  {
    pattern: /dashboard.*loading|webview.*not.*receiving/i,
    explanation: () => ({
      title: 'Dashboard Loading Issue',
      explanation:
        'The dashboard webview isn\'t receiving data from the extension. ' +
        'This can happen if the extension host restarted or the webview lost connection.',
      actions: [
        { label: 'Refresh Dashboard', target: 'kdream.refreshDashboard', type: 'command', primary: true },
        { label: 'Reload Window', target: 'workbench.action.reloadWindow', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'dashboard-loading-indefinitely',
      severity: 'warning'
    })
  },
  {
    pattern: /workflow.*not.*found/i,
    explanation: () => ({
      title: 'Workflow Not Found',
      explanation:
        'The named workflow doesn\'t exist. Check available workflows or create a new one.',
      actions: [
        { label: 'List Workflows', target: 'autobuild.list', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'workflow-not-found',
      severity: 'info'
    })
  },
  {
    pattern: /step.*failed.*exit code|exit code \d+/i,
    explanation: (match) => ({
      title: 'Workflow Step Failed',
      explanation:
        `A shell command in your workflow returned ${match[0] || 'a non-zero exit code'}. ` +
        'Check the run log to see the full output and fix the underlying command issue.',
      actions: [
        { label: 'View Run Log', target: 'autobuild.status', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'step-failed-with-exit-code',
      severity: 'critical'
    })
  },
  {
    pattern: /rate limit|too many requests|429/i,
    explanation: () => ({
      title: 'Rate Limit Exceeded',
      explanation:
        'Your LLM provider is throttling requests. This is common with free-tier providers. ' +
        'ZippyMesh LLM Router can automatically route across multiple providers to avoid this.',
      actions: [
        { label: 'Learn About ZMLR', target: 'https://zippymesh.com', type: 'url', primary: true },
        { label: 'Retry Later', target: '', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'rate-limit-exceeded',
      severity: 'warning'
    })
  },
  {
    pattern: /fetch failed|network error|ECONNREFUSED|ENOTFOUND/i,
    explanation: () => ({
      title: 'Connection Error',
      explanation:
        'The extension couldn\'t reach an LLM provider or service. Check your internet ' +
        'connection and verify that any local services (like ZippyMesh LLM Router) are running.',
      actions: [
        { label: 'Check ZMLR Status', target: 'kdream.showDashboard', type: 'command' },
        { label: 'Learn About ZMLR', target: 'https://zippymesh.com', type: 'url' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command', primary: true }
      ],
      faqSection: 'connection-adapter-errors',
      severity: 'warning'
    })
  },
  {
    pattern: /zippymesh.*not detected|zmlr.*not detected/i,
    explanation: () => ({
      title: 'ZMLR Not Detected',
      explanation:
        'ZippyMesh LLM Router isn\'t running at the configured URL. The dashboard works ' +
        'fine without ZMLR — this is just a recommendation. ZMLR provides private, local ' +
        'LLM routing with multi-provider failover.',
      actions: [
        { label: 'Learn About ZMLR', target: 'https://zippymesh.com', type: 'url', primary: true },
        { label: 'Dismiss', target: '', type: 'command' }
      ],
      faqSection: 'zippymesh-llm-router-not-detected',
      isNonCritical: true,
      severity: 'info'
    })
  },
  {
    pattern: /no supported.*ai.*extension|no.*adapter/i,
    explanation: () => ({
      title: 'No AI Extensions Detected',
      explanation:
        'AutoClaw couldn\'t find any compatible AI extensions. Install a supported AI ' +
        'extension (Claude Code, KiloCode, Cline, Cursor, etc.) or manually copy adapter ' +
        'files from the extension\'s adapters/ folder.',
      actions: [
        { label: 'Install Adapters', target: 'autoclaw.installAdapters', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'no-supported-ai-extensions-detected',
      severity: 'warning'
    })
  },
  {
    pattern: /EPERM|permission denied/i,
    explanation: () => ({
      title: 'Permission Denied',
      explanation:
        'Windows file locking prevented an operation. This is usually transient — ' +
        'close any open file handles and retry. AutoClaw handles this gracefully.',
      actions: [
        { label: 'Retry', target: 'kdream.refreshDashboard', type: 'command', primary: true },
        { label: 'Dismiss', target: '', type: 'command' }
      ],
      faqSection: 'file-system-errors',
      isNonCritical: true,
      severity: 'warning'
    })
  },
  {
    pattern: /ENOENT|no such file/i,
    explanation: () => ({
      title: 'File Not Found',
      explanation:
        'A file that AutoClaw expected doesn\'t exist yet. This is normal on first use — ' +
        'AutoClaw creates files as needed. If it persists, check that your workspace is writable.',
      actions: [
        { label: 'Check Workspace', target: 'workbench.action.files.openFolder', type: 'command' },
        { label: 'Dismiss', target: '', type: 'command', primary: true }
      ],
      faqSection: 'file-system-errors',
      isNonCritical: true,
      severity: 'info'
    })
  },
  {
    pattern: /agent.*failed|session.*halted/i,
    explanation: () => ({
      title: 'MAteam Agent Failed',
      explanation:
        'One of the MAteam agents encountered an error. Check the scratchpad files ' +
        'in .autoclaw/mateam/scratch/ for details. The review.md file often contains ' +
        'blocker information.',
      actions: [
        { label: 'View Session Status', target: 'mateam.status', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'mateam-errors',
      severity: 'critical'
    })
  },
  {
    pattern: /timeout|timed out|ETIMEDOUT/i,
    explanation: () => ({
      title: 'Operation Timed Out',
      explanation: 'An operation took longer than expected and was cancelled. This can happen with slow network connections or long-running workflows.',
      actions: [
        { label: 'Retry', target: '', type: 'command', primary: true },
        { label: 'Increase Timeout', target: 'workbench.action.openSettings', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'operation-timed-out',
      severity: 'warning'
    })
  },
  {
    pattern: /out of memory|heap.*limit|FATAL ERROR.*CALL_AND_RETRY_LAST/i,
    explanation: () => ({
      title: 'Out of Memory',
      explanation: 'The Node.js process ran out of memory. This can happen with very large workspaces or memory-intensive operations.',
      actions: [
        { label: 'Reload Window', target: 'workbench.action.reloadWindow', type: 'command', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'out-of-memory',
      severity: 'critical'
    })
  },
  {
    pattern: /spawn.*ENOENT|command not found/i,
    explanation: () => ({
      title: 'Command Not Found',
      explanation: 'A shell command in your workflow or adapter couldn\'t be found. Make sure the required tool is installed and in your PATH.',
      actions: [
        { label: 'Check PATH', target: 'workbench.action.terminal.new', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command', primary: true }
      ],
      faqSection: 'command-not-found',
      severity: 'warning'
    })
  },
  {
    pattern: /invalid.*json|unexpected token|JSON\.parse/i,
    explanation: () => ({
      title: 'Invalid JSON',
      explanation: 'A configuration file or response contained invalid JSON. This can happen with corrupted state files or malformed API responses.',
      actions: [
        { label: 'Reset State', target: 'autoclaw.resetState', type: 'command' },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command', primary: true }
      ],
      faqSection: 'invalid-json',
      severity: 'warning'
    })
  },
  {
    pattern: /git.*not found|ENOENT.*git/i,
    explanation: () => ({
      title: 'Git Not Found',
      explanation: 'Git is required for KDream\'s workspace monitoring but wasn\'t found in your PATH.',
      actions: [
        { label: 'Install Git', target: 'https://git-scm.com/downloads', type: 'url', primary: true },
        { label: 'Ask AI About This', target: 'autoclaw.askAIHelp', type: 'command' }
      ],
      faqSection: 'git-not-found',
      severity: 'warning'
    })
  }
];

/**
 * Context information extracted for AI-assisted help
 */
export interface ErrorContext {
  /** The raw error message */
  errorMessage: string;
  /** Error stack trace if available */
  stackTrace?: string;
  /** Current KDream state if available */
  kdreamState?: string;
  /** Today's log entries if available */
  recentLogs?: string[];
  /** Active MAteam sessions if available */
  mateamSessions?: string;
  /** Timestamp when error occurred */
  timestamp: string;
  /** VS Code version */
  vscodeVersion: string;
  /** Extension version */
  extensionVersion: string;
}

/**
 * Find the best matching explanation for an error message
 */
export function explainError(errorMessage: string, context?: ErrorContext): ErrorExplanation | null {
  for (const { pattern, explanation } of ERROR_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) {
      return explanation(match, context);
    }
  }

  // Fallback for unknown errors
  return {
    title: 'Unknown Error',
    explanation:
      `An unexpected error occurred: "${errorMessage}". ` +
      'This error isn\'t in our FAQ yet, but AI can help explain it.',
    actions: [
      { label: 'Ask AI About This Error', target: 'autoclaw.askAIHelp', type: 'command', primary: true },
      { label: 'View Full FAQ', target: 'autoclaw.openFAQ', type: 'command' },
      { label: 'Report on GitHub', target: 'https://github.com/GoZippy/autoclaw/issues', type: 'url' }
    ],
    isNonCritical: false,
    severity: 'critical'
  };
}

/**
 * Extract context information for AI-assisted help
 */
export async function extractErrorContext(errorMessage: string): Promise<ErrorContext> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const context: ErrorContext = {
    errorMessage,
    timestamp: new Date().toISOString(),
    vscodeVersion: vscode.version,
    extensionVersion: '1.3.0'
  };

  if (!workspaceRoot) {
    return context;
  }

  // Try to read KDream state
  try {
    const statePath = path.join(workspaceRoot, '.autoclaw', 'kdream', 'state.json');
    const stateContent = await fs.promises.readFile(statePath, 'utf8');
    context.kdreamState = stateContent;
  } catch {
    // State file doesn't exist yet
  }

  // Try to read today's log
  try {
    const today = new Date().toISOString().split('T')[0];
    const logPath = path.join(workspaceRoot, '.autoclaw', 'kdream', 'logs', `${today}.md`);
    const logContent = await fs.promises.readFile(logPath, 'utf8');
    context.recentLogs = logContent.split('\n').filter(l => l.trim()).slice(-20);
  } catch {
    // Log file doesn't exist
  }

  // Try to read MAteam sessions
  try {
    const mateamDir = path.join(workspaceRoot, '.autoclaw', 'mateam', 'scratch');
    const entries = await fs.promises.readdir(mateamDir, { withFileTypes: true });
    const sessions = entries.filter(e => e.isDirectory()).map(e => e.name);
    context.mateamSessions = sessions.length > 0 ? sessions.join(', ') : 'No active sessions';
  } catch {
    // MAteam directory doesn't exist
  }

  return context;
}

/**
 * Format error context as a prompt for AI assistance
 */
export function formatAIHelpPrompt(context: ErrorContext, explanation: ErrorExplanation): string {
  let prompt = `I need help understanding an error in AutoClaw (VS Code extension for AI agents).\n\n`;
  prompt += `## Error\n${context.errorMessage}\n\n`;
  prompt += `## What AutoClaw Says\n${explanation.explanation}\n\n`;

  if (context.kdreamState) {
    prompt += `## KDream State\n\`\`\`json\n${context.kdreamState}\n\`\`\`\n\n`;
  }

  if (context.recentLogs && context.recentLogs.length > 0) {
    prompt += `## Recent Logs\n\`\`\`\n${context.recentLogs.join('\n')}\n\`\`\`\n\n`;
  }

  if (context.mateamSessions) {
    prompt += `## MAteam Sessions\n${context.mateamSessions}\n\n`;
  }

  prompt += `## Environment\n`;
  prompt += `- VS Code Version: ${context.vscodeVersion}\n`;
  prompt += `- AutoClaw Version: ${context.extensionVersion}\n`;
  prompt += `- Timestamp: ${context.timestamp}\n\n`;

  prompt += `Please explain what this error means, why it might have occurred, and what steps I should take to resolve it. `;
  prompt += `Be concise and practical.`;

  return prompt;
}

/**
 * Records an error occurrence for frequency tracking
 */
async function recordErrorOccurrence(context: vscode.ExtensionContext, errorType: string): Promise<void> {
  const counts = context.globalState.get<Record<string, { count: number; lastSeen: string }>>('errorCounts', {});
  const now = new Date().toISOString();
  if (!counts[errorType]) {
    counts[errorType] = { count: 0, lastSeen: now };
  }
  counts[errorType].count++;
  counts[errorType].lastSeen = now;
  await context.globalState.update('errorCounts', counts);
}

/**
 * Gets the frequency info for an error type
 */
function getErrorFrequency(context: vscode.ExtensionContext, errorType: string): { count: number; lastSeen: string } | null {
  const counts = context.globalState.get<Record<string, { count: number; lastSeen: string }>>('errorCounts', {});
  return counts[errorType] || null;
}

/**
 * Records a dismissal for an error type with a cooldown period
 */
async function recordDismissal(context: vscode.ExtensionContext, errorType: string, cooldownMs: number = 3600000): Promise<void> {
  const dismissals = context.globalState.get<Record<string, number>>('errorDismissals', {});
  dismissals[errorType] = Date.now() + cooldownMs;
  await context.globalState.update('errorDismissals', dismissals);
}

/**
 * Checks if an error type is currently dismissed (within cooldown)
 */
function isDismissed(context: vscode.ExtensionContext, errorType: string): boolean {
  const dismissals = context.globalState.get<Record<string, number>>('errorDismissals', {});
  const expiry = dismissals[errorType];
  if (!expiry) {
    return false;
  }
  if (Date.now() > expiry) {
    return false;
  }
  return true;
}

/**
 * Show an error notification with helpful actions
 */
export async function showHelpfulErrorNotification(
  errorMessage: string,
  options?: { stackTrace?: string; isSilent?: boolean; context?: vscode.ExtensionContext }
): Promise<void> {
  const context = await extractErrorContext(errorMessage);
  if (options?.stackTrace) {
    context.stackTrace = options.stackTrace;
  }

  const explanation = explainError(errorMessage, context);
  if (!explanation) {
    return;
  }

  if (explanation.isNonCritical && options?.isSilent) {
    console.log('[AutoClaw]', explanation.title, '-', errorMessage);
    return;
  }

  if (options?.context && explanation.faqSection) {
    if (isDismissed(options.context, explanation.faqSection)) {
      return;
    }
  }

  let message = `${explanation.title}: ${explanation.explanation.substring(0, 150)}${explanation.explanation.length > 150 ? '...' : ''}`;

  if (options?.context && explanation.faqSection) {
    const freq = getErrorFrequency(options.context, explanation.faqSection);
    if (freq && freq.count > 1) {
      message += `\n\nThis error has occurred ${freq.count} times.`;
    }
    await recordErrorOccurrence(options.context, explanation.faqSection);
  }

  const actionLabels = explanation.actions.map(a => a.label);
  const hasDismissAction = explanation.actions.some(a => a.type === 'dismiss');
  if (!hasDismissAction) {
    actionLabels.push('Mark as Resolved');
  }

  const selected = await vscode.window.showInformationMessage(
    message,
    { modal: !explanation.isNonCritical },
    ...actionLabels
  );

  if (!selected) {
    return;
  }

  if (selected === 'Mark as Resolved' && options?.context && explanation.faqSection) {
    await recordDismissal(options.context, explanation.faqSection);
    return;
  }

  const action = explanation.actions.find(a => a.label === selected);
  if (!action) {
    return;
  }

  if (action.type === 'dismiss' && options?.context && explanation.faqSection) {
    await recordDismissal(options.context, explanation.faqSection);
    return;
  }

  switch (action.type) {
    case 'command':
      if (action.target) {
        await vscode.commands.executeCommand(action.target);
      }
      break;
    case 'url':
      await vscode.env.openExternal(vscode.Uri.parse(action.target));
      break;
    case 'faq':
      await vscode.commands.executeCommand('autoclaw.openFAQ', action.target);
      break;
    case 'dismiss':
      if (options?.context && explanation.faqSection) {
        await recordDismissal(options.context, explanation.faqSection);
      }
      break;
  }
}
