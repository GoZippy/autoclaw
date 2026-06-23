import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scaffoldFleetManifest,
  setAgentManifestEntry,
  setManifestOrchestrator,
  generateNeedsFile,
  assertValidAgentId,
  assertValidRole,
  type DetectedAgent,
} from '../fleet/authoring';
import { readFleetManifest, writeFleetManifest, fleetPath } from '../fleet/pending';
import { readNeeds, needsPath } from '../fleet/needs';
import type { FleetManifest } from '../fleet/architecture';

function makeTmp(): string {
  // The authoring module's `autoclawDir` is the `.autoclaw` dir; create a tmp
  // workspace and point at its (not-yet-existing) `.autoclaw` child.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'authoring-test-'));
  return path.join(ws, '.autoclaw');
}

function agent(over: Partial<DetectedAgent> & { id: string }): DetectedAgent {
  return { ...over };
}

suite('Fleet manifest authoring (Follow-up #2)', () => {

  // -------------------------------------------------------------------------
  // scaffoldFleetManifest — create from scratch
  // -------------------------------------------------------------------------

  test('scaffold creates fleet.json from detected agents with sensible defaults', async () => {
    const autoclaw = makeTmp();
    const agents: DetectedAgent[] = [
      agent({ id: 'claude-code', role: 'orchestrator', can_orchestrate: true }),
      agent({ id: 'kilocode', role: 'coder' }),
      agent({ id: 'hermes', agent_type: 'runner' }), // role inferred from type -> ops
      agent({ id: 'mystery' }),                       // no signal -> generalist
    ];

    const res = await scaffoldFleetManifest(autoclaw, agents);

    // File exists and round-trips.
    assert.ok(fs.existsSync(fleetPath(autoclaw)), 'fleet.json written');
    const back = await readFleetManifest(autoclaw);
    assert.ok(back);

    // Every detected agent has an entry.
    assert.deepStrictEqual(
      Object.keys(back!.agents!).sort(),
      ['claude-code', 'hermes', 'kilocode', 'mystery'],
    );

    // Roles defaulted from each agent's signal via the canonical taxonomy.
    assert.strictEqual(back!.agents!['claude-code'].role, 'orchestrator');
    assert.strictEqual(back!.agents!['kilocode'].role, 'coder');
    assert.strictEqual(back!.agents!['hermes'].role, 'ops');         // runner -> ops
    assert.strictEqual(back!.agents!['mystery'].role, 'generalist'); // unknown -> generalist

    // agent_type defaulted (coder when no known fabric type given).
    assert.strictEqual(back!.agents!['hermes'].agent_type, 'runner');
    assert.strictEqual(back!.agents!['mystery'].agent_type, 'coder');

    // Orchestrator auto-picked from the can_orchestrate agent.
    assert.strictEqual(back!.orchestrator, 'claude-code');
    assert.strictEqual(res.orchestrator, 'claude-code');

    // Summary reflects 4 added, 0 preserved.
    assert.deepStrictEqual(res.added.sort(), ['claude-code', 'hermes', 'kilocode', 'mystery']);
    assert.deepStrictEqual(res.preserved, []);
  });

  // -------------------------------------------------------------------------
  // scaffoldFleetManifest — MERGE (never clobber hand-set roles)
  // -------------------------------------------------------------------------

  test('scaffold PRESERVES existing hand-set entries and only adds missing agents', async () => {
    const autoclaw = makeTmp();
    // User hand-authored fleet.json: kilocode is a 'reviewer' (NOT its default).
    const hand: FleetManifest = {
      schema_version: '1.0',
      orchestrator: 'claude-code',
      agents: {
        'claude-code': { role: 'orchestrator', agent_type: 'governance' },
        'kilocode': { role: 'reviewer', agent_type: 'auditor', reports_to: 'claude-code' },
      },
    };
    await writeFleetManifest(autoclaw, hand);

    // Now scaffold with the same two PLUS a newcomer. The newcomer's signal says
    // 'coder' but kilocode's signal would default to 'coder' too — preservation
    // must keep kilocode's hand-set 'reviewer'.
    const res = await scaffoldFleetManifest(autoclaw, [
      agent({ id: 'claude-code', role: 'coder' }),  // would-be 'coder', must stay 'orchestrator'
      agent({ id: 'kilocode', role: 'coder' }),     // would-be 'coder', must stay 'reviewer'
      agent({ id: 'codex', role: 'tester' }),       // NEW -> added as 'tester'
    ]);

    const back = await readFleetManifest(autoclaw);
    // Hand-set entries preserved verbatim, including reports_to + agent_type.
    assert.strictEqual(back!.agents!['claude-code'].role, 'orchestrator');
    assert.strictEqual(back!.agents!['claude-code'].agent_type, 'governance');
    assert.strictEqual(back!.agents!['kilocode'].role, 'reviewer');
    assert.strictEqual(back!.agents!['kilocode'].agent_type, 'auditor');
    assert.strictEqual(back!.agents!['kilocode'].reports_to, 'claude-code');
    // Newcomer added.
    assert.strictEqual(back!.agents!['codex'].role, 'tester');
    // Orchestrator preserved from the existing manifest.
    assert.strictEqual(back!.orchestrator, 'claude-code');

    // Summary: exactly one added, two preserved.
    assert.deepStrictEqual(res.added, ['codex']);
    assert.deepStrictEqual(res.preserved.sort(), ['claude-code', 'kilocode']);
    const codexOutcome = res.agents.find(a => a.agent_id === 'codex');
    assert.strictEqual(codexOutcome!.disposition, 'added');
    const kiloOutcome = res.agents.find(a => a.agent_id === 'kilocode');
    assert.strictEqual(kiloOutcome!.disposition, 'preserved');
  });

  test('scaffold de-dupes a duplicated detected agent', async () => {
    const autoclaw = makeTmp();
    const res = await scaffoldFleetManifest(autoclaw, [
      agent({ id: 'dup', role: 'coder' }),
      agent({ id: 'dup', role: 'tester' }), // second sighting ignored
    ]);
    const back = await readFleetManifest(autoclaw);
    assert.strictEqual(Object.keys(back!.agents!).length, 1);
    assert.strictEqual(back!.agents!['dup'].role, 'coder'); // first wins
    assert.deepStrictEqual(res.added, ['dup']);
  });

  test('scaffold honours an explicit orchestrator opt over auto-pick', async () => {
    const autoclaw = makeTmp();
    const res = await scaffoldFleetManifest(
      autoclaw,
      [agent({ id: 'a', can_orchestrate: true }), agent({ id: 'b' })],
      { orchestrator: 'b' },
    );
    assert.strictEqual(res.orchestrator, 'b');
    const back = await readFleetManifest(autoclaw);
    assert.strictEqual(back!.orchestrator, 'b');
  });

  test('scaffold with autoPickOrchestrator:false leaves orchestrator unset', async () => {
    const autoclaw = makeTmp();
    const res = await scaffoldFleetManifest(
      autoclaw,
      [agent({ id: 'a', can_orchestrate: true })],
      { autoPickOrchestrator: false },
    );
    assert.strictEqual(res.orchestrator, null);
    const back = await readFleetManifest(autoclaw);
    assert.ok(!('orchestrator' in back!), 'orchestrator field omitted');
  });

  // -------------------------------------------------------------------------
  // setAgentManifestEntry — upsert
  // -------------------------------------------------------------------------

  test('setAgentManifestEntry inserts a new entry', async () => {
    const autoclaw = makeTmp();
    const m = await setAgentManifestEntry(autoclaw, 'hermes', { role: 'tester', agent_type: 'runner' });
    assert.strictEqual(m.agents!['hermes'].role, 'tester');
    assert.strictEqual(m.agents!['hermes'].agent_type, 'runner');
    const back = await readFleetManifest(autoclaw);
    assert.strictEqual(back!.agents!['hermes'].role, 'tester');
  });

  test('setAgentManifestEntry merges fields without clobbering peers or unset keys', async () => {
    const autoclaw = makeTmp();
    await writeFleetManifest(autoclaw, {
      schema_version: '1.0',
      orchestrator: 'claude-code',
      agents: {
        'claude-code': { role: 'orchestrator' },
        'kilocode': { role: 'coder', agent_type: 'coder', reports_to: 'claude-code' },
      },
    });
    // Change ONLY kilocode's role; agent_type + reports_to must survive.
    const m = await setAgentManifestEntry(autoclaw, 'kilocode', { role: 'reviewer' });
    assert.strictEqual(m.agents!['kilocode'].role, 'reviewer');
    assert.strictEqual(m.agents!['kilocode'].agent_type, 'coder');
    assert.strictEqual(m.agents!['kilocode'].reports_to, 'claude-code');
    // Peer + orchestrator untouched.
    assert.strictEqual(m.agents!['claude-code'].role, 'orchestrator');
    assert.strictEqual(m.orchestrator, 'claude-code');
  });

  test('setAgentManifestEntry accepts and validates reports_to', async () => {
    const autoclaw = makeTmp();
    const m = await setAgentManifestEntry(autoclaw, 'worker', { role: 'coder', reports_to: 'claude-code' });
    assert.strictEqual(m.agents!['worker'].reports_to, 'claude-code');
  });

  // -------------------------------------------------------------------------
  // setManifestOrchestrator
  // -------------------------------------------------------------------------

  test('setManifestOrchestrator sets the orchestrator field, preserving agents', async () => {
    const autoclaw = makeTmp();
    await writeFleetManifest(autoclaw, {
      schema_version: '1.0',
      agents: { 'claude-code': { role: 'orchestrator' }, 'kilocode': { role: 'coder' } },
    });
    const m = await setManifestOrchestrator(autoclaw, 'claude-code');
    assert.strictEqual(m.orchestrator, 'claude-code');
    assert.strictEqual(m.agents!['claude-code'].role, 'orchestrator');
    assert.strictEqual(m.agents!['kilocode'].role, 'coder');
  });

  test('setManifestOrchestrator on a fresh project seeds a manifest', async () => {
    const autoclaw = makeTmp();
    const m = await setManifestOrchestrator(autoclaw, 'solo');
    assert.strictEqual(m.orchestrator, 'solo');
    assert.ok(m.schema_version);
    assert.ok(fs.existsSync(fleetPath(autoclaw)));
  });

  // -------------------------------------------------------------------------
  // Validation — invalid role / id rejected
  // -------------------------------------------------------------------------

  test('assertValidAgentId rejects traversal, separators, whitespace, dots', () => {
    assert.strictEqual(assertValidAgentId('claude-code'), 'claude-code');
    assert.strictEqual(assertValidAgentId('  kilocode  '), 'kilocode'); // trims
    assert.strictEqual(assertValidAgentId('gemini-cli_2'), 'gemini-cli_2');
    for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', 'a b', '', '   ', 'a*b', 'a$b']) {
      assert.throws(() => assertValidAgentId(bad), /invalid agentId|agentId is required/, `should reject "${bad}"`);
    }
  });

  test('assertValidRole accepts canonical roles + synonyms, rejects unknown labels', () => {
    assert.strictEqual(assertValidRole('coder'), 'coder');
    assert.strictEqual(assertValidRole('reviewer'), 'reviewer');
    assert.strictEqual(assertValidRole('qa'), 'qa');           // synonym -> tester
    assert.strictEqual(assertValidRole('security'), 'security');
    assert.strictEqual(assertValidRole('generalist'), 'generalist');
    for (const bad of ['', '   ', 'wizard', 'banana', 'not-a-role']) {
      assert.throws(() => assertValidRole(bad), /unknown role|role must be a non-empty string/, `should reject "${bad}"`);
    }
  });

  test('setAgentManifestEntry rejects an invalid role and does NOT write', async () => {
    const autoclaw = makeTmp();
    await assert.rejects(
      () => setAgentManifestEntry(autoclaw, 'x', { role: 'wizard' }),
      /unknown role/,
    );
    // Nothing should have been written for the bad role (validation precedes write).
    assert.ok(!fs.existsSync(fleetPath(autoclaw)), 'no fleet.json written on invalid role');
  });

  test('setAgentManifestEntry rejects an invalid agent id', async () => {
    const autoclaw = makeTmp();
    await assert.rejects(() => setAgentManifestEntry(autoclaw, '../evil', { role: 'coder' }), /invalid agentId/);
  });

  test('scaffold rejects an invalid agent id in the detected list', async () => {
    const autoclaw = makeTmp();
    await assert.rejects(
      () => scaffoldFleetManifest(autoclaw, [agent({ id: '../evil' })]),
      /invalid agentId/,
    );
  });

  // -------------------------------------------------------------------------
  // generateNeedsFile — thin wrapper over needs.ts
  // -------------------------------------------------------------------------

  test('generateNeedsFile authors needs.json by reusing the needs pipeline', async () => {
    const autoclaw = makeTmp();
    // Author a manifest so declaredRoles flow into the needs vector.
    await scaffoldFleetManifest(autoclaw, [
      agent({ id: 'claude-code', role: 'orchestrator', can_orchestrate: true }),
    ]);

    const T0 = Date.parse('2026-06-22T00:00:00.000Z');
    const res = await generateNeedsFile(autoclaw, {
      plannedLanes: [{ lane: 'SA', role: 'researcher', unclaimed: 1 }],
      now: T0,
    });

    assert.ok(fs.existsSync(needsPath(autoclaw)), 'needs.json written');
    assert.strictEqual(res.path, needsPath(autoclaw));
    // researcher is wanted (open lane) and not covered by any fresh live agent.
    assert.ok(res.needs.role_coverage_gap.includes('researcher'));
    assert.strictEqual(res.needs.open_lanes.length, 1);
    assert.strictEqual(res.needs.generated_at, new Date(T0).toISOString());

    const back = await readNeeds(autoclaw);
    assert.ok(back);
    assert.ok(back!.role_coverage_gap.includes('researcher'));
    assert.strictEqual(back!.generated_at, new Date(T0).toISOString());
  });
});
