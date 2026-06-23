/**
 * scopeLease.test.ts — CL-4 file-scope leases.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  globsOverlap, detectConflicts, declareScope, releaseScope, readLeases, gcExpiredLeases,
  type ScopeLease,
} from '../orchestrator/scopeLease';

const NOW = new Date('2026-06-23T12:00:00Z').getTime();
const future = new Date(NOW + 60 * 60_000).toISOString();
const past = new Date(NOW - 1000).toISOString();

function lease(over: Partial<ScopeLease> & { session_id: string; globs: string[] }): ScopeLease {
  return { agent_id: 'claude-code', created_at: new Date(NOW).toISOString(), expires_at: future, ...over };
}

suite('scopeLease — globsOverlap', () => {
  test('equal globs overlap', () => assert.ok(globsOverlap('src/extension.ts', 'src/extension.ts')));
  test('wildcard contains a literal file', () => assert.ok(globsOverlap('src/**', 'src/foo.ts')));
  test('nested dir wildcard vs literal', () => assert.ok(globsOverlap('src/panel/**', 'src/panel/fleet.ts')));
  test('two distinct literal files do NOT overlap', () => assert.ok(!globsOverlap('src/a.ts', 'src/b.ts')));
  test('disjoint wildcard dirs do NOT overlap', () => assert.ok(!globsOverlap('src/**', 'docs/**')));
  test('nested wildcards overlap', () => assert.ok(globsOverlap('src/**', 'src/panel/**')));
  test('"**" overlaps everything', () => assert.ok(globsOverlap('**', 'anything/here.ts')));
  test('literal not under the other wildcard does NOT overlap', () => assert.ok(!globsOverlap('docs/x.md', 'src/**')));
});

suite('scopeLease — detectConflicts', () => {
  test('two different sessions with overlapping globs → 1 conflict', () => {
    const c = detectConflicts([
      lease({ session_id: 's1', globs: ['src/extension.ts'] }),
      lease({ session_id: 's2', agent_id: 'kilocode', globs: ['src/**'] }),
    ], NOW);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].glob_a, 'src/extension.ts');
    assert.strictEqual(c[0].glob_b, 'src/**');
  });
  test('same session never conflicts with itself', () => {
    const c = detectConflicts([
      lease({ session_id: 's1', globs: ['src/extension.ts'] }),
      lease({ session_id: 's1', globs: ['src/**'] }),
    ], NOW);
    assert.strictEqual(c.length, 0);
  });
  test('expired leases are ignored', () => {
    const c = detectConflicts([
      lease({ session_id: 's1', globs: ['src/**'] }),
      lease({ session_id: 's2', globs: ['src/x.ts'], expires_at: past }),
    ], NOW);
    assert.strictEqual(c.length, 0);
  });
  test('non-overlapping sessions → 0 conflicts', () => {
    const c = detectConflicts([
      lease({ session_id: 's1', globs: ['src/a.ts'] }),
      lease({ session_id: 's2', globs: ['docs/**'] }),
    ], NOW);
    assert.strictEqual(c.length, 0);
  });
});

suite('scopeLease — IO', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const leasesDir = () => path.join(dir, '.autoclaw', 'orchestrator', 'comms', 'leases');
  const sharedDir = () => path.join(dir, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');

  test('declareScope writes a lease, no conflict when alone', async () => {
    const res = await declareScope(dir, { agent_id: 'claude-code', session_id: 's1', globs: ['src/**'], now: NOW });
    assert.strictEqual(res.conflicts.length, 0);
    assert.strictEqual((await readLeases(dir)).length, 1);
  });

  test('overlapping declare emits a scope_violation finding', async () => {
    await declareScope(dir, { agent_id: 'kilocode', session_id: 's2', globs: ['src/extension.ts'], now: NOW });
    const res = await declareScope(dir, { agent_id: 'claude-code', session_id: 's1', globs: ['src/**'], now: NOW });
    assert.strictEqual(res.conflicts.length, 1);
    const findings = fs.readdirSync(sharedDir()).filter(f => f.includes('scope_violation'));
    assert.strictEqual(findings.length, 1);
  });

  test('releaseScope removes the lease', async () => {
    await declareScope(dir, { agent_id: 'claude-code', session_id: 's1', globs: ['src/**'], now: NOW });
    assert.ok(await releaseScope(dir, 'claude-code', 's1'));
    assert.strictEqual((await readLeases(dir)).length, 0);
  });

  test('re-declaring refreshes (one lease per session, not duplicated)', async () => {
    await declareScope(dir, { agent_id: 'claude-code', session_id: 's1', globs: ['src/a.ts'], now: NOW });
    await declareScope(dir, { agent_id: 'claude-code', session_id: 's1', globs: ['src/b.ts'], now: NOW });
    const ls = await readLeases(dir);
    assert.strictEqual(ls.length, 1);
    assert.deepStrictEqual(ls[0].globs, ['src/b.ts']);
  });

  test('gcExpiredLeases removes only expired files', async () => {
    fs.mkdirSync(leasesDir(), { recursive: true });
    fs.writeFileSync(path.join(leasesDir(), 'a-old.json'), JSON.stringify({ agent_id: 'a', session_id: 'old', globs: ['x'], expires_at: past }));
    fs.writeFileSync(path.join(leasesDir(), 'a-new.json'), JSON.stringify({ agent_id: 'a', session_id: 'new', globs: ['y'], expires_at: future }));
    const reaped = await gcExpiredLeases(dir, NOW);
    assert.strictEqual(reaped, 1);
    assert.strictEqual((await readLeases(dir)).length, 1);
  });

  test('missing leases dir → readLeases [] / gc 0, no throw', async () => {
    assert.deepStrictEqual(await readLeases(dir), []);
    assert.strictEqual(await gcExpiredLeases(dir, NOW), 0);
  });
});
