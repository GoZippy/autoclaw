import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireLease, renewLease, releaseLease, readLeases, writeLeases,
  isStale, isExpired, isLive, scopesIntersect, leasesPath,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  Lease, LeaseRequest,
} from '../program/leases';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leases-test-'));
}

const PROGRAM = 'prog_test';
// A fixed epoch base so derived ISO timestamps are deterministic.
const T0 = Date.parse('2026-06-15T00:00:00.000Z');

function req(over: Partial<LeaseRequest> = {}): LeaseRequest {
  return {
    project: 'webster',
    owner: 'claude-code',
    session_id: 'sess-1',
    role: 'coder',
    scope: ['src/payments/**'],
    exclusivity: 'exclusive',
    ...over,
  };
}

suite('Scope-Lease Primitive', () => {

  test('exclusive vs exclusive overlapping scope in same project → second denied with conflictsWith', async () => {
    const home = makeTmpDir();
    const first = await acquireLease(home, PROGRAM, req(), { now: T0 });
    assert.strictEqual(first.granted, true);

    const second = await acquireLease(
      home, PROGRAM,
      req({ owner: 'kilocode', session_id: 'sess-2', scope: ['src/payments/gateways/**'] }),
      { now: T0 }
    );
    assert.strictEqual(second.granted, false);
    assert.ok(second.conflictsWith && second.conflictsWith.length === 1);
    assert.strictEqual(second.conflictsWith![0], first.lease!.lease_id);

    // Only the first lease persisted (first writer wins).
    const doc = await readLeases(home, PROGRAM);
    assert.strictEqual(doc.leases.length, 1);
  });

  test('shared-read overlap → both granted', async () => {
    const home = makeTmpDir();
    const a = await acquireLease(home, PROGRAM, req({ exclusivity: 'shared-read' }), { now: T0 });
    const b = await acquireLease(
      home, PROGRAM,
      req({ owner: 'kilocode', session_id: 'sess-2', exclusivity: 'shared-read' }),
      { now: T0 }
    );
    assert.strictEqual(a.granted, true);
    assert.strictEqual(b.granted, true);
    const doc = await readLeases(home, PROGRAM);
    assert.strictEqual(doc.leases.length, 2);
  });

  test('two exclusive in same project with NON-overlapping scopes → both granted', async () => {
    const home = makeTmpDir();
    const a = await acquireLease(home, PROGRAM, req({ scope: ['src/payments/**'] }), { now: T0 });
    const b = await acquireLease(
      home, PROGRAM,
      req({ owner: 'kilocode', session_id: 'sess-2', scope: ['src/auth/**'] }),
      { now: T0 }
    );
    assert.strictEqual(a.granted, true);
    assert.strictEqual(b.granted, true);
  });

  test('renew extends lease_expires and bumps heartbeat', async () => {
    const home = makeTmpDir();
    const a = await acquireLease(home, PROGRAM, req(), { now: T0 });
    const originalExpires = a.lease!.lease_expires;

    const later = T0 + 5 * 60 * 1000; // +5 min
    const renewed = await renewLease(home, PROGRAM, a.lease!.lease_id, { now: later });
    assert.ok(renewed);
    assert.ok(
      Date.parse(renewed!.lease_expires) > Date.parse(originalExpires),
      'lease_expires should move forward'
    );
    assert.strictEqual(renewed!.heartbeat, new Date(later).toISOString());
  });

  test('renew is no-op-safe when lease missing', async () => {
    const home = makeTmpDir();
    const result = await renewLease(home, PROGRAM, 'lease_nonexistent', { now: T0 });
    assert.strictEqual(result, null);
  });

  test('a lease past 2× heartbeat is stale and a fresh acquire over its scope succeeds (reclaim)', async () => {
    const home = makeTmpDir();
    // Long TTL so the lease is NOT passively expired — only stale via heartbeat.
    const a = await acquireLease(home, PROGRAM, req({ ttl_sec: 3600 }), { now: T0 });
    assert.strictEqual(a.granted, true);

    // Advance past 2× the heartbeat interval (but well within the 1h TTL).
    const staleAt = T0 + (2 * DEFAULT_HEARTBEAT_INTERVAL_SEC + 1) * 1000;
    assert.strictEqual(isStale(a.lease!, staleAt), true);
    assert.strictEqual(isExpired(a.lease!, staleAt), false);

    const reclaim = await acquireLease(
      home, PROGRAM,
      req({ owner: 'kilocode', session_id: 'sess-2' }),
      { now: staleAt }
    );
    assert.strictEqual(reclaim.granted, true, 'stale lease should not block reclaim');
  });

  test('release frees the scope for a new exclusive acquire', async () => {
    const home = makeTmpDir();
    const a = await acquireLease(home, PROGRAM, req(), { now: T0 });
    const released = await releaseLease(home, PROGRAM, a.lease!.lease_id, { now: T0 });
    assert.strictEqual(released, true);

    // Released lease is no longer live.
    const doc = await readLeases(home, PROGRAM);
    const stored = doc.leases.find(l => l.lease_id === a.lease!.lease_id)!;
    assert.strictEqual(isLive(stored, T0), false);

    const b = await acquireLease(
      home, PROGRAM,
      req({ owner: 'kilocode', session_id: 'sess-2' }),
      { now: T0 }
    );
    assert.strictEqual(b.granted, true);
  });

  test('cross-project same-scope never conflicts', async () => {
    const home = makeTmpDir();
    const a = await acquireLease(home, PROGRAM, req({ project: 'webster' }), { now: T0 });
    const b = await acquireLease(
      home, PROGRAM,
      req({ project: 'zippyswap', owner: 'kilocode', session_id: 'sess-2' }),
      { now: T0 }
    );
    assert.strictEqual(a.granted, true);
    assert.strictEqual(b.granted, true);
  });

  test('readLeases tolerates a missing file', async () => {
    const home = makeTmpDir();
    const doc = await readLeases(home, PROGRAM);
    assert.strictEqual(doc.schema_version, '1.0');
    assert.deepStrictEqual(doc.leases, []);
  });

  test('writeLeases is atomic and stamps updated_at', async () => {
    const home = makeTmpDir();
    const lease: Lease = {
      lease_id: 'lease_x', project: 'p', owner: 'o', session_id: 's', role: 'coder',
      scope: ['src/**'], exclusivity: 'exclusive',
      lease_granted: new Date(T0).toISOString(),
      lease_expires: new Date(T0 + 1000).toISOString(),
      heartbeat: new Date(T0).toISOString(),
      heartbeat_interval_sec: DEFAULT_HEARTBEAT_INTERVAL_SEC, released: false,
    };
    await writeLeases(home, PROGRAM, { schema_version: '1.0', updated_at: '', leases: [lease] }, { now: T0 });
    const raw = fs.readFileSync(leasesPath(home, PROGRAM), 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.updated_at, new Date(T0).toISOString());
    assert.strictEqual(parsed.leases.length, 1);
  });

  test('scopesIntersect: prefix overlap detected, disjoint paths do not', () => {
    assert.strictEqual(scopesIntersect(['src/payments/**'], ['src/payments/gateways/**']), true);
    assert.strictEqual(scopesIntersect(['src/**'], ['src/auth/login.ts']), true);
    assert.strictEqual(scopesIntersect(['src/payments/**'], ['src/auth/**']), false);
  });
});
