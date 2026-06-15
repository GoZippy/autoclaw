// ZIPPY OPEN MATERIAL
//
// VS Code glue for commercial licensing + BYO-key.
//
// Design principle (non-abusive): NOTHING that runs locally is ever gated. The
// only gate, `requireHosted`, guards features that cost *us* money to run
// (hosted model oracle, cross-machine routing, cloud memory/fleet sync). A user
// can satisfy that gate two ways — hold a paid license, OR bring their own API
// key (BYO) and pay the provider directly. Free local use is unconditional.

import * as vscode from 'vscode';
import {
  Entitlement,
  FREE_ENTITLEMENT,
  isPaid,
  verifyLicenseKey,
} from './license';
import { LICENSE_PUBLIC_KEY_PEM } from './publicKey';
import { getSupportLinks, isPlaceholder } from '../support/supportConfig';

const LICENSE_SECRET = 'autoclaw.license.key';
const BYO_KEY_SECRET = 'autoclaw.byok.apiKey';

/** Current entitlement from the stored license key (free if none/invalid). */
export async function getEntitlement(context: vscode.ExtensionContext): Promise<Entitlement> {
  const key = await context.secrets.get(LICENSE_SECRET);
  if (!key) return FREE_ENTITLEMENT;
  return verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM);
}

/** True when the user has stored their own provider API key. */
export async function hasByoKey(context: vscode.ExtensionContext): Promise<boolean> {
  const k = await context.secrets.get(BYO_KEY_SECRET);
  return !!(k && k.trim());
}

export async function getByoKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const k = await context.secrets.get(BYO_KEY_SECRET);
  return k && k.trim() ? k.trim() : undefined;
}

/**
 * Gate for a HOSTED feature (one that costs us money). Returns true if the user
 * may proceed: they hold a paid license OR have a BYO key. Otherwise shows a
 * non-blocking upgrade/BYO choice and returns false. Never call this for local
 * features.
 */
export async function requireHosted(
  context: vscode.ExtensionContext,
  featureLabel: string,
): Promise<boolean> {
  const ent = await getEntitlement(context);
  if (isPaid(ent)) return true;
  if (await hasByoKey(context)) return true;

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
  if (!ent.valid && ent.tier === 'free') return ent.reason;
  const exp =
    ent.expiresAt === null || ent.expiresAt === undefined
      ? 'perpetual'
      : `expires ${new Date(ent.expiresAt * 1000).toISOString().slice(0, 10)}`;
  const status = ent.valid ? 'ACTIVE' : 'INVALID';
  return `${ent.tier.toUpperCase()} — ${status} (${exp}${ent.seats ? `, ${ent.seats} seat${ent.seats > 1 ? 's' : ''}` : ''})`;
}

export function registerLicensing(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.license.enter', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Enter AutoClaw license key',
        prompt: 'Paste the AUTOCLAW-… key from your purchase email.',
        ignoreFocusOut: true,
        password: false,
        placeHolder: 'AUTOCLAW-…',
      });
      if (!key) return;
      const ent = verifyLicenseKey(key.trim(), LICENSE_PUBLIC_KEY_PEM);
      if (!ent.valid) {
        vscode.window.showErrorMessage(`License not accepted: ${ent.reason}`);
        return;
      }
      await context.secrets.store(LICENSE_SECRET, key.trim());
      vscode.window.showInformationMessage(`AutoClaw license activated: ${describe(ent)}. Thank you!`);
    }),

    vscode.commands.registerCommand('autoclaw.license.status', async () => {
      const ent = await getEntitlement(context);
      const byo = (await hasByoKey(context)) ? ' • BYO API key set' : '';
      vscode.window.showInformationMessage(`AutoClaw: ${describe(ent)}${byo}`);
    }),

    vscode.commands.registerCommand('autoclaw.license.clear', async () => {
      await context.secrets.delete(LICENSE_SECRET);
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
      if (key === undefined) return;
      if (!key.trim()) {
        await context.secrets.delete(BYO_KEY_SECRET);
        vscode.window.showInformationMessage('BYO API key cleared.');
        return;
      }
      await context.secrets.store(BYO_KEY_SECRET, key.trim());
      vscode.window.showInformationMessage('BYO API key saved. Hosted features unlocked using your key.');
    }),
  );
}
