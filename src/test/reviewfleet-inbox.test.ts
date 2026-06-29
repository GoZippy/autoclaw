/**
 * reviewfleet-inbox.test.ts — RF-4c: Tests for the Review Fleet inbox adapter.
 *
 * Uses real filesystem operations against a temp commsDir.  No LLM calls,
 * no network.  The fleet stays dormant (enabled defaults to false in
 * defaultReviewFleetDeps, so dispatchReviewer throws).
 *
 * Suites:
 *  1. scanReviewRequests — type filtering, idempotency, field mapping,
 *     malformed JSON tolerance.
 *  2. markReviewRequestProcessed — moves file, second call is no-op.
 *  3. defaultReviewFleetWatcherDeps — wiring correctness; dormant by default.
 *  4. End-to-end offline — seed 2 review_requests; runReviewFleetCycle via
 *     defaultReviewFleetWatcherDeps(enabled:false) → humanRequired + moved
 *     to processed/.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  scanReviewRequests,
  markReviewRequestProcessed,
  defaultReviewFleetWatcherDeps,
} from '../reviewfleet/inbox';
import { runReviewFleetCycle } from '../reviewfleet/watcher';
import type { ReviewerCapacity } from '../reviewfleet/roster';

/* -------------------------------------------------------------------------- */
/*  Temp dir helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a fresh temp commsDir for a test.  Returns its absolute path.
 * The caller must call rmTemp() in teardown.
 */
function makeTempCommsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rf-inbox-test-'));
}

/** Recursively remove a temp dir.  Best-effort — does not throw. */
function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in tests.
  }
}

/**
 * Ensure a directory exists (mkdir -p equivalent).
 */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a JSON object as a file.
 */
function writeJson(filePath: string, obj: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Build a minimal review_request message object.
 */
function makeReviewRequestMsg(overrides: {
  id?: string;
  task_id?: string;
  scaffold?: unknown;
  ctx?: unknown;
  payload?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const {
    id = `msg-${Math.random().toString(36).slice(2)}`,
    task_id = `task-${Math.random().toString(36).slice(2)}`,
    scaffold,
    ctx,
    payload: extraPayload = {},
  } = overrides;

  const payload: Record<string, unknown> = { ...extraPayload };
  if (scaffold !== undefined) { payload['scaffold'] = scaffold; }
  if (ctx !== undefined) { payload['ctx'] = ctx; }

  return {
    id,
    from: 'orchestrator-loop',
    to: 'shared',
    type: 'review_request',
    timestamp: new Date().toISOString(),
    task_id,
    requires_response: true,
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/*  Minimal roster for end-to-end test                                        */
/* -------------------------------------------------------------------------- */

function makeMinimalRoster(): ReviewerCapacity[] {
  return [
    {
      id: 'test:local-model',
      kind: 'model' as const,
      locality: 'local' as const,
      costTier: 'free' as const,
      strength: 'cheap' as const,
      healthy: true,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Suite 1: scanReviewRequests                                                */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetInbox — scanReviewRequests', () => {
  let commsDir: string;

  setup(() => {
    commsDir = makeTempCommsDir();
  });

  teardown(() => {
    rmTemp(commsDir);
  });

  test('returns only review_request messages, skips other types', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg1 = makeReviewRequestMsg({ id: 'msg-rr-1', task_id: 'T1' });
    const msgOther = { ...msg1, id: 'msg-other', type: 'task_complete' };
    const msg2 = makeReviewRequestMsg({ id: 'msg-rr-2', task_id: 'T2' });

    writeJson(path.join(sharedDir, 'msg-rr-1.json'), msg1);
    writeJson(path.join(sharedDir, 'msg-other.json'), msgOther);
    writeJson(path.join(sharedDir, 'msg-rr-2.json'), msg2);

    const results = await scanReviewRequests({ commsDir });

    assert.strictEqual(results.length, 2, 'should return only 2 review_request messages');
    const ids = results.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['msg-rr-1', 'msg-rr-2']);
  });

  test('skips messages already in processed/', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    const processedDir = path.join(sharedDir, 'processed');
    ensureDir(sharedDir);
    ensureDir(processedDir);

    const live = makeReviewRequestMsg({ id: 'msg-live', task_id: 'T-live' });
    const done = makeReviewRequestMsg({ id: 'msg-done', task_id: 'T-done' });

    writeJson(path.join(sharedDir, 'msg-live.json'), live);
    // Write the "done" message to processed/ — it should be skipped.
    writeJson(path.join(processedDir, 'msg-done.json'), done);
    // Also write it in the inbox root to confirm the processed/ check wins.
    writeJson(path.join(sharedDir, 'msg-done-dup.json'), done);

    const results = await scanReviewRequests({ commsDir });

    assert.strictEqual(results.length, 1, 'should return only the live message');
    assert.strictEqual(results[0].id, 'msg-live');
  });

  test('parses taskId from top-level task_id, then payload.task_id', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    // Top-level task_id.
    const msgTopLevel = makeReviewRequestMsg({ id: 'msg-top', task_id: 'T-top' });
    // Payload-only task_id (remove top-level).
    const msgPayloadOnly: Record<string, unknown> = {
      id: 'msg-payload',
      from: 'test',
      type: 'review_request',
      timestamp: new Date().toISOString(),
      payload: { task_id: 'T-payload' },
    };

    writeJson(path.join(sharedDir, 'msg-top.json'), msgTopLevel);
    writeJson(path.join(sharedDir, 'msg-payload.json'), msgPayloadOnly);

    const results = await scanReviewRequests({ commsDir });

    const byId = new Map(results.map((r) => [r.id, r]));
    assert.strictEqual(byId.get('msg-top')?.taskId, 'T-top', 'top-level task_id');
    assert.strictEqual(byId.get('msg-payload')?.taskId, 'T-payload', 'payload.task_id');
  });

  test('parses scaffold and ctx from payload when present', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const scaffold = {
      schema: 'autoclaw.scaffold.v1',
      id: 'test-scaffold',
      workflowId: 'wf-1',
      taskIntent: 'code',
      routerProfile: 'balanced',
      toolLaneIds: [],
      createdAt: '2026-06-29T00:00:00.000Z',
      review: { tier: 'tier1-local', reviewerIndependence: 'same-model', gatesFirst: false },
    };
    const ctx = { tags: ['test-tag'] };

    const msg = makeReviewRequestMsg({
      id: 'msg-with-payload',
      task_id: 'T-payload',
      scaffold,
      ctx,
    });

    writeJson(path.join(sharedDir, 'msg-with-payload.json'), msg);

    const results = await scanReviewRequests({ commsDir });

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].scaffold !== undefined, 'scaffold should be present');
    assert.strictEqual((results[0].scaffold as { id: string }).id, 'test-scaffold');
    assert.ok(results[0].ctx !== undefined, 'ctx should be present');
  });

  test('tolerates one malformed JSON file without throwing', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    // Write a malformed JSON file.
    fs.writeFileSync(path.join(sharedDir, 'bad.json'), '{this is not json', 'utf8');
    // And one valid review_request.
    const msg = makeReviewRequestMsg({ id: 'msg-good', task_id: 'T-good' });
    writeJson(path.join(sharedDir, 'msg-good.json'), msg);

    let results: Awaited<ReturnType<typeof scanReviewRequests>> | undefined;
    let threw = false;
    try {
      results = await scanReviewRequests({ commsDir });
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'scanReviewRequests must not throw on malformed JSON');
    assert.ok(results !== undefined);
    assert.strictEqual(results.length, 1, 'should return only the valid message');
    assert.strictEqual(results[0].id, 'msg-good');
  });

  test('missing inbox dir contributes nothing and does not throw', async () => {
    // commsDir exists but has no inboxes/ subdirectory at all.
    const results = await scanReviewRequests({ commsDir, agentId: 'no-such-agent' });
    assert.deepStrictEqual(results, []);
  });

  test('also scans agentId inbox when provided', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    const agentDir = path.join(commsDir, 'inboxes', 'my-agent');
    ensureDir(sharedDir);
    ensureDir(agentDir);

    const msgShared = makeReviewRequestMsg({ id: 'msg-shared', task_id: 'T-shared' });
    const msgAgent = makeReviewRequestMsg({ id: 'msg-agent', task_id: 'T-agent' });

    writeJson(path.join(sharedDir, 'msg-shared.json'), msgShared);
    writeJson(path.join(agentDir, 'msg-agent.json'), msgAgent);

    const results = await scanReviewRequests({ commsDir, agentId: 'my-agent' });

    const ids = results.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['msg-agent', 'msg-shared']);
  });

  test('deduplicates when same message id appears in both inboxes', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    const agentDir = path.join(commsDir, 'inboxes', 'my-agent');
    ensureDir(sharedDir);
    ensureDir(agentDir);

    const msg = makeReviewRequestMsg({ id: 'msg-dup', task_id: 'T-dup' });
    writeJson(path.join(sharedDir, 'msg-dup.json'), msg);
    writeJson(path.join(agentDir, 'msg-dup.json'), msg);

    const results = await scanReviewRequests({ commsDir, agentId: 'my-agent' });
    assert.strictEqual(results.length, 1, 'dedup by id across inboxes');
    assert.strictEqual(results[0].id, 'msg-dup');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 2: markReviewRequestProcessed                                        */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetInbox — markReviewRequestProcessed', () => {
  let commsDir: string;

  setup(() => {
    commsDir = makeTempCommsDir();
  });

  teardown(() => {
    rmTemp(commsDir);
  });

  test('moves the file from shared/ to shared/processed/', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg = makeReviewRequestMsg({ id: 'msg-to-move', task_id: 'T-move' });
    const srcPath = path.join(sharedDir, 'msg-to-move.json');
    writeJson(srcPath, msg);

    await markReviewRequestProcessed({ commsDir }, 'msg-to-move');

    // Source file should be gone.
    assert.strictEqual(
      fs.existsSync(srcPath),
      false,
      'source file must be gone after markProcessed',
    );

    // File should be in processed/.
    const destPath = path.join(sharedDir, 'processed', 'msg-to-move.json');
    assert.strictEqual(
      fs.existsSync(destPath),
      true,
      'file must exist in processed/ after markProcessed',
    );

    // Verify the content is intact.
    const parsed = JSON.parse(fs.readFileSync(destPath, 'utf8'));
    assert.strictEqual(parsed.id, 'msg-to-move');
  });

  test('second call on same id is a no-op (idempotent)', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg = makeReviewRequestMsg({ id: 'msg-idem', task_id: 'T-idem' });
    writeJson(path.join(sharedDir, 'msg-idem.json'), msg);

    // First call.
    await markReviewRequestProcessed({ commsDir }, 'msg-idem');

    // Second call — should not throw.
    let threw = false;
    try {
      await markReviewRequestProcessed({ commsDir }, 'msg-idem');
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'second markProcessed call must not throw');

    // The processed file must still be there (not double-moved or deleted).
    const destPath = path.join(sharedDir, 'processed', 'msg-idem.json');
    assert.strictEqual(fs.existsSync(destPath), true, 'processed file must still exist');
  });

  test('no-op when id is not found', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    let threw = false;
    try {
      await markReviewRequestProcessed({ commsDir }, 'msg-does-not-exist');
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'no-op when id not found, must not throw');
  });

  test('moves file from agent inbox when agentId provided', async () => {
    const agentDir = path.join(commsDir, 'inboxes', 'my-agent');
    ensureDir(agentDir);

    const msg = makeReviewRequestMsg({ id: 'msg-agent-move', task_id: 'T-am' });
    const srcPath = path.join(agentDir, 'msg-agent-move.json');
    writeJson(srcPath, msg);

    await markReviewRequestProcessed({ commsDir, agentId: 'my-agent' }, 'msg-agent-move');

    assert.strictEqual(fs.existsSync(srcPath), false, 'source must be gone');
    assert.strictEqual(
      fs.existsSync(path.join(agentDir, 'processed', 'msg-agent-move.json')),
      true,
      'must appear in processed/',
    );
  });

  test('creates processed/ dir if it does not exist', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);
    // Do NOT create processed/ — markProcessed should create it.

    const msg = makeReviewRequestMsg({ id: 'msg-mkdir', task_id: 'T-mkdir' });
    writeJson(path.join(sharedDir, 'msg-mkdir.json'), msg);

    await markReviewRequestProcessed({ commsDir }, 'msg-mkdir');

    const processedDir = path.join(sharedDir, 'processed');
    assert.strictEqual(
      fs.existsSync(processedDir),
      true,
      'processed/ must be created automatically',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 3: defaultReviewFleetWatcherDeps wiring                             */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetInbox — defaultReviewFleetWatcherDeps wiring', () => {
  let commsDir: string;
  let workspaceRoot: string;

  setup(() => {
    commsDir = makeTempCommsDir();
    workspaceRoot = commsDir; // Close enough for wiring tests.
  });

  teardown(() => {
    rmTemp(commsDir);
  });

  test('returns a ReviewFleetWatcherDeps with all required seams', () => {
    const deps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: makeMinimalRoster(),
      commsDir,
    });

    assert.ok(typeof deps.scanPendingRequests === 'function', 'scanPendingRequests must be a function');
    assert.ok(typeof deps.markProcessed === 'function', 'markProcessed must be a function');
    assert.ok(typeof deps.now === 'function', 'now must be a function');
    assert.ok(deps.deps !== undefined, 'deps.deps must be present');
    assert.ok(deps.deps.roster !== undefined, 'deps.deps.roster must be present');
  });

  test('scanPendingRequests is wired to the real commsDir', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);
    const msg = makeReviewRequestMsg({ id: 'msg-wire-test', task_id: 'T-wire' });
    writeJson(path.join(sharedDir, 'msg-wire.json'), msg);

    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: makeMinimalRoster(),
      commsDir,
    });

    const results = await watcherDeps.scanPendingRequests();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'msg-wire-test');
  });

  test('markProcessed is wired and moves files in the real tree', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);
    const msg = makeReviewRequestMsg({ id: 'msg-mark-test', task_id: 'T-mark' });
    const srcPath = path.join(sharedDir, 'msg-mark.json');
    writeJson(srcPath, msg);

    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: makeMinimalRoster(),
      commsDir,
    });

    await watcherDeps.markProcessed('msg-mark-test');
    assert.strictEqual(fs.existsSync(srcPath), false, 'source must be gone after markProcessed');
  });

  test('enabled:false (default) → dispatchReviewer throws (fleet dormant)', async () => {
    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: makeMinimalRoster(),
      commsDir,
      // enabled intentionally omitted (defaults to false)
    });

    const reviewer = makeMinimalRoster()[0];
    let threw = false;
    try {
      await watcherDeps.deps.dispatchReviewer(reviewer, 'T-dormant');
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, true, 'dispatchReviewer must throw when fleet is dormant (enabled=false)');
  });

  test('commsDir defaults to <workspaceRoot>/.autoclaw/orchestrator/comms', async () => {
    // Use a real workspace root and let inbox default the commsDir.
    // Create the expected default dir so the scan can succeed.
    const defaultCommsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
    const sharedDir = path.join(defaultCommsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg = makeReviewRequestMsg({ id: 'msg-default-path', task_id: 'T-dp' });
    writeJson(path.join(sharedDir, 'msg-default-path.json'), msg);

    // Do NOT pass commsDir — it should default.
    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: makeMinimalRoster(),
    });

    const results = await watcherDeps.scanPendingRequests();
    const found = results.find((r) => r.id === 'msg-default-path');
    assert.ok(found !== undefined, 'should find message via default commsDir path');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 4: End-to-end offline                                               */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetInbox — end-to-end offline (enabled:false)', () => {
  let commsDir: string;
  let workspaceRoot: string;

  setup(() => {
    commsDir = makeTempCommsDir();
    workspaceRoot = commsDir;
  });

  teardown(() => {
    rmTemp(commsDir);
  });

  test('2 review_requests → runReviewFleetCycle → both humanRequired, both moved to processed/', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg1 = makeReviewRequestMsg({ id: 'msg-e2e-1', task_id: 'E2E-T1' });
    const msg2 = makeReviewRequestMsg({ id: 'msg-e2e-2', task_id: 'E2E-T2' });

    writeJson(path.join(sharedDir, 'msg-e2e-1.json'), msg1);
    writeJson(path.join(sharedDir, 'msg-e2e-2.json'), msg2);

    // Build watcher deps via defaultReviewFleetWatcherDeps with enabled:false.
    // The fleet is dormant: dispatchReviewer will throw → humanRequired path.
    // (processReviewRequest catches dispatch errors gracefully → humanRequired)
    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: [], // empty roster → planReview → humanRequired immediately
      commsDir,
      enabled: false, // explicit dormant
      budgetCents: 0,
    });

    // Run a single cycle.
    const summary = await runReviewFleetCycle(watcherDeps);

    // Both messages should have been scanned.
    assert.strictEqual(summary.scanned, 2, 'scanned must be 2');

    // With empty roster and enabled:false, both should resolve to humanRequired
    // (planReview finds no eligible reviewers → humanRequired=true → no vote written).
    assert.strictEqual(summary.humanRequired, 2, 'both must be humanRequired with empty roster');
    assert.strictEqual(summary.voted, 0, 'no automated vote when humanRequired');
    assert.strictEqual(summary.errors, 0, 'humanRequired is not an error');

    // Both must have been marked processed (moved to processed/).
    assert.strictEqual(summary.processed, 2, 'both must be processed');

    const processedDir = path.join(sharedDir, 'processed');
    const processedFiles = fs.readdirSync(processedDir);
    const processedIds = processedFiles
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const obj = JSON.parse(fs.readFileSync(path.join(processedDir, f), 'utf8'));
        return obj.id as string;
      })
      .sort();

    assert.deepStrictEqual(
      processedIds,
      ['msg-e2e-1', 'msg-e2e-2'],
      'both messages must be in processed/',
    );

    // Source files must be gone from the inbox root.
    assert.strictEqual(
      fs.existsSync(path.join(sharedDir, 'msg-e2e-1.json')),
      false,
      'msg-e2e-1.json must be gone from inbox root',
    );
    assert.strictEqual(
      fs.existsSync(path.join(sharedDir, 'msg-e2e-2.json')),
      false,
      'msg-e2e-2.json must be gone from inbox root',
    );
  });

  test('second cycle finds no pending requests (idempotency)', async () => {
    const sharedDir = path.join(commsDir, 'inboxes', 'shared');
    ensureDir(sharedDir);

    const msg = makeReviewRequestMsg({ id: 'msg-idem-e2e', task_id: 'T-idem-e2e' });
    writeJson(path.join(sharedDir, 'msg-idem-e2e.json'), msg);

    const watcherDeps = defaultReviewFleetWatcherDeps({
      workspaceRoot,
      roster: [],
      commsDir,
      enabled: false,
    });

    // First cycle processes the message.
    const summary1 = await runReviewFleetCycle(watcherDeps);
    assert.strictEqual(summary1.scanned, 1);
    assert.strictEqual(summary1.processed, 1);

    // Second cycle should find nothing (message already in processed/).
    const summary2 = await runReviewFleetCycle(watcherDeps);
    assert.strictEqual(summary2.scanned, 0, 'second cycle must scan 0 (already processed)');
    assert.strictEqual(summary2.processed, 0);
  });
});
