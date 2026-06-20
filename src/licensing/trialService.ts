// ZIPPY OPEN MATERIAL
//
// 7-day full-Pro trial — the vscode wrapper around the pure trialLogic. Starts on
// first MEANINGFUL use (not install), stored in globalState (survives updates,
// restarts, and disable/enable; a full uninstall clears it — acceptable, we do
// NOT fingerprint). No account, no card. After expiry the user keeps Free
// Community mode. (If stronger reset-resistance is ever wanted, mirror the
// consumed-flag to ~/.autoclaw — deliberately not done here.)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TRIAL_DAYS,
  type TrialState,
  type TrialStatus,
  computeTrialStatus,
  startedTrialState,
  consumedIfExpiredState,
  mergeTrialStates,
} from './trialLogic';

export type { TrialState, TrialStatus } from './trialLogic';

const TRIAL_STATE_KEY = 'autoclaw.trial.state';
/** Cross-install mirror — survives extension reinstall / globalState clear, so a
 *  consumed trial can't be reset that easily (reasonable, non-hostile). */
const TRIAL_MIRROR_FILE = path.join(os.homedir(), '.autoclaw', 'trial.json');

export class TrialService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getState(): TrialState {
    const gs = this.context.globalState.get<TrialState>(TRIAL_STATE_KEY, { trialConsumed: false });
    const mirror = this.readMirror();
    // Merge to the more-restrictive of globalState + the ~/.autoclaw mirror, so
    // clearing one (reinstall / wiping globalState) can't grant a fresh trial.
    return mirror ? mergeTrialStates(gs, mirror) : gs;
  }

  async saveState(state: TrialState): Promise<void> {
    const stamped: TrialState = { ...state, machineId: state.machineId ?? this.machineId() };
    await this.context.globalState.update(TRIAL_STATE_KEY, stamped);
    // Best-effort cross-install mirror (failure must never break the trial).
    try {
      fs.mkdirSync(path.dirname(TRIAL_MIRROR_FILE), { recursive: true });
      fs.writeFileSync(TRIAL_MIRROR_FILE, JSON.stringify(stamped, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  private readMirror(): TrialState | undefined {
    try {
      const raw = fs.readFileSync(TRIAL_MIRROR_FILE, 'utf8').replace(/^﻿/, '');
      const parsed = JSON.parse(raw) as TrialState;
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private machineId(): string | undefined {
    try { return vscode.env.machineId; } catch { return undefined; }
  }

  getStatus(now = Date.now()): TrialStatus {
    return computeTrialStatus(this.getState(), now);
  }

  async startIfNeeded(reason: string, now = Date.now()): Promise<TrialStatus> {
    const next = startedTrialState(this.getState(), now);
    if (!next) { return this.getStatus(now); }
    await this.saveState(next);
    vscode.window.showInformationMessage(
      `AutoClaw Pro trial started: ${TRIAL_DAYS} days of full access. Trigger: ${reason}. No account required.`,
    );
    return computeTrialStatus(next, now);
  }

  async markConsumedIfExpired(now = Date.now()): Promise<TrialStatus> {
    const next = consumedIfExpiredState(this.getState(), now);
    if (next) { await this.saveState(next); }
    return this.getStatus(now);
  }

  async setLastNagAt(now = Date.now()): Promise<void> {
    await this.saveState({ ...this.getState(), lastNagAt: now });
  }

  getLastNagAt(): number | undefined {
    return this.getState().lastNagAt;
  }
}
