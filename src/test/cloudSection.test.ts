/**
 * cloudSection.test.ts — Unit tests for the Sprint-4 WA-4 "Remote Agents"
 * Fleet-panel section (D3).
 *
 * Exercises the cross-machine table, the cross-project rollup powered by
 * `.autoclaw/program/registry.json`, and the honest relay-status view —
 * against temp workspaces. Pure file I/O.
 *
 * NEW test file — Sprint 4 (WA-4). Does not modify any existing test.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildCloudSection,
  remoteAgentStatus,
} from '../panel/cloudSection';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-wa4-panel-'));
}

/** Write a repo's comms registry + a heartbeat for one agent. */
function seedRepo(
  repoRoot: string,
  agents: Array<{ id: string; name?: string; role?: string; machine_id?: string }>,
  heartbeats: Record<string, { timestamp: string; current_task?: string | null }>,
): void {
  const comms = path.join(repoRoot, '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(path.join(comms, 'heartbeats'), { recursive: true });
  fs.writeFileSync(path.join(comms, 'registry.json'), JSON.stringify({ agents }));
  for (const [agentId, hb] of Object.entries(heartbeats)) {
    fs.writeFileSync(
      path.join(comms, 'heartbeats', `${agentId}.json`),
      JSON.stringify({ agent_id: agentId, ...hb }),
    );
  }
}

// ---------------------------------------------------------------------------
// status derivation
// ---------------------------------------------------------------------------

suite('Sprint 4 WA-4 — D3 remoteAgentStatus', () => {
  const now = Date.parse('2026-05-21T12:00:00Z');
  test('fresh heartbeat ⇒ active', () => {
    assert.strictEqual(remoteAgentStatus('2026-05-21T11:59:30Z', now), 'active');
  });
  test('a few minutes old ⇒ idle', () => {
    assert.strictEqual(remoteAgentStatus('2026-05-21T11:57:00Z', now), 'idle');
  });
  test('an hour old ⇒ stalled', () => {
    assert.strictEqual(remoteAgentStatus('2026-05-21T11:00:00Z', now), 'stalled');
  });
  test('no heartbeat ⇒ offline', () => {
    assert.strictEqual(remoteAgentStatus(null, now), 'offline');
  });
});

// ---------------------------------------------------------------------------
// section builder
// ---------------------------------------------------------------------------

suite('Sprint 4 WA-4 — D3 buildCloudSection', () => {
  test('renders standalone when there is no program registry', async () => {
    const root = makeWorkspace();
    seedRepo(root, [{ id: 'claude-code', name: 'Claude' }], {
      'claude-code': { timestamp: new Date().toISOString(), current_task: 't' },
    });
    const model = await buildCloudSection({ workspaceRoot: root });
    assert.strictEqual(model.standalone, true);
    assert.strictEqual(model.programName, null);
    assert.strictEqual(model.remoteAgents.length, 1);
    assert.strictEqual(model.remoteAgents[0].machine, os.hostname());
  });

  test('builds a cross-project rollup from the program registry', async () => {
    const root = makeWorkspace();
    const sibling = makeWorkspace();
    seedRepo(root, [{ id: 'claude-code' }], {
      'claude-code': { timestamp: new Date().toISOString() },
    });
    seedRepo(sibling, [{ id: 'kilocode', machine_id: 'build-box' }], {
      kilocode: { timestamp: '2020-01-01T00:00:00Z' }, // stale → offline
    });
    fs.mkdirSync(path.join(root, '.autoclaw', 'program'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.autoclaw', 'program', 'registry.json'),
      JSON.stringify({
        program_name: 'demo-program',
        repos: [
          { path: root, label: 'host', enabled: true },
          { path: sibling, label: 'sibling', enabled: true },
        ],
      }),
    );
    const model = await buildCloudSection({ workspaceRoot: root });
    assert.strictEqual(model.standalone, false);
    assert.strictEqual(model.programName, 'demo-program');
    assert.strictEqual(model.projectRollup.length, 2);
    assert.strictEqual(model.remoteAgents.length, 2);

    const siblingRow = model.remoteAgents.find(r => r.agentId === 'kilocode');
    assert.ok(siblingRow);
    assert.strictEqual(siblingRow.machine, 'build-box', 'machine_id wins for sibling repos');
    assert.strictEqual(siblingRow.status, 'offline');

    const hostRollup = model.projectRollup.find(r => r.repoLabel === 'host');
    assert.ok(hostRollup && hostRollup.activeCount === 1);
  });

  test('relay status is honest: inert by default', async () => {
    const root = makeWorkspace();
    const model = await buildCloudSection({ workspaceRoot: root });
    assert.strictEqual(model.relay.active, false);
    assert.strictEqual(model.relay.loggedIn, false);
    assert.ok(model.relay.summary.toLowerCase().includes('disabled'));
  });

  test('relay status reflects an endpoint set but disabled', async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, '.autoclaw', 'cloud'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.autoclaw', 'cloud', 'relay-config.json'),
      JSON.stringify({ endpoint: 'https://relay.example.com', enabled: false }),
    );
    const model = await buildCloudSection({ workspaceRoot: root });
    assert.strictEqual(model.relay.active, false);
    assert.strictEqual(model.relay.endpointHost, 'relay.example.com');
    assert.ok(model.relay.summary.includes('not transmitting'));
  });

  test('skips disabled repos in the rollup', async () => {
    const root = makeWorkspace();
    const parked = makeWorkspace();
    seedRepo(root, [{ id: 'claude-code' }], {
      'claude-code': { timestamp: new Date().toISOString() },
    });
    fs.mkdirSync(path.join(root, '.autoclaw', 'program'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.autoclaw', 'program', 'registry.json'),
      JSON.stringify({
        program_name: 'p',
        repos: [
          { path: root, label: 'host', enabled: true },
          { path: parked, label: 'parked', enabled: false },
        ],
      }),
    );
    const model = await buildCloudSection({ workspaceRoot: root });
    const parkedRollup = model.projectRollup.find(r => r.repoLabel === 'parked');
    assert.ok(parkedRollup && parkedRollup.enabled === false);
    assert.strictEqual(parkedRollup.agentCount, 0);
  });
});
