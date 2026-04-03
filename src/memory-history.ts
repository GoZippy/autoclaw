import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface MemorySnapshot {
  timestamp: string;
  memoryFiles: Record<string, string>;
  consolidationEvents: ConsolidationEvent[];
}

export interface ConsolidationEvent {
  timestamp: string;
  type: 'autoConsolidation' | 'manualConsolidation' | 'userEdit';
  description: string;
  changes: {
    removed?: string[];
    consolidated?: string[];
    added?: string[];
  };
}

export class MemoryHistoryManager {
  private workspaceRoot: string;
  private historyDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.historyDir = path.join(workspaceRoot, '.autoclaw', 'kdream', 'memory', 'history');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.historyDir, { recursive: true });
  }

  async takeSnapshot(memoryFiles: Record<string, string>): Promise<void> {
    const timestamp = new Date().toISOString();
    const date = timestamp.slice(0, 10); // YYYY-MM-DD

    const snapshot: MemorySnapshot = {
      timestamp,
      memoryFiles: { ...memoryFiles },
      consolidationEvents: []
    };

    const historyFile = path.join(this.historyDir, `${date}.json`);

    try {
      // Read existing snapshot for the day
      const existing = await this.loadSnapshot(date);
      if (existing) {
        // Merge consolidation events
        snapshot.consolidationEvents = existing.consolidationEvents;
      }

      await fs.promises.writeFile(historyFile, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      console.warn('Failed to save memory snapshot:', error);
    }
  }

  async loadSnapshot(date: string): Promise<MemorySnapshot | null> {
    const historyFile = path.join(this.historyDir, `${date}.json`);

    try {
      const content = await fs.promises.readFile(historyFile, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async getHistoryRange(startDate: string, endDate: string): Promise<MemorySnapshot[]> {
    const snapshots: MemorySnapshot[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().slice(0, 10);
      const snapshot = await this.loadSnapshot(dateStr);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  async recordConsolidation(event: ConsolidationEvent): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const snapshot = await this.loadSnapshot(date);

    if (snapshot) {
      snapshot.consolidationEvents.push(event);
      const historyFile = path.join(this.historyDir, `${date}.json`);
      await fs.promises.writeFile(historyFile, JSON.stringify(snapshot, null, 2));
    }
  }

  async getMemoryDiff(oldSnapshot: MemorySnapshot, newSnapshot: MemorySnapshot): Promise<{
    added: string[];
    removed: string[];
    changed: Array<{file: string, oldContent: string, newContent: string}>;
  }> {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: Array<{file: string, oldContent: string, newContent: string}> = [];

    const allFiles = new Set([...Object.keys(oldSnapshot.memoryFiles), ...Object.keys(newSnapshot.memoryFiles)]);

    for (const file of allFiles) {
      const oldContent = oldSnapshot.memoryFiles[file];
      const newContent = newSnapshot.memoryFiles[file];

      if (!oldContent && newContent) {
        added.push(file);
      } else if (oldContent && !newContent) {
        removed.push(file);
      } else if (oldContent !== newContent) {
        changed.push({ file, oldContent, newContent });
      }
    }

    return { added, removed, changed };
  }
}