import * as assert from 'assert';
import {
  buildAgentCard,
  AUTOCLAW_EXTENSION_URI,
  A2A_PROTOCOL_VERSION,
} from '../agent-card';

suite('Agent Card — buildAgentCard', () => {
  test('minimal input produces a valid card with required fields populated', () => {
    const card = buildAgentCard({
      name: 'Test Agent',
      description: 'A minimal test agent',
      url: 'http://127.0.0.1:9876/a2a',
      version: '1.0.0',
      autoclaw: { machine_id: 'abc123hex' },
    });

    assert.strictEqual(card.protocolVersion, A2A_PROTOCOL_VERSION);
    assert.strictEqual(card.name, 'Test Agent');
    assert.strictEqual(card.description, 'A minimal test agent');
    assert.strictEqual(card.url, 'http://127.0.0.1:9876/a2a');
    assert.strictEqual(card.version, '1.0.0');
    // Defaults applied.
    assert.deepStrictEqual(card.defaultInputModes, ['text/plain', 'application/json']);
    assert.deepStrictEqual(card.defaultOutputModes, ['text/plain', 'application/json']);
    assert.deepStrictEqual(card.inputModes, ['text/plain', 'application/json']);
    assert.deepStrictEqual(card.outputModes, ['text/plain', 'application/json']);
    assert.deepStrictEqual(card.skills, []);
    // Endpoints object always carries http URL.
    assert.ok(card.endpoints);
    assert.strictEqual(card.endpoints.http, 'http://127.0.0.1:9876/a2a');
    // capabilities.extensions[] always contains the AutoClaw entry.
    assert.ok(Array.isArray(card.capabilities.extensions));
    assert.strictEqual(card.capabilities.extensions.length, 1);
    assert.strictEqual(card.capabilities.extensions[0].uri, AUTOCLAW_EXTENSION_URI);
    // Top-level x-autoclaw mirrored.
    assert.ok(card['x-autoclaw']);
    assert.strictEqual(card['x-autoclaw']!.machine_id, 'abc123hex');
  });

  test('all x-autoclaw.* fields populated → mirrored into both top-level AND capabilities.extensions[].params', () => {
    const card = buildAgentCard({
      name: 'Claude Code',
      description: 'Anthropic CLI',
      url: 'http://127.0.0.1:9876/a2a',
      version: '2.4.0',
      capabilities: { streaming: true, pushNotifications: false },
      skills: [{
        id: 'review_request',
        name: 'Code review',
        description: 'Review another agent\'s diff',
        tags: ['review'],
      }],
      supportsAuthenticatedExtendedCard: true,
      autoclaw: {
        machine_id: 'a3f9c1b87d24',
        machine_ip: '10.0.0.42',
        llms_available: ['claude-opus-4-7', 'claude-sonnet-4-6'],
        context_window: 1_000_000,
        tools_supported: ['bash', 'edit', 'grep', 'glob'],
        trust_level: 'high',
        cost_budget: { daily_usd: 100, hourly_usd: 10 },
        max_parallel_tasks: 3,
        skills_loaded: ['kdream', 'autobuild', 'mateam', 'orchestrate'],
        human_in_loop_required: false,
        capabilities: ['typescript', 'react'],
      },
    });

    // Top-level mirror still present (transitional).
    assert.ok(card['x-autoclaw']);
    assert.strictEqual(card['x-autoclaw']!.machine_id, 'a3f9c1b87d24');
    assert.strictEqual(card['x-autoclaw']!.context_window, 1_000_000);
    assert.deepStrictEqual(card['x-autoclaw']!.llms_available, ['claude-opus-4-7', 'claude-sonnet-4-6']);
    assert.strictEqual(card['x-autoclaw']!.trust_level, 'high');

    // Canonical extension entry exists with same params.
    const ext = card.capabilities.extensions.find(e => e.uri === AUTOCLAW_EXTENSION_URI);
    assert.ok(ext, 'AutoClaw extension entry must exist');
    assert.strictEqual(ext!.required, false);
    assert.strictEqual(ext!.description, 'AutoClaw extension fields');
    const params = ext!.params!;
    assert.strictEqual(params.machine_id, 'a3f9c1b87d24');
    assert.strictEqual(params.machine_ip, '10.0.0.42');
    assert.strictEqual(params.context_window, 1_000_000);
    assert.deepStrictEqual(params.llms_available, ['claude-opus-4-7', 'claude-sonnet-4-6']);
    assert.deepStrictEqual(params.tools_supported, ['bash', 'edit', 'grep', 'glob']);
    assert.strictEqual(params.trust_level, 'high');
    assert.deepStrictEqual(params.cost_budget, { daily_usd: 100, hourly_usd: 10 });
    assert.strictEqual(params.max_parallel_tasks, 3);
    assert.deepStrictEqual(params.skills_loaded, ['kdream', 'autobuild', 'mateam', 'orchestrate']);
    assert.strictEqual(params.human_in_loop_required, false);
    assert.deepStrictEqual(params.capabilities, ['typescript', 'react']);

    // Streaming capability passed through.
    assert.strictEqual(card.capabilities.streaming, true);
    assert.strictEqual(card.capabilities.pushNotifications, false);
    // Auth flag honored.
    assert.strictEqual(card.supportsAuthenticatedExtendedCard, true);
    // Skills passed through.
    assert.strictEqual(card.skills.length, 1);
    assert.strictEqual(card.skills[0].id, 'review_request');
  });

  test('schema sanity: endpoints is an object with at least an http URL; extensions[] is an array; AutoClaw URI matches', () => {
    const card = buildAgentCard({
      name: 'X', description: 'y', url: 'https://example.com/a2a', version: '0.0.1',
      autoclaw: { machine_id: 'm' },
    });
    assert.strictEqual(typeof card.endpoints, 'object');
    assert.ok(typeof card.endpoints.http === 'string' && card.endpoints.http.length > 0);
    assert.ok(Array.isArray(card.capabilities.extensions));
    assert.strictEqual(card.capabilities.extensions[0].uri, AUTOCLAW_EXTENSION_URI);
  });

  test('caller-supplied capabilities.extensions[] are preserved alongside the AutoClaw entry', () => {
    const card = buildAgentCard({
      name: 'X', description: 'y', url: 'https://example.com/a2a', version: '0.0.1',
      capabilities: {
        extensions: [
          { uri: 'https://other.example/ext', required: true, description: 'Other' },
        ],
      },
      autoclaw: { machine_id: 'm' },
    });
    const uris = card.capabilities.extensions.map(e => e.uri).sort();
    assert.deepStrictEqual(uris, [
      AUTOCLAW_EXTENSION_URI,
      'https://other.example/ext',
    ].sort());
  });

  test('endpoints.ws / endpoints.nats are pass-through when supplied', () => {
    const card = buildAgentCard({
      name: 'X', description: 'y', url: 'http://h/a2a', version: '0.0.1',
      endpoints: { http: 'http://h/a2a', ws: 'ws://h/ws', nats: 'nats://h:4222' },
      autoclaw: { machine_id: 'm' },
    });
    assert.strictEqual(card.endpoints.ws, 'ws://h/ws');
    assert.strictEqual(card.endpoints.nats, 'nats://h:4222');
  });

  test('only populated x-autoclaw fields appear in extensions[].params (no undefined leakage)', () => {
    const card = buildAgentCard({
      name: 'X', description: 'y', url: 'http://h/a2a', version: '0.0.1',
      autoclaw: { machine_id: 'm', llms_available: undefined, context_window: 200000 },
    });
    const params = card.capabilities.extensions[0].params!;
    assert.ok('machine_id' in params);
    assert.ok('context_window' in params);
    assert.strictEqual('llms_available' in params, false);
  });
});
