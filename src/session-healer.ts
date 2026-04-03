/**
 * AutoClaw Session Healer
 *
 * Monitors active kdream and mateam sessions for stall/failure patterns.
 * When "fetch failed" or rate-limit errors are detected (via output file
 * changes or explicit reports), it:
 *  1. Identifies the failing model/provider
 *  2. Asks the routing engine for the next best model
 *  3. Offers the user an auto-reroute or manual switch
 *  4. Writes a .autoclaw/routing/reroute-<session>.md playbook the agent
 *     can read to understand it should resume with a new model
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getRoutingEngine, TaskType, RoutingDecision } from './routing-engine';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  type: 'kdream' | 'mateam';
  scratchDir: string;
  /** Last file write timestamp (ms) */
  lastActivity: number;
  /** Detected failure message, if any */
  failureReason?: string;
  /** Suggested new model from routing engine */
  suggestedModel?: string;
  status: 'healthy' | 'stalled' | 'failed' | 'rerouted';
}

export interface HealResult {
  sessionId: string;
  action: 'rerouted' | 'playbook-written' | 'user-dismissed' | 'no-action';
  newModel?: string;
  viaZMLR?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// SessionHealer
// ──────────────────────────────────────────────────────────────────────────────

export class SessionHealer {
  private watchedSessions = new Map<string, SessionInfo>();
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private workspaceRoot: string) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start watching all existing mateam sessions and the kdream log */
  async startWatching(): Promise<void> {
    await this._indexExistingSessions();
    this._startFileWatchers();
  }

  dispose(): void {
    for (const w of this.watchers) { w.dispose(); }
    this.watchers = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Scan all known sessions and return those that appear stalled or failed.
   * "Stalled" = no file activity in >staleThresholdMs (default 10 min).
   */
  async detectStalledSessions(staleThresholdMs = 10 * 60 * 1000): Promise<SessionInfo[]> {
    const stalled: SessionInfo[] = [];
    const now = Date.now();

    for (const session of this.watchedSessions.values()) {
      // Refresh last-activity from filesystem
      session.lastActivity = await this._getLastModified(session.scratchDir);
      const age = now - session.lastActivity;

      if (age > staleThresholdMs && session.status === 'healthy') {
        session.status = 'stalled';
      }

      if (session.status !== 'healthy') {
        stalled.push(session);
      }
    }

    return stalled;
  }

  /**
   * Analyse a session's output files for failure patterns ("fetch failed",
   * rate-limit markers, error text).
   */
  async analyseSession(sessionId: string): Promise<{ hasError: boolean; reason?: string; modelHint?: string }> {
    const session = this.watchedSessions.get(sessionId);
    if (!session) { return { hasError: false }; }

    const filesToCheck = ['output.md', 'context.md', 'review.md', 'verify.md'];
    const patterns = [
      /fetch failed/i,
      /\[RATE_LIMIT:\s*([^\]]+)\]/i,
      /Failed to send prompt/i,
      /429|rate limit|too many requests/i,
      /ECONNREFUSED|ENOTFOUND|network error/i,
      /session halted|agent failed/i,
    ];

    for (const fileName of filesToCheck) {
      const filePath = path.join(session.scratchDir, fileName);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        for (const pat of patterns) {
          const m = content.match(pat);
          if (m) {
            const modelHint = m[1]; // captured by RATE_LIMIT pattern
            return { hasError: true, reason: m[0], modelHint };
          }
        }
      } catch {
        // File missing — that's fine
      }
    }

    return { hasError: false };
  }

  /**
   * Attempt to heal a session: get the next best model, write a reroute
   * playbook, and notify the user.
   */
  async healSession(sessionId: string, taskType: TaskType = 'general'): Promise<HealResult> {
    const session = this.watchedSessions.get(sessionId);
    if (!session) {
      return { sessionId, action: 'no-action' };
    }

    const engine = getRoutingEngine();
    let decision: RoutingDecision;
    try {
      decision = await engine.decide(taskType, { minCapability: 0.5 });
    } catch (err) {
      vscode.window.showWarningMessage(
        `AutoClaw Session Healer: No available model for session "${sessionId}". ` +
        `Check provider connectivity or configure additional providers.`
      );
      return { sessionId, action: 'no-action' };
    }

    // Write reroute playbook to the session scratchpad
    const playbookPath = path.join(session.scratchDir, 'reroute.md');
    const playbookContent = this._buildReroutePlaybook(session, decision, taskType);
    await fs.promises.writeFile(playbookPath, playbookContent);

    session.suggestedModel = decision.modelId;
    session.status = 'rerouted';

    // Notify user
    const failoverMode = vscode.workspace.getConfiguration('autoclaw.routing').get<string>('failoverMode', 'ask');

    if (failoverMode === 'auto') {
      vscode.window.showInformationMessage(
        `AutoClaw: Session "${sessionId}" rerouted to ${decision.model} ` +
        `(${decision.viaZMLR ? 'via ZMLR' : 'direct'}). Reroute playbook written.`
      );
      return { sessionId, action: 'rerouted', newModel: decision.modelId, viaZMLR: decision.viaZMLR };
    }

    const action = await vscode.window.showWarningMessage(
      `AutoClaw: Session "${sessionId}" appears stalled/failed. ` +
      `Suggested reroute → ${decision.model}${decision.viaZMLR ? ' via ZMLR' : ''}.`,
      'Apply Reroute',
      'View Playbook',
      'Dismiss'
    );

    if (action === 'Apply Reroute') {
      return { sessionId, action: 'rerouted', newModel: decision.modelId, viaZMLR: decision.viaZMLR };
    }
    if (action === 'View Playbook') {
      const doc = await vscode.workspace.openTextDocument(playbookPath);
      await vscode.window.showTextDocument(doc);
      return { sessionId, action: 'playbook-written', newModel: decision.modelId, viaZMLR: decision.viaZMLR };
    }

    return { sessionId, action: 'user-dismissed' };
  }

  /**
   * Heal all detected stalled/failed sessions in one pass.
   */
  async healAllStalledSessions(): Promise<HealResult[]> {
    const stalled = await this.detectStalledSessions();
    const results: HealResult[] = [];

    for (const session of stalled) {
      const analysis = await this.analyseSession(session.id);
      if (analysis.hasError) {
        session.failureReason = analysis.reason;
        session.status = 'failed';
      }
      // Only heal sessions with detected errors or after 20 min stall
      if (session.status === 'failed' || (session.status === 'stalled' && Date.now() - session.lastActivity > 20 * 60_000)) {
        const result = await this.healSession(session.id, this._inferTaskType(session));
        results.push(result);
      }
    }

    return results;
  }

  /** Return a snapshot of all watched sessions */
  getSessions(): SessionInfo[] {
    return Array.from(this.watchedSessions.values());
  }

  /** Register an external error report from KiloCode adapter */
  reportError(sessionId: string, errorMessage: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (session) {
      session.status = 'failed';
      session.failureReason = errorMessage;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _indexExistingSessions(): Promise<void> {
    // kdream
    const kdreamDir = path.join(this.workspaceRoot, '.autoclaw', 'kdream');
    const kdreamId = 'kdream-main';
    this.watchedSessions.set(kdreamId, {
      id: kdreamId,
      type: 'kdream',
      scratchDir: kdreamDir,
      lastActivity: await this._getLastModified(kdreamDir),
      status: 'healthy',
    });

    // mateam sessions
    const mateamBase = path.join(this.workspaceRoot, '.autoclaw', 'mateam', 'scratch');
    try {
      const entries = await fs.promises.readdir(mateamBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const sessionDir = path.join(mateamBase, entry.name);
        this.watchedSessions.set(entry.name, {
          id: entry.name,
          type: 'mateam',
          scratchDir: sessionDir,
          lastActivity: await this._getLastModified(sessionDir),
          status: 'healthy',
        });
      }
    } catch {
      // mateam dir doesn't exist yet
    }
  }

  private _startFileWatchers(): void {
    const autoclaw = path.join(this.workspaceRoot, '.autoclaw');

    // Watch for new mateam sessions
    const mateamWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(autoclaw, 'mateam/scratch/**/*.md')
    );
    mateamWatcher.onDidChange(uri => this._onFileChange(uri));
    mateamWatcher.onDidCreate(uri => this._onFileCreate(uri));
    this.watchers.push(mateamWatcher);

    // Watch kdream logs
    const kdreamWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(autoclaw, 'kdream/**/*.{md,json}')
    );
    kdreamWatcher.onDidChange(uri => this._onFileChange(uri));
    this.watchers.push(kdreamWatcher);
  }

  private _onFileChange(uri: vscode.Uri): void {
    const parts = uri.fsPath.split(path.sep);
    const scratchIdx = parts.indexOf('scratch');
    if (scratchIdx >= 0 && parts[scratchIdx + 1]) {
      const sessionId = parts[scratchIdx + 1];
      const session = this.watchedSessions.get(sessionId);
      if (session) {
        session.lastActivity = Date.now();
        // If previously stalled, recover status
        if (session.status === 'stalled') { session.status = 'healthy'; }
      }
    }
  }

  private async _onFileCreate(uri: vscode.Uri): Promise<void> {
    const parts = uri.fsPath.split(path.sep);
    const scratchIdx = parts.indexOf('scratch');
    if (scratchIdx < 0) { return; }
    const sessionId = parts[scratchIdx + 1];
    if (!sessionId || this.watchedSessions.has(sessionId)) { return; }

    const sessionDir = parts.slice(0, scratchIdx + 2).join(path.sep);
    this.watchedSessions.set(sessionId, {
      id: sessionId,
      type: 'mateam',
      scratchDir: sessionDir,
      lastActivity: Date.now(),
      status: 'healthy',
    });
  }

  private async _getLastModified(dirPath: string): Promise<number> {
    try {
      let latest = 0;
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      await Promise.all(entries.map(async entry => {
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtimeMs > latest) { latest = stat.mtimeMs; }
        } catch { /* */ }
      }));
      return latest || Date.now();
    } catch {
      return Date.now();
    }
  }

  private _inferTaskType(session: SessionInfo): TaskType {
    const slug = session.id.toLowerCase();
    if (slug.includes('research')) { return 'research'; }
    if (slug.includes('review') || slug.includes('audit')) { return 'review'; }
    if (slug.includes('plan') || slug.includes('infra')) { return 'planning'; }
    if (slug.includes('code') || slug.includes('api') || slug.includes('fix')) { return 'coding'; }
    return 'general';
  }

  private _buildReroutePlaybook(session: SessionInfo, decision: RoutingDecision, taskType: TaskType): string {
    const now = new Date().toISOString();
    return `# Reroute Playbook — ${session.id}
Generated: ${now}

## Situation
Session \`${session.id}\` was detected as ${session.status}.
${session.failureReason ? `**Error detected:** \`${session.failureReason}\`` : ''}

## Recommended Action

Resume work using the following routing configuration:

| Field | Value |
|---|---|
| Model | **${decision.model}** |
| Model ID | \`${decision.modelId}\` |
| Provider | ${decision.provider} |
| Via ZMLR | ${decision.viaZMLR ? 'Yes — route through http://localhost:20128' : 'No — direct provider call'} |
| Task Type | ${taskType} |
| Reason | ${decision.reason} |

## Fallback Chain
If the above model also fails, try in order:
${decision.fallbackChain.map((f, i) => `${i + 1}. \`${f.modelId}\` (${f.provider})`).join('\n')}

## Instructions for Agent
1. Acknowledge this reroute playbook.
2. Continue work from where you left off (check \`output.md\` and \`context.md\` for prior progress).
3. Use the model above for all subsequent completions.
4. If you encounter another rate-limit or fetch error, append \`[RATE_LIMIT: <model_id>]\` to this file and AutoClaw will reroute again.
5. When done, mark this reroute complete: \`[REROUTE COMPLETE]\`
`;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────────

let _healer: SessionHealer | undefined;

export function getSessionHealer(workspaceRoot?: string): SessionHealer | undefined {
  if (!_healer && workspaceRoot) {
    _healer = new SessionHealer(workspaceRoot);
  }
  return _healer;
}

export function resetSessionHealer(): void {
  _healer?.dispose();
  _healer = undefined;
}
