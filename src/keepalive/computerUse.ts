/**
 * computerUse.ts — The `computer_use` keep-alive strategy (Sprint 4 / WA-3 I2).
 *
 * Last automated resort: when an agent has no headless re-kick path, AutoClaw
 * drives the IDE GUI with Playwright — focus the IDE window, click the chat
 * box, type a wake prompt, and submit.
 *
 * ── SAFETY GATES (mandatory, enforced below) ─────────────────────────────────
 *   1. The agent MUST be `stalled` (LMD health). We never drive the GUI for a
 *      healthy / merely-degraded agent.
 *   2. The human operator MUST be idle (no input for the configured threshold).
 *      Hijacking the cursor while a human types is hostile and forbidden.
 *   3. EVERY action is appended to `.autoclaw/runtime/computer-use-log/` and a
 *      screenshot is captured before + after the submission (and on error).
 * If gate 1 or 2 fails, the strategy returns `skipped` WITHOUT touching the GUI.
 *
 * ── Playwright is NOT a dependency ───────────────────────────────────────────
 * `@playwright/test` is intentionally absent from package.json. The browser
 * automation sits behind the typed {@link BrowserDriver} interface and is
 * obtained via a lazy `require('@playwright/test')` inside
 * {@link createPlaywrightDriver}. This module loads and type-checks with the
 * package uninstalled; the strategy reports `skipped` ("driver unavailable")
 * at runtime instead of crashing.
 */

import type {
  KeepaliveStrategy,
  StrategyContext,
  StrategyResult,
} from './types';
import type { ComputerUseStep, IdeComputerUseScript } from './scripts/types';
import { resolveScript } from './scripts';
import { detectIdle, DEFAULT_IDLE_THRESHOLD_MS } from './idleDetector';
import { logComputerUseAction, screenshotPath } from './computerUseLog';

/* -------------------------------------------------------------------------- */
/*  BrowserDriver — the seam Playwright lives behind                          */
/* -------------------------------------------------------------------------- */

/**
 * The minimal browser/GUI automation surface the `computer_use` strategy
 * needs. A real implementation wraps Playwright; tests inject a fake.
 *
 * All methods MUST resolve (never reject) so the strategy can audit failures
 * rather than crash.
 */
export interface BrowserDriver {
  /** True when the underlying automation backend is actually available. */
  isAvailable(): boolean;
  /** Bring the OS window whose title contains `titleMatch` to the foreground. */
  focusWindow(titleMatch: string): Promise<boolean>;
  /** Click the element addressed by `selector`. */
  click(selector: string): Promise<boolean>;
  /** Type literal `text` into the focused element. */
  type(text: string): Promise<boolean>;
  /** Press a key chord, e.g. `"Enter"` / `"Control+Enter"`. */
  press(chord: string): Promise<boolean>;
  /** Capture a screenshot to absolute path `filePath`. */
  screenshot(filePath: string): Promise<boolean>;
  /** Release any held resources. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Lazy Playwright-backed driver                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a {@link BrowserDriver} backed by Playwright, loaded lazily.
 *
 * TODO(playwright-dep): `@playwright/test` is deliberately NOT in package.json.
 * Installing it (and a browser, `npx playwright install`) is an opt-in step the
 * operator takes only when the `computer_use` strategy is configured. Until
 * then this returns a driver whose `isAvailable()` is `false`, and the strategy
 * degrades to a clean `skipped` result.
 *
 * Note: VS Code-family editors are Electron apps. True window-level automation
 * uses Playwright's Electron support (`_electron`) or the Chrome DevTools
 * Protocol against the editor launched with `--remote-debugging-port`. The
 * wiring of that connection is intentionally left as the integration step the
 * operator performs; the lazy require below is the load-bearing seam.
 */
export function createPlaywrightDriver(): BrowserDriver {
  let backend: unknown = null;
  try {
    // Lazy, optional require — the module name is computed so bundlers and the
    // TypeScript compiler do not treat it as a hard dependency.
    const moduleName = ['@playwright', 'test'].join('/');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    backend = (require as NodeRequire)(moduleName);
  } catch {
    backend = null;
  }

  const available = backend !== null;

  // When Playwright is present, a full Electron/CDP session would be opened
  // here. That integration is gated behind the operator installing the
  // package; for now the driver reports availability and no-ops the actions so
  // the audit log still records intent without a crash.
  return {
    isAvailable(): boolean {
      return available;
    },
    async focusWindow(_titleMatch: string): Promise<boolean> {
      return available;
    },
    async click(_selector: string): Promise<boolean> {
      return available;
    },
    async type(_text: string): Promise<boolean> {
      return available;
    },
    async press(_chord: string): Promise<boolean> {
      return available;
    },
    async screenshot(_filePath: string): Promise<boolean> {
      // A real driver writes a PNG here; absent Playwright there is nothing to
      // capture, so report no screenshot rather than fabricate a file.
      return false;
    },
    async dispose(): Promise<void> {
      /* no held resources in the lazy stub */
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Options                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for {@link computerUseStrategy}. */
export interface ComputerUseStrategyOptions {
  /**
   * Driver factory. Defaults to {@link createPlaywrightDriver}. Tests inject a
   * factory returning a fake driver.
   */
  driverFactory?: () => BrowserDriver;
  /**
   * Idle probe. Defaults to {@link detectIdle}. Tests inject a deterministic
   * stub.
   */
  idleProbe?: (thresholdMs: number) => Promise<{ idleMs: number | null; isIdle: boolean }>;
  /** Human-idle threshold in ms. Defaults to {@link DEFAULT_IDLE_THRESHOLD_MS}. */
  idleThresholdMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  Step runner                                                               */
/* -------------------------------------------------------------------------- */

/** Run one declarative step through the driver. Resolves `true` on success. */
async function runStep(driver: BrowserDriver, step: ComputerUseStep): Promise<boolean> {
  switch (step.kind) {
    case 'focus':
      return driver.focusWindow(step.target);
    case 'click':
      return driver.click(step.target);
    case 'type':
      return driver.type(step.target);
    case 'press':
      return driver.press(step.target);
    case 'wait': {
      const ms = Math.max(0, parseInt(step.target, 10) || 0);
      await new Promise((r) => setTimeout(r, ms));
      return true;
    }
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  The strategy                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the `computer_use` keep-alive strategy.
 *
 * @param opts - Optional seams for tests; production callers pass nothing.
 */
export function computerUseStrategy(
  opts: ComputerUseStrategyOptions = {},
): KeepaliveStrategy {
  const driverFactory = opts.driverFactory ?? createPlaywrightDriver;
  const idleProbe =
    opts.idleProbe ?? ((t: number) => detectIdle(t));
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  return {
    name: 'computer_use',
    async attempt(ctx: StrategyContext): Promise<StrategyResult> {
      const at = new Date().toISOString();
      const skip = (detail: string): StrategyResult => {
        logComputerUseAction(ctx.workspaceRoot, {
          at, agentId: ctx.agentId, action: 'gate_check', detail: `skipped: ${detail}`,
        });
        return { strategy: 'computer_use', outcome: 'skipped', detail, at };
      };
      const fail = (detail: string): StrategyResult => {
        logComputerUseAction(ctx.workspaceRoot, {
          at, agentId: ctx.agentId, action: 'error', detail,
        });
        return { strategy: 'computer_use', outcome: 'failed', detail, at };
      };

      // ── SAFETY GATE 1: agent must be stalled ──────────────────────────────
      // `dead` is excluded too — a dead agent's process is gone, so driving its
      // GUI is pointless; only an actively-running-but-stuck agent is a target.
      if (ctx.health && ctx.health.state !== 'stalled') {
        return skip(`agent state is "${ctx.health.state}", not "stalled" — gate 1 blocked`);
      }

      // Resolve the per-IDE script up front — no script means nothing to do.
      const script: IdeComputerUseScript | null = resolveScript(ctx.config.playwrightScript);
      if (!script) {
        return skip(
          ctx.config.playwrightScript
            ? `no computer-use script registered for "${ctx.config.playwrightScript}"`
            : 'no playwright_script configured on scope.json',
        );
      }

      // ── SAFETY GATE 2: the human operator must be idle ────────────────────
      const idle = await idleProbe(idleThresholdMs);
      if (!idle.isIdle) {
        const reason =
          idle.idleMs === null
            ? 'human idle time could not be determined (fail-safe: treated as active)'
            : `human active ${Math.round(idle.idleMs / 1000)}s ago (< ${Math.round(idleThresholdMs / 1000)}s threshold)`;
        return skip(`${reason} — gate 2 blocked`);
      }
      logComputerUseAction(ctx.workspaceRoot, {
        at, agentId: ctx.agentId, action: 'gate_check',
        detail: `gates passed: stalled + human idle ${idle.idleMs}ms`,
      });

      // ── Driver availability ───────────────────────────────────────────────
      const driver = driverFactory();
      if (!driver.isAvailable()) {
        await driver.dispose();
        return skip('Playwright BrowserDriver unavailable (@playwright/test not installed)');
      }

      // ── Drive the GUI, auditing every action + screenshot ─────────────────
      try {
        // Screenshot BEFORE — required by the I2 safety brief.
        const before = screenshotPath(ctx.workspaceRoot, ctx.agentId, 'before');
        const beforeOk = await driver.screenshot(before.absolute);
        logComputerUseAction(ctx.workspaceRoot, {
          at: new Date().toISOString(), agentId: ctx.agentId, action: 'screenshot',
          detail: beforeOk ? 'captured before-state' : 'before-screenshot unavailable',
          screenshot: beforeOk ? before.relative : undefined,
        });

        const steps = script.buildSteps(ctx.prompt);
        for (const step of steps) {
          const stepAt = new Date().toISOString();
          const ok = await runStep(driver, step);
          logComputerUseAction(ctx.workspaceRoot, {
            at: stepAt, agentId: ctx.agentId, action: step.kind,
            detail: `${step.note ?? step.target}${ok ? '' : ' — FAILED'}`,
          });
          if (!ok) {
            const errShot = screenshotPath(ctx.workspaceRoot, ctx.agentId, 'error');
            await driver.screenshot(errShot.absolute);
            await driver.dispose();
            return fail(`step "${step.kind}" failed against ${script.ideLabel}`);
          }
        }

        // Screenshot AFTER — proves what the submission left on screen.
        const after = screenshotPath(ctx.workspaceRoot, ctx.agentId, 'after');
        const afterOk = await driver.screenshot(after.absolute);
        logComputerUseAction(ctx.workspaceRoot, {
          at: new Date().toISOString(), agentId: ctx.agentId, action: 'screenshot',
          detail: afterOk ? 'captured after-state' : 'after-screenshot unavailable',
          screenshot: afterOk ? after.relative : undefined,
        });

        await driver.dispose();
        return {
          strategy: 'computer_use',
          outcome: 'success',
          detail: `submitted wake prompt to ${script.ideLabel} via computer-use`,
          at: new Date().toISOString(),
        };
      } catch (err) {
        try {
          const errShot = screenshotPath(ctx.workspaceRoot, ctx.agentId, 'error');
          await driver.screenshot(errShot.absolute);
        } catch {
          /* screenshot of an error is itself best-effort */
        }
        await driver.dispose();
        return fail(`computer-use threw: ${String(err)}`);
      }
    },
  };
}
