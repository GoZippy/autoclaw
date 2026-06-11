/**
 * fabricOnboarding.test.ts — AF-4: onboard a platform runner as a typed worker.
 */

import * as assert from 'assert';

import { onboardPlatform, type OnboardOptions } from '../fabric/onboarding';
import type { AgentRegistry } from '../comms';

/** A minimal fake runner exposing just id/detect/health. */
function fakeRunner(id: string, found: boolean, healthy: boolean) {
  return {
    id,
    async detect() {
      return found
        ? { found: true as const, version: '1.0.0', endpoint: 'local' }
        : { found: false as const, reason: 'not_running' as const, hint: 'start it' };
    },
    async health() {
      if (!healthy) { throw new Error('unreachable'); }
      return { ok: true, authPresent: true, cliVersion: '1.0.0', mcpServersConfigured: 0 };
    },
  };
}

/** In-memory registry IO seam. */
function memRegistry(initial: AgentRegistry | null = null) {
  let reg = initial;
  const io: Pick<OnboardOptions, 'readRegistry' | 'writeRegistry'> = {
    readRegistry: async () => reg,
    writeRegistry: async (r) => { reg = r; },
  };
  return { io, get: () => reg };
}

const fixedNow = () => new Date('2026-06-09T00:00:00Z');

suite('fabric onboarding (AF-4)', () => {
  test('Hermes onboards as an assistant and is registered', async () => {
    const { io, get } = memRegistry();
    const report = await onboardPlatform({ runner: fakeRunner('hermes', true, true), ...io, now: fixedNow });
    assert.strictEqual(report.detected, true);
    assert.strictEqual(report.healthy, true);
    assert.strictEqual(report.agent_type, 'assistant', 'hermes default ⇒ assistant');
    assert.strictEqual(report.registered, true);
    const agents = get()!.agents;
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].id, 'hermes');
    assert.strictEqual(agents[0].agent_type, 'assistant');
  });

  test('a coding platform onboards as a coder by default', async () => {
    const { io, get } = memRegistry();
    const report = await onboardPlatform({ runner: fakeRunner('openclaw', true, true), ...io, now: fixedNow });
    assert.strictEqual(report.agent_type, 'coder');
    assert.strictEqual(get()!.agents[0].agent_type, 'coder');
  });

  test('explicit agentType override wins (openclaw as supervisor sets can_orchestrate)', async () => {
    const { io, get } = memRegistry();
    const report = await onboardPlatform({ runner: fakeRunner('openclaw', true, true), agentType: 'supervisor', ...io, now: fixedNow });
    assert.strictEqual(report.agent_type, 'supervisor');
    assert.strictEqual(get()!.agents[0].can_orchestrate, true, 'supervisor ⇒ can_orchestrate');
  });

  test('a not-detected platform is reported but NOT registered', async () => {
    const { io, get } = memRegistry();
    const report = await onboardPlatform({ runner: fakeRunner('cursor', false, false), ...io, now: fixedNow });
    assert.strictEqual(report.detected, false);
    assert.strictEqual(report.registered, false);
    assert.match(report.detail, /not detected/);
    assert.strictEqual(get(), null, 'registry untouched');
  });

  test('detected-but-unhealthy is still registered, with health noted', async () => {
    const { io, get } = memRegistry();
    const report = await onboardPlatform({ runner: fakeRunner('codex', true, false), ...io, now: fixedNow });
    assert.strictEqual(report.detected, true);
    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.registered, true);
    assert.match(report.detail, /health check failed/);
    assert.strictEqual(get()!.agents[0].id, 'codex');
  });

  test('idempotent: re-onboarding updates the existing entry, no duplicate', async () => {
    const { io, get } = memRegistry();
    await onboardPlatform({ runner: fakeRunner('hermes', true, true), ...io, now: fixedNow });
    await onboardPlatform({ runner: fakeRunner('hermes', true, true), agentType: 'supervisor', ...io, now: fixedNow });
    const agents = get()!.agents;
    assert.strictEqual(agents.length, 1, 'no duplicate entry');
    assert.strictEqual(agents[0].agent_type, 'supervisor', 'updated in place');
  });
});
