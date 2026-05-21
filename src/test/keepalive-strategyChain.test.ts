/**
 * keepalive-strategyChain.test.ts — Unit tests for the keep-alive strategy
 * chain (Sprint 4 / WA-3 I1).
 *
 * Covers:
 *  1. Chain tries strategies in declared order, stops at first success.
 *  2. `skipped` does not stop the chain; `failed` does not stop the chain.
 *  3. `cli` strategy skips with no command, runs the configured command.
 *  4. `toast` strategy always succeeds + writes an Awaiting You entry.
 *  5. `loadKeepaliveConfig` degrades gracefully on a missing scope.json.
 *  6. Default chain order is used when the agent declares none.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  StrategyChain,
  loadKeepaliveConfig,
  cliStrategy,
  toastStrategy,
} from '../keepalive/strategyChain';
import { DEFAULT_KEEPALIVE_CHAIN } from '../keepalive/types';
import type { KeepaliveConfig, KeepaliveStrategy, StrategyResult } from '../keepalive/types';
import type { AgentHealth } from '../lmd/types';

const silentLogger = { warn: () => {}, error: () => {}, info: () => {}, log: () => {} };

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-keepalive-'));
}

/** A fake strategy returning a fixed outcome, recording whether it ran. */
function fakeStrategy(
  name: KeepaliveStrategy['name'],
  outcome: StrategyResult['outcome'],
  ran: { value: boolean },
): KeepaliveStrategy {
  return {
    name,
    async attempt(): Promise<StrategyResult> {
      ran.value = true;
      return { strategy: name, outcome, detail: `fake ${name}`, at: new Date().toISOString() };
    },
  };
}

const stalledHealth: AgentHealth = {
  agentId: 'a1', state: 'stalled', lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 5,
};

suite('keepalive: StrategyChain (I1)', () => {
  test('tries strategies in order and stops at the first success', async () => {
    const ran = { runner: { value: false }, cli: { value: false }, toast: { value: false } };
    const chain = new StrategyChain({
      workspaceRoot: tmpWorkspace(),
      logger: silentLogger,
      strategies: {
        runner: fakeStrategy('runner', 'failed', ran.runner),
        cli: fakeStrategy('cli', 'success', ran.cli),
        toast: fakeStrategy('toast', 'success', ran.toast),
      },
    });
    const config: KeepaliveConfig = { agentId: 'a1', strategy: ['runner', 'cli', 'toast'] };
    const result = await chain.run(config, stalledHealth);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.succeededWith, 'cli');
    assert.strictEqual(ran.runner.value, true, 'runner should have run');
    assert.strictEqual(ran.cli.value, true, 'cli should have run');
    assert.strictEqual(ran.toast.value, false, 'toast should NOT run after cli succeeds');
    assert.strictEqual(result.attempts.length, 2);
  });

  test('treats "skipped" as non-terminal and continues the chain', async () => {
    const ran = { runner: { value: false }, toast: { value: false } };
    const chain = new StrategyChain({
      workspaceRoot: tmpWorkspace(),
      logger: silentLogger,
      strategies: {
        runner: fakeStrategy('runner', 'skipped', ran.runner),
        toast: fakeStrategy('toast', 'success', ran.toast),
      },
    });
    const result = await chain.run({ agentId: 'a1', strategy: ['runner', 'toast'] }, stalledHealth);
    assert.strictEqual(result.succeededWith, 'toast');
    assert.strictEqual(ran.toast.value, true);
  });

  test('reports ok=false when every strategy fails or skips', async () => {
    const chain = new StrategyChain({
      workspaceRoot: tmpWorkspace(),
      logger: silentLogger,
      strategies: {
        runner: fakeStrategy('runner', 'failed', { value: false }),
        cli: fakeStrategy('cli', 'skipped', { value: false }),
      },
    });
    const result = await chain.run({ agentId: 'a1', strategy: ['runner', 'cli'] }, stalledHealth);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.succeededWith, null);
  });

  test('uses the default chain order when the agent declares none', async () => {
    const order: string[] = [];
    const mk = (name: KeepaliveStrategy['name']): KeepaliveStrategy => ({
      name,
      async attempt() {
        order.push(name);
        return { strategy: name, outcome: 'skipped' as const, detail: '', at: new Date().toISOString() };
      },
    });
    const chain = new StrategyChain({
      workspaceRoot: tmpWorkspace(),
      logger: silentLogger,
      strategies: { runner: mk('runner'), cli: mk('cli'), computer_use: mk('computer_use'), toast: mk('toast') },
    });
    await chain.run({ agentId: 'a1' }, stalledHealth);
    assert.deepStrictEqual(order, [...DEFAULT_KEEPALIVE_CHAIN]);
  });
});

suite('keepalive: cli strategy (I1)', () => {
  test('skips when no keepalive_cli_command is configured', async () => {
    const ws = tmpWorkspace();
    const strat = cliStrategy();
    const result = await strat.attempt({
      agentId: 'a1', config: { agentId: 'a1' }, workspaceRoot: ws,
      prompt: 'wake', logger: silentLogger,
    });
    assert.strictEqual(result.outcome, 'skipped');
  });

  test('runs the configured command and reports success', async () => {
    const ws = tmpWorkspace();
    let received = '';
    const strat = cliStrategy({
      exec: async (cmd) => { received = cmd; return { ok: true, detail: 'ran' }; },
    });
    const result = await strat.attempt({
      agentId: 'a1', config: { agentId: 'a1', cliCommand: 'echo wake-a1' },
      workspaceRoot: ws, prompt: 'wake', logger: silentLogger,
    });
    assert.strictEqual(result.outcome, 'success');
    assert.strictEqual(received, 'echo wake-a1');
  });

  test('reports failed when the command exits non-zero', async () => {
    const strat = cliStrategy({ exec: async () => ({ ok: false, detail: 'boom' }) });
    const result = await strat.attempt({
      agentId: 'a1', config: { agentId: 'a1', cliCommand: 'false' },
      workspaceRoot: tmpWorkspace(), prompt: 'wake', logger: silentLogger,
    });
    assert.strictEqual(result.outcome, 'failed');
  });
});

suite('keepalive: toast strategy (I1)', () => {
  test('always succeeds and writes an Awaiting You entry', async () => {
    const ws = tmpWorkspace();
    let warned = '';
    const strat = toastStrategy({
      bridge: { showWarningMessage: (m) => { warned = m; } },
      platform: 'win32',
    });
    const result = await strat.attempt({
      agentId: 'a1', config: { agentId: 'a1', ideLabel: 'Kilo Code' },
      workspaceRoot: ws, prompt: 'wake', logger: silentLogger,
    });
    assert.strictEqual(result.outcome, 'success');
    assert.ok(warned.includes('a1'), 'VS Code bridge should be notified');

    const awaitingFile = path.join(ws, '.autoclaw', 'runtime', 'awaiting-you.jsonl');
    assert.ok(fs.existsSync(awaitingFile), 'awaiting-you.jsonl should be written');
    const entry = JSON.parse(fs.readFileSync(awaitingFile, 'utf8').trim());
    assert.strictEqual(entry.agentId, 'a1');
    assert.strictEqual(entry.ide, 'Kilo Code');
  });
});

suite('keepalive: loadKeepaliveConfig (I1)', () => {
  test('returns a default config when scope.json is absent', () => {
    const config = loadKeepaliveConfig(tmpWorkspace(), 'ghost');
    assert.strictEqual(config.agentId, 'ghost');
    assert.strictEqual(config.strategy, undefined);
    assert.strictEqual(config.cliCommand, undefined);
  });

  test('reads keepalive fields from scope.json when present', () => {
    const ws = tmpWorkspace();
    const dir = path.join(ws, '.autoclaw', 'orchestrator', 'agents', 'kilocode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify({
      trust: 'auto',
      keepalive_strategy: ['cli', 'toast'],
      keepalive_cli_command: 'wake.sh',
      playwright_script: 'kilocode-chat-submit',
      ide_label: 'Kilo Code',
    }));
    const config = loadKeepaliveConfig(ws, 'kilocode');
    assert.deepStrictEqual(config.strategy, ['cli', 'toast']);
    assert.strictEqual(config.cliCommand, 'wake.sh');
    assert.strictEqual(config.playwrightScript, 'kilocode-chat-submit');
    assert.strictEqual(config.ideLabel, 'Kilo Code');
  });
});
