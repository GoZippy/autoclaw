import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  workspaceSlug, isValidBeacon, normalizeBeacon, readBeacons, readAllBeacons,
  writeBeacon, machineBeaconDir, BEACON_TTL_MS,
  type Beacon,
} from '../fleet/beacons';

const NOW = new Date('2026-06-13T12:00:00Z').getTime();
const fresh = (offsetMs = 0) => new Date(NOW - offsetMs).toISOString();

function mkBeacon(over: Partial<Beacon> = {}): Beacon {
  return { agent_id: 'kiro-claude', timestamp: fresh(), status: 'active', host: 'kiro', ...over };
}

suite('fleet/beacons — helpers', () => {
  test('workspaceSlug slugs an absolute path to its basename', () => {
    assert.strictEqual(workspaceSlug('k:/Projects/autoclaw-intel'), 'autoclaw-intel');
    assert.strictEqual(workspaceSlug('K:\\Projects\\Webster\\'), 'webster');
    assert.strictEqual(workspaceSlug(undefined), '');
  });

  test('isValidBeacon requires agent_id + timestamp', () => {
    assert.ok(isValidBeacon(mkBeacon()));
    assert.ok(!isValidBeacon({ agent_id: 'x' }));
    assert.ok(!isValidBeacon(null));
    assert.ok(!isValidBeacon('nope'));
  });

  test('normalizeBeacon defaults origin, derives workspace_id, flags staleness', () => {
    const row = normalizeBeacon(mkBeacon({ workspace: 'k:/Projects/autoclaw-intel' }), NOW);
    assert.strictEqual(row.origin, 'beacon');
    assert.strictEqual(row.workspace_id, 'autoclaw-intel');
    assert.strictEqual(row.stale, false);

    const old = normalizeBeacon(mkBeacon({ timestamp: fresh(BEACON_TTL_MS + 1000) }), NOW);
    assert.strictEqual(old.stale, true);
  });
});

suite('fleet/beacons — read/write round-trip', () => {
  let tmp: string;
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aclaw-beacon-')); });
  teardown(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('missing dir → empty array', async () => {
    assert.deepStrictEqual(await readBeacons(path.join(tmp, 'nope')), []);
  });

  test('writeBeacon (machine scope) round-trips through readBeacons', async () => {
    const written = await writeBeacon(mkBeacon({ session_id: 's1' }), { homeDir: tmp });
    assert.ok(written.startsWith(machineBeaconDir(tmp)));
    const rows = await readBeacons(machineBeaconDir(tmp), { now: NOW });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].agent_id, 'kiro-claude');
    assert.strictEqual(rows[0].origin, 'beacon');
  });

  test('readBeacons drops stale unless includeStale, and skips malformed', async () => {
    const dir = machineBeaconDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(mkBeacon({ agent_id: 'a' })));
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(mkBeacon({ agent_id: 'old', timestamp: fresh(BEACON_TTL_MS + 5000) })));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not valid');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x');

    const fresh1 = await readBeacons(dir, { now: NOW });
    assert.deepStrictEqual(fresh1.map(r => r.agent_id), ['a']);

    const withStale = await readBeacons(dir, { now: NOW, includeStale: true });
    assert.strictEqual(withStale.length, 2);
  });

  test('readAllBeacons dedupes by agent|session keeping the freshest', async () => {
    const home = tmp;
    const commsDir = path.join(tmp, 'ws', '.autoclaw', 'orchestrator', 'comms');
    // machine beacon: older
    await writeBeacon(mkBeacon({ agent_id: 'dup', session_id: 's', timestamp: fresh(60_000), current_task: 'old' }), { homeDir: home });
    // workspace beacon: newer
    await writeBeacon(mkBeacon({ agent_id: 'dup', session_id: 's', timestamp: fresh(1_000), current_task: 'new' }), { scope: 'workspace', commsDir });

    const rows = await readAllBeacons({ commsDir, homeDir: home, now: NOW });
    const dup = rows.filter(r => r.agent_id === 'dup');
    assert.strictEqual(dup.length, 1);
    assert.strictEqual(dup[0].current_task, 'new');
  });
});
