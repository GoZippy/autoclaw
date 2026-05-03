/**
 * KDream Helper Functions
 * 
 * Pure logic functions extracted from extension.ts for testability.
 * These functions have no vscode dependencies and can be unit tested directly.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a task parsed from MEMORY.md
 */
export interface ParsedTask {
  completed: boolean;
  description: string;
}

/**
 * Represents adapter health information
 */
export interface AdapterHealth {
  name: string;
  status: 'healthy' | 'warning';
  details: string;
}

/**
 * Represents a TODO/FIXME comment found in source code
 */
export interface TodoItem {
  file: string;
  line: number;
  type: string;
  text: string;
}

/**
 * Code churn metrics data
 */
export interface CodeChurnMetrics {
  totalCommits: number;
  commitsLast7Days: number;
  commitsLast30Days: number;
  linesAdded: number;
  linesDeleted: number;
  churnRate: number; // (added + deleted) / commits
  avgCommitSize: number; // lines changed per commit
  mostActiveDay: string; // YYYY-MM-DD
}

/**
 * Productivity insights data
 */
export interface ProductivityInsights {
  todoResolutionRate: number; // resolved / total todos
  avgTimeToResolveTodo: number; // days
  commitFrequency: number; // commits per day last 30 days
  activeDays: number; // days with commits last 30 days
  memorySize: number; // KB
  logsSize: number; // KB
}

/**
 * Project health indicators
 */
export interface ProjectHealthIndicators {
  totalFiles: number;
  sourceFiles: number;
  openTodos: number;
  uncommittedChanges: number;
  staleChangesHours: number; // age of oldest uncommitted change
  memoryCompleteness: number; // percentage of sections filled
  adapterCoverage: number; // percentage of adapters healthy
}

/**
 * Parses MEMORY.md content and extracts tasks.
 * @param memoryContent - The raw content of MEMORY.md
 * @returns Array of parsed tasks
 */
export function parseMemoryTasks(memoryContent: string): ParsedTask[] {
  const taskRegex = /^- \[([ xX])\] (.+)$/gm;
  const tasks: ParsedTask[] = [];
  let match;
  
  while ((match = taskRegex.exec(memoryContent)) !== null) {
    const completed = match[1].toLowerCase() === 'x';
    const description = match[2];
    tasks.push({ completed, description });
  }
  
  return tasks;
}

/**
 * Formats a task for insertion into MEMORY.md
 * @param task - The task description
 * @returns Formatted task string with checkbox
 */
export function formatTask(task: string): string {
  return `- [ ] ${task}`;
}

/**
 * Adds a task to existing MEMORY.md content, placing it under the Follow-ups section.
 * @param existingContent - Current MEMORY.md content
 * @param task - Task description to add
 * @returns Updated MEMORY.md content with the new task
 */
export function addTaskToContent(existingContent: string, task: string): string {
  const followUpsHeader = '## Follow-ups';
  const formattedTask = formatTask(task);
  
  if (!existingContent.includes(followUpsHeader)) {
    // No Follow-ups section exists, append it
    return existingContent + '\n## Follow-ups\n\n' + formattedTask + '\n';
  }
  
  // Insert task immediately after the Follow-ups header
  const headerIndex = existingContent.indexOf(followUpsHeader);
  const afterHeader = headerIndex + followUpsHeader.length;
  
  // Find the end of the header line (including any trailing whitespace)
  let insertPos = afterHeader;
  while (insertPos < existingContent.length && 
         (existingContent[insertPos] === ' ' || existingContent[insertPos] === '\t')) {
    insertPos++;
  }
  
  // Skip the newline after the header
  if (insertPos < existingContent.length && existingContent[insertPos] === '\n') {
    insertPos++;
    // Skip any additional blank lines
    while (insertPos < existingContent.length && existingContent[insertPos] === '\n') {
      insertPos++;
    }
  }
  
  // Insert the task at this position
  return existingContent.slice(0, insertPos) + formattedTask + '\n' + existingContent.slice(insertPos);
}

/**
 * Creates initial MEMORY.md content with a task
 * @param task - First task to add
 * @returns Complete MEMORY.md content
 */
export function createInitialMemoryContent(task: string): string {
  return '# KDream Memory\n\n## Follow-ups\n\n' + formatTask(task) + '\n';
}

/**
 * Checks if .autoclaw/ is mentioned in .gitignore content
 * @param gitignoreContent - Content of .gitignore file
 * @returns true if .autoclaw/ is already in .gitignore
 */
export function isAutoclawInGitignore(gitignoreContent: string): boolean {
  return gitignoreContent.includes('.autoclaw/');
}

/**
 * Adds .autoclaw/ to .gitignore content
 * @param existingContent - Current .gitignore content
 * @returns Updated .gitignore content with .autoclaw/ entry
 */
export function addAutoclawToGitignore(existingContent: string): string {
  return existingContent + '\n# AutoClaw KDream data\n.autoclaw/\n';
}

/**
 * Parses log content and returns recent entries
 * @param logContent - Raw log file content
 * @param maxEntries - Maximum number of entries to return
 * @returns Array of log entries
 */
export function parseLogEntries(logContent: string, maxEntries: number = 10): string[] {
  return logContent.split('\n').filter(line => line.trim()).slice(-maxEntries);
}

/**
 * Parses TODO/FIXME comments from source file content
 * @param content - Source file content
 * @param relativePath - Relative path of the file (for reporting)
 * @returns Array of found TODO/FIXME items
 */
export function parseTodosFromContent(content: string, relativePath: string): TodoItem[] {
  const todoRegex = /(TODO|FIXME)\s*[:\-]?\s*(.*)/i;
  const results: TodoItem[] = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(todoRegex);
    if (match) {
      results.push({
        file: relativePath,
        line: i + 1,
        type: match[1].toUpperCase(),
        text: match[2].trim()
      });
    }
  }
  
  return results;
}

/**
 * Determines adapter health based on whether it's installed
 * @param adapterName - Human-readable adapter name
 * @param isInstalled - Whether the adapter is installed
 * @returns Adapter health object
 */
export function getAdapterHealthEntry(adapterName: string, isInstalled: boolean): AdapterHealth {
  return {
    name: adapterName,
    status: isInstalled ? 'healthy' : 'warning',
    details: isInstalled ? 'Installed' : 'Not detected'
  };
}

/**
 * Default adapter configuration. `id` is the VS Code extension ID where one
 * exists; `null` means the adapter targets a standalone host detected by
 * other means (Cursor: `.cursor/` workspace marker; Antigravity: app name).
 * Keep this list in sync with `adapters/` and `package.json` defaults.
 */
export interface AdapterConfig {
  name: string;
  id: string | null;
}

export const DEFAULT_ADAPTERS: AdapterConfig[] = [
  { name: 'Claude Code', id: 'Anthropic.claude-code' },
  { name: 'Cline', id: 'saoudrizwan.claude-dev' },
  { name: 'KiloCode', id: 'kilocode.kilo-code' },
  { name: 'Kiro', id: 'amazon.kiro' },
  { name: 'Windsurf', id: 'codeium.windsurf' },
  { name: 'Continue', id: 'Continue.continue' },
  { name: 'Cursor', id: null },
  { name: 'Antigravity', id: null }
];

/**
 * Checks if ZippyMesh LLM Router is running locally.
 *
 * "Healthy" requires more than a 200 OK on the port — many unrelated services
 * happen to listen on the same port and answer HEAD with 200. We require the
 * `/health` (or `/api/health`) endpoint to either return JSON identifying the
 * service or send an `x-zippymesh` / `server: zippymesh` header.
 *
 * @param baseUrl - Base URL to check (default: http://localhost:20128)
 * @returns Promise resolving to health status object
 */
export async function checkZippyMeshHealth(baseUrl = 'http://localhost:20128'): Promise<AdapterHealth> {
  const healthEndpoints = [`${baseUrl}/health`, `${baseUrl}/api/health`];

  for (const url of healthEndpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal, method: 'GET' });
      clearTimeout(timeout);
      if (!res.ok) { continue; }

      // Require either a recognizable header or a JSON body that names ZippyMesh.
      const headerHit =
        /zippymesh/i.test(res.headers.get('server') || '') ||
        res.headers.has('x-zippymesh') ||
        res.headers.has('x-zippymesh-version');

      let bodyHit = false;
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body: any = await res.json();
          const text = JSON.stringify(body || '').toLowerCase();
          bodyHit = text.includes('zippymesh') || text.includes('zmlr');
        } catch {
          // ignore parse error
        }
      }

      if (headerHit || bodyHit) {
        return {
          name: 'ZippyMesh LLM Router',
          status: 'healthy',
          details: `Running at ${baseUrl}`
        };
      }

      // Reachable but doesn't identify as ZippyMesh — degraded.
      return {
        name: 'ZippyMesh LLM Router',
        status: 'warning',
        details: `Service responded at ${url} but did not identify as ZippyMesh`
      };
    } catch {
      // Try next endpoint
    }
  }

  return {
    name: 'ZippyMesh LLM Router',
    status: 'warning',
    details: 'Not detected — start ZippyMesh on localhost:20128'
  };
}

/**
 * Generates nonce for CSP using cryptographically secure random bytes
 * @param length - Length of nonce (default 32)
 * @returns Random nonce string
 */
export function generateNonce(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = require('crypto').randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}

/**
 * Determines if a notification should be shown based on notification level setting
 * @param notificationLevel - Current notification level setting
 * @param messageLevel - Level of the message to show
 * @returns true if notification should be shown
 */
export function shouldShowNotification(
  notificationLevel: string,
  messageLevel: 'info' | 'warning' | 'error'
): boolean {
  switch (notificationLevel) {
    case 'none':
      return false;
    case 'errors':
      return messageLevel === 'error';
    case 'warnings':
      return messageLevel === 'error' || messageLevel === 'warning';
    case 'all':
    default:
      return true;
  }
}

/**
 * Gets today's date in YYYY-MM-DD format
 * @returns Today's date string
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Constructs the path to the .autoclaw/kdream directory for a workspace
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to .autoclaw/kdream directory
 */
export function getKdreamDirPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'kdream');
}

/**
 * Constructs the path to MEMORY.md for a workspace
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to MEMORY.md
 */
export function getMemoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'kdream', 'memory', 'MEMORY.md');
}

/**
 * Constructs the path to state.json for a workspace
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to state.json
 */
export function getStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'kdream', 'state.json');
}

/**
 * Constructs the path to today's log file for a workspace
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to today's log file
 */
export function getTodayLogPath(workspaceRoot: string): string {
  const today = getTodayDate();
  return path.join(workspaceRoot, '.autoclaw', 'kdream', 'logs', `${today}.md`);
}
