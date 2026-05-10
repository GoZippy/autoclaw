import * as assert from 'assert';
import { createFabricBus, compileTopicMatcher } from '../fabric';
import { BridgeEventBus } from '../bridge';

// ---------------------------------------------------------------------------
// fs driver
// ---------------------------------------------------------------------------

suite('FabricBus — fs driver', () => {
  test('creates without error and stats() reports driver=fs', async () => {
    const bus = await createFabricBus({ driver: 'fs' });
    try {
      assert.strictEqual(bus.driver, 'fs');
      const s = bus.stats();
      assert.strictEqual(s.driver, 'fs');
      assert.strictEqual(s.subscribers, 0);
      assert.strictEqual(s.published, 0);
    } finally { await bus.close(); }
  });

  test('publish/subscribe are no-ops but increment counters; close() is idempotent', async () => {
    const bus = await createFabricBus({ driver: 'fs' });
    let received = 0;
    const unsub = await bus.subscribe('ac.>', () => { received++; });
    assert.strictEqual(bus.stats().subscribers, 1);
    await bus.publish('ac.fleet.heartbeat.x', { t: 1 });
    await bus.publish('ac.task.assign.s1', { t: 2 });
    // FS driver does NOT deliver: it relies on the comms.ts file path.
    assert.strictEqual(received, 0);
    assert.strictEqual(bus.stats().published, 2);
    unsub();
    assert.strictEqual(bus.stats().subscribers, 0);
    await bus.close();
    await bus.close(); // idempotent
  });
});

// ---------------------------------------------------------------------------
// ws driver
// ---------------------------------------------------------------------------

suite('FabricBus — ws driver', () => {
  test('publish on bus → subscriber receives matching topic', async () => {
    const eventBus = new BridgeEventBus();
    const bus = await createFabricBus({ driver: 'ws', bus: eventBus });
    try {
      assert.strictEqual(bus.driver, 'ws');
      const got: Array<{ topic: string; data: unknown }> = [];
      await bus.subscribe('ac.fleet.>', (topic, data) => { got.push({ topic, data }); });
      await bus.publish('ac.fleet.heartbeat.x', { agent: 'x', q: 0 });
      await bus.publish('ac.task.assign.s1', { task: 't1' }); // filtered out
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].topic, 'ac.fleet.heartbeat.x');
      assert.deepStrictEqual(got[0].data, { agent: 'x', q: 0 });
    } finally { await bus.close(); }
  });

  test('subscriber unsubscribe stops further deliveries', async () => {
    const bus = await createFabricBus({ driver: 'ws', bus: new BridgeEventBus() });
    try {
      let count = 0;
      const unsub = await bus.subscribe('topic.*', () => { count++; });
      await bus.publish('topic.a', 1);
      assert.strictEqual(count, 1);
      unsub();
      await bus.publish('topic.b', 2);
      assert.strictEqual(count, 1);
      assert.strictEqual(bus.stats().subscribers, 0);
    } finally { await bus.close(); }
  });

  test('close() prevents further deliveries and is idempotent', async () => {
    const bus = await createFabricBus({ driver: 'ws', bus: new BridgeEventBus() });
    let count = 0;
    await bus.subscribe('>', () => { count++; });
    await bus.publish('any.thing', 1);
    assert.strictEqual(count, 1);
    await bus.close();
    await bus.close();
    await bus.publish('any.thing', 1);
    // After close, fanout is severed.
    assert.strictEqual(count, 1);
  });
});

// ---------------------------------------------------------------------------
// Topic matcher
// ---------------------------------------------------------------------------

suite('FabricBus — topic matcher', () => {
  test('exact match', () => {
    const m = compileTopicMatcher('ac.fleet.announce');
    assert.strictEqual(m('ac.fleet.announce'), true);
    assert.strictEqual(m('ac.fleet.announce.x'), false);
    assert.strictEqual(m('ac.fleet'), false);
  });

  test('* matches a single token', () => {
    const m = compileTopicMatcher('ac.fleet.heartbeat.*');
    assert.strictEqual(m('ac.fleet.heartbeat.kiro'), true);
    assert.strictEqual(m('ac.fleet.heartbeat.kiro.window'), false);
    assert.strictEqual(m('ac.fleet.heartbeat.'), false);
  });

  test('> matches one or more terminal tokens', () => {
    const m = compileTopicMatcher('ac.fleet.>');
    assert.strictEqual(m('ac.fleet.announce'), true);
    assert.strictEqual(m('ac.fleet.heartbeat.kiro'), true);
    assert.strictEqual(m('ac.fleet'), false);
    assert.strictEqual(m('ac.task.assign.s1'), false);
  });
});
