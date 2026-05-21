/**
 * scripts/kilocode-chat-submit.ts — Computer-use script for Kilo Code.
 *
 * Kilo Code runs inside a VS Code host and (in some configurations) has no
 * headless re-kick path, so the `computer_use` strategy drives its chat box
 * directly: focus the editor window, click into the Kilo Code chat input,
 * type the wake prompt, and submit.
 *
 * This file declares ONLY the step list — no Playwright import. The injected
 * {@link BrowserDriver} performs the steps. See `scripts/types.ts`.
 */

import type { IdeComputerUseScript } from './types';

/** The Kilo Code computer-use submission script. */
export const kilocodeChatSubmit: IdeComputerUseScript = {
  id: 'kilocode-chat-submit',
  ideLabel: 'Kilo Code (VS Code)',
  // VS Code window titles end with " - Visual Studio Code"; Kilo Code does not
  // change the host title, so match the host. The driver picks the most
  // recently focused match when several VS Code windows are open.
  windowTitleMatch: 'Visual Studio Code',
  buildSteps(prompt: string) {
    return [
      { kind: 'focus', target: 'Visual Studio Code', note: 'bring the IDE window forward' },
      { kind: 'wait', target: '400', note: 'let the window settle after focus' },
      {
        // Kilo Code chat textarea — matched by its placeholder/aria role so the
        // selector survives minor DOM changes.
        kind: 'click',
        target: 'textarea[aria-label*="Kilo" i], textarea[placeholder*="Type" i]',
        note: 'click into the Kilo Code chat input',
      },
      { kind: 'type', target: prompt, note: 'type the wake prompt' },
      { kind: 'wait', target: '150', note: 'debounce before submit' },
      { kind: 'press', target: 'Enter', note: 'submit the chat message' },
    ];
  },
};

export default kilocodeChatSubmit;
