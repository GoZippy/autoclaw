import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  computePendingAgents, admitToFleet, admitAgent, readFleetManifest, fleetPath,
  PendingAgent,
} from '../fleet/pending';
import type { BeaconRow } from '../fleet/beacons';
import type { Invite } from '../fleet/invites';
import type { FleetManifest } from '../fleet/architecture';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'));
}

function beacon(over: Partial<BeaconRow>): BeaconRow {
  return {
    agent_id: 'x', timestamp: '', origin: 'beacon', workspace_id: 'ws',
    age_ms: 0, stale: false, ...over,
  };
}

function invite(over: Partial<Invite>): Invite {
  return {
    token: 't', issued_by: 'claude-code', project: 'autoclaw', trust: 'off',
    admit_policy: 'auto-preapproved', issued_at: '', expires: '', consumed_by: null,
    ...over,
  };
}

suite('Pending tray + admit (FF-3)', () => {

  test('a fresh beacon not in fleet.json is pending', () => {
    const manifest: FleetManifest = { agents: { 'claude-code': { role: 'orchestrator' } } };
    const beacons = [
      beacon({ agent_id: 'claude-code', role: 'orchestrator' }), // declared → not pending
      beacon({ agent_id: 'hermes', role: 'tester', host: 'hermes', session_id: 's1' }),
    ];
    const pending = computePendingAgents(beacons, manifest);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].agent_id, 'hermes');
    assert.strictEqual(pending[0].suggested_role, 'tester');
    assert.strictEqual(pending[0].trust, 'off');
  });

  test('a matching consumed invite supplies suggested role/type/trust', () => {
    const beacons = [beacon({ agent_id: 'openclaw' })];
    const inv = invite({
      token: 'join-1', suggested_role: 'researcher', suggested_agent_type: 'coder',
      trust: 'auto', consumed_by: { agent_id: 'openclaw', at: '' },
    });
    const pending = computePendingAgents(beacons, null, [inv]);
    assert.strictEqual(pending[0].suggested_role, 'researcher');
    assert.strictEqual(pending[0].suggested_agent_type, 'coder');
    assert.strictEqual(pending[0].trust, 'auto');
    assert.strictEqual(pending[0].via_invite, 'join-1');
  });

  test('stale beacons are not pending', () => {
    const pending = computePendingAgents([beacon({ agent_id: 'ghost', stale: true })], null);
    assert.deepStrictEqual(pending, [] as PendingAgent[]);
  });

  test('duplicate beacons for one agent collapse to a single pending row', () => {
    const beacons = [
      beacon({ agent_id: 'dup', session_id: 's1' }),
      beacon({ agent_id: 'dup', session_id: 's2' }),
    ];
    assert.strictEqual(computePendingAgents(beacons, null).length, 1);
  });

  test('admitToFleet adds the agent and preserves the orchestrator + peers', () => {
    const manifest: FleetManifest = {
      orchestrator: 'claude-code',
      agents: { 'claude-code': { role: 'orchestrator' }, 'kilocode': { role: 'coder' } },
    };
    const next = admitToFleet(manifest, 'hermes', { role: 'tester', agent_type: 'coder' });
    assert.strictEqual(next.orchestrator, 'claude-code');
    assert.strictEqual(next.agents!['kilocode'].role, 'coder');
    assert.strictEqual(next.agents!['hermes'].role, 'tester');
    assert.strictEqual(next.agents!['hermes'].agent_type, 'coder');
  });

  test('admitToFleet on a null manifest seeds a fresh one', () => {
    const next = admitToFleet(null, 'solo', { role: 'coder' });
    assert.strictEqual(next.agents!['solo'].role, 'coder');
    assert.ok(next.schema_version);
  });

  test('admitAgent read-modify-writes fleet.json on disk', async () => {
    const dir = makeTmp();
    const autoclaw = path.join(dir, '.autoclaw');
    await admitAgent(autoclaw, 'hermes', { role: 'tester' });
    assert.ok(fs.existsSync(fleetPath(autoclaw)));
    const back = await readFleetManifest(autoclaw);
    assert.strictEqual(back!.agents!['hermes'].role, 'tester');

    // A second admit preserves the first.
    await admitAgent(autoclaw, 'openclaw', { role: 'researcher' });
    const back2 = await readFleetManifest(autoclaw);
    assert.strictEqual(back2!.agents!['hermes'].role, 'tester');
    assert.strictEqual(back2!.agents!['openclaw'].role, 'researcher');
  });
});
