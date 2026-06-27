import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendTaskCompletion,
  readTaskLedger,
  summarizeByAgent,
  recentCompletions,
  taskLedgerPath,
  TASK_LEDGER_FILE,
  type TaskLedgerEntry,
  type LedgerClaim,
  type LedgerBoard,
} from '../taskLedger';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taskledger-test-'));
}

function entry(over: Partial<TaskLedgerEntry>): TaskLedgerEntry {
  return {
    task_id: 'T-1',
    agent_id: 'claude-code',
    completed_at: '2026-06-22T12:00:00.000Z',
    ...over,
  };
}

suite('taskLedger — append/read roundtrip', () => {
  test('append then read returns the same records, in order', () => {
    const root = makeTmp();
    appendTaskCompletion(root, entry({ task_id: 'A', completed_at: '2026-06-22T10:00:00Z' }));
    appendTaskCompletion(root, entry({ task_id: 'B', completed_at: '2026-06-22T11:00:00Z', sprint: 2, title: 'Build panel' }));
    const ledger = readTaskLedger(root);
    assert.strictEqual(ledger.length, 2);
    assert.strictEqual(ledger[0].task_id, 'A');
    assert.strictEqual(ledger[1].task_id, 'B');
    assert.strictEqual(ledger[1].sprint, 2);
    assert.strictEqual(ledger[1].title, 'Build panel');
  });

  test('enriched fields (gates, tests_run, task_ids, summary) round-trip', () => {
    const root = makeTmp();
    appendTaskCompletion(root, entry({
      task_id: 'C',
      gates: ['lint', 'test', 'build'],
      tests_run: 42,
      task_ids: ['C1', 'C2', 'C3'],
      summary: 'Implemented the feature with full coverage',
    }));
    const ledger = readTaskLedger(root);
    assert.strictEqual(ledger.length, 1);
    assert.deepStrictEqual(ledger[0].gates, ['lint', 'test', 'build']);
    assert.strictEqual(ledger[0].tests_run, 42);
    assert.deepStrictEqual(ledger[0].task_ids, ['C1', 'C2', 'C3']);
    assert.strictEqual(ledger[0].summary, 'Implemented the feature with full coverage');
  });

  test('writes JSONL (one object per line) to the canonical path', () => {
    const root = makeTmp();
    appendTaskCompletion(root, entry({ task_id: 'A' }));
    appendTaskCompletion(root, entry({ task_id: 'B' }));
    const p = taskLedgerPath(root);
    assert.ok(p.endsWith(TASK_LEDGER_FILE));
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    // each line must be valid standalone JSON
    for (const l of lines) { JSON.parse(l); }
  });

  test('creates the comms dir on first append (fresh project)', () => {
    const root = path.join(makeTmp(), 'does', 'not', 'exist', 'yet');
    assert.ok(!fs.existsSync(root));
    appendTaskCompletion(root, entry({ task_id: 'A' }));
    assert.ok(fs.existsSync(taskLedgerPath(root)));
    assert.strictEqual(readTaskLedger(root).length, 1);
  });

  test('stamps completed_at when the caller omits it', () => {
    const root = makeTmp();
    appendTaskCompletion(root, { task_id: 'A', agent_id: 'x', completed_at: '' });
    const [rec] = readTaskLedger(root);
    assert.ok(rec.completed_at.length > 0, 'completed_at should be filled in');
    assert.ok(!Number.isNaN(new Date(rec.completed_at).getTime()));
  });
});

suite('taskLedger — read tolerance', () => {
  test('missing file → []', () => {
    const root = makeTmp(); // no file written
    assert.deepStrictEqual(readTaskLedger(root), []);
  });

  test('skips blank and malformed lines, keeps valid ones', () => {
    const root = makeTmp();
    const p = taskLedgerPath(root);
    fs.writeFileSync(p, [
      JSON.stringify(entry({ task_id: 'A' })),
      '',                                   // blank
      '{ not json',                         // malformed (half-written tail)
      JSON.stringify(entry({ task_id: 'B' })),
      JSON.stringify({ agent_id: 'x' }),    // missing task_id → dropped
    ].join('\n'), 'utf8');
    const ledger = readTaskLedger(root);
    assert.deepStrictEqual(ledger.map(e => e.task_id), ['A', 'B']);
  });

  test('strips a leading UTF-8 BOM', () => {
    const root = makeTmp();
    fs.writeFileSync(taskLedgerPath(root), '﻿' + JSON.stringify(entry({ task_id: 'A' })) + '\n', 'utf8');
    assert.strictEqual(readTaskLedger(root).length, 1);
  });
});

suite('taskLedger — summarizeByAgent rollups', () => {
  const NOW = new Date('2026-06-22T18:00:00Z');

  const ledger: TaskLedgerEntry[] = [
    entry({ task_id: 'T-1', agent_id: 'claude-code', completed_at: '2026-06-22T09:00:00Z', review_status: 'approved' }),
    entry({ task_id: 'T-2', agent_id: 'claude-code', completed_at: '2026-06-22T12:00:00Z' }),
    entry({ task_id: 'T-old', agent_id: 'claude-code', completed_at: '2026-06-20T12:00:00Z' }), // earlier day
    entry({ task_id: 'K-1', agent_id: 'kilocode', completed_at: '2026-06-22T08:00:00Z' }),
  ];

  const claims: LedgerClaim[] = [
    { task_id: 'T-9', claimed_by: 'claude-code' },     // canonical field
    { task_id: 'K-9', agent: 'kilocode' },             // legacy field
  ];

  const board: LedgerBoard = {
    in_flight: [{ task_id: 'T-9', claimed_by: 'claude-code' }], // also a live claim → dedup
    awaiting_review: [{ task_id: 'T-rev', author: 'claude-code' }],
  };

  test('counts done total + done today per agent', () => {
    const roll = summarizeByAgent(ledger, claims, board, { now: NOW });
    assert.strictEqual(roll['claude-code'].doneTotal, 3);
    assert.strictEqual(roll['claude-code'].doneToday, 2); // T-old is a different day
    assert.strictEqual(roll['kilocode'].doneTotal, 1);
    assert.strictEqual(roll['kilocode'].doneToday, 1);
  });

  test('assigned = union of claims + board (deduped); in-progress = board in_flight', () => {
    const roll = summarizeByAgent(ledger, claims, board, { now: NOW });
    // claude-code: claim T-9, board in_flight T-9 (same), review T-rev → 2 distinct
    assert.strictEqual(roll['claude-code'].assigned, 2);
    assert.strictEqual(roll['claude-code'].inProgress, 1);
    // kilocode: legacy claim K-9 only
    assert.strictEqual(roll['kilocode'].assigned, 1);
    assert.strictEqual(roll['kilocode'].inProgress, 0);
  });

  test('recentCompleted is newest-first and capped by recentLimit', () => {
    const roll = summarizeByAgent(ledger, [], null, { now: NOW, recentLimit: 2 });
    const recent = roll['claude-code'].recentCompleted;
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].task_id, 'T-2');  // 12:00 newest
    assert.strictEqual(recent[1].task_id, 'T-1');  // 09:00 next
  });

  test('an agent with only completions (no open work) still appears', () => {
    const roll = summarizeByAgent(
      [entry({ task_id: 'Z', agent_id: 'ghost', completed_at: '2026-06-22T01:00:00Z' })],
      [], null, { now: NOW });
    assert.ok(roll['ghost']);
    assert.strictEqual(roll['ghost'].assigned, 0);
    assert.strictEqual(roll['ghost'].doneTotal, 1);
  });

  test('empty inputs → empty rollup', () => {
    assert.deepStrictEqual(summarizeByAgent([], [], null, { now: NOW }), {});
  });
});

suite('taskLedger — recentCompletions', () => {
  test('sorts newest-first and caps to limit', () => {
    const ledger: TaskLedgerEntry[] = [
      entry({ task_id: 'A', completed_at: '2026-06-22T01:00:00Z' }),
      entry({ task_id: 'C', completed_at: '2026-06-22T03:00:00Z' }),
      entry({ task_id: 'B', completed_at: '2026-06-22T02:00:00Z' }),
    ];
    const out = recentCompletions(ledger, 2);
    assert.deepStrictEqual(out.map(e => e.task_id), ['C', 'B']);
  });

  test('empty ledger → []', () => {
    assert.deepStrictEqual(recentCompletions([]), []);
  });
});
