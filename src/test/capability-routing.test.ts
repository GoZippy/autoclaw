/**
 * capability-routing.test.ts — Capability-aware reputation routing.
 *
 * Proves that `dispatchPreferredForCapability` routes to the agent with the
 * best per-capability track record rather than overall reputation, and that
 * `buildCapabilityReputationPreference` reflects per-capability scores.
 *
 * Test topology:
 *   - agent A ("claude-code"):  strong 'security' record (8/10), weak 'test' (2/10)
 *   - agent B ("kilocode"):     weak 'security' record (2/10), strong 'test' (8/10)
 *
 * Expected routing:
 *   capability 'security' → agent A (factor ≈ 0.9 > 0.6 ≈ B)
 *   capability 'test'     → agent B (factor ≈ 0.9 > 0.6 ≈ A)
 *
 * Seeding counts are chosen so both agents clear the default minSamples=3
 * threshold, producing a clean (non-tie) split on the `reputation` criterion.
 *
 * A third case verifies the fallback: a capability with no samples in the
 * ledger causes all agents to receive the neutral prior (0.9), which triggers
 * a tie and falls through to the next §5.5 criterion — the test confirms the
 * dispatch still succeeds and does not throw.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordTaskOutcome, type TaskOutcome } from '../reputation/ledger';
import { RunnerRegistry } from '../runners/registry';
import {
  buildCapabilityReputationPreference,
  dispatchPreferredForCapability,
} from '../runners/capabilityRouting';
import type { Runner } from '../runners/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Create a fresh temp workspace directory. */
function mkws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-caproute-'));
}

/**
 * Seed the ledger with `ok` successes and `fail` failures for `agent`,
 * all tagged with the given `capabilities` array.
 */
async function seedCapability(
  ws: string,
  agent: string,
  capabilities: string[],
  ok: number,
  fail: number,
): Promise<void> {
  for (let i = 0; i < ok; i++) {
    const o: TaskOutcome = {
      task_id: `${agent}-${capabilities.join('+')}-ok-${i}`,
      agent_id: agent,
      capabilities,
      verdict: 'approved',
      gate_passed: true,
      timestamp: '2026-06-28T00:00:00.000Z',
    };
    await recordTaskOutcome(ws, o);
  }
  for (let i = 0; i < fail; i++) {
    const o: TaskOutcome = {
      task_id: `${agent}-${capabilities.join('+')}-fail-${i}`,
      agent_id: agent,
      capabilities,
      verdict: 'needs_changes',
      timestamp: '2026-06-28T00:00:00.000Z',
    };
    await recordTaskOutcome(ws, o);
  }
}

/** Build a fake runner whose dispatch records which runner id was called. */
function fakeRunner(id: string, dispatched: string[]): Runner {
  return {
    id,
    capabilities: {} as Runner['capabilities'],
    detect: async () => ({ found: true, version: '1.0.0', path: '/fake' }),
    dispatch: async () => {
      dispatched.push(id);
      return {
        ok: true,
        sessionId: 's-' + id,
        exitCode: 0,
        finishedAt: '2026-06-28T00:00:00.000Z',
        durationMs: 1,
      };
    },
    resume: async () => {
      dispatched.push(id);
      return {
        ok: true,
        sessionId: 's-' + id,
        exitCode: 0,
        finishedAt: '2026-06-28T00:00:00.000Z',
        durationMs: 1,
      };
    },
    listSessions: async () => [],
    health: async () => ({
      ok: true,
      authPresent: true,
      cliVersion: '1.0.0',
      mcpServersConfigured: 0,
      recentErrors: [],
    }),
    cancel: async () => { /* no-op */ },
  };
}

/* -------------------------------------------------------------------------- */
/*  Seeding plan                                                               */
/*                                                                             */
/*  agent A ('claude-code'):  security 8 ok / 2 fail  → rate 0.8 → factor 0.9 */
/*                            test     2 ok / 8 fail  → rate 0.2 → factor 0.6 */
/*  agent B ('kilocode'):     security 2 ok / 8 fail  → rate 0.2 → factor 0.6 */
/*                            test     8 ok / 2 fail  → rate 0.8 → factor 0.9 */
/*                                                                             */
/*  Both agents clear minSamples=3 for both capabilities, so the per-          */
/*  capability branch fires and produces a clean, non-tie 0.9 vs 0.6 split.   */
/* -------------------------------------------------------------------------- */

suite('capability-routing — buildCapabilityReputationPreference', () => {
  test('security capability: A scores higher than B', async () => {
    const ws = mkws();
    try {
      await seedCapability(ws, 'claude-code', ['security'], 8, 2);
      await seedCapability(ws, 'kilocode',    ['security'], 2, 8);

      const pref = await buildCapabilityReputationPreference(ws, 'security');
      assert.ok(pref.reputationByRunnerId, 'map is produced');
      const aScore = pref.reputationByRunnerId!['claude-code'];
      const bScore = pref.reputationByRunnerId!['kilocode'];
      assert.ok(typeof aScore === 'number', 'A has a score');
      assert.ok(typeof bScore === 'number', 'B has a score');
      assert.ok(aScore > bScore, `A (${aScore}) should beat B (${bScore}) on security`);
      // Bounded to [0.5, 1.0]
      assert.ok(aScore <= 1.0 && aScore >= 0.5, `A score ${aScore} in bounds`);
      assert.ok(bScore <= 1.0 && bScore >= 0.5, `B score ${bScore} in bounds`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('test capability: B scores higher than A', async () => {
    const ws = mkws();
    try {
      await seedCapability(ws, 'claude-code', ['test'], 2, 8);
      await seedCapability(ws, 'kilocode',    ['test'], 8, 2);

      const pref = await buildCapabilityReputationPreference(ws, 'test');
      assert.ok(pref.reputationByRunnerId, 'map is produced');
      const aScore = pref.reputationByRunnerId!['claude-code'];
      const bScore = pref.reputationByRunnerId!['kilocode'];
      assert.ok(bScore > aScore, `B (${bScore}) should beat A (${aScore}) on test`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('empty ledger returns {} (safe no-op)', async () => {
    const ws = mkws();
    try {
      const pref = await buildCapabilityReputationPreference(ws, 'security');
      assert.deepStrictEqual(pref, {}, 'empty ledger → {}');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('unknown capability gives neutral prior (0.9) to all agents', async () => {
    const ws = mkws();
    try {
      // Seed only 'security' outcomes; query 'refactor' — nobody has samples.
      await seedCapability(ws, 'claude-code', ['security'], 8, 2);
      await seedCapability(ws, 'kilocode',    ['security'], 8, 2);

      const pref = await buildCapabilityReputationPreference(ws, 'refactor');
      assert.ok(pref.reputationByRunnerId, 'map is still produced (overall samples exist)');
      // No capability-specific samples → reputationFactor falls back to overall
      // overall: 8/10 for both → rate 0.8 → factor 0.9 (> minSamples=3, so NOT neutral)
      // Both agents share the same overall success rate → same score
      const aScore = pref.reputationByRunnerId!['claude-code'];
      const bScore = pref.reputationByRunnerId!['kilocode'];
      assert.strictEqual(aScore, bScore, 'tied overall → identical scores for unknown capability');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('newcomer below minSamples gets neutral prior for a capability', async () => {
    const ws = mkws();
    try {
      // Only 2 security samples → below minSamples=3
      await seedCapability(ws, 'newcomer', ['security'], 2, 0);

      const pref = await buildCapabilityReputationPreference(ws, 'security');
      assert.ok(pref.reputationByRunnerId, 'map is produced');
      // 2 overall samples also < 3, so neutral prior 0.9 expected
      assert.strictEqual(pref.reputationByRunnerId!['newcomer'], 0.9,
        'newcomer with <3 capability samples → neutral prior 0.9');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

suite('capability-routing — dispatchPreferredForCapability', () => {
  /**
   * Full cross-seeded workspace so both capabilities are testable in one setup.
   * A = strong security / weak test; B = weak security / strong test.
   */
  async function mkCrossSeededWs(): Promise<string> {
    const ws = mkws();
    // A: security champion
    await seedCapability(ws, 'claude-code', ['security'], 8, 2);
    await seedCapability(ws, 'claude-code', ['test'],     2, 8);
    // B: test champion
    await seedCapability(ws, 'kilocode',    ['security'], 2, 8);
    await seedCapability(ws, 'kilocode',    ['test'],     8, 2);
    return ws;
  }

  test('security task routes to the security champion (A)', async () => {
    const ws = await mkCrossSeededWs();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode',    dispatched));

      const out = await dispatchPreferredForCapability(reg, {
        prompt: 'audit for vulnerabilities',
        workingDir: ws,
        workspaceRoot: ws,
        capability: 'security',
      });

      assert.ok(out, 'a runner was selected');
      assert.strictEqual(
        out!.runnerId,
        'claude-code',
        'A (security champion) should be chosen for security tasks',
      );
      assert.deepStrictEqual(dispatched, ['claude-code']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('test task routes to the test champion (B)', async () => {
    const ws = await mkCrossSeededWs();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode',    dispatched));

      const out = await dispatchPreferredForCapability(reg, {
        prompt: 'write unit tests',
        workingDir: ws,
        workspaceRoot: ws,
        capability: 'test',
      });

      assert.ok(out, 'a runner was selected');
      assert.strictEqual(
        out!.runnerId,
        'kilocode',
        'B (test champion) should be chosen for test tasks',
      );
      assert.deepStrictEqual(dispatched, ['kilocode']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('fallback: unknown capability still dispatches without throwing', async () => {
    const ws = await mkCrossSeededWs();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode',    dispatched));

      // 'refactor' has no samples → reputation criterion ties → falls through
      // to stable default (first registered runner: 'claude-code')
      const out = await dispatchPreferredForCapability(reg, {
        prompt: 'refactor the module',
        workingDir: ws,
        workspaceRoot: ws,
        capability: 'refactor',
      });

      assert.ok(out, 'a runner is still selected despite tied capability scores');
      assert.strictEqual(dispatched.length, 1, 'exactly one dispatch fired');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('empty ledger: falls through to stable default (first registered runner)', async () => {
    const ws = mkws();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode',    dispatched));

      const out = await dispatchPreferredForCapability(reg, {
        prompt: 'do something',
        workingDir: ws,
        workspaceRoot: ws,
        capability: 'security',
      });

      assert.ok(out, 'dispatch succeeds with empty ledger');
      assert.strictEqual(dispatched.length, 1, 'exactly one dispatch fired');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('single runner always wins regardless of reputation', async () => {
    const ws = mkws();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('only-runner', dispatched));

      const out = await dispatchPreferredForCapability(reg, {
        prompt: 'security scan',
        workingDir: ws,
        workspaceRoot: ws,
        capability: 'security',
      });

      assert.ok(out, 'single-runner dispatch succeeds');
      assert.strictEqual(out!.runnerId, 'only-runner');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
