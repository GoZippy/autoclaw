import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readDependencies, writeDependencies, consumersOf, addDependency,
  backendFor, seedZippyStack, emptyDependenciesDoc, globMatch,
  dependenciesPath, DependencyEdge,
} from '../program/dependencies';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
}

const PROGRAM_ID = 'prog_test_dr1';

suite('Program Dependency Registry', () => {

  test('consumersOf matches an edge when changedPaths intersect consumed_via', () => {
    const doc = seedZippyStack();
    // checkitfixit consumes payments-api via src/services/payments/**.
    const matched = consumersOf(doc, 'guru-connect', ['src/services/payments/intents.ts']);
    assert.ok(matched.length >= 1, 'should match at least the checkitfixit edge');
    assert.ok(matched.some(e => e.consumer === 'checkitfixit'));
  });

  test('consumersOf returns [] for a non-matching producer', () => {
    const doc = seedZippyStack();
    const matched = consumersOf(doc, 'some-other-project', ['src/services/payments/intents.ts']);
    assert.deepStrictEqual(matched, []);
  });

  test('consumersOf returns [] when changedPaths miss the consumed_via globs', () => {
    const doc = seedZippyStack();
    // guru-connect IS a producer, but this path is in no consumer's contract surface.
    const matched = consumersOf(doc, 'guru-connect', ['README.md', 'docs/notes.md']);
    assert.deepStrictEqual(matched, []);
  });

  test('consumersOf matches multiple consumers when each surface is touched', () => {
    const doc = seedZippyStack();
    const matched = consumersOf(doc, 'guru-connect', [
      'src/services/payments/gateway.ts',       // checkitfixit
      'apps/main-app/src/billing/invoice.ts',   // zippyhealth
    ]);
    const consumers = matched.map(e => e.consumer).sort();
    assert.deepStrictEqual(consumers, ['checkitfixit', 'zippyhealth']);
  });

  test('addDependency is idempotent on (consumer,producer,api) and updates version', () => {
    const doc = emptyDependenciesDoc();
    const edge: DependencyEdge = {
      consumer: 'checkitfixit', producer: 'guru-connect', api: 'payments-api',
      version: 'v2', consumed_via: ['src/services/payments/**'], notify: ['po-checkitfixit'],
    };
    addDependency(doc, edge);
    assert.strictEqual(doc.dependencies.length, 1);

    // Re-add same triple with a bumped version + new globs/notify.
    addDependency(doc, {
      ...edge, version: 'v3', consumed_via: ['src/payments/**'], notify: ['po-checkitfixit', 'claude-code'],
    });
    assert.strictEqual(doc.dependencies.length, 1, 'must not duplicate the triple');
    assert.strictEqual(doc.dependencies[0].version, 'v3');
    assert.deepStrictEqual(doc.dependencies[0].consumed_via, ['src/payments/**']);
    assert.deepStrictEqual(doc.dependencies[0].notify, ['po-checkitfixit', 'claude-code']);

    // A different api on the same pair IS a distinct edge.
    addDependency(doc, { ...edge, api: 'tenant-api' });
    assert.strictEqual(doc.dependencies.length, 2);
  });

  test('backendFor returns the abstract-capability backend', () => {
    const doc = seedZippyStack();
    const backend = backendFor(doc, 'payments-api');
    assert.ok(backend, 'payments-api backend should exist');
    assert.strictEqual(backend!.current, 'guru-connect-internal');
    assert.ok(backend!.interchangeable.includes('stripe-adapter'));
    assert.strictEqual(backendFor(doc, 'no-such-api'), undefined);
  });

  test('seedZippyStack: guru-connect is the highest-fan-out producer (>=2 payments-api consumers)', () => {
    const doc = seedZippyStack();
    const paymentsConsumers = doc.dependencies.filter(
      e => e.producer === 'guru-connect' && e.api === 'payments-api',
    );
    assert.ok(paymentsConsumers.length >= 2, 'guru-connect should fan out to >=2 consumers of payments-api');
    // Vendor-neutral: the edges name the abstract capability, not a vendor.
    assert.ok(doc.dependencies.every(e => e.api === 'payments-api'));
    assert.ok(doc.projects['guru-connect'].provides!.includes('payments-api'));
  });

  test('round-trip read/write preserves the doc', async () => {
    const home = makeTmpDir();
    const doc = seedZippyStack();
    await writeDependencies(home, PROGRAM_ID, doc);

    // updated_at gets stamped on write.
    assert.ok(doc.updated_at.length > 0);
    assert.ok(fs.existsSync(dependenciesPath(home, PROGRAM_ID)));

    const onDisk = await readDependencies(home, PROGRAM_ID);
    assert.strictEqual(onDisk.schema_version, '1.0');
    assert.strictEqual(onDisk.dependencies.length, doc.dependencies.length);
    assert.deepStrictEqual(onDisk.projects, doc.projects);
    assert.deepStrictEqual(onDisk.backends, doc.backends);
    assert.strictEqual(onDisk.updated_at, doc.updated_at);
  });

  test('readDependencies tolerates a missing file with an empty well-formed doc', async () => {
    const home = makeTmpDir();
    const doc = await readDependencies(home, 'prog_does_not_exist');
    assert.strictEqual(doc.schema_version, '1.0');
    assert.deepStrictEqual(doc.dependencies, []);
    assert.deepStrictEqual(doc.projects, {});
  });

  test('globMatch handles **, *, and literal segments', () => {
    assert.ok(globMatch('src/services/payments/**', 'src/services/payments/intents.ts'));
    assert.ok(globMatch('src/services/payments/**', 'src/services/payments')); // ** matches zero segments
    assert.ok(globMatch('src/*.ts', 'src/index.ts'));
    assert.ok(!globMatch('src/*.ts', 'src/sub/index.ts')); // single * does not cross a separator
    assert.ok(globMatch('apps/main-app/src/billing/**', 'apps\\main-app\\src\\billing\\invoice.ts')); // backslash input
  });
});
