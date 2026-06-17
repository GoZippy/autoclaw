import * as assert from 'assert';
import {
  reputationScore, rankByReputation, rollUp,
} from '../fleet/performance';
import { emptyResume, Worker, Resume } from '../fleet/workforce';

/** Build a Worker fixture; résumé overrides fold onto an empty résumé. */
function makeWorker(
  agent_id: string,
  resume: Partial<Resume> = {},
  extra: Partial<Worker> = {},
): Worker {
  return {
    agent_id,
    roles_can_play: ['coder'],
    skills: [],
    llms: [],
    tools: [],
    resume: { ...emptyResume(), ...resume },
    status: 'available',
    trust: 'off',
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

suite('Performance roll-up + reputation routing (HR-3)', () => {

  test('reputationScore: a proven worker beats a spotless newcomer (which scores 0)', () => {
    const newcomer = makeWorker('newcomer');
    const proven = makeWorker('proven', { tasks_completed: 6, reviews_passed: 3 });
    assert.strictEqual(reputationScore(newcomer), 0, 'all-zeros newcomer is unproven, not negative');
    assert.ok(reputationScore(proven) > reputationScore(newcomer));
  });

  test('reputationScore: scope violations drop it (never below 0)', () => {
    const clean = makeWorker('clean', { tasks_completed: 4 });
    const violator = makeWorker('violator', { tasks_completed: 4, scope_violations: 2 });
    assert.ok(reputationScore(violator) < reputationScore(clean));

    // Penalties exceeding credits floor at 0, not negative.
    const sunk = makeWorker('sunk', { tasks_completed: 1, scope_violations: 5 });
    assert.strictEqual(reputationScore(sunk), 0);
  });

  test('reputationScore: above-average review scores raise it', () => {
    const base = { tasks_completed: 4, reviews_passed: 2, reviews_scored: 2 };
    const high = makeWorker('high', { ...base, avg_review_score: 4.5 });
    const low = makeWorker('low', { ...base, avg_review_score: 1.0 });
    assert.ok(reputationScore(high) > reputationScore(low));
  });

  test('reputationScore: bounded in [0, 1)', () => {
    const huge = makeWorker('huge', {
      tasks_completed: 1000, reviews_passed: 1000,
      reviews_scored: 1000, avg_review_score: 5,
    });
    const score = reputationScore(huge);
    assert.ok(score >= 0 && score < 1, `expected [0,1), got ${score}`);
  });

  test('rankByReputation: sorts by score desc with deterministic agent_id tie-break', () => {
    const low = makeWorker('zeta', { tasks_completed: 1 });
    const high = makeWorker('alpha', { tasks_completed: 10, reviews_passed: 5 });
    // Two workers with identical résumés → equal scores → tie-break by agent_id asc.
    const tieB = makeWorker('bravo', { tasks_completed: 3 });
    const tieD = makeWorker('delta', { tasks_completed: 3 });

    const ranked = rankByReputation([low, high, tieD, tieB]);
    assert.deepStrictEqual(ranked.map(r => r.worker.agent_id), ['alpha', 'bravo', 'delta', 'zeta']);
    // Scores are non-increasing.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].score >= ranked[i].score);
    }
  });

  test('rankByReputation: filters by role (case-insensitive)', () => {
    const coder = makeWorker('coder1', { tasks_completed: 5 }, { roles_can_play: ['Coder'] });
    const reviewer = makeWorker('rev1', { tasks_completed: 5 }, { roles_can_play: ['Reviewer'] });
    const both = makeWorker('both1', { tasks_completed: 5 }, { roles_can_play: ['coder', 'reviewer'] });

    const reviewers = rankByReputation([coder, reviewer, both], { role: 'REVIEWER' });
    assert.deepStrictEqual(reviewers.map(r => r.worker.agent_id).sort(), ['both1', 'rev1']);
  });

  test('rollUp: fleet totals are correct', () => {
    const workers = [
      makeWorker('a', { tasks_completed: 6, tasks_failed: 1, scope_violations: 0 }),
      makeWorker('b', { tasks_completed: 2, tasks_failed: 3, scope_violations: 2 }),
    ];
    const report = rollUp(workers);
    assert.strictEqual(report.fleet.workers, 2);
    assert.strictEqual(report.fleet.tasks_completed, 8);
    assert.strictEqual(report.fleet.tasks_failed, 4);
    assert.strictEqual(report.fleet.scope_violations, 2);
    assert.strictEqual(report.generated_at, undefined, 'compute stays pure — caller stamps the clock');
  });

  test('rollUp: agents sorted by reputation desc', () => {
    const weak = makeWorker('weak', { tasks_completed: 1 });
    const strong = makeWorker('strong', { tasks_completed: 10, reviews_passed: 5 });
    const report = rollUp([weak, strong]);
    assert.deepStrictEqual(report.agents.map(a => a.agent_id), ['strong', 'weak']);
    assert.ok(report.agents[0].reputation >= report.agents[1].reputation);
  });

  test('rollUp: flags include a scope-violator and a high-failure agent; lines non-empty', () => {
    const workers = [
      makeWorker('kilo', { tasks_completed: 4, scope_violations: 2 }),
      makeWorker('faily', { tasks_completed: 1, tasks_failed: 3 }),
      makeWorker('clean', { tasks_completed: 5 }),
    ];
    const report = rollUp(workers);

    assert.ok(report.flags.some(f => f.startsWith('kilo:') && /scope violation/.test(f)),
      'scope-violator flagged');
    assert.ok(report.flags.some(f => f.startsWith('faily:') && /failed task/.test(f)),
      'high-failure agent flagged');
    assert.ok(!report.flags.some(f => f.startsWith('clean:')), 'clean agent not flagged');

    // lines: a header + one line per agent.
    assert.ok(report.lines.length >= workers.length + 1);
    assert.ok(/^Fleet:/.test(report.lines[0]));
    assert.ok(report.lines.every(l => l.length > 0));
  });
});
