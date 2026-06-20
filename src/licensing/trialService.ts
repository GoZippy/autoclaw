// ZIPPY OPEN MATERIAL
//
// 7-day full-Pro trial — the vscode wrapper around the pure trialLogic. Starts on
// first MEANINGFUL use (not install), stored in globalState (survives updates,
// restarts, and disable/enable; a full uninstall clears it — acceptable, we do
// NOT fingerprint). No account, no card. After expiry the user keeps Free
// Community mode. (If stronger reset-resistance is ever wanted, mirror the
// consumed-flag to ~/.autoclaw — deliberately not done here.)

import * as vscode from 'vscode';
import {
  TRIAL_DAYS,
  type TrialState,
  type TrialStatus,
  computeTrialStatus,
  startedTrialState,
  consumedIfExpiredState,
} from './trialLogic';

export type { TrialState, TrialStatus } from './trialLogic';

const TRIAL_STATE_KEY = 'autoclaw.trial.state';

export class TrialService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getState(): TrialState {
    return this.context.globalState.get<TrialState>(TRIAL_STATE_KEY, { trialConsumed: false });
  }

  async saveState(state: TrialState): Promise<void> {
    await this.context.globalState.update(TRIAL_STATE_KEY, state);
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
