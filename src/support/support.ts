// ZIPPY OPEN MATERIAL
//
// Non-invasive "support the project" prompts: rate / donate / commercial-license
// awareness. Fires on a usage-day schedule (day 15, 30, 90, then every +90),
// at most one prompt per crossed milestone, with permanent opt-out. The
// scheduling logic is pure and unit-tested in src/test/support.test.ts; the
// VS Code glue lives at the bottom.

import * as vscode from 'vscode';
import {
  getSupportLinks,
  promptsEnabled,
  isPlaceholder,
  detectMarketplace,
  reviewUrlFor,
} from './supportConfig';
import {
  SupportState,
  defaultState,
  epochDay,
  recordActiveDay,
  dueMilestone,
  askKindFor,
} from './schedule';

// Re-export the pure scheduling API so existing importers keep working.
export * from './schedule';

// ---------------------------------------------------------------------------
// VS Code glue
// ---------------------------------------------------------------------------

const STATE_KEY = 'autoclaw.support.state.v1';

export function loadState(context: vscode.ExtensionContext): SupportState {
  const saved = context.globalState.get<Partial<SupportState>>(STATE_KEY);
  return { ...defaultState(), ...(saved || {}) };
}

export async function saveState(
  context: vscode.ExtensionContext,
  state: SupportState,
): Promise<void> {
  await context.globalState.update(STATE_KEY, state);
}

async function openExternal(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Count today's activity. Call once per activation. */
export async function tickActivity(
  context: vscode.ExtensionContext,
): Promise<SupportState> {
  const today = epochDay(Date.now());
  const next = recordActiveDay(loadState(context), today);
  await saveState(context, next);
  return next;
}

/**
 * Show one milestone prompt if due. Marks the milestone as prompted regardless
 * of the user's choice so it never re-fires for the same milestone.
 */
export async function maybePrompt(context: vscode.ExtensionContext): Promise<void> {
  if (!promptsEnabled()) return;
  let state = loadState(context);
  const milestone = dueMilestone(state);
  if (milestone === null) return;

  const kind = askKindFor(milestone, state);
  const links = getSupportLinks();

  // Record that we prompted for this milestone up front, so a reload mid-prompt
  // doesn't double-fire.
  state = {
    ...state,
    lastPromptAtActiveDay: milestone,
    promptsShown: state.promptsShown + 1,
  };
  await saveState(context, state);

  const DISMISS = "Don't ask again";
  const LATER = 'Maybe later';

  if (kind === 'rate') {
    const market = detectMarketplace(vscode.env.appName || '');
    const choice = await vscode.window.showInformationMessage(
      'Enjoying AutoClaw? How is it working out for you?',
      '😀 Great',
      '😕 Not great',
      LATER,
      DISMISS,
    );
    if (choice === '😀 Great') {
      await openExternal(reviewUrlFor(links, market));
      state = { ...state, reviewed: true, rating: 5 };
    } else if (choice === '😕 Not great') {
      await openExternal(links.feedbackUrl);
      state = { ...state, rating: 2 };
    } else if (choice === DISMISS) {
      state = { ...state, dismissedForever: true };
    }
  } else if (kind === 'donate') {
    const choice = await vscode.window.showInformationMessage(
      'AutoClaw is free for personal use and runs on donations. Mind chipping in to support development?',
      'Donate',
      'Other ways',
      LATER,
      DISMISS,
    );
    if (choice === 'Donate') {
      // Prefer the Square link when set; otherwise fall back to Ko-fi, then the panel.
      const donateUrl = !isPlaceholder(links.donationUrl)
        ? links.donationUrl
        : links.koFiUrl;
      if (isPlaceholder(donateUrl)) {
        await vscode.commands.executeCommand('autoclaw.support.open');
      } else {
        await openExternal(donateUrl);
      }
      state = { ...state, donated: true };
    } else if (choice === 'Other ways') {
      await vscode.commands.executeCommand('autoclaw.support.open');
    } else if (choice === DISMISS) {
      state = { ...state, dismissedForever: true };
    }
  } else {
    // pro / commercial-license awareness — never gates features.
    const choice = await vscode.window.showInformationMessage(
      'Using AutoClaw at work? A commercial license keeps you compliant and funds development. Personal use stays free.',
      'See plans',
      LATER,
      DISMISS,
    );
    if (choice === 'See plans') {
      await vscode.commands.executeCommand('autoclaw.support.open');
    } else if (choice === DISMISS) {
      state = { ...state, dismissedForever: true };
    }
  }

  await saveState(context, state);
}

/**
 * Register support commands and run the once-per-activation activity tick +
 * (deferred) milestone prompt. Safe to call once from activate().
 */
export function registerSupport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('autoclaw.support.open', async () => {
      const { showSupportPanel } = await import('./supportPanel');
      showSupportPanel(context);
    }),
    vscode.commands.registerCommand('autoclaw.support.rate', async () => {
      const { showSupportPanel } = await import('./supportPanel');
      showSupportPanel(context);
    }),
  );

  // Count activity now; defer the prompt a bit so it never competes with the
  // first-run welcome or startup noise.
  void tickActivity(context).then(() => {
    setTimeout(() => {
      void maybePrompt(context);
    }, 60_000);
  });
}
