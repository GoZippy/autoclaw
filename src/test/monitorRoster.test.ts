import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeMonitorPresence, readMonitorRoster, pruneStaleMonitorPresence,
  monitorDir, monitorPresencePath, MONITOR_PRESENCE_TTL_MS,
} from '../orchestrator/monitorRoster';

function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monroster-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return root;
}
const T0 = Date.parse('2026-06-24T12:00:00.000Z');
const iso = (t: number): string => new Date(t).toISOString();

suite('monitorRoster — presence write/read (E2b-ii)', () => {
  test('write then read round-trips with age_ms 0 for a fresh presence', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-A', timestamp: iso(T0) });
    const rows = await readMonitorRoster(ws, { now: T0, ttlMs: MONITOR_PRESENCE_TTL_MS });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].instance_id, 'loop-A');
    assert.strictEqual(rows[0].age_ms, 0);
  });

  test('age_ms is computed from the timestamp vs now', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-A', timestamp: iso(T0) });
    const rows = await readMonitorRoster(ws, { now: T0 + 5_000 });
    assert.strictEqual(rows[0].age_ms, 5_000);
  });

  test('STALE presences (age > ttl) are dropped; includeStale keeps them', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-A', timestamp: iso(T0) });
    assert.deepStrictEqual(await readMonitorRoster(ws, { now: T0 + MONITOR_PRESENCE_TTL_MS + 1 }), []);
    const withStale = await readMonitorRoster(ws, { now: T0 + MONITOR_PRESENCE_TTL_MS + 1, includeStale: true });
    assert.strictEqual(withStale.length, 1);
  });

  test('malformed files are skipped; multiple valid presences are read', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-A', timestamp: iso(T0) });
    await writeMonitorPresence(ws, { instance_id: 'loop-B', timestamp: iso(T0) });
    fs.writeFileSync(path.join(monitorDir(ws), 'garbage.json'), '{not json', 'utf8');
    fs.writeFileSync(path.join(monitorDir(ws), 'no-id.json'), JSON.stringify({ timestamp: iso(T0) }), 'utf8');
    const rows = await readMonitorRoster(ws, { now: T0 });
    assert.deepStrictEqual(rows.map((r) => r.instance_id).sort(), ['loop-A', 'loop-B']);
  });

  test('the atomic write leaves NO .tmp- sibling and readers ignore .tmp- files', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-A', timestamp: iso(T0) });
    assert.ok(!fs.readdirSync(monitorDir(ws)).some((f) => f.includes('.tmp-')), 'no temp sibling left');
    fs.writeFileSync(path.join(monitorDir(ws), 'loop-B.json.tmp-9-9'), JSON.stringify({ instance_id: 'loop-B', timestamp: iso(T0) }), 'utf8');
    assert.deepStrictEqual((await readMonitorRoster(ws, { now: T0 })).map((r) => r.instance_id), ['loop-A']);
  });

  test('missing dir → [] (no throw)', async () => {
    const ws = makeWs();
    assert.deepStrictEqual(await readMonitorRoster(ws, { now: T0 }), []);
  });

  test('monitorPresencePath sanitizes the instance id into the filename', () => {
    const ws = makeWs();
    assert.ok(monitorPresencePath(ws, 'orchestrator-loop-ab12cd').endsWith(path.join('monitors', 'orchestrator-loop-ab12cd.json')));
  });

  test('pruneStaleMonitorPresence reaps LONG-dead presences, leaves fresh + malformed', async () => {
    const ws = makeWs();
    await writeMonitorPresence(ws, { instance_id: 'loop-fresh', timestamp: iso(T0) });
    await writeMonitorPresence(ws, { instance_id: 'loop-dead', timestamp: iso(T0 - MONITOR_PRESENCE_TTL_MS * 11) });
    fs.writeFileSync(path.join(monitorDir(ws), 'garbage.json'), '{bad', 'utf8');
    const removed = await pruneStaleMonitorPresence(ws, { now: T0, ttlMs: MONITOR_PRESENCE_TTL_MS });
    assert.strictEqual(removed, 1, 'only the long-dead presence reaped');
    assert.ok(fs.existsSync(monitorPresencePath(ws, 'loop-fresh')), 'fresh kept');
    assert.ok(!fs.existsSync(monitorPresencePath(ws, 'loop-dead')), 'dead reaped');
    assert.ok(fs.existsSync(path.join(monitorDir(ws), 'garbage.json')), 'malformed left (transient-safe)');
  });
});
