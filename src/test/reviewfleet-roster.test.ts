/**
 * reviewfleet-roster.test.ts — RF-1 unit tests.
 *
 * All tests use STUBBED RosterDeps — no real detect(), network, or filesystem.
 */

import * as assert from 'assert';
import {
  buildReviewerRoster,
  rankReviewers,
  type RosterDeps,
  type ReviewerCapacity,
} from '../reviewfleet/roster';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeRunnerDeps(
  runners: Array<{ id: string; enabled: boolean }>,
): RosterDeps {
  return {
    scanRunners: async () => runners,
    scanLocalModels: async () => [],
    scanRemote: async () => [],
  };
}

function makeModelDeps(
  models: Array<{ providerId: string; model: string; locality: 'local' | 'lan' | 'cloud' }>,
): RosterDeps {
  return {
    scanRunners: async () => [],
    scanLocalModels: async () => models,
    scanRemote: async () => [],
  };
}

function makeRemoteDeps(
  remotes: Array<{ agent_id: string; host?: string; healthy: boolean }>,
): RosterDeps {
  return {
    scanRunners: async () => [],
    scanLocalModels: async () => [],
    scanRemote: async () => remotes,
  };
}

function emptyDeps(): RosterDeps {
  return {
    scanRunners: async () => [],
    scanLocalModels: async () => [],
    scanRemote: async () => [],
  };
}

function throwingDeps(): RosterDeps {
  return {
    scanRunners: async () => { throw new Error('runner scan failed'); },
    scanLocalModels: async () => { throw new Error('model scan failed'); },
    scanRemote: async () => { throw new Error('remote scan failed'); },
    reputationById: async () => { throw new Error('rep scan failed'); },
  };
}

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — runners                                              */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — runners', () => {
  test('cloud runner ids map to locality=cloud, costTier=paid, strength=strong', async () => {
    const cloudRunners = ['claude-code', 'codex', 'cursor', 'kiro', 'gemini-cli'];
    const roster = await buildReviewerRoster(makeRunnerDeps(
      cloudRunners.map((id) => ({ id, enabled: true })),
    ));
    for (const r of roster) {
      assert.strictEqual(r.kind, 'runner', `${r.id} kind`);
      assert.strictEqual(r.locality, 'cloud', `${r.id} locality`);
      assert.strictEqual(r.costTier, 'paid', `${r.id} costTier`);
      assert.strictEqual(r.strength, 'strong', `${r.id} strength`);
      assert.strictEqual(r.healthy, true, `${r.id} healthy`);
    }
  });

  test('non-cloud runner ids map to locality=local, costTier=free, strength=cheap', async () => {
    const localRunners = ['hermes', 'openclaw', 'autogpt'];
    const roster = await buildReviewerRoster(makeRunnerDeps(
      localRunners.map((id) => ({ id, enabled: true })),
    ));
    for (const r of roster) {
      assert.strictEqual(r.locality, 'local', `${r.id} locality`);
      assert.strictEqual(r.costTier, 'free', `${r.id} costTier`);
      assert.strictEqual(r.strength, 'cheap', `${r.id} strength`);
    }
  });

  test('disabled runner (enabled=false) → healthy=false', async () => {
    const roster = await buildReviewerRoster(makeRunnerDeps([
      { id: 'claude-code', enabled: false },
    ]));
    assert.strictEqual(roster.length, 1);
    assert.strictEqual(roster[0].healthy, false);
  });
});

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — local models                                        */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — local models', () => {
  test('local small model → kind=model, costTier=free, strength=cheap', async () => {
    const roster = await buildReviewerRoster(makeModelDeps([
      { providerId: 'ollama', model: 'llama3.1:8b', locality: 'local' },
    ]));
    assert.strictEqual(roster.length, 1);
    const r = roster[0];
    assert.strictEqual(r.id, 'ollama:llama3.1:8b');
    assert.strictEqual(r.kind, 'model');
    assert.strictEqual(r.locality, 'local');
    assert.strictEqual(r.costTier, 'free');
    assert.strictEqual(r.strength, 'cheap');
    assert.strictEqual(r.healthy, true);
  });

  test('local large model (70b) → strength=strong', async () => {
    const roster = await buildReviewerRoster(makeModelDeps([
      { providerId: 'ollama', model: 'llama3.1:70b', locality: 'local' },
    ]));
    assert.strictEqual(roster[0].strength, 'strong');
  });

  test('LAN model → costTier=free, strength=strong', async () => {
    const roster = await buildReviewerRoster(makeModelDeps([
      { providerId: 'zippymesh', model: 'auto', locality: 'lan' },
    ]));
    const r = roster[0];
    assert.strictEqual(r.locality, 'lan');
    assert.strictEqual(r.costTier, 'free');
    assert.strictEqual(r.strength, 'strong');
  });

  test('cloud model → costTier=paid, strength=strong', async () => {
    const roster = await buildReviewerRoster(makeModelDeps([
      { providerId: 'lmstudio', model: 'gpt-4o', locality: 'cloud' },
    ]));
    const r = roster[0];
    assert.strictEqual(r.locality, 'cloud');
    assert.strictEqual(r.costTier, 'paid');
    assert.strictEqual(r.strength, 'strong');
  });
});

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — remote beacons                                      */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — remote agents', () => {
  test('remote beacon maps to kind=remote, locality=lan, costTier=free, strength=cheap', async () => {
    const roster = await buildReviewerRoster(makeRemoteDeps([
      { agent_id: 'kiro-remote', host: 'desktop2', healthy: true },
    ]));
    assert.strictEqual(roster.length, 1);
    const r = roster[0];
    assert.strictEqual(r.kind, 'remote');
    assert.strictEqual(r.id, 'kiro-remote');
    assert.strictEqual(r.host, 'desktop2');
    assert.strictEqual(r.locality, 'lan');
    assert.strictEqual(r.costTier, 'free');
    assert.strictEqual(r.strength, 'cheap');
    assert.strictEqual(r.healthy, true);
  });

  test('unhealthy remote beacon → healthy=false', async () => {
    const roster = await buildReviewerRoster(makeRemoteDeps([
      { agent_id: 'dead-agent', healthy: false },
    ]));
    assert.strictEqual(roster[0].healthy, false);
  });
});

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — dedup                                               */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — dedup', () => {
  test('runner wins over remote when they share the same id', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => [{ id: 'claude-code', enabled: true }],
      scanLocalModels: async () => [],
      scanRemote: async () => [{ agent_id: 'claude-code', host: 'remotehost', healthy: true }],
    };
    const roster = await buildReviewerRoster(deps);
    const hits = roster.filter((r) => r.id === 'claude-code');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].kind, 'runner'); // runner wins
  });

  test('dedup across planes — each id appears exactly once', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => [
        { id: 'claude-code', enabled: true },
        { id: 'hermes', enabled: true },
      ],
      scanLocalModels: async () => [
        { providerId: 'ollama', model: 'llama3:8b', locality: 'local' },
      ],
      scanRemote: async () => [
        { agent_id: 'kiro-peer', healthy: true },
      ],
    };
    const roster = await buildReviewerRoster(deps);
    const ids = roster.map((r) => r.id);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length);
    assert.strictEqual(roster.length, 4);
  });
});

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — reputation attachment                               */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — reputation', () => {
  test('reputation scores attach to matching ids', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => [
        { id: 'claude-code', enabled: true },
        { id: 'kiro', enabled: true },
      ],
      scanLocalModels: async () => [],
      scanRemote: async () => [],
      reputationById: async () => ({ 'claude-code': 0.95, 'kiro': 0.72 }),
    };
    const roster = await buildReviewerRoster(deps);
    const cc = roster.find((r) => r.id === 'claude-code');
    const ki = roster.find((r) => r.id === 'kiro');
    assert.strictEqual(cc?.reputation, 0.95);
    assert.strictEqual(ki?.reputation, 0.72);
  });

  test('id without reputation entry → reputation field absent', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => [{ id: 'hermes', enabled: true }],
      scanLocalModels: async () => [],
      scanRemote: async () => [],
      reputationById: async () => ({ 'claude-code': 0.9 }), // different id
    };
    const roster = await buildReviewerRoster(deps);
    assert.strictEqual(roster[0].reputation, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster — graceful degradation                                */
/* -------------------------------------------------------------------------- */

suite('buildReviewerRoster — graceful degradation', () => {
  test('all scanners throw → empty roster (no throw propagated)', async () => {
    const roster = await buildReviewerRoster(throwingDeps());
    assert.deepStrictEqual(roster, []);
  });

  test('one scanner throws → partial roster from non-throwing scanners', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => { throw new Error('runners unavailable'); },
      scanLocalModels: async () => [
        { providerId: 'ollama', model: 'llama3:8b', locality: 'local' },
      ],
      scanRemote: async () => [{ agent_id: 'remote-1', healthy: true }],
    };
    const roster = await buildReviewerRoster(deps);
    // runners contributed nothing (threw); models + remotes contribute 2
    assert.strictEqual(roster.length, 2);
    const kinds = new Set(roster.map((r) => r.kind));
    assert.ok(kinds.has('model'));
    assert.ok(kinds.has('remote'));
    assert.ok(!kinds.has('runner'));
  });

  test('reputationById throws → roster still built, reputation fields absent', async () => {
    const deps: RosterDeps = {
      scanRunners: async () => [{ id: 'claude-code', enabled: true }],
      scanLocalModels: async () => [],
      scanRemote: async () => [],
      reputationById: async () => { throw new Error('rep error'); },
    };
    const roster = await buildReviewerRoster(deps);
    assert.strictEqual(roster.length, 1);
    assert.strictEqual(roster[0].reputation, undefined);
  });

  test('empty deps → empty roster', async () => {
    const roster = await buildReviewerRoster(emptyDeps());
    assert.deepStrictEqual(roster, []);
  });
});

/* -------------------------------------------------------------------------- */
/*  rankReviewers — tier1-local                                               */
/* -------------------------------------------------------------------------- */

suite('rankReviewers — tier1-local', () => {
  const BASE: ReviewerCapacity[] = [
    {
      id: 'cloud-runner',
      kind: 'runner',
      locality: 'cloud',
      costTier: 'paid',
      strength: 'strong',
      healthy: true,
    },
    {
      id: 'local-small',
      kind: 'model',
      locality: 'local',
      costTier: 'free',
      strength: 'cheap',
      healthy: true,
    },
    {
      id: 'lan-model',
      kind: 'model',
      locality: 'lan',
      costTier: 'free',
      strength: 'strong',
      healthy: true,
    },
    {
      id: 'unhealthy-local',
      kind: 'model',
      locality: 'local',
      costTier: 'free',
      strength: 'cheap',
      healthy: false,
    },
  ];

  test('filters out cloud and unhealthy; keeps local+lan free/cheap', () => {
    const ranked = rankReviewers(BASE, { tier: 'tier1-local' });
    const ids = ranked.map((r) => r.id);
    assert.ok(ids.includes('local-small'));
    assert.ok(ids.includes('lan-model'));
    assert.ok(!ids.includes('cloud-runner'));
    assert.ok(!ids.includes('unhealthy-local'));
  });

  test('free sorts before cheap (cost order)', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'cheap-model',
        kind: 'model',
        locality: 'local',
        costTier: 'cheap',
        strength: 'cheap',
        healthy: true,
      },
      {
        id: 'free-model',
        kind: 'model',
        locality: 'local',
        costTier: 'free',
        strength: 'cheap',
        healthy: true,
      },
    ];
    const ranked = rankReviewers(roster, { tier: 'tier1-local' });
    assert.strictEqual(ranked[0].id, 'free-model');
    assert.strictEqual(ranked[1].id, 'cheap-model');
  });

  test('among same cost tier, higher reputation sorts first', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'low-rep',
        kind: 'model',
        locality: 'local',
        costTier: 'free',
        strength: 'cheap',
        healthy: true,
        reputation: 0.6,
      },
      {
        id: 'high-rep',
        kind: 'model',
        locality: 'local',
        costTier: 'free',
        strength: 'cheap',
        healthy: true,
        reputation: 0.9,
      },
    ];
    const ranked = rankReviewers(roster, { tier: 'tier1-local' });
    assert.strictEqual(ranked[0].id, 'high-rep');
    assert.strictEqual(ranked[1].id, 'low-rep');
  });

  test('empty roster → empty result', () => {
    assert.deepStrictEqual(rankReviewers([], { tier: 'tier1-local' }), []);
  });
});

/* -------------------------------------------------------------------------- */
/*  rankReviewers — tier2-strong                                              */
/* -------------------------------------------------------------------------- */

suite('rankReviewers — tier2-strong', () => {
  test('keeps only healthy + strength=strong', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'strong-cloud',
        kind: 'runner',
        locality: 'cloud',
        costTier: 'paid',
        strength: 'strong',
        healthy: true,
      },
      {
        id: 'cheap-local',
        kind: 'model',
        locality: 'local',
        costTier: 'free',
        strength: 'cheap',
        healthy: true,
      },
      {
        id: 'unhealthy-strong',
        kind: 'model',
        locality: 'lan',
        costTier: 'free',
        strength: 'strong',
        healthy: false,
      },
    ];
    const ranked = rankReviewers(roster, { tier: 'tier2-strong' });
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].id, 'strong-cloud');
  });

  test('sorts by higher reputation first', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'low-rep-strong',
        kind: 'runner',
        locality: 'cloud',
        costTier: 'paid',
        strength: 'strong',
        healthy: true,
        reputation: 0.7,
      },
      {
        id: 'high-rep-strong',
        kind: 'model',
        locality: 'lan',
        costTier: 'free',
        strength: 'strong',
        healthy: true,
        reputation: 0.95,
      },
    ];
    const ranked = rankReviewers(roster, { tier: 'tier2-strong' });
    assert.strictEqual(ranked[0].id, 'high-rep-strong');
    assert.strictEqual(ranked[1].id, 'low-rep-strong');
  });

  test('equal reputation: prefers local/lan over cloud', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'cloud-strong',
        kind: 'runner',
        locality: 'cloud',
        costTier: 'paid',
        strength: 'strong',
        healthy: true,
        reputation: 0.8,
      },
      {
        id: 'lan-strong',
        kind: 'model',
        locality: 'lan',
        costTier: 'free',
        strength: 'strong',
        healthy: true,
        reputation: 0.8,
      },
    ];
    const ranked = rankReviewers(roster, { tier: 'tier2-strong' });
    assert.strictEqual(ranked[0].id, 'lan-strong');
    assert.strictEqual(ranked[1].id, 'cloud-strong');
  });

  test('empty roster → empty result', () => {
    assert.deepStrictEqual(rankReviewers([], { tier: 'tier2-strong' }), []);
  });
});

/* -------------------------------------------------------------------------- */
/*  rankReviewers — does not mutate input                                     */
/* -------------------------------------------------------------------------- */

suite('rankReviewers — pure function', () => {
  test('does not mutate the input roster array', () => {
    const roster: ReviewerCapacity[] = [
      {
        id: 'a',
        kind: 'model',
        locality: 'cloud',
        costTier: 'paid',
        strength: 'strong',
        healthy: true,
        reputation: 0.9,
      },
      {
        id: 'b',
        kind: 'model',
        locality: 'local',
        costTier: 'free',
        strength: 'strong',
        healthy: true,
        reputation: 0.5,
      },
    ];
    const originalOrder = roster.map((r) => r.id);
    rankReviewers(roster, { tier: 'tier2-strong' });
    assert.deepStrictEqual(roster.map((r) => r.id), originalOrder);
  });
});
