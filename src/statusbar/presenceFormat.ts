/**
 * presenceFormat.ts — Pure formatters for the AutoClaw status-bar presence.
 *
 * Split out of `statusBar.ts` so these can be unit-tested in plain Node:
 * `statusBar.ts` imports `vscode`, this file does not.
 *
 * The `PresenceSummary.text` field is already formatted by `buildPresence`
 * (src/views/fleetViewModelBuilders.ts); these helpers add the status-bar
 * glyph, the multi-line tooltip, and the attention-colour theme key.
 *
 * Sprint 4 — C5_statusbar (C.11).
 */

import type { PresenceSummary } from '../views/fleetViewModel';

/**
 * Render the status-bar label for a presence summary.
 *
 * Prepends the AutoClaw glyph and falls back to a neutral idle string when
 * there are no tracked agents.
 */
export function formatPresenceText(p: PresenceSummary): string {
  if (p.total === 0) {
    return '$(rocket) AutoClaw: idle';
  }
  return `$(rocket) ${p.text}`;
}

/** Render a multi-line tooltip describing the fleet presence breakdown. */
export function presenceTooltip(p: PresenceSummary): string {
  const lines = [
    'AutoClaw Fleet',
    `  ${p.working} working`,
    `  ${p.needsReview} need review`,
    `  ${p.down} down`,
    `  ${p.total} agent${p.total === 1 ? '' : 's'} total`,
    '',
    'Click to open the Fleet panel.',
  ];
  return lines.join('\n');
}

/**
 * Choose a status-bar background-colour theme key for the presence state.
 * Returns `undefined` for the normal (no-attention) case.
 */
export function presenceColorKey(p: PresenceSummary): string | undefined {
  if (p.down > 0) {
    return 'statusBarItem.errorBackground';
  }
  if (p.needsReview > 0) {
    return 'statusBarItem.warningBackground';
  }
  return undefined;
}
