// ZIPPY OPEN MATERIAL
//
// Upgrade-reminder rate limiting. No nag on startup, no blocking modals, global
// nags at most every 14 days, per-feature nags at most weekly. Free mode is
// always usable.

import * as vscode from 'vscode';

const NAG_STATE_KEY = 'autoclaw.nag.state';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

interface NagState {
  lastGlobalNagAt?: number;
  lastFeatureNagAt?: Record<string, number>;
}

export class NagService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private getState(): NagState {
    return this.context.globalState.get<NagState>(NAG_STATE_KEY, {});
  }

  private async saveState(state: NagState): Promise<void> {
    await this.context.globalState.update(NAG_STATE_KEY, state);
  }

  async shouldShowGlobalNag(now = Date.now()): Promise<boolean> {
    const state = this.getState();
    return !state.lastGlobalNagAt || now - state.lastGlobalNagAt > TWO_WEEKS_MS;
  }

  async markGlobalNagShown(now = Date.now()): Promise<void> {
    const state = this.getState();
    await this.saveState({ ...state, lastGlobalNagAt: now });
  }

  async shouldShowFeatureNag(featureId: string, now = Date.now()): Promise<boolean> {
    const state = this.getState();
    const last = state.lastFeatureNagAt?.[featureId];
    return !last || now - last > WEEK_MS;
  }

  async markFeatureNagShown(featureId: string, now = Date.now()): Promise<void> {
    const state = this.getState();
    await this.saveState({
      ...state,
      lastFeatureNagAt: { ...(state.lastFeatureNagAt ?? {}), [featureId]: now },
    });
  }

  async showTrialEndedOnce(): Promise<void> {
    if (!(await this.shouldShowGlobalNag())) { return; }
    await this.markGlobalNagShown();
    void vscode.window.showInformationMessage(
      'AutoClaw Pro trial ended. AutoClaw Free remains active. Upgrade anytime for Pro reports, advanced orchestration, and commercial use.',
      'Compare Plans', 'Enter License', 'Continue Free',
    ).then(choice => {
      if (choice === 'Compare Plans') {
        void vscode.commands.executeCommand('autoclaw.support.open');
      } else if (choice === 'Enter License') {
        void vscode.commands.executeCommand('autoclaw.license.enter');
      }
    });
  }
}
