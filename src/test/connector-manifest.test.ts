/**
 * connector-manifest.test.ts — acp/1 manifest validation + discovery (Phase 0).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  validateConnectorManifest, parseConnectorManifest, satisfiesAbiRange,
} from '../connector/manifest';
import { discoverConnectorManifests } from '../connector/discovery';

const SIGNED = {
  acp: 'acp/1', id: 'acme-foo', kind: 'source', displayName: 'Acme Foo',
  version: '1.4.2', tier: 3, abiRange: '>=2.0 <3.0', provides: ['source', 'presence'],
  permissions: { reads: ['~/.acme/**'], network: 'none' }, signature: 'deadbeef',
};

suite('acp/1 — satisfiesAbiRange', () => {
  test('empty/absent range is permissive', () => {
    assert.strictEqual(satisfiesAbiRange(undefined), true);
    assert.strictEqual(satisfiesAbiRange(''), true);
  });
  test('host 2.0 satisfies ">=2.0 <3.0"', () => assert.strictEqual(satisfiesAbiRange('>=2.0 <3.0', '2.0'), true));
  test('host 2.0 fails ">=2.1"', () => assert.strictEqual(satisfiesAbiRange('>=2.1', '2.0'), false));
  test('host 2.0 fails "<2.0"', () => assert.strictEqual(satisfiesAbiRange('<2.0', '2.0'), false));
  test('exact "=2.0" matches', () => assert.strictEqual(satisfiesAbiRange('=2.0', '2.0'), true));
  test('unparseable range fails closed', () => assert.strictEqual(satisfiesAbiRange('garbage', '2.0'), false));
});

suite('acp/1 — validateConnectorManifest', () => {
  test('valid signed manifest → ok, verified', () => {
    const r = validateConnectorManifest(SIGNED);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.unverified, false);
    assert.strictEqual(r.manifest?.tier, 3);
  });
  test('unsigned manifest → ok but unverified', () => {
    const { signature, ...unsigned } = SIGNED;
    const r = validateConnectorManifest(unsigned);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.unverified, true);
  });
  test('non-object → disabled', () => {
    assert.strictEqual(validateConnectorManifest(null).status, 'disabled');
    assert.strictEqual(validateConnectorManifest([1] as unknown).status, 'disabled');
  });
  test('missing acp → disabled', () => {
    const { acp, ...m } = SIGNED;
    assert.strictEqual(validateConnectorManifest(m).status, 'disabled');
  });
  test('acp/2 → shelved (not crashed)', () => {
    const r = validateConnectorManifest({ ...SIGNED, acp: 'acp/2' });
    assert.strictEqual(r.status, 'shelved');
    assert.strictEqual(r.ok, false);
  });
  test('bad id (path separator) → disabled', () => {
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, id: '../evil' }).status, 'disabled');
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, id: '' }).status, 'disabled');
  });
  test('empty/invalid provides → disabled', () => {
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, provides: [] }).status, 'disabled');
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, provides: ['wat'] }).status, 'disabled');
  });
  test('malformed permissions → disabled (fail-closed)', () => {
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, permissions: 'all' }).status, 'disabled');
  });
  test('tier defaults to 3 when omitted', () => {
    const { tier, ...m } = SIGNED;
    assert.strictEqual(validateConnectorManifest(m).manifest?.tier, 3);
  });
  test('invalid tier → disabled', () => {
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, tier: 4 }).status, 'disabled');
  });
  test('a runner forces tier ≥ 2 (3 → 2)', () => {
    const r = validateConnectorManifest({ ...SIGNED, tier: 3, provides: ['runner'] });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.manifest?.tier, 2);
  });
  test('abiRange the host cannot satisfy → shelved', () => {
    assert.strictEqual(validateConnectorManifest({ ...SIGNED, abiRange: '>=3.0' }).status, 'shelved');
  });
  test('unknown/forward fields preserved on the normalized manifest', () => {
    const r = validateConnectorManifest({ ...SIGNED, futureField: { nested: 1 } });
    assert.deepStrictEqual((r.manifest as Record<string, unknown>).futureField, { nested: 1 });
  });
  test('parseConnectorManifest tolerates bad JSON', () => {
    assert.strictEqual(parseConnectorManifest('{not json').status, 'disabled');
  });
});

suite('acp/1 — discoverConnectorManifests', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeConnector(base: string, id: string, manifest: unknown): void {
    const d = path.join(base, '.autoclaw', 'connectors', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'connector.json'), JSON.stringify(manifest));
  }

  test('scans workspace plugins, validates each', async () => {
    const ws = path.join(dir, 'ws'); fs.mkdirSync(ws, { recursive: true });
    writeConnector(ws, 'acme-foo', SIGNED);
    writeConnector(ws, 'future', { ...SIGNED, id: 'future', acp: 'acp/2' });
    fs.mkdirSync(path.join(ws, '.autoclaw', 'connectors', 'empty'), { recursive: true }); // no connector.json
    const found = await discoverConnectorManifests({ workspaceRoot: ws });
    assert.strictEqual(found.length, 3);
    const byId = Object.fromEntries(found.map(f => [f.id, f.validation.status]));
    assert.strictEqual(byId['acme-foo'], 'ok');
    assert.strictEqual(byId['future'], 'shelved');
    assert.strictEqual(byId['empty'], 'disabled');
  });

  test('workspace wins over user on id collision', async () => {
    const ws = path.join(dir, 'ws'); const home = path.join(dir, 'home');
    fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(home, { recursive: true });
    writeConnector(ws, 'dup', { ...SIGNED, id: 'dup', displayName: 'WS' });
    writeConnector(home, 'dup', { ...SIGNED, id: 'dup', displayName: 'USER' });
    const found = await discoverConnectorManifests({ workspaceRoot: ws, homeDir: home });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].origin, 'workspace');
    assert.strictEqual(found[0].validation.manifest?.displayName, 'WS');
  });

  test('missing roots → [], no throw', async () => {
    assert.deepStrictEqual(await discoverConnectorManifests({ workspaceRoot: dir, homeDir: dir }), []);
  });
});
