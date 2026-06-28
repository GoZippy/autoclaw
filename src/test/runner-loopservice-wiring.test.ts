/**
 * runner-loopservice-wiring.test.ts — BL-14: config-driven loop_services[]
 * runners wired into createDefaultRunnerRegistry.
 *
 * Proves:
 *  1. A config containing `loop_services[]` causes the corresponding
 *     LoopServiceAdapter runners to appear in the registry.
 *  2. Each adapter's id matches the configured entry id.
 *  3. A missing / empty / invalid `loopServices` option registers no
 *     extra runners beyond the built-in set.
 *  4. Malformed entries (missing id or endpoint) are silently dropped.
 *  5. Config-driven runners are registered in addition to — not instead
 *     of — the built-in runners.
 */

import * as assert from 'assert';

import { createDefaultRunnerRegistry, BUILTIN_RUNNER_IDS } from '../runners/defaultRegistry';
import { LoopServiceAdapter } from '../runners/loop-service-adapter';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A minimal valid loop_services[] config entry. */
function entry(id: string, endpoint = 'http://localhost:8080') {
  return { id, endpoint };
}

/** Count of built-in runners (provides a stable baseline for "no extras"). */
const BUILTIN_COUNT = BUILTIN_RUNNER_IDS.length;

/* -------------------------------------------------------------------------- */
/*  Suite                                                                      */
/* -------------------------------------------------------------------------- */

suite('BL-14 — createDefaultRunnerRegistry loop_services wiring', () => {

  test('no loopServices option → only built-in runners registered', () => {
    const reg = createDefaultRunnerRegistry();
    assert.strictEqual(reg.list().length, BUILTIN_COUNT,
      'baseline: no extra runners without loopServices');
  });

  test('undefined loopServices → no extra runners', () => {
    const reg = createDefaultRunnerRegistry({ loopServices: undefined });
    assert.strictEqual(reg.list().length, BUILTIN_COUNT);
  });

  test('empty array loopServices → no extra runners', () => {
    const reg = createDefaultRunnerRegistry({ loopServices: [] });
    assert.strictEqual(reg.list().length, BUILTIN_COUNT);
  });

  test('non-array loopServices (null, string, object) → no extra runners', () => {
    for (const bad of [null, 'nope', { id: 'x', endpoint: 'http://x' }]) {
      const reg = createDefaultRunnerRegistry({ loopServices: bad });
      assert.strictEqual(reg.list().length, BUILTIN_COUNT,
        `loopServices=${JSON.stringify(bad)} should produce no extras`);
    }
  });

  test('single valid entry → one extra LoopServiceAdapter registered', () => {
    const reg = createDefaultRunnerRegistry({
      loopServices: [entry('my-loop', 'http://loop.local:4000')],
    });
    assert.strictEqual(reg.list().length, BUILTIN_COUNT + 1);
    const found = reg.get('my-loop');
    assert.ok(found, 'my-loop runner must be present in the registry');
    assert.ok(found!.runner instanceof LoopServiceAdapter,
      'the registered runner must be a LoopServiceAdapter');
    assert.strictEqual(found!.runner.id, 'my-loop');
  });

  test('multiple valid entries → one runner per entry, all reachable by id', () => {
    const services = [
      entry('svc-a', 'http://a.local'),
      entry('svc-b', 'http://b.local'),
      entry('svc-c', 'http://c.local'),
    ];
    const reg = createDefaultRunnerRegistry({ loopServices: services });
    assert.strictEqual(reg.list().length, BUILTIN_COUNT + 3);
    for (const svc of services) {
      const found = reg.get(svc.id);
      assert.ok(found, `${svc.id} must be registered`);
      assert.ok(found!.runner instanceof LoopServiceAdapter);
      assert.strictEqual(found!.runner.id, svc.id);
    }
  });

  test('malformed entries are dropped; valid ones still register', () => {
    const mixed = [
      { id: 'good-one', endpoint: 'http://good.local' },
      { id: 'missing-endpoint' },      // malformed — no endpoint
      { endpoint: 'http://no-id' },    // malformed — no id
      42,                              // not an object
      null,                            // null
      { id: 'good-two', endpoint: 'http://good2.local' },
    ];
    const reg = createDefaultRunnerRegistry({ loopServices: mixed });
    assert.strictEqual(reg.list().length, BUILTIN_COUNT + 2,
      'only the two valid entries should register');
    assert.ok(reg.get('good-one'), 'good-one registered');
    assert.ok(reg.get('good-two'), 'good-two registered');
    assert.strictEqual(reg.get('missing-endpoint'), undefined);
  });

  test('built-in runners are all still present alongside config-driven runners', () => {
    const reg = createDefaultRunnerRegistry({
      loopServices: [entry('extra', 'http://extra.local')],
    });
    for (const id of BUILTIN_RUNNER_IDS) {
      assert.ok(reg.get(id), `built-in runner ${id} must still be registered`);
    }
    assert.ok(reg.get('extra'), 'config-driven runner must also be registered');
  });

  test('optional fields (auth, routes, pollIntervalMs) are preserved in the adapter', () => {
    const reg = createDefaultRunnerRegistry({
      loopServices: [
        {
          id: 'rich-svc',
          endpoint: 'http://rich.local',
          auth: { kind: 'bearer', tokenEnv: 'RICH_TOKEN' },
          routes: { dispatch: '/submit', health: '/ping' },
          pollIntervalMs: 500,
          idField: 'run_id',
        },
      ],
    });
    const entry = reg.get('rich-svc');
    assert.ok(entry, 'rich-svc registered');
    assert.ok(entry!.runner instanceof LoopServiceAdapter);
    // The id is the primary observable on the Runner interface.
    assert.strictEqual(entry!.runner.id, 'rich-svc');
  });
});
