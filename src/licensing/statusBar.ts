// ZIPPY OPEN MATERIAL
//
// A small, non-intrusive status-bar indicator of the current mode: Free / Trial
// Nd / <tier>. Click → license status. Refreshed after any license/trial change.

import * as vscode from 'vscode';
import { EntitlementService } from './entitlementService';

const DAY_MS = 24 * 60 * 60 * 1000;

export class LicenseStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = 'autoclaw.license.status';
    this.context.subscriptions.push(this.item);
  }

  async refresh(): Promise<void> {
    const svc = new EntitlementService(this.context);
    const ent = await svc.getEffectiveEntitlement();

    if (ent.reason === 'trial') {
      const days = ent.trialEndsAt ? Math.max(0, Math.ceil((ent.trialEndsAt - Date.now()) / DAY_MS)) : 0;
      this.item.text = `$(rocket) AutoClaw Trial ${days}d`;
      this.item.tooltip = 'AutoClaw Pro trial is active. Click for license status.';
    } else if (ent.reason === 'licensed') {
      this.item.text = `$(verified) AutoClaw ${ent.effectiveTier}`;
      this.item.tooltip = 'AutoClaw commercial license active. Click for details.';
    } else {
      this.item.text = '$(zap) AutoClaw Free';
      this.item.tooltip = 'AutoClaw Free Community mode. Click for license status.';
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
