/**
 * KDream Helper Functions
 * 
 * Pure logic functions extracted from extension.ts for testability.
 * These functions have no vscode dependencies and can be unit tested directly.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

/**
 * Represents a task parsed from MEMORY.md
 */
export interface ParsedTask {
  completed: boolean;
  description: string;
  priority?: 'high' | 'medium' | 'low';
  dueDate?: string;
  created?: string;
  source?: {
    file: string;
    line: number;
    commit?: string;
    date?: string;
  };
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
    let description = match[2];

    // Parse metadata from description
    const metadata: Partial<ParsedTask> = {};

    // Extract priority [priority: high]
    const priorityMatch = description.match(/\[priority:\s*(high|medium|low)\]/i);
    if (priorityMatch) {
      metadata.priority = priorityMatch[1].toLowerCase() as 'high' | 'medium' | 'low';
      description = description.replace(priorityMatch[0], '').trim();
    }

    // Extract due date [due: 2026-04-15]
    const dueMatch = description.match(/\[due:\s*([^\]]+)\]/i);
    if (dueMatch) {
      metadata.dueDate = dueMatch[1].trim();
      description = description.replace(dueMatch[0], '').trim();
    }

    // Extract created date [created: 2026-04-02T12:00:00Z]
    const createdMatch = description.match(/\[created:\s*([^\]]+)\]/i);
    if (createdMatch) {
      metadata.created = createdMatch[1].trim();
      description = description.replace(createdMatch[0], '').trim();
    }

    tasks.push({ completed, description, ...metadata });
  }

  return tasks;
}

/**
 * Formats a task for insertion into MEMORY.md
 * @param task - The task description or task object
 * @param metadata - Optional metadata (priority, dueDate, created)
 * @returns Formatted task string with checkbox
 */
export function formatTask(task: string | Partial<ParsedTask>, metadata?: { priority?: string; dueDate?: string; created?: string }): string {
  let description = typeof task === 'string' ? task : task.description || '';
  const meta = typeof task === 'object' ? task : metadata || {};

  const metadataParts: string[] = [];

  if (meta.priority) {
    metadataParts.push(`[priority: ${meta.priority}]`);
  }

  if (meta.dueDate) {
    metadataParts.push(`[due: ${meta.dueDate}]`);
  }

  if (meta.created) {
    metadataParts.push(`[created: ${meta.created}]`);
  }

  if (metadataParts.length > 0) {
    description += ' ' + metadataParts.join(' ');
  }

  return `- [ ] ${description}`;
}

/**
 * Adds a task to existing MEMORY.md content, placing it under the Follow-ups section.
 * @param existingContent - Current MEMORY.md content
 * @param task - Task description to add
 * @returns Updated MEMORY.md content with the new task
 */
export function addTaskToContent(existingContent: string, task: string, metadata?: { priority?: string; dueDate?: string; created?: string }): string {
  const followUpsHeader = '## Follow-ups';
  const formattedTask = formatTask(task, metadata);
  
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
 * Gets git commit information for a file
 * @param filePath - Relative path to the file
 * @returns Promise resolving to commit info or null if git is not available
 */
export async function getFileCommitInfo(filePath: string): Promise<{ commit: string; date: string } | null> {
  try {
    const execAsync = promisify(exec);
    const gitCommand = `git log -1 --format="%H %ad" --date=short -- "${filePath}"`;
    const { stdout } = await execAsync(gitCommand, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });

    if (stdout.trim()) {
      const [commit, date] = stdout.trim().split(' ');
      return { commit, date };
    }
  } catch {
    // Git not available or file not tracked
  }

  return null;
}

/**
 * Default adapter configuration
 */
export const DEFAULT_ADAPTERS = [
  { name: 'Claude Code', id: 'Anthropic.claude-code' },
  { name: 'Cline', id: 'saoudrizwan.claude-dev' },
  { name: 'KiloCode', id: 'kilocode.kilo-code' },
  { name: 'Kiro', id: 'amazon.kiro' },
  { name: 'Windsurf', id: 'codeium.windsurf' },
  { name: 'Continue', id: 'Continue.continue' }
];

/**
 * Checks if ZippyMesh LLM Router is running locally
 * @param baseUrl - Base URL to check (default: http://localhost:20128)
 * @returns Promise resolving to health status object
 */
export async function checkZippyMeshHealth(baseUrl = 'http://localhost:20128'): Promise<AdapterHealth> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(baseUrl, { signal: controller.signal, method: 'HEAD' });
    clearTimeout(timeout);
    return {
      name: 'ZippyMesh LLM Router',
      status: res.ok ? 'healthy' : 'warning',
      details: res.ok ? `Running at ${baseUrl}` : `Responded ${res.status} at ${baseUrl}`
    };
  } catch {
    return {
      name: 'ZippyMesh LLM Router',
      status: 'warning',
      details: 'Not detected — start ZippyMesh on localhost:20128'
    };
  }
}

/**
 * Generates nonce for CSP using cryptographically secure random bytes
 * @param length - Length of nonce (default 32)
 * @returns Random nonce string
 */
export function generateNonce(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
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
 * Helper function for shouldShowNotification - kept for backward compatibility
 * @param notificationLevel - Current notification level setting
 * @param messageLevel - Level of the message to show
 * @returns true if notification should be shown
 */
 export function shouldShowNotificationHelper(
   notificationLevel: string,
   messageLevel: 'info' | 'warning' | 'error'
 ): boolean {
   return shouldShowNotification(notificationLevel, messageLevel);
 }

/**
 * Gets today's date in YYYY-MM-DD format
 * @returns Today's date string
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Parses tags from content using #tag format
 * @param content - Text content to parse for tags
 * @returns Array of tag strings without the # prefix
 */
export function parseTagsFromContent(content: string): string[] {
  const tagRegex = /#(\w+)/g;
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }
  return [...new Set(tags)]; // Remove duplicates
}

/**
 * Adds tags to memory content, only to unchecked tasks
 * @param content - Existing memory content
 * @param tags - Array of tags to add (without # prefix)
 * @returns Updated content with tags added to unchecked tasks
 */
export function addTagsToMemory(content: string, tags: string[]): string {
  // Remove existing tags from follow-ups
  const lines = content.split('\n');
  const taggedLines = lines.map(line => {
    if (line.startsWith('- [') && line.includes('#')) {
      return line.replace(/\s+#\w+/g, ''); // Remove existing tags
    }
    return line;
  });

  // Add new tags to unchecked items
  return taggedLines.map(line => {
    if (line.startsWith('- [ ]') && !line.includes('#')) {
      return line + ' ' + tags.map(tag => `#${tag}`).join(' ');
    }
    return line;
  }).join('\n');
}

/**
 * Gets memories (tasks) that contain all required tags
 * @param content - Memory content to search
 * @param requiredTags - Array of tags that must all be present
 * @returns Array of tasks that match all required tags
 */
export function getMemoriesByTags(content: string, requiredTags: string[]): ParsedTask[] {
  const tasks = parseMemoryTasks(content);
  return tasks.filter(task => {
    const taskTags = parseTagsFromContent(task.description);
    return requiredTags.every(tag => taskTags.includes(tag));
  });
}

/**
 * Suggests tags for a task based on content patterns
 * @param task - Task description
 * @returns Array of suggested tag strings
 */
export function suggestTagsForTask(task: string): string[] {
  const suggestions: string[] = [];
  const lowerTask = task.toLowerCase();

  if (lowerTask.includes('bug') || lowerTask.includes('fix') || lowerTask.includes('error')) {
    suggestions.push('bug', 'fix');
  }
  if (lowerTask.includes('feature') || lowerTask.includes('implement') || lowerTask.includes('add')) {
    suggestions.push('feature', 'enhancement');
  }
  if (lowerTask.includes('test') || lowerTask.includes('spec')) {
    suggestions.push('testing', 'quality');
  }
  if (lowerTask.includes('ui') || lowerTask.includes('interface') || lowerTask.includes('display')) {
    suggestions.push('ui', 'ux');
  }
  if (lowerTask.includes('performance') || lowerTask.includes('speed') || lowerTask.includes('optimize')) {
    suggestions.push('performance', 'optimization');
  }

  return [...new Set(suggestions)]; // Remove duplicates
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

/**
 * Constructs the path to the health directory for a workspace
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to .autoclaw/kdream/health directory
 */
 export function getHealthDirPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'kdream', 'health');
}

/**
 * Constructs the path to the adapter health history file
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to adapter-health.jsonl file
 */
 export function getAdapterHealthHistoryPath(workspaceRoot: string): string {
  return path.join(getHealthDirPath(workspaceRoot), 'adapter-health.jsonl');
}

/**
 * Constructs the path to the alerts file
 * @param workspaceRoot - Root path of the workspace
 * @returns Path to alerts.json file
 */
 export function getAlertsPath(workspaceRoot: string): string {
  return path.join(getHealthDirPath(workspaceRoot), 'alerts.json');
}

/**
 * Get priority color based on priority level
 * @param priority - Priority level (high, medium, low)
 * @returns CSS color string for the priority
 */
 export function getPriorityColor(priority: string): string {
   switch (priority) {
     case 'high': return 'var(--vscode-notificationsErrorIcon-foreground)';
     case 'medium': return 'var(--vscode-notificationsWarningIcon-foreground)';
     case 'low': return 'var(--vscode-notificationsInfoIcon-foreground)';
     default: return 'var(--vscode-descriptionForeground)';
   }
 }

/**
 * Get due date status based on current date
 * @param dueDate - Due date string (YYYY-MM-DD)
 * @returns Status: 'overdue', 'due-soon', 'upcoming', or 'none'
 */
 export function getDueDateStatus(dueDate: string | null): 'overdue' | 'due-soon' | 'upcoming' | 'none' {
   if (!dueDate) return 'none';
   
   const due = new Date(dueDate);
   const now = new Date();
   const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);
   
   if (diffHours < 0) return 'overdue';
   if (diffHours < 24) return 'due-soon';
   return 'upcoming';
 }

/**
 * Format due date for display (relative dates)
 * @param dueDate - Due date string (YYYY-MM-DD)
 * @returns Formatted date string (Today, Tomorrow, In X days, etc.)
 */
 export function formatDueDate(dueDate: string | null): string {
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

/**
 * Extended adapter health interface with metrics for history tracking
 */
 export interface AdapterHealthExtended extends AdapterHealth {
   responseTime?: number;
   errorRate?: number;
 }

/**
 * Health history entry interface
 */
 export interface HealthHistoryEntry {
   timestamp: string;
   adapters: AdapterHealthExtended[];
 }

/**
 * Records adapter health history to a JSONL file
 * @param workspaceRoot - Root path of the workspace
 * @param healthData - Adapter health data to record
 */
 export async function recordAdapterHealth(workspaceRoot: string, healthData: AdapterHealthExtended[]): Promise<void> {
   const healthDir = getHealthDirPath(workspaceRoot);
   await fs.promises.mkdir(healthDir, { recursive: true });
   
   const historyEntry: HealthHistoryEntry = {
     timestamp: new Date().toISOString(),
     adapters: healthData
   };
   
   const historyFile = getAdapterHealthHistoryPath(workspaceRoot);
   await fs.promises.appendFile(historyFile, JSON.stringify(historyEntry) + '\n');
   
   // Check for alerts
   await checkAndGenerateAlerts(workspaceRoot, healthData);
 }

/**
 * Loads adapter health history from the JSONL file
 * @param workspaceRoot - Root path of the workspace
 * @param hours - Number of hours of history to retrieve (default: 24)
 * @returns Array of health history entries
 */
 export async function getAdapterHealthHistory(workspaceRoot: string, hours: number = 24): Promise<HealthHistoryEntry[]> {
   const historyFile = getAdapterHealthHistoryPath(workspaceRoot);
   
   try {
     const content = await fs.promises.readFile(historyFile, 'utf8');
     const lines = content.trim().split('\n').filter(line => line.trim());
     const entries = lines.map(line => JSON.parse(line));
     
     // Filter by time range
     const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
     return entries.filter(entry => new Date(entry.timestamp) > cutoff);
    } catch {
      return []; // No history yet
    }
  }

/**
 * Checks health data and generates alerts if necessary
 * @param workspaceRoot - Root path of the workspace
 * @param healthData - Current adapter health data
 */
export async function checkAndGenerateAlerts(workspaceRoot: string, healthData: AdapterHealthExtended[]): Promise<void> {
  const alerts: any[] = [];

  healthData.forEach(adapter => {
    if (adapter.status === 'warning') {
      alerts.push({
        id: `${adapter.name}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        adapter: adapter.name,
        severity: 'warning',
        message: `${adapter.name} is experiencing issues: ${adapter.details}`
      });
    }

    if (adapter.responseTime && adapter.responseTime > 5000) {
      alerts.push({
        id: `${adapter.name}-response-time-${Date.now()}`,
        timestamp: new Date().toISOString(),
        adapter: adapter.name,
        severity: 'warning',
        message: `${adapter.name} has high response time: ${adapter.responseTime}ms`
      });
    }

    if (adapter.errorRate && adapter.errorRate > 0.1) {
      alerts.push({
        id: `${adapter.name}-error-rate-${Date.now()}`,
        timestamp: new Date().toISOString(),
        adapter: adapter.name,
        severity: 'error',
        message: `${adapter.name} has high error rate: ${(adapter.errorRate * 100).toFixed(1)}%`
      });
    }
  });

  if (alerts.length > 0) {
    const alertsFile = getAlertsPath(workspaceRoot);
    try {
      let existingAlerts: any[] = [];
      try {
        const content = await fs.promises.readFile(alertsFile, 'utf8');
        existingAlerts = JSON.parse(content);
      } catch {
        // File doesn't exist or is invalid
      }

      const combinedAlerts = [...existingAlerts, ...alerts];
      const uniqueAlerts = Array.from(new Map(combinedAlerts.map(item => [item.id, item])).values());
      await fs.promises.writeFile(alertsFile, JSON.stringify(uniqueAlerts, null, 2));
    } catch (error) {
      console.error('Failed to write alerts:', error);
    }
  }
}

/**
 * ZMLR status interface
 */
export interface ZMLRStatus {
  available: boolean;
  url: string;
  responseTime: number;
  lastChecked: string;
  error?: string;
}

/**
 * Checks if ZippyMesh LLM Router is available and responding
 * @param customUrl - Optional custom ZMLR URL (defaults to config)
 * @returns ZMLR status object
 */
export async function checkZMLRAvailability(customUrl?: string): Promise<ZMLRStatus> {
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const zmlrUrl = customUrl || config.get<string>('zippymeshUrl', 'http://localhost:20128');

  const startTime = Date.now();
  try {
    const response = await fetch(`${zmlrUrl}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      return {
        available: true,
        url: zmlrUrl,
        responseTime: Math.round(responseTime),
        lastChecked: new Date().toISOString()
      };
    } else {
      return {
        available: false,
        url: zmlrUrl,
        responseTime: Math.round(Date.now() - startTime),
        lastChecked: new Date().toISOString(),
        error: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      available: false,
      url: zmlrUrl,
      responseTime: Math.round(Date.now() - startTime),
      lastChecked: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Connection failed'
    };
  }
}

/**
 * Gets AI help response directly from ZMLR
 * @param prompt - The help prompt to send
 * @param customUrl - Optional custom ZMLR URL
 * @returns AI response text
 */
export async function getZMLRAIHelp(prompt: string, customUrl?: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('autoclaw.kdream');
  const zmlrUrl = customUrl || config.get<string>('zippymeshUrl', 'http://localhost:20128');

  try {
    const response = await fetch(`${zmlrUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        stream: false
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`ZMLR error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || data.response || 'No response from ZMLR';
  } catch (error) {
    throw new Error(`Failed to get AI help from ZMLR: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Checks health data and generates alerts if necessary
 * @param workspaceRoot - Root path of the workspace
 * @param healthData - Current adapter health data
 */
