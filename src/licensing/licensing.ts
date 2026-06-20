// ZIPPY OPEN MATERIAL
//
// VS Code glue for commercial licensing + BYO-key + the 7-day Pro trial.
//
// Design principle (non-abusive): local features degrade gracefully, never hard
// lock. Two distinct gates:
//   - `requireHosted` guards features that cost *us* money (hosted oracle,
//     cross-machine routing, cloud sync). Satisfied by ANY paid license OR a BYO
//     key — NOT by the trial (a trial must not run up our hosted bill). Behavior
//     preserved from the original.
//   - `GateService` (see gateService.ts) guards tiered *local* paid features and
//     is what command wrappers use; the trial unlocks those.

import * as vscode from 'vscode';
import {
  Entitlement,
  FREE_ENTITLEMENT,
  isPaid,
  verifyLicenseKey,
} from './license';
import { LICENSE_PUBLIC_KEY_PEM } from './publicKey';
import { LicenseStore } from './licenseStore';
import { EntitlementService } from './entitlementService';
import { TrialService } from './trialService';
import { LicenseStatusBar } from './statusBar';
import { getSupportLinks, isPlaceholder } from '../support/supportConfig';

/** Current entitlement from the stored license key (free if none/invalid). */
export async function getEntitlement(context: vscode.ExtensionContext): Promise<Entitlement> {
  const key = await new LicenseStore(context).getLicenseKey();
  if (!key) { return FREE_ENTITLEMENT; }
  return verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM);
}

/** True when the user has stored their own provider API key. */
export async function hasByoKey(context: vscode.ExtensionContext): Promise<boolean> {
  return new LicenseStore(context).hasByoKey();
}

export async function getByoKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return new LicenseStore(context).getByoKey();
}

/**
 * Gate for a HOSTED feature (one that costs us money). Returns true if the user
 * may proceed: they hold a paid license OR have a BYO key. Otherwise shows a
 * non-blocking upgrade/BYO choice and returns false. Never call this for local
 * features. The trial does NOT satisfy this gate.
 */
export async function requireHosted(
  context: vscode.ExtensionContext,
  featureLabel: string,
): Promise<boolean> {
  const ent = await getEntitlement(context);
  if (isPaid(ent)) { return true; }
  if (await hasByoKey(context)) { return true; }

  const UPGRADE = 'Get a license';
  const BYO = 'Use my own API key';
  const choice = await vscode.window.showInformationMessage(
    `"${featureLabel}" is a hosted feature that runs on our servers. Use a commercial license, or bring your own API key (free — you pay your provider directly). Everything local stays free.`,
    UPGRADE,
    BYO,
    'Not now',
  );
  if (choice === UPGRADE) {
    await openProOrPanel(context);
  } else if (choice === BYO) {
    await vscode.commands.executeCommand('autoclaw.byok.set');
  }
  return false;
}

async function openProOrPanel(context: vscode.ExtensionContext): Promise<void> {
  const links = getSupportLinks();
  if (isPlaceholder(links.proUrl)) {
    await vscode.commands.executeCommand('autoclaw.support.open');
  } else {
    await vscode.env.openExternal(vscode.Uri.parse(links.proUrl));
  }
}

function describe(ent: Entitlement): string {
  if (!ent.valid && ent.tier === 'free') { return ent.reason; }
  const exp =
    ent.expiresAt === null || ent.expiresAt === undefined
      ? 'perpetual'
      : `expires ${new Date(ent.expiresAt * 1000).toISOString().slice(0, 10)}`;
  const status = ent.valid ? 'ACTIVE' : 'INVALID';
  return `${ent.tier.toUpperCase()} — ${status} (${exp}${ent.seats ? `, ${ent.seats} seat${ent.seats > 1 ? 's' : ''}` : ''})`;
}

/** Build the rich effective-status line (license + trial + BYO). */
async function describeEffective(context: vscode.ExtensionContext): Promise<string> {
  const svc = new EntitlementService(context);
  const eff = await svc.getEffectiveEntitlement();
  const byo = eff.hasByoKey ? ' • BYO API key set' : '';
  if (eff.reason === 'trial') {
    const days = eff.trialEndsAt
      ? Math.max(0, Math.ceil((eff.trialEndsAt - Date.now()) / 86_400_000))
      : 0;
    return `Pro TRIAL — ${days} day${days === 1 ? '' : 's'} left (local Pro features unlocked; commercial use needs a license)${byo}`;
  }
  if (eff.reason === 'licensed') {
    return `${describe(eff.base)}${byo}`;
  }
  // free or expired-license
  const tail = eff.reason === 'expired-license' ? ` (last license: ${describe(eff.base)})` : '';
  return `Free Community mode${tail}${byo}`;
}

export function registerLicensing(context: vscode.ExtensionContext): void {
  const store = new LicenseStore(context);
  const trial = new TrialService(context);
  const statusBar = new LicenseStatusBar(context);
  const refresh = (): void => { void statusBar.refresh(); };
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.license.enter', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Enter AutoClaw license key',
        prompt: 'Paste the AUTOCLAW-… key from your purchase email.',
        ignoreFocusOut: true,
        placeHolder: 'AUTOCLAW-…',
      });
      if (!key) { return; }
      const ent = verifyLicenseKey(key.trim(), LICENSE_PUBLIC_KEY_PEM);
      if (!ent.valid) {
        vscode.window.showErrorMessage(`License not accepted: ${ent.reason}`);
        return;
      }
      await store.setLicenseKey(key.trim());
      refresh();
      vscode.window.showInformationMessage(`AutoClaw license activated: ${describe(ent)}. Thank you!`);
    }),

    vscode.commands.registerCommand('autoclaw.license.status', async () => {
      vscode.window.showInformationMessage(`AutoClaw: ${await describeEffective(context)}`);
    }),

    vscode.commands.registerCommand('autoclaw.license.clear', async () => {
      await store.clearLicenseKey();
      refresh();
      vscode.window.showInformationMessage('AutoClaw license key removed. Back to free local use.');
    }),

    vscode.commands.registerCommand('autoclaw.byok.set', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Bring your own API key',
        prompt: 'Stored securely in VS Code secrets. Used for hosted features so you pay your provider directly instead of buying a license.',
        ignoreFocusOut: true,
        password: true,
        placeHolder: 'sk-… (leave blank and confirm to clear)',
      });
      if (key === undefined) { return; }
      if (!key.trim()) {
        await store.clearByoKey();
        refresh();
        vscode.window.showInformationMessage('BYO API key cleared.');
        return;
      }
      await store.setByoKey(key.trim());
      refresh();
      vscode.window.showInformationMessage('BYO API key saved. Hosted features unlocked using your key.');
    }),

    vscode.commands.registerCommand('autoclaw.license.comparePlans', async () => {
      await openProOrPanel(context);
    }),

    vscode.commands.registerCommand('autoclaw.trial.status', async () => {
      const s = trial.getStatus();
      if (!s.started) {
        vscode.window.showInformationMessage('AutoClaw Pro trial not started yet — it begins on first meaningful use (7 days, no account).');
      } else if (s.active) {
        vscode.window.showInformationMessage(`AutoClaw Pro trial: ${s.daysRemaining} day${s.daysRemaining === 1 ? '' : 's'} remaining.`);
      } else {
        vscode.window.showInformationMessage('AutoClaw Pro trial has ended. Free Community mode remains active.');
      }
    }),

    vscode.commands.registerCommand('autoclaw.trial.start', async () => {
      const before = trial.getStatus();
      await trial.startIfNeeded('manual start');
      refresh();
      const after = trial.getStatus();
      if (!before.started && after.started) {
        // startIfNeeded already toasted the start.
      } else if (after.consumed && !after.active) {
        vscode.window.showInformationMessage('AutoClaw Pro trial was already used. Enter a license for commercial features.');
      } else if (after.active) {
        vscode.window.showInformationMessage(`AutoClaw Pro trial already active — ${after.daysRemaining} day${after.daysRemaining === 1 ? '' : 's'} left.`);
      }
    }),
  );

  refresh();
}
