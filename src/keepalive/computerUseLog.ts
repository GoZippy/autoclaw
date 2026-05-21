/**
 * computerUseLog.ts — Audit logger for the `computer_use` keep-alive strategy.
 *
 * SAFETY REQUIREMENT (Sprint 4 / WA-3 I2): every action the computer-use
 * strategy takes against a human's GUI MUST be logged, and a screenshot MUST
 * be captured around each automated submission. The log lives at
 * `.autoclaw/runtime/computer-use-log/` so a human can audit exactly what the
 * automation did and when.
 *
 * Layout:
 *   .autoclaw/runtime/computer-use-log/
 *     actions.jsonl                  — append-only JSONL of every action
 *     <ts>-<agent>-<phase>.png       — screenshots (phase = before|after|error)
 *
 * *** NO LLM CALLS. Pure file I/O. ***
 */

import * as fs from 'fs';
import * as path from 'path';

/** A single audited computer-use action. */
export interface ComputerUseAction {
  /** ISO timestamp. */
  at: string;
  /** The agent the action was taken for. */
  agentId: string;
  /** What happened, e.g. `gate_check`, `focus_window`, `click_chat`, `submit`. */
  action: string;
  /** Outcome detail. */
  detail: string;
  /** Relative path of an associated screenshot, when one was captured. */
  screenshot?: string;
}

/** Resolve the computer-use-log directory for a workspace. */
export function computerUseLogDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'runtime', 'computer-use-log');
}

/**
 * Append an action to `computer-use-log/actions.jsonl`. Creates the directory
 * on first use. Best-effort; logs on failure but never throws.
 */
export function logComputerUseAction(
  workspaceRoot: string,
  action: ComputerUseAction,
  logger: { error: (m: string) => void } = console,
): void {
  const dir = computerUseLogDir(workspaceRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify(action) + '\n', 'utf8');
  } catch (err) {
    logger.error(`[keepalive] computer-use: failed to append action log: ${String(err)}`);
  }
}

/**
 * Build the absolute path for a screenshot file and ensure its directory
 * exists. Returns both the absolute path (for the driver to write to) and the
 * relative path (for embedding in the action log).
 *
 * @param phase - `before`, `after`, or `error`.
 */
export function screenshotPath(
  workspaceRoot: string,
  agentId: string,
  phase: 'before' | 'after' | 'error',
): { absolute: string; relative: string } {
  const dir = computerUseLogDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const name = `${ts}-${safeAgent}-${phase}.png`;
  return { absolute: path.join(dir, name), relative: name };
}
