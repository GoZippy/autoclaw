/**
 * reviewfleet-router.test.ts — RF-2 unit tests (pure, no IO)
 *
 * Covers:
 *  - tier1-local: picks the cheapest local reviewer
 *  - highStakes: escalates to a strong reviewer
 *  - reviewerIndependence 'different-provider': never selects same-provider reviewer
 *  - panel with panelSize 2: returns 2 distinct-provider reviewers
 *  - tier 'human': reviewers:[] + humanRequired
 *  - empty roster: humanRequired (fail-safe, never silent pass)
 *  - gatesFirst flag propagated
 *  - panelSize diversity exhaustion fallback
 */

import * as assert from 'assert';
import { suite, test } from 'mocha';

import type { ReviewerCapacity } from '../reviewfleet/roster';
import type { ReviewContext, ReviewPlan } from '../reviewfleet/router';
import { planReview, reviewerProvider } from '../reviewfleet/router';
import type { ReviewScaffoldConfig } from '../workflows/scaffolds/types';

/* -------------------------------------------------------------------------- */
/*  Test fixture roster                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Local cheap model — free tier1 reviewer.
 * kind='model', locality='local', costTier='free', strength='cheap'
 */
const LOCAL_CHEAP: ReviewerCapacity = {
  id: 'ollama:phi3',
  kind: 'model',
  locality: 'local',
  costTier: 'free',
  strength: 'cheap',
  healthy: true,
  detail: 'ollama/phi3',
};

/**
 * Claude Code runner — anthropic provider, cloud, paid, strong.
 * kind='runner', id='claude-code'
 */
const CLAUDE_CODE: ReviewerCapacity = {
  id: 'claude-code',
  kind: 'runner',
  locality: 'cloud',
  costTier: 'paid',
  strength: 'strong',
  healthy: true,
  detail: 'runner:claude-code',
};

/**
 * Codex runner — openai provider, cloud, paid, strong.
 * kind='runner', id='codex'
 */
const CODEX: ReviewerCapacity = {
  id: 'codex',
  kind: 'runner',
  locality: 'cloud',
  costTier: 'paid',
  strength: 'strong',
  healthy: true,
  detail: 'runner:codex',
};

/**
 * LAN-hosted large model — self-hosted strong, no provider cost.
 * kind='model', locality='lan', costTier='free', strength='strong'
 */
const LAN_STRONG: ReviewerCapacity = {
  id: 'localai:mixtral-large',
  kind: 'model',
  locality: 'lan',
  costTier: 'free',
  strength: 'strong',
  healthy: true,
  detail: 'localai/mixtral-large',
};

/** Standard roster used by most tests. */
const ROSTER: ReviewerCapacity[] = [LOCAL_CHEAP, CLAUDE_CODE, CODEX, LAN_STRONG];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeTier1Config(overrides: Partial<ReviewScaffoldConfig> = {}): ReviewScaffoldConfig {
  return {
    tier: 'tier1-local',
    reviewerIndependence: 'same-model',
    gatesFirst: false,
    ...overrides,
  };
}

function makeTier2Config(overrides: Partial<ReviewScaffoldConfig> = {}): ReviewScaffoldConfig {
  return {
    tier: 'tier2-strong',
    reviewerIndependence: 'different-model',
    gatesFirst: false,
    ...overrides,
  };
}

function makePanelConfig(overrides: Partial<ReviewScaffoldConfig> = {}): ReviewScaffoldConfig {
  return {
    tier: 'panel',
    reviewerIndependence: 'different-provider',
    gatesFirst: false,
    panelSize: 2,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  reviewerProvider mapping                                                   */
/* -------------------------------------------------------------------------- */

suite('reviewerProvider', () => {
  test('claude-code runner → anthropic', () => {
    assert.strictEqual(reviewerProvider(CLAUDE_CODE), 'anthropic');
  });

  test('codex runner → openai', () => {
    assert.strictEqual(reviewerProvider(CODEX), 'openai');
  });

  test('kiro runner → kiro', () => {
    const kiro: ReviewerCapacity = { id: 'kiro', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true };
    assert.strictEqual(reviewerProvider(kiro), 'kiro');
  });

  test('gemini-cli runner → google', () => {
    const gemini: ReviewerCapacity = { id: 'gemini-cli', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true };
    assert.strictEqual(reviewerProvider(gemini), 'google');
  });

  test('cursor runner → cursor', () => {
    const cursor: ReviewerCapacity = { id: 'cursor', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true };
    assert.strictEqual(reviewerProvider(cursor), 'cursor');
  });

  test('local model → local regardless of providerId', () => {
    assert.strictEqual(reviewerProvider(LOCAL_CHEAP), 'local');
  });

  test('LAN model → local (self-hosted)', () => {
    assert.strictEqual(reviewerProvider(LAN_STRONG), 'local');
  });

  test('cloud model → extractedProviderId', () => {
    const cloudModel: ReviewerCapacity = {
      id: 'openai:gpt-4o',
      kind: 'model',
      locality: 'cloud',
      costTier: 'paid',
      strength: 'strong',
      healthy: true,
    };
    assert.strictEqual(reviewerProvider(cloudModel), 'openai');
  });

  test('remote lan → remote', () => {
    const remoteLan: ReviewerCapacity = { id: 'agent-xyz', kind: 'remote', locality: 'lan', costTier: 'free', strength: 'cheap', healthy: true };
    assert.strictEqual(reviewerProvider(remoteLan), 'remote');
  });

  test('remote cloud → remote-cloud', () => {
    const remoteCloud: ReviewerCapacity = { id: 'agent-abc', kind: 'remote', locality: 'cloud', costTier: 'paid', strength: 'cheap', healthy: true };
    assert.strictEqual(reviewerProvider(remoteCloud), 'remote-cloud');
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — tier1-local                                                   */
/* -------------------------------------------------------------------------- */

suite('planReview — tier1-local', () => {
  test('picks the local cheap reviewer', () => {
    const plan = planReview(makeTier1Config(), ROSTER);
    assert.strictEqual(plan.tier, 'tier1-local');
    assert.strictEqual(plan.reviewers.length, 1);
    assert.strictEqual(plan.reviewers[0].id, LOCAL_CHEAP.id);
    assert.strictEqual(plan.humanRequired, false);
    assert.strictEqual(plan.escalate, false);
  });

  test('gatesFirst propagated as false', () => {
    const plan = planReview(makeTier1Config({ gatesFirst: false }), ROSTER);
    assert.strictEqual(plan.gatesFirst, false);
  });

  test('gatesFirst propagated as true', () => {
    const plan = planReview(makeTier1Config({ gatesFirst: true }), ROSTER);
    assert.strictEqual(plan.gatesFirst, true);
  });

  test('cross-provider: local model (provider=local) not excluded when authorProvider=anthropic', () => {
    // LOCAL_CHEAP provider family is 'local' ≠ 'anthropic' → should be selected
    const plan = planReview(
      makeTier1Config({ reviewerIndependence: 'different-provider' }),
      ROSTER,
      { authorProvider: 'anthropic' },
    );
    assert.strictEqual(plan.tier, 'tier1-local');
    assert.strictEqual(plan.reviewers[0].id, LOCAL_CHEAP.id);
  });

  test('high-stakes escalates past tier1 even if tier1 configured', () => {
    const plan = planReview(makeTier1Config(), ROSTER, { highStakes: true });
    assert.notStrictEqual(plan.tier, 'tier1-local');
    assert.ok(plan.escalate, 'escalate should be true on highStakes');
    assert.ok(
      plan.tier === 'tier2-strong' || plan.tier === 'human',
      `unexpected tier: ${plan.tier}`,
    );
  });

  test('no eligible tier1 reviewer → escalates to tier2', () => {
    // Roster with ONLY cloud-paid-strong reviewers (no local or LAN).
    // rankReviewers tier1-local filters to locality local|lan AND costTier free|cheap,
    // so cloud-paid reviewers never qualify for tier1.
    const rosterCloudOnly: ReviewerCapacity[] = [CLAUDE_CODE, CODEX];
    const plan = planReview(makeTier1Config(), rosterCloudOnly);
    // Should escalate to tier2-strong
    assert.strictEqual(plan.tier, 'tier2-strong');
    assert.strictEqual(plan.escalate, true);
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — tier2-strong                                                  */
/* -------------------------------------------------------------------------- */

suite('planReview — tier2-strong', () => {
  test('picks a strong reviewer', () => {
    const plan = planReview(makeTier2Config(), ROSTER);
    assert.strictEqual(plan.tier, 'tier2-strong');
    assert.strictEqual(plan.reviewers.length, 1);
    assert.strictEqual(plan.reviewers[0].strength, 'strong');
    assert.strictEqual(plan.humanRequired, false);
  });

  test('escalate is false for direct tier2 request', () => {
    const plan = planReview(makeTier2Config(), ROSTER);
    assert.strictEqual(plan.escalate, false);
  });

  test('different-provider: never selects anthropic reviewer when authorProvider=anthropic', () => {
    const plan = planReview(
      makeTier2Config({ reviewerIndependence: 'different-provider' }),
      ROSTER,
      { authorProvider: 'anthropic' },
    );
    assert.strictEqual(plan.tier, 'tier2-strong');
    const selectedProviders = plan.reviewers.map(reviewerProvider);
    assert.ok(
      !selectedProviders.includes('anthropic'),
      `Expected no anthropic reviewer; got: ${JSON.stringify(selectedProviders)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — panel                                                         */
/* -------------------------------------------------------------------------- */

suite('planReview — panel', () => {
  test('panelSize 2 returns 2 reviewers', () => {
    const plan = planReview(makePanelConfig({ panelSize: 2 }), ROSTER);
    assert.strictEqual(plan.tier, 'panel');
    assert.strictEqual(plan.reviewers.length, 2);
    assert.strictEqual(plan.humanRequired, false);
  });

  test('panel reviewers are distinct-provider when crossProvider enforced', () => {
    const plan = planReview(makePanelConfig({ panelSize: 2, reviewerIndependence: 'different-provider' }), ROSTER);
    const providers = plan.reviewers.map(reviewerProvider);
    const uniqueProviders = new Set(providers);
    assert.strictEqual(
      uniqueProviders.size,
      providers.length,
      `Expected distinct providers, got: ${JSON.stringify(providers)}`,
    );
  });

  test('default panelSize is 2 when not specified', () => {
    const config: ReviewScaffoldConfig = {
      tier: 'panel',
      reviewerIndependence: 'different-provider',
      gatesFirst: false,
    };
    const plan = planReview(config, ROSTER);
    assert.ok(plan.reviewers.length >= 1, 'Should have at least 1 reviewer');
    assert.ok(plan.reviewers.length <= 2, 'Should not exceed default panel size of 2');
  });

  test('panel with same-provider allowed fills slots from any remaining', () => {
    // Two claude-code-like reviewers; crossProvider=false so both can be selected
    const twoAnthropic: ReviewerCapacity[] = [
      CLAUDE_CODE,
      { ...CLAUDE_CODE, id: 'claude-code-2', detail: 'runner:claude-code-2' },
    ];
    const config: ReviewScaffoldConfig = {
      tier: 'panel',
      reviewerIndependence: 'same-model',
      gatesFirst: false,
      panelSize: 2,
      requiredProviderDiversity: false,
    };
    const plan = planReview(config, twoAnthropic);
    // With crossProvider=false, should fill panel from same-provider candidates
    assert.ok(plan.reviewers.length >= 1, 'Should pick at least 1');
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — human tier                                                    */
/* -------------------------------------------------------------------------- */

suite('planReview — human tier', () => {
  test('tier human → reviewers:[] + humanRequired', () => {
    const config: ReviewScaffoldConfig = {
      tier: 'human',
      reviewerIndependence: 'human',
      gatesFirst: false,
    };
    const plan = planReview(config, ROSTER);
    assert.strictEqual(plan.tier, 'human');
    assert.deepStrictEqual(plan.reviewers, []);
    assert.strictEqual(plan.humanRequired, true);
    assert.strictEqual(plan.escalate, false);
  });

  test('reviewerIndependence human forces human even with tier1 config', () => {
    const config: ReviewScaffoldConfig = {
      tier: 'tier1-local',
      reviewerIndependence: 'human',
      gatesFirst: true,
    };
    const plan = planReview(config, ROSTER);
    assert.strictEqual(plan.tier, 'human');
    assert.deepStrictEqual(plan.reviewers, []);
    assert.strictEqual(plan.humanRequired, true);
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — empty roster (fail-safe)                                      */
/* -------------------------------------------------------------------------- */

suite('planReview — empty roster fail-safe', () => {
  test('tier1-local with empty roster → humanRequired (never silent pass)', () => {
    const plan = planReview(makeTier1Config(), []);
    assert.strictEqual(plan.humanRequired, true);
    assert.deepStrictEqual(plan.reviewers, []);
  });

  test('tier2-strong with empty roster → humanRequired', () => {
    const plan = planReview(makeTier2Config(), []);
    assert.strictEqual(plan.humanRequired, true);
    assert.deepStrictEqual(plan.reviewers, []);
  });

  test('panel with empty roster → humanRequired', () => {
    const plan = planReview(makePanelConfig(), []);
    assert.strictEqual(plan.humanRequired, true);
    assert.deepStrictEqual(plan.reviewers, []);
  });

  test('all-unhealthy roster → humanRequired (never silent pass)', () => {
    const deadRoster: ReviewerCapacity[] = [
      { ...LOCAL_CHEAP, healthy: false },
      { ...CLAUDE_CODE, healthy: false },
      { ...CODEX, healthy: false },
      { ...LAN_STRONG, healthy: false },
    ];
    const plan = planReview(makeTier1Config(), deadRoster);
    assert.strictEqual(plan.humanRequired, true);
    assert.deepStrictEqual(plan.reviewers, []);
  });
});

/* -------------------------------------------------------------------------- */
/*  planReview — requiredProviderDiversity flag                                */
/* -------------------------------------------------------------------------- */

suite('planReview — requiredProviderDiversity', () => {
  test('requiredProviderDiversity triggers cross-provider exclusion', () => {
    // reviewerIndependence is 'same-model' but requiredProviderDiversity=true
    const config: ReviewScaffoldConfig = {
      tier: 'tier2-strong',
      reviewerIndependence: 'same-model',
      gatesFirst: false,
      requiredProviderDiversity: true,
    };
    const plan = planReview(config, ROSTER, { authorProvider: 'openai' });
    // Codex (openai) should be excluded
    const providers = plan.reviewers.map(reviewerProvider);
    assert.ok(!providers.includes('openai'), `Expected openai excluded, got: ${JSON.stringify(providers)}`);
  });
});
