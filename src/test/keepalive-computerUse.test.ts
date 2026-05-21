/**
 * keepalive-computerUse.test.ts — Unit tests for the `computer_use` keep-alive
 * strategy and its mandatory safety gates (Sprint 4 / WA-3 I2).
 *
 * Covers:
 *  1. SAFETY GATE 1 — strategy is skipped when the agent is NOT stalled.
 *  2. SAFETY GATE 2 — strategy is skipped when the human is NOT idle.
 *  3. Fail-safe — when idle time is undeterminable, the gate blocks.
 *  4. With both gates passed and a driver available, the IDE script runs and
 *     every action + before/after screenshot is written to the audit log.
 *  5. The strategy degrades to `skipped` when the Playwright driver is
 *     unavailable (package not installed).
 *  6. Per-IDE script registry resolves known scripts.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computerUseStrategy } from '../keepalive/computerUse';
import type { BrowserDriver } from '../keepalive/computerUse';
import { resolveScript } from '../keepalive/scripts';
import type { StrategyContext } from '../keepalive/types';
import type { AgentHealth } from '../lmd/types';

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cu-'));
}

function health(state: AgentHealth['state']): AgentHealth {
  return { agentId: 'kilocode', state, lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 5 };
}

function ctx(ws: string, h: AgentHealth): StrategyContext {
  return {
    agentId: 'kilocode',
    config: { agentId: 'kilocode', playwrightScript: 'kilocode-chat-submit', ideLabel: 'Kilo Code' },
    health: h,
    workspaceRoot: ws,
    prompt: 'wake up',
    logger: silentLogger,
  };
}

/** A fake BrowserDriver that records every call. */
function fakeDriver(available: boolean): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: () => available,
    async focusWindow(t) { calls.push(`focus:${t}`); return true; },
    async click(s) { calls.push(`click:${s}`); return true; },
    async type(t) { calls.push(`type:${t}`); return true; },
    async press(c) { calls.push(`press:${c}`); return true; },
    async screenshot(f) { calls.push(`shot:${path.basename(f)}`); fs.writeFileSync(f, 'PNG'); return true; },
    async dispose() { calls.push('dispose'); },
  };
}

const idleStub = (idleMs: number | null) =>
  async () => ({ idleMs, isIdle: idleMs !== null && idleMs >= 180000 });

suite('keepalive: computer_use SAFETY GATES (I2)', () => {
  test('GATE 1 — skips when the agent is NOT stalled (degraded)', async () => {
    const strat = computerUseStrategy({
      driverFactory: () => fakeDriver(true),
      idleProbe: idleStub(999999),
    });
    const result = await strat.attempt(ctx(tmpWorkspace(), health('degraded')));
    assert.strictEqual(result.outcome, 'skipped');
    assert.ok(/not "stalled"/.test(result.detail), `gate-1 reason expected, got: ${result.detail}`);
  });

  test('GATE 2 — skips when the human is NOT idle', async () => {
    const ws = tmpWorkspace();
    const driver = fakeDriver(true);
    const strat = computerUseStrategy({
      driverFactory: () => driver,
      idleProbe: idleStub(5000), // 5s — human active
    });
    const result = await strat.attempt(ctx(ws, health('stalled')));
    assert.strictEqual(result.outcome, 'skipped');
    assert.ok(/human active/.test(result.detail), `gate-2 reason expected, got: ${result.detail}`);
    assert.strictEqual(driver.calls.length, 0, 'driver MUST NOT be touched when gate 2 blocks');
  });

  test('GATE 2 fail-safe — undeterminable idle time blocks the action', async () => {
    const driver = fakeDriver(true);
    const strat = computerUseStrategy({
      driverFactory: () => driver,
      idleProbe: idleStub(null), // unknown
    });
    const result = await strat.attempt(ctx(tmpWorkspace(), health('stalled')));
    assert.strictEqual(result.outcome, 'skipped');
    assert.ok(/could not be determined/.test(result.detail));
    assert.strictEqual(driver.calls.length, 0);
  });
});

suite('keepalive: computer_use happy path + audit log (I2)', () => {
  test('runs the IDE script and logs every action + before/after screenshots', async () => {
    const ws = tmpWorkspace();
    const driver = fakeDriver(true);
    const strat = computerUseStrategy({
      driverFactory: () => driver,
      idleProbe: idleStub(999999), // long-idle human
    });
    const result = await strat.attempt(ctx(ws, health('stalled')));
    assert.strictEqual(result.outcome, 'success', result.detail);

    // Driver was actually driven: focus + click + type + press all happened.
    assert.ok(driver.calls.some((c) => c.startsWith('focus:')));
    assert.ok(driver.calls.some((c) => c.startsWith('click:')));
    assert.ok(driver.calls.some((c) => c.startsWith('type:')));
    assert.ok(driver.calls.some((c) => c.startsWith('press:')));

    // Audit log exists and records actions.
    const logFile = path.join(ws, '.autoclaw', 'runtime', 'computer-use-log', 'actions.jsonl');
    assert.ok(fs.existsSync(logFile), 'computer-use-log/actions.jsonl must exist');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.action === 'gate_check'), 'gate check must be logged');
    assert.ok(lines.some((e) => e.action === 'screenshot' && e.screenshot), 'screenshots must be logged');
    assert.ok(lines.some((e) => e.action === 'press'), 'submit action must be logged');

    // before + after screenshot PNGs written.
    const shots = fs.readdirSync(path.join(ws, '.autoclaw', 'runtime', 'computer-use-log'))
      .filter((f) => f.endsWith('.png'));
    assert.ok(shots.some((f) => f.includes('-before')), 'before screenshot must exist');
    assert.ok(shots.some((f) => f.includes('-after')), 'after screenshot must exist');
  });

  test('degrades to skipped when the Playwright driver is unavailable', async () => {
    const strat = computerUseStrategy({
      driverFactory: () => fakeDriver(false), // package not installed
      idleProbe: idleStub(999999),
    });
    const result = await strat.attempt(ctx(tmpWorkspace(), health('stalled')));
    assert.strictEqual(result.outcome, 'skipped');
    assert.ok(/unavailable/.test(result.detail));
  });

  test('skips when no playwright_script is configured', async () => {
    const ws = tmpWorkspace();
    const strat = computerUseStrategy({
      driverFactory: () => fakeDriver(true),
      idleProbe: idleStub(999999),
    });
    const noScriptCtx: StrategyContext = {
      ...ctx(ws, health('stalled')),
      config: { agentId: 'kilocode' },
    };
    const result = await strat.attempt(noScriptCtx);
    assert.strictEqual(result.outcome, 'skipped');
    assert.ok(/no playwright_script/.test(result.detail));
  });
});

suite('keepalive: per-IDE script registry (I2)', () => {
  test('resolves the kilocode and cursor scripts by id', () => {
    const kilo = resolveScript('kilocode-chat-submit');
    assert.ok(kilo, 'kilocode script must resolve');
    assert.strictEqual(kilo!.id, 'kilocode-chat-submit');
    const steps = kilo!.buildSteps('hello');
    assert.ok(steps.some((s) => s.kind === 'type' && s.target === 'hello'));
    assert.ok(steps.some((s) => s.kind === 'press'));

    assert.ok(resolveScript('cursor-chat-submit'), 'cursor script must resolve');
  });

  test('returns null for an unknown script id', () => {
    assert.strictEqual(resolveScript('does-not-exist'), null);
    assert.strictEqual(resolveScript(undefined), null);
  });
});
