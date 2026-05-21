/**
 * scripts/types.ts — Contract for per-IDE computer-use submission scripts.
 *
 * Each IDE that lacks a headless re-kick path ships a small script under
 * `src/keepalive/scripts/` (e.g. `kilocode-chat-submit.ts`). A script knows the
 * window title pattern and the chat-box / submit selectors for one IDE; the
 * generic {@link computerUseStrategy} resolves a script by id (the
 * `playwright_script` field on `scope.json`) and runs it through the injected
 * {@link BrowserDriver}.
 *
 * Scripts contain ZERO Playwright imports themselves — they only describe the
 * steps. The driver (the lazy Playwright wrapper) performs them. This keeps the
 * whole subsystem loadable and type-checkable without `@playwright/test`
 * installed.
 */

/** A keyboard/UI step a script asks the driver to perform. */
export interface ComputerUseStep {
  /** The kind of step. */
  kind: 'focus' | 'click' | 'type' | 'press' | 'wait';
  /**
   * For `click`/`type` — a selector or accessibility locator for the target.
   * For `focus` — a window-title substring to bring forward.
   * For `press` — the key chord, e.g. `"Enter"` or `"Control+Enter"`.
   * For `type`  — the literal text to type.
   * For `wait`  — milliseconds, as a string.
   */
  target: string;
  /** Optional human-readable note recorded in the audit log. */
  note?: string;
}

/**
 * A per-IDE computer-use script: an ordered list of steps plus the IDE window
 * title pattern used to locate and focus the editor window.
 */
export interface IdeComputerUseScript {
  /** Script id — matches the `playwright_script` field on `scope.json`. */
  id: string;
  /** Human-readable IDE label. */
  ideLabel: string;
  /** Substring matched against OS window titles to find the IDE window. */
  windowTitleMatch: string;
  /**
   * Build the ordered steps for a wake submission. `prompt` is the text to
   * place in the chat box before submitting.
   */
  buildSteps(prompt: string): ComputerUseStep[];
}
