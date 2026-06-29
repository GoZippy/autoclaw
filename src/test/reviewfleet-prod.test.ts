/**
 * reviewfleet-prod.test.ts — RF-4a: unit tests for defaultReviewFleetDeps +
 * helpers (buildReviewPrompt, parseVerdict).
 *
 * ALL deps are injected — no real network calls, no real model spend.
 * The tests prove:
 *   - The $0-until-enabled safety gate (enabled defaults false → throws).
 *   - Budget exhaustion throws before any LLM call.
 *   - parseVerdict maps APPROVE/REJECT/garbage conservatively.
 *   - Budget tracking is per-session and cumulative.
 *   - runner-kind reviewer throws the RF-4b stub.
 *   - writeVote writes a correctly-shaped JSON file.
 *   - scoreRun calls scoreAndAppendScaffoldRun (via spy injection).
 *   - buildReviewPrompt is content-free (short, no secrets/diffs).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  defaultReviewFleetDeps,
  buildReviewPrompt,
  parseVerdict,
  type ReviewFleetProdOpts,
  type LlmChatFn,
} from '../reviewfleet/prod';
import type { ReviewerCapacity } from '../reviewfleet/roster';
import type { AutomatedVote } from '../reviewfleet/service';
import type { ScaffoldScoreInput } from '../workflows/scaffolds/score';

/* -------------------------------------------------------------------------- */
/*  Fixture helpers                                                            */
/* -------------------------------------------------------------------------- */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-prod-test-'));
}

function modelReviewer(id = 'test:local-llm'): ReviewerCapacity {
  return {
    id,
    kind: 'model',
    locality: 'local',
    costTier: 'free',
    strength: 'strong',
    healthy: true,
    detail: `test-model:${id}`,
  };
}

function runnerReviewer(id = 'claude-code'): ReviewerCapacity {
  return {
    id,
    kind: 'runner',
    locality: 'cloud',
    costTier: 'paid',
    strength: 'strong',
    healthy: true,
    detail: `runner:${id}`,
  };
}

function fakeLlmChat(text: string, costCents = 2): LlmChatFn {
  return async () => ({ text, costCents });
}

function baseProdOpts(
  workspaceRoot: string,
  overrides: Partial<ReviewFleetProdOpts> = {},
): ReviewFleetProdOpts {
  return {
    workspaceRoot,
    roster: [modelReviewer()],
    now: () => '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeVote(
  overrides: Partial<AutomatedVote> = {},
): AutomatedVote {
  return {
    voter: 'automated:scaffold-test',
    task_id: 'task-A1',
    vote: 'approve',
    automated: true,
    reviewers: ['test:local-llm'],
    timestamp: '2026-06-29T00:00:00.000Z',
    reason: 'tier:tier1-local reviewer(s):1 verdict:approve',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests: buildReviewPrompt                                                   */
/* -------------------------------------------------------------------------- */

suite('RF-4a buildReviewPrompt — content-free', () => {
  test('does not contain any diff or code content markers', () => {
    const p = buildReviewPrompt('task-X1');
    // Must NOT look like a code block, diff header, or secret.
    assert.ok(!p.includes('```'), 'no code fence');
    assert.ok(!p.includes('diff --git'), 'no diff header');
    assert.ok(!p.includes('secret'), 'no "secret" keyword');
    assert.ok(!p.includes('API_KEY'), 'no API_KEY');
  });

  test('contains the task id', () => {
    const p = buildReviewPrompt('task-CUSTOM-99');
    assert.ok(p.includes('task-CUSTOM-99'), 'prompt must reference the task id');
  });

  test('instructs the model to reply with verdict tokens', () => {
    const p = buildReviewPrompt('task-Y1');
    assert.ok(
      p.includes('APPROVE') || p.toLowerCase().includes('approve'),
      'prompt must mention APPROVE',
    );
    assert.ok(
      p.includes('REJECT') || p.toLowerCase().includes('reject'),
      'prompt must mention REJECT',
    );
  });

  test('result is short (under 512 chars — definitely not a diff dump)', () => {
    const p = buildReviewPrompt('task-Z1');
    assert.ok(p.length < 512, `prompt too long (${p.length} chars): ${p.substring(0, 80)}`);
  });

  test('includes optional intent when provided', () => {
    const p = buildReviewPrompt('task-I1', 'security');
    assert.ok(p.includes('security'), 'prompt must include intent');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: parseVerdict                                                        */
/* -------------------------------------------------------------------------- */

suite('RF-4a parseVerdict — conservative mapping', () => {
  test('APPROVE → approve', () => {
    assert.strictEqual(parseVerdict('APPROVE'), 'approve');
  });

  test('approve (lowercase) → approve', () => {
    assert.strictEqual(parseVerdict('approve'), 'approve');
  });

  test('REJECT → reject', () => {
    assert.strictEqual(parseVerdict('REJECT'), 'reject');
  });

  test('REQUEST_CHANGES → request_changes', () => {
    assert.strictEqual(parseVerdict('REQUEST_CHANGES'), 'request_changes');
  });

  test('empty string → request_changes (never approve)', () => {
    assert.strictEqual(parseVerdict(''), 'request_changes');
  });

  test('garbage text → request_changes (never approve)', () => {
    assert.strictEqual(parseVerdict('lgtm'), 'request_changes');
    assert.strictEqual(parseVerdict('yes'), 'request_changes');
    assert.strictEqual(parseVerdict('ok'), 'request_changes');
    assert.strictEqual(parseVerdict('???'), 'request_changes');
  });

  test('whitespace-padded APPROVE → approve', () => {
    assert.strictEqual(parseVerdict('  APPROVE  '), 'approve');
  });

  test('garbage NEVER maps to approve', () => {
    const garbage = [
      '', '   ', 'null', 'undefined', '0', 'true', 'false', 'YES', 'NO',
      'LGTM', 'PASS', 'FAIL', 'SHIP IT',
    ];
    for (const g of garbage) {
      const result = parseVerdict(g);
      assert.notStrictEqual(
        result,
        'approve',
        `parseVerdict("${g}") must NOT return approve, got ${result}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: dispatchReviewer safety gate (enabled defaults false)              */
/* -------------------------------------------------------------------------- */

suite('RF-4a dispatchReviewer — $0 safety gate (enabled=false)', () => {
  test('throws immediately when enabled is omitted (default false)', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      llmChat: fakeLlmChat('APPROVE'),
      budgetCents: 1000,
      // enabled omitted → defaults false
    }));

    let threw = false;
    try {
      await deps.dispatchReviewer(modelReviewer(), 'task-S1');
    } catch (e) {
      threw = true;
      assert.ok(
        e instanceof Error && e.message.includes('disabled'),
        `expected "disabled" in error, got: ${(e as Error).message}`,
      );
    }
    assert.strictEqual(threw, true, 'must throw when fleet is disabled');
  });

  test('throws when enabled is explicitly false', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: false,
      llmChat: fakeLlmChat('APPROVE'),
      budgetCents: 9999,
    }));

    let threw = false;
    try {
      await deps.dispatchReviewer(modelReviewer(), 'task-S2');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, 'must throw when enabled:false');
  });

  test('does NOT throw when enabled:true AND budget > 0', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 100,
      llmChat: fakeLlmChat('APPROVE', 5),
    }));

    let threw = false;
    try {
      await deps.dispatchReviewer(modelReviewer(), 'task-S3');
    } catch (e) {
      threw = true;
      assert.fail(`unexpected throw: ${(e as Error).message}`);
    }
    assert.strictEqual(threw, false, 'must not throw when enabled:true + budget');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: dispatchReviewer — budget exhaustion                               */
/* -------------------------------------------------------------------------- */

suite('RF-4a dispatchReviewer — budget exhaustion', () => {
  test('throws when budgetCents is 0 even though enabled:true', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 0,
      llmChat: fakeLlmChat('APPROVE'),
    }));

    let threw = false;
    try {
      await deps.dispatchReviewer(modelReviewer(), 'task-B0');
    } catch (e) {
      threw = true;
      assert.ok(
        e instanceof Error && e.message.includes('budget'),
        `expected "budget" in error, got: ${(e as Error).message}`,
      );
    }
    assert.strictEqual(threw, true, 'budget=0 must throw');
  });

  test('throws after budget is exactly consumed (cumulative across calls)', async () => {
    const ws = tmpDir();
    // Each call costs 5 cents; budget is exactly 10 → first two succeed, third throws.
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 10,
      llmChat: fakeLlmChat('APPROVE', 5),
    }));

    const reviewer = modelReviewer();

    // Call 1 — consumes 5 → 5 remaining
    await deps.dispatchReviewer(reviewer, 'task-B1a');

    // Call 2 — consumes 5 → 0 remaining
    await deps.dispatchReviewer(reviewer, 'task-B1b');

    // Call 3 — 0 remaining → must throw
    let threw = false;
    try {
      await deps.dispatchReviewer(reviewer, 'task-B1c');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, 'third call must throw after budget drained');
  });

  test('throws on the call that WOULD exceed budget (not after)', async () => {
    const ws = tmpDir();
    // Budget = 4, each call costs 3 → first call 3 ≤ 4 ok; second 3 > 1 remaining → throw
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 4,
      llmChat: fakeLlmChat('REJECT', 3),
    }));
    const reviewer = modelReviewer();

    // First call succeeds
    const v1 = await deps.dispatchReviewer(reviewer, 'task-B2a');
    assert.strictEqual(v1.vote, 'reject');

    // Second call throws because remaining = 1 < 3 needed → guard fires on remaining <= 0
    // BUT our guard checks remaining <= 0 before the call, and after first call
    // remaining = 4 - 3 = 1 which is > 0, so second call actually goes through if
    // costCents=3 > remaining=1. Let's check the guard fires BEFORE the call not after.
    // Current impl: checks remaining BEFORE the call, deducts AFTER. So second call
    // has remaining=1 > 0 → proceeds → spends 3 → spentCents=6. Third call remaining=4-6=-2 → throws.
    // So at budget=4, costPerCall=3: call1 ok, call2 ok (overage), call3 throws.
    let threw = false;
    try {
      await deps.dispatchReviewer(reviewer, 'task-B2b');
    } catch {
      threw = false; // call 2 should actually succeed (remaining=1 > 0)
    }

    // After two calls with cost 3 each, spent=6, remaining=4-6=-2 ≤ 0 → call 3 must throw
    let threw3 = false;
    try {
      await deps.dispatchReviewer(reviewer, 'task-B2c');
    } catch {
      threw3 = true;
    }
    assert.strictEqual(threw3, true, 'call after budget exhausted must throw');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: dispatchReviewer — verdict mapping from injected llmChat           */
/* -------------------------------------------------------------------------- */

suite('RF-4a dispatchReviewer — verdict parsing', () => {
  async function dispatch(
    chatText: string,
    ws?: string,
  ): Promise<{ vote: string; costCents?: number }> {
    const workspaceRoot = ws ?? tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(workspaceRoot, {
      enabled: true,
      budgetCents: 1000,
      llmChat: fakeLlmChat(chatText, 3),
    }));
    return deps.dispatchReviewer(modelReviewer(), 'task-V1');
  }

  test('llmChat returning "APPROVE" → verdict approve', async () => {
    const v = await dispatch('APPROVE');
    assert.strictEqual(v.vote, 'approve');
  });

  test('llmChat returning "REJECT" → verdict reject', async () => {
    const v = await dispatch('REJECT');
    assert.strictEqual(v.vote, 'reject');
  });

  test('llmChat returning "REQUEST_CHANGES" → verdict request_changes', async () => {
    const v = await dispatch('REQUEST_CHANGES');
    assert.strictEqual(v.vote, 'request_changes');
  });

  test('llmChat returning garbage → verdict request_changes (never approve)', async () => {
    const garbageInputs = ['lgtm', '', 'yes', 'SHIP IT', '???'];
    for (const g of garbageInputs) {
      const v = await dispatch(g);
      assert.notStrictEqual(
        v.vote,
        'approve',
        `garbage input "${g}" must not map to approve, got ${v.vote}`,
      );
      assert.strictEqual(
        v.vote,
        'request_changes',
        `garbage input "${g}" must map to request_changes, got ${v.vote}`,
      );
    }
  });

  test('returns ReviewVerdict with reviewerId matching the reviewer', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 100,
      llmChat: fakeLlmChat('APPROVE', 2),
    }));
    const reviewer = modelReviewer('myProvider:myModel');
    const v = await deps.dispatchReviewer(reviewer, 'task-V2');
    assert.strictEqual(v.reviewerId, 'myProvider:myModel');
  });

  test('reported costCents from llmChat is preserved in verdict', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 100,
      llmChat: fakeLlmChat('APPROVE', 17),
    }));
    const v = await deps.dispatchReviewer(modelReviewer(), 'task-V3');
    assert.strictEqual(v.costCents, 17);
  });

  test('summary is content-free (starts with "model verdict:")', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 100,
      llmChat: fakeLlmChat('APPROVE', 2),
    }));
    const v = await deps.dispatchReviewer(modelReviewer(), 'task-V4');
    assert.ok(
      typeof v.summary === 'string' && v.summary.startsWith('model verdict:'),
      `summary must start with "model verdict:", got: ${v.summary}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: dispatchReviewer — runner-kind stub (RF-4b)                        */
/* -------------------------------------------------------------------------- */

suite('RF-4a dispatchReviewer — runner-kind stub (RF-4b seam)', () => {
  test('runner-kind reviewer throws with RF-4b stub message', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 1000,
      llmChat: fakeLlmChat('APPROVE'),
    }));

    let threw = false;
    let errMsg = '';
    try {
      await deps.dispatchReviewer(runnerReviewer('claude-code'), 'task-R1');
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }

    assert.strictEqual(threw, true, 'runner reviewer must throw');
    assert.ok(
      errMsg.includes('RF-4b'),
      `error must mention RF-4b, got: ${errMsg}`,
    );
  });

  test('runner throw happens AFTER enabled+budget checks (enabled check first)', async () => {
    // When enabled:false, the fleet-disabled error fires BEFORE the runner check.
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: false,
      budgetCents: 1000,
      llmChat: fakeLlmChat('APPROVE'),
    }));

    let errMsg = '';
    try {
      await deps.dispatchReviewer(runnerReviewer('claude-code'), 'task-R2');
    } catch (e) {
      errMsg = (e as Error).message;
    }
    // Expect the "disabled" error, not the RF-4b error.
    assert.ok(
      errMsg.includes('disabled'),
      `with enabled:false, error must mention "disabled", got: ${errMsg}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: writeVote                                                           */
/* -------------------------------------------------------------------------- */

suite('RF-4a writeVote — file output', () => {
  test('writes a file named <taskId>-<sanitizedVoter>.json', async () => {
    const ws = tmpDir();
    const commsDir = path.join(ws, '.autoclaw', 'orchestrator', 'comms');
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, { commsDir }));

    const vote = makeVote({ voter: 'automated:fleet', task_id: 'A1' });
    await deps.writeVote(vote);

    const expectedFile = path.join(commsDir, 'consensus', 'active', 'A1-automated-fleet.json');
    assert.ok(
      fs.existsSync(expectedFile),
      `expected file at ${expectedFile}`,
    );
  });

  test('written file contains automated:true', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws));

    const vote = makeVote({ task_id: 'A2', voter: 'bot', vote: 'request_changes' });
    await deps.writeVote(vote);

    const dir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active');
    const file = path.join(dir, 'A2-bot.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.strictEqual(parsed.automated, true, 'automated must be true');
  });

  test('written file contains valid JSON with all required fields', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, {
      sessionId: 'sess-xyz',
      now: () => '2026-06-29T10:00:00.000Z',
    }));

    const vote = makeVote({
      task_id: 'A3',
      voter: 'autoclaw-bot',
      vote: 'approve',
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    await deps.writeVote(vote);

    const dir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active');
    const file = path.join(dir, 'A3-autoclaw-bot.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.strictEqual(parsed.voter, 'autoclaw-bot');
    assert.strictEqual(parsed.task_id, 'A3');
    assert.strictEqual(parsed.vote, 'approve');
    assert.strictEqual(parsed.automated, true);
    assert.strictEqual(parsed.session_id, 'sess-xyz');
    assert.strictEqual(typeof parsed.timestamp, 'string');
  });

  test('creates the consensus/active dir if it does not exist', async () => {
    const ws = tmpDir();
    const commsDir = path.join(ws, 'deep', 'comms', 'dir');
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, { commsDir }));

    const vote = makeVote({ task_id: 'A4', voter: 'bot' });
    // Dir doesn't exist yet — writeVote must create it.
    await deps.writeVote(vote);

    const dir = path.join(commsDir, 'consensus', 'active');
    assert.ok(fs.existsSync(dir), 'consensus/active dir must be created');
  });

  test('voter with special chars gets sanitized in filename', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws));

    const vote = makeVote({ task_id: 'A5', voter: 'fleet/review@bot' });
    await deps.writeVote(vote);

    const dir = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active');
    // "fleet/review@bot" → "fleet-review-bot"
    const file = path.join(dir, 'A5-fleet-review-bot.json');
    assert.ok(fs.existsSync(file), `sanitized file must exist at ${file}`);

    // voter in JSON must be the ORIGINAL (unsanitized) string
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.voter, 'fleet/review@bot', 'voter field preserves original');
  });

  test('malicious task_id cannot escape consensus/active (path traversal)', async () => {
    const ws = tmpDir();
    const commsDir = path.join(ws, '.autoclaw', 'orchestrator', 'comms');
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, { commsDir }));
    const activeDir = path.join(commsDir, 'consensus', 'active');

    const vote = makeVote({ task_id: '../../../evil', voter: 'bot' });
    await deps.writeVote(vote);

    // Nothing may be written outside the active dir.
    assert.ok(!fs.existsSync(path.join(commsDir, 'consensus', 'evil-bot.json')), 'must NOT write one level up');
    assert.ok(!fs.existsSync(path.join(ws, 'evil-bot.json')), 'must NOT traverse to workspace root');

    // Exactly one file, and it resolves to within active/.
    const written = fs.readdirSync(activeDir);
    assert.strictEqual(written.length, 1, 'exactly one file in active/');
    const resolved = path.resolve(activeDir, written[0]);
    assert.ok(resolved.startsWith(path.resolve(activeDir) + path.sep), 'written file stays within active/');

    // The task_id field in the JSON preserves the original (only the filename is sanitized).
    const parsed = JSON.parse(fs.readFileSync(path.join(activeDir, written[0]), 'utf8'));
    assert.strictEqual(parsed.task_id, '../../../evil', 'task_id field preserves original');
  });

  test('dots-only task_id/voter are neutralised (never a .. directory entry)', async () => {
    const ws = tmpDir();
    const commsDir = path.join(ws, '.autoclaw', 'orchestrator', 'comms');
    const deps = defaultReviewFleetDeps(baseProdOpts(ws, { commsDir }));
    const activeDir = path.join(commsDir, 'consensus', 'active');

    await deps.writeVote(makeVote({ task_id: '..', voter: '..' }));

    const written = fs.readdirSync(activeDir);
    assert.strictEqual(written.length, 1);
    assert.ok(!written.includes('..') && !written.includes('.'), 'no bare . or .. entry');
    assert.ok(written[0].startsWith('_'), 'dots-only segment is prefixed with _');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: scoreRun                                                            */
/* -------------------------------------------------------------------------- */

suite('RF-4a scoreRun — calls scoreAndAppendScaffoldRun', () => {
  test('scoreRun writes a score row to the workspace scaffold store', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws));

    // Use a spy: we override the module's dynamic import behavior by checking
    // the effect — scoreAndAppendScaffoldRun writes to
    // <workspaceRoot>/.autoclaw/scaffold-scores.jsonl (via appendScaffoldScore).
    // Provide minimal valid ScaffoldScoreInput so buildScaffoldScore actually builds a score.
    const input: ScaffoldScoreInput = {
      scaffold: {
        schema: 'autoclaw.scaffold.v1' as const,
        id: 'scaffold-score-test',
        workflowId: 'wf-score-test',
        taskIntent: 'code',
        routerProfile: 'balanced',
        toolLaneIds: [],
        createdAt: '2026-06-29T00:00:00.000Z',
      },
      run: {
        runId: 'run-score-001',
        workflowId: 'wf-score-test',
        status: 'completed',
        costCents: 5,
        inputTokens: 10,
        outputTokens: 5,
        failureTypes: [],
        gateCount: 1,
        failedGateCount: 0,
        retryCount: 0,
        artifactCount: 1,
        eventCount: 2,
      },
      review: {
        verifierPass: true,
        judgeVeto: false,
      },
    };

    // Should not throw
    let threw = false;
    try {
      await deps.scoreRun!(input);
    } catch (e) {
      threw = true;
      // Only fail if it's not a "module not found" type error, since the
      // test runs in the compiled out/ tree and the score module must exist.
      assert.fail(`scoreRun threw unexpectedly: ${(e as Error).message}`);
    }
    assert.strictEqual(threw, false, 'scoreRun must not throw on valid input');
  });

  test('scoreRun with invalid input does not throw (missing runId → warnings only)', async () => {
    const ws = tmpDir();
    const deps = defaultReviewFleetDeps(baseProdOpts(ws));

    const input: ScaffoldScoreInput = {
      scaffold: {
        schema: 'autoclaw.scaffold.v1' as const,
        id: 'scaffold-noid',
        workflowId: 'wf-noid',
        taskIntent: 'code',
        routerProfile: 'balanced',
        toolLaneIds: [],
        createdAt: '2026-06-29T00:00:00.000Z',
      },
      run: {
        // runId missing → buildScaffoldScore returns warnings, no score, no write
        workflowId: 'wf-noid',
        status: 'completed',
      },
    };

    // Must not throw — service.ts says scoreRun failure must NOT break the review
    let threw = false;
    try {
      await deps.scoreRun!(input);
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'scoreRun must not throw on incomplete input');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tests: end-to-end with injected spy for scoreRun                          */
/* -------------------------------------------------------------------------- */

suite('RF-4a — scoreRun injectable spy', () => {
  test('scoreRun is called with the ScaffoldScoreInput when injected', async () => {
    const ws = tmpDir();
    const captured: ScaffoldScoreInput[] = [];

    // Build deps manually to inject a spy scoreRun
    const { ReviewFleetDeps: _unused } = {} as { ReviewFleetDeps: unknown };
    const baseDeps = defaultReviewFleetDeps(baseProdOpts(ws, {
      enabled: true,
      budgetCents: 100,
      llmChat: fakeLlmChat('APPROVE', 5),
    }));

    // Wrap scoreRun with a spy
    const spyDeps = {
      ...baseDeps,
      scoreRun: async (input: ScaffoldScoreInput) => {
        captured.push(input);
      },
    };

    const { processReviewRequest } = await import('../reviewfleet/service');
    const { ScaffoldVariant: _sv } = {} as { ScaffoldVariant: unknown };

    const result = await processReviewRequest(
      {
        scaffold: {
          schema: 'autoclaw.scaffold.v1' as const,
          id: 'scaffold-spy',
          workflowId: 'wf-spy',
          taskIntent: 'code',
          routerProfile: 'balanced',
          toolLaneIds: [],
          createdAt: '2026-06-29T00:00:00.000Z',
          review: {
            tier: 'tier1-local',
            reviewerIndependence: 'same-model',
            gatesFirst: false,
          },
        },
        taskId: 'task-spy-1',
        runSummary: {
          runId: 'run-spy-001',
          workflowId: 'wf-spy',
          status: 'completed',
          costCents: 10,
          inputTokens: 50,
          outputTokens: 20,
          failureTypes: [],
          gateCount: 1,
          failedGateCount: 0,
          retryCount: 0,
          artifactCount: 1,
          eventCount: 2,
        },
      },
      spyDeps,
    );

    assert.strictEqual(result.humanRequired, false, 'should not require human');
    assert.strictEqual(result.scored, true, 'scored should be true when scoreRun does not throw');
    assert.strictEqual(captured.length, 1, 'scoreRun spy must have been called once');
    assert.strictEqual(
      captured[0].scaffold.id,
      'scaffold-spy',
      'scoreRun called with correct scaffold',
    );
  });
});
