/**
 * agentCardPublisher.test.ts — DESIGN.md Gap D (Agent Card publisher).
 */

import * as assert from 'assert';

import { publishAgentCards, WELL_KNOWN_DIR, A2A_CARD_FILENAME } from '../fabric/agentCardPublisher';
import type { AgentRegistry } from '../comms';
import type { AgentCard } from '../agent-card';

const registry: AgentRegistry = {
  agents: [
    { id: 'kiro', name: 'Kiro', extension_id: null, detected: true, inbox_path: '', hooks_supported: true, last_heartbeat: null, status: 'detected', agent_type: 'supervisor', trust_level: 'high', capabilities: ['orchestrate', 'code'], max_parallel_tasks: 1 },
    { id: 'kilocode', name: 'Kilo Code', extension_id: 'kilocode.kilo-code', detected: true, inbox_path: '', hooks_supported: false, last_heartbeat: null, status: 'detected', agent_type: 'coder', trust_level: 'medium', capabilities: ['code'] },
  ],
  ide: 'Visual Studio Code',
  provisioned_at: '2026-06-14T00:00:00.000Z',
  schema_version: '2',
};

suite('Agent Card publisher', () => {
  test('writes one card per agent + an orchestrator card, with agent_card_path set', async () => {
    const written = new Map<string, AgentCard>();
    const report = await publishAgentCards({
      registry,
      baseUrl: 'http://127.0.0.1:9876/a2a',
      version: '3.4.0',
      writeCard: async (relPath, card) => { written.set(relPath, card); },
    });

    // 2 agents + 1 orchestrator
    assert.strictEqual(report.published.length, 3);
    assert.ok(written.has(`${WELL_KNOWN_DIR}/kiro/agent-card.json`));
    assert.ok(written.has(`${WELL_KNOWN_DIR}/kilocode/agent-card.json`));
    assert.ok(written.has(`${WELL_KNOWN_DIR}/orchestrator/agent-card.json`));

    // agent_card_path is recorded back on the registry copy.
    const kiro = report.registry.agents.find(a => a.id === 'kiro');
    assert.strictEqual(kiro?.agent_card_path, `${WELL_KNOWN_DIR}/kiro/agent-card.json`);
  });

  test('cards carry A2A protocolVersion + AutoClaw extension fields', async () => {
    const written = new Map<string, AgentCard>();
    await publishAgentCards({
      registry,
      baseUrl: 'http://127.0.0.1:9876/a2a',
      version: '3.4.0',
      writeCard: async (relPath, card) => { written.set(relPath, card); },
    });
    const kiroCard = written.get(`${WELL_KNOWN_DIR}/kiro/agent-card.json`)!;
    assert.strictEqual(kiroCard.protocolVersion, '0.2.5');
    assert.strictEqual(kiroCard.url, 'http://127.0.0.1:9876/a2a/kiro');
    assert.deepStrictEqual(kiroCard['x-autoclaw']?.capabilities, ['orchestrate', 'code']);
    assert.strictEqual(kiroCard['x-autoclaw']?.trust_level, 'high');
  });

  test('publishes the A2A-canonical agent.json alias alongside agent-card.json', async () => {
    const written = new Map<string, AgentCard>();
    await publishAgentCards({
      registry,
      baseUrl: 'http://127.0.0.1:9876/a2a',
      version: '3.4.0',
      writeCard: async (relPath, card) => { written.set(relPath, card); },
    });
    // Alias present for every agent + the orchestrator, identical to the primary card.
    for (const id of ['kiro', 'kilocode', 'orchestrator']) {
      const alias = written.get(`${WELL_KNOWN_DIR}/${id}/${A2A_CARD_FILENAME}`);
      assert.ok(alias, `missing ${A2A_CARD_FILENAME} alias for ${id}`);
      assert.deepStrictEqual(alias, written.get(`${WELL_KNOWN_DIR}/${id}/agent-card.json`));
    }
  });

  test('orchestrator card advertises routing capabilities', async () => {
    const written = new Map<string, AgentCard>();
    await publishAgentCards({
      registry, baseUrl: 'http://x/a2a', version: '1',
      writeCard: async (relPath, card) => { written.set(relPath, card); },
    });
    const orch = written.get(`${WELL_KNOWN_DIR}/orchestrator/agent-card.json`)!;
    assert.ok(orch['x-autoclaw']?.capabilities?.includes('route'));
  });
});
