// ZIPPY OPEN MATERIAL
//
// Support / donation / review configuration.
//
// These are MAINTAINER / PRODUCT values, not end-user settings — an end user has
// no reason to set their own donation URL, wallet, or contact email. They are
// therefore NOT contributed to the VS Code Settings UI. Configure them by editing
// the DEFAULTS below before publishing (the primary path).
//
// All payment endpoints are PLACEHOLDERS by design — there is nothing here that
// costs Zippy Technologies anything.
//
// A hidden, advanced override still works: these keys are read from settings.json
// even though they are not shown in the Settings UI, so a deployment can set e.g.
// `autoclaw.support.donationUrl` by hand. Settings always win over the DEFAULTS.

import * as vscode from 'vscode';

/** A placeholder is any unset value or one still containing REPLACE_ME. */
export const PLACEHOLDER = 'REPLACE_ME';

export interface SupportLinks {
  /** Square one-time "$10 thank you" payment link. */
  donationUrl: string;
  /** Square custom-amount payment link. */
  customAmountUrl: string;
  /** Square subscription / commercial-license checkout link. */
  proUrl: string;
  /** Ko-fi page for one-time tips and memberships. */
  koFiUrl: string;
  /** Marketplace review deep-links. */
  reviewVscode: string;
  reviewOpenVsx: string;
  /** Where unhappy users go (private feedback, not the public review page). */
  feedbackUrl: string;
  /** Symbol -> wallet address. */
  cryptoWallets: Record<string, string>;
  /** Commercial-license / enterprise contact. */
  contactEmail: string;
}

const EXT_ID = 'ZippyTechnologiesLLC.autoclaw';

const DEFAULTS: SupportLinks = {
  // TODO(maintainer): paste your real Square links here or via settings.
  donationUrl: `https://square.link/u/${PLACEHOLDER}`,
  customAmountUrl: `https://square.link/u/${PLACEHOLDER}`,
  proUrl: `https://square.link/u/${PLACEHOLDER}`,
  koFiUrl: 'https://ko-fi.com/gozippy',
  reviewVscode: `https://marketplace.visualstudio.com/items?itemName=${EXT_ID}&ssr=false#review-details`,
  reviewOpenVsx: `https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw/reviews`,
  feedbackUrl: 'https://github.com/GoZippy/autoclaw/issues/new',
  cryptoWallets: {
    BTC: PLACEHOLDER,
    ETH: PLACEHOLDER,
    SOL: PLACEHOLDER,
    USDC: PLACEHOLDER,
  },
  contactEmail: 'Support@GoZippy.com',
};

/** True when a link/address is unset or still a REPLACE_ME placeholder. */
export function isPlaceholder(value: string | undefined | null): boolean {
  return !value || value.includes(PLACEHOLDER);
}

/** Merge VS Code settings over the file defaults. Settings always win. */
export function getSupportLinks(): SupportLinks {
  const cfg = vscode.workspace.getConfiguration('autoclaw.support');
  const pick = (key: string, fallback: string): string => {
    const v = cfg.get<string>(key);
    return v && v.trim() ? v.trim() : fallback;
  };
  const wallets = cfg.get<Record<string, string>>('cryptoWallets');
  return {
    donationUrl: pick('donationUrl', DEFAULTS.donationUrl),
    customAmountUrl: pick('customAmountUrl', DEFAULTS.customAmountUrl),
    proUrl: pick('proUrl', DEFAULTS.proUrl),
    koFiUrl: pick('koFiUrl', DEFAULTS.koFiUrl),
    reviewVscode: pick('reviewVscodeUrl', DEFAULTS.reviewVscode),
    reviewOpenVsx: pick('reviewOpenVsxUrl', DEFAULTS.reviewOpenVsx),
    feedbackUrl: pick('feedbackUrl', DEFAULTS.feedbackUrl),
    cryptoWallets:
      wallets && Object.keys(wallets).length ? wallets : DEFAULTS.cryptoWallets,
    contactEmail: pick('contactEmail', DEFAULTS.contactEmail),
  };
}

/** Are the timed support prompts enabled? Defaults to true. */
export function promptsEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('autoclaw.support')
    .get<boolean>('prompts', true);
}

export type Marketplace = 'vscode' | 'openvsx';

/**
 * Best-effort guess of which registry the user installed from. VS Code does not
 * expose this, so we infer from the host: forks (Cursor, Windsurf, VSCodium,
 * Code - OSS, and most non-Microsoft builds) pull from Open VSX; stock VS Code
 * uses the Microsoft Marketplace. When unsure we return 'vscode' and the panel
 * shows both links anyway.
 */
export function detectMarketplace(appName: string): Marketplace {
  const name = (appName || '').toLowerCase();
  const openVsxHosts = ['cursor', 'windsurf', 'vscodium', 'code - oss', 'codium', 'trae', 'kiro'];
  if (openVsxHosts.some((h) => name.includes(h))) return 'openvsx';
  return 'vscode';
}

/** The review URL for the inferred marketplace. */
export function reviewUrlFor(links: SupportLinks, market: Marketplace): string {
  return market === 'openvsx' ? links.reviewOpenVsx : links.reviewVscode;
}
