/**
 * scripts/cursor-chat-submit.ts — Computer-use script for Cursor.
 *
 * Cursor's agent chat is driven by submitting into the AI pane. When no
 * headless re-kick path is configured, the `computer_use` strategy focuses the
 * Cursor window, clicks the chat input, types the wake prompt, and submits
 * with the Cursor-default Cmd/Ctrl+Enter chord.
 *
 * Declares ONLY the step list — no Playwright import. See `scripts/types.ts`.
 */

import type { IdeComputerUseScript } from './types';

/** The Cursor computer-use submission script. */
export const cursorChatSubmit: IdeComputerUseScript = {
  id: 'cursor-chat-submit',
  ideLabel: 'Cursor',
  windowTitleMatch: 'Cursor',
  buildSteps(prompt: string) {
    return [
      { kind: 'focus', target: 'Cursor', note: 'bring the Cursor window forward' },
      { kind: 'wait', target: '400', note: 'let the window settle after focus' },
      {
        kind: 'click',
        target: 'div[contenteditable="true"], textarea[placeholder*="Plan" i]',
        note: 'click into the Cursor chat input',
      },
      { kind: 'type', target: prompt, note: 'type the wake prompt' },
      { kind: 'wait', target: '150', note: 'debounce before submit' },
      { kind: 'press', target: 'Control+Enter', note: 'submit the Cursor chat message' },
    ];
  },
};

export default cursorChatSubmit;
