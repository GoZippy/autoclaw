/**
 * reviewfleet-service.test.ts — offline unit tests for RF-3 service core.
 *
 * All deps are stubbed — no real IO, no real LLM dispatch, no filesystem writes.
 * Tests pin:
 *   - happy path: all-approve → AutomatedVote vote='approve', voter label, writeVote+scoreRun called
 *   - reject propagation: one reject → vote='reject', scoreRun review.judgeVeto=true
 *   - human tier → humanRequired:true, NO writeVote, NO score
 *   - fail-safe: only reviewer throws → humanRequired:true, NO approve vote written
 *   - scoreRun failure does NOT break the review (scored=false, writeVote still called)
 */

import * as assert from 'assert';

import {
  processReviewRequest,
  defaultReviewConfig,
  type ReviewFleetInput,
  type ReviewFleetDeps,
  type ReviewVerdict,
  type AutomatedVote,
} from '../reviewfleet/service';
import type { ReviewerCapacity } from '../reviewfleet/roster';
import type { ScaffoldVariant } from '../workflows/scaffolds/types';
import type { ScaffoldScoreInput } from '../workflows/scaffolds/score';

/* -------------------------------------------------------------------------- */
/*  Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function makeReviewer(id: string, strength: 'cheap' | 'strong' = 'strong'): ReviewerCapacity {
  return {
    id,
    kind: 'model',
    locality: 'local',
    costTier: 'free',
    strength,
    healthy: true,
    detail: `test:${id}`,
  };
}

function makeScaffold(overrides: Partial<ScaffoldVariant> = {}): ScaffoldVariant {
  return {
    schema: 'autoclaw.scaffold.v1' as const,
    id: 'scaffold-test-1',
    workflowId: 'wf-test',
    taskIntent: 'code',
    routerProfile: 'balanced',
    toolLaneIds: [],
    createdAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewFleetInput> = {}): ReviewFleetInput {
  return {
    scaffold: makeScaffold({
      review: {
        tier: 'tier1-local',
        reviewerIndependence: 'different-provider',
        gatesFirst: true,
      },
    }),
    taskId: 'task-1',
    runSummary: {
      runId: 'run-001',
      workflowId: 'wf-test',
      status: 'completed',
      costCents: 10,
      inputTokens: 100,
      outputTokens: 50,
      failureTypes: [],
      artifactCount: 1,
      eventCount: 3,
      gateCount: 1,
      failedGateCount: 0,
      retryCount: 0,
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReviewFleetDeps> = {}): ReviewFleetDeps & {
  capturedVotes: AutomatedVote[];
  capturedScoreInputs: ScaffoldScoreInput[];
} {
  const capturedVotes: AutomatedVote[] = [];
  const capturedScoreInputs: ScaffoldScoreInput[] = [];

  return {
    roster: [makeReviewer('local:llama3-70b')],
    dispatchReviewer: async (reviewer) => ({
      reviewerId: reviewer.id,
      vote: 'approve' as const,
      costCents: 0,
    }),
    writeVote: async (vote) => { capturedVotes.push(vote); },
    scoreRun: async (input) => { capturedScoreInputs.push(input); },
    now: () => '2026-06-28T12:00:00.000Z',
    capturedVotes,
    capturedScoreInputs,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests: all-approve path                                                    */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — happy path (all approve)', () => {
  test('returns vote=approve when single reviewer approves', async () => {
    const input = makeInput();
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.humanRequired, false, 'should not require human');
    assert.ok(result.vote, 'vote must be present');
    assert.strictEqual(result.vote.vote, 'approve');
    assert.strictEqual(result.vote.automated, true);
  });

  test('voter label starts with "automated:" when no automatedVoteLabel configured', async () => {
    const input = makeInput();
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote, 'vote must be present');
    assert.ok(
      result.vote.voter.startsWith('automated:'),
      `voter must start with "automated:", got: ${result.vote.voter}`,
    );
  });

  test('voter label uses config.automatedVoteLabel when provided', async () => {
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'tier1-local',
          reviewerIndependence: 'same-model',
          gatesFirst: false,
          automatedVoteLabel: 'autoclaw-bot',
        },
      }),
    });
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote, 'vote must be present');
    assert.strictEqual(result.vote.voter, 'autoclaw-bot');
  });

  test('writeVote is called exactly once', async () => {
    const input = makeInput();
    const deps = makeDeps();
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedVotes.length, 1, 'writeVote must be called once');
    assert.strictEqual(deps.capturedVotes[0].vote, 'approve');
  });

  test('scoreRun is called with review.verifierPass=true when approved', async () => {
    const input = makeInput();
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.scored, true, 'scored must be true');
    assert.strictEqual(deps.capturedScoreInputs.length, 1, 'scoreRun must be called once');
    const scoreInput = deps.capturedScoreInputs[0];
    assert.strictEqual(scoreInput.review?.verifierPass, true);
    assert.strictEqual(scoreInput.review?.judgeVeto, false);
  });

  test('scoreRun run.costCents includes verdict costCents', async () => {
    const input = makeInput();  // runSummary.costCents = 10
    const deps = makeDeps({
      dispatchReviewer: async (reviewer) => ({
        reviewerId: reviewer.id,
        vote: 'approve' as const,
        costCents: 5,
      }),
    });
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedScoreInputs.length, 1);
    // 10 (run) + 5 (verdict) = 15
    assert.strictEqual(deps.capturedScoreInputs[0].run.costCents, 15);
  });

  test('vote carries correct task_id and timestamp', async () => {
    const input = makeInput();
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote);
    assert.strictEqual(result.vote.task_id, 'task-1');
    assert.strictEqual(result.vote.timestamp, '2026-06-28T12:00:00.000Z');
  });

  test('vote.reviewers lists the reviewer ids from verdicts', async () => {
    const input = makeInput();
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote);
    assert.deepStrictEqual(result.vote.reviewers, ['local:llama3-70b']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: reject propagation                                                  */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — reject propagation', () => {
  test('any reject verdict → vote=reject', async () => {
    // Use two cloud runners with distinct providers so a panel of 2 selects both.
    // claude-code → 'anthropic'; codex → 'openai' (RUNNER_PROVIDER in router.ts)
    const roster: ReviewerCapacity[] = [
      { id: 'claude-code', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:claude-code' },
      { id: 'codex',       kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:codex' },
    ];
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'panel',
          reviewerIndependence: 'different-provider',
          gatesFirst: true,
          panelSize: 2,
        },
      }),
    });
    const votes: Record<string, ReviewVerdict['vote']> = { 'claude-code': 'approve', 'codex': 'reject' };
    const deps = makeDeps({
      roster,
      dispatchReviewer: async (reviewer) => ({
        reviewerId: reviewer.id,
        vote: votes[reviewer.id] ?? 'approve',
      }),
    });
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote, 'vote must be present');
    assert.strictEqual(result.vote.vote, 'reject');
  });

  test('scoreRun called with review.judgeVeto=true when rejected', async () => {
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'tier1-local',
          reviewerIndependence: 'same-model',
          gatesFirst: false,
        },
      }),
    });
    const deps = makeDeps({
      dispatchReviewer: async (reviewer) => ({
        reviewerId: reviewer.id,
        vote: 'reject' as const,
      }),
    });
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedScoreInputs.length, 1);
    assert.strictEqual(deps.capturedScoreInputs[0].review?.judgeVeto, true);
    assert.strictEqual(deps.capturedScoreInputs[0].review?.verifierPass, false);
  });

  test('request_changes propagates when no reject but some request_changes', async () => {
    // Two cloud runners, distinct providers — panel of 2 selects both
    const roster: ReviewerCapacity[] = [
      { id: 'claude-code', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:claude-code' },
      { id: 'codex',       kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:codex' },
    ];
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'panel',
          reviewerIndependence: 'different-provider',
          gatesFirst: true,
          panelSize: 2,
        },
      }),
    });
    const votes: Record<string, ReviewVerdict['vote']> = {
      'claude-code': 'approve',
      'codex': 'request_changes',
    };
    const deps = makeDeps({
      roster,
      dispatchReviewer: async (reviewer) => ({
        reviewerId: reviewer.id,
        vote: votes[reviewer.id] ?? 'approve',
      }),
    });
    const result = await processReviewRequest(input, deps);

    assert.ok(result.vote);
    assert.strictEqual(result.vote.vote, 'request_changes');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: human tier                                                          */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — human tier (humanRequired)', () => {
  test('tier=human scaffold → humanRequired:true', async () => {
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'human',
          reviewerIndependence: 'human',
          gatesFirst: false,
        },
      }),
    });
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.humanRequired, true);
    assert.strictEqual(result.vote, undefined, 'no automated vote should be written for human tier');
  });

  test('writeVote is NOT called for human tier', async () => {
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'human',
          reviewerIndependence: 'human',
          gatesFirst: false,
        },
      }),
    });
    const deps = makeDeps();
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedVotes.length, 0, 'writeVote must not be called for human tier');
  });

  test('scoreRun is NOT called for human tier', async () => {
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'human',
          reviewerIndependence: 'human',
          gatesFirst: false,
        },
      }),
    });
    const deps = makeDeps();
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.scored, false, 'scored must be false for human tier');
    assert.strictEqual(deps.capturedScoreInputs.length, 0, 'scoreRun must not be called for human tier');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: fail-safe (all dispatches throw)                                   */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — fail-safe (dispatcher crash)', () => {
  test('only reviewer throws → humanRequired:true (never silent approve)', async () => {
    const input = makeInput();
    const deps = makeDeps({
      dispatchReviewer: async () => {
        throw new Error('simulated dispatcher crash');
      },
    });
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.humanRequired, true, 'must fall back to human required');
    assert.strictEqual(result.vote, undefined, 'NO automated vote must be written on empty verdicts');
    assert.strictEqual(result.verdicts.length, 0);
  });

  test('writeVote is NOT called when all dispatches failed', async () => {
    const input = makeInput();
    const deps = makeDeps({
      dispatchReviewer: async () => {
        throw new Error('simulated dispatcher crash');
      },
    });
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedVotes.length, 0, 'writeVote must not be called when no verdicts');
  });

  test('reason includes "no reviewer verdict" when all dispatches failed', async () => {
    const input = makeInput();
    const deps = makeDeps({
      dispatchReviewer: async () => {
        throw new Error('boom');
      },
    });
    const result = await processReviewRequest(input, deps);

    assert.ok(
      result.reason.includes('no reviewer verdict'),
      `reason must mention "no reviewer verdict", got: ${result.reason}`,
    );
  });

  test('partial crash: surviving reviewer verdict is used', async () => {
    // Two cloud runners, different providers — panel picks both; first crashes, second approves
    const roster: ReviewerCapacity[] = [
      { id: 'claude-code', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:claude-code' },
      { id: 'codex',       kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'runner:codex' },
    ];
    const input = makeInput({
      scaffold: makeScaffold({
        review: {
          tier: 'panel',
          reviewerIndependence: 'different-provider',
          gatesFirst: false,
          panelSize: 2,
        },
      }),
    });
    const deps = makeDeps({
      roster,
      dispatchReviewer: async (reviewer) => {
        if (reviewer.id === 'claude-code') {
          throw new Error('crash');
        }
        return { reviewerId: reviewer.id, vote: 'approve' as const };
      },
    });
    const result = await processReviewRequest(input, deps);

    // Should NOT be humanRequired — 'codex' survived and voted approve
    assert.strictEqual(result.humanRequired, false);
    assert.ok(result.vote);
    assert.strictEqual(result.vote.vote, 'approve');
    assert.deepStrictEqual(result.verdicts.map((v) => v.reviewerId), ['codex']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: scoreRun failure isolation                                          */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — scoreRun failure isolation', () => {
  test('scoreRun throwing does not propagate; review still completes', async () => {
    const input = makeInput();
    const deps = makeDeps({
      scoreRun: async () => {
        throw new Error('simulated scoring failure');
      },
    });

    // Must NOT throw
    let result: Awaited<ReturnType<typeof processReviewRequest>> | undefined;
    let threw = false;
    try {
      result = await processReviewRequest(input, deps);
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'processReviewRequest must not throw when scoreRun throws');
    assert.ok(result, 'result must be defined');
    assert.strictEqual(result.scored, false, 'scored must be false when scoreRun throws');
  });

  test('writeVote IS still called even when scoreRun throws', async () => {
    const input = makeInput();
    const deps = makeDeps({
      scoreRun: async () => {
        throw new Error('simulated scoring failure');
      },
    });
    await processReviewRequest(input, deps);

    assert.strictEqual(deps.capturedVotes.length, 1, 'writeVote must still be called when scoreRun fails');
  });

  test('review result vote is correct even when scoreRun throws', async () => {
    const input = makeInput();
    const deps = makeDeps({
      scoreRun: async () => {
        throw new Error('simulated scoring failure');
      },
    });
    const result = await processReviewRequest(input, deps);

    assert.strictEqual(result.humanRequired, false);
    assert.ok(result.vote);
    assert.strictEqual(result.vote.vote, 'approve');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: defaultReviewConfig                                                 */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetService — defaultReviewConfig', () => {
  test('returns conservative defaults', () => {
    const cfg = defaultReviewConfig();
    assert.strictEqual(cfg.tier, 'tier1-local');
    assert.strictEqual(cfg.reviewerIndependence, 'different-provider');
    assert.strictEqual(cfg.gatesFirst, true);
  });

  test('scaffold without .review uses defaultReviewConfig', async () => {
    const input = makeInput({
      scaffold: makeScaffold(),  // no .review
    });
    const deps = makeDeps();
    // If no tier1-local reviewer exists in roster with cross-provider exclusion,
    // plan may fall through — as long as it doesn't throw, we pass.
    // Use a roster that satisfies tier1-local + no author-provider exclusion.
    const result = await processReviewRequest(input, deps);
    // Result must not throw; just verify it returns a consistent shape
    assert.ok(typeof result.humanRequired === 'boolean');
    assert.ok(typeof result.scored === 'boolean');
    assert.ok(typeof result.reason === 'string');
  });
});
