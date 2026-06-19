/**
 * intelligence-coordination.test.ts — coverage for the coordination-signal
 * collector that feeds team outcomes into /learn.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { collectCoordinationSignals } from '../intelligence/coordinationSignals';

function commsResolved(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'resolved');
}
function commsShared(root: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
}
function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

suite('intelligence — collectCoordinationSignals', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-')); });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('no comms tree → empty signal, no throw', () => {
    const s = collectCoordinationSignals(root);
    assert.deepStrictEqual(s.counts, { approved: 0, changesRequested: 0, rejected: 0, findings: 0 });
    assert.strictEqual(s.successful.length, 0);
    assert.strictEqual(s.avoided.length, 0);
  });

  test('approved consensus becomes a successful pattern', () => {
    writeJson(path.join(commsResolved(root), 'A1.json'), {
      task_id: 'A1', verdict: 'approved', rule: 'majority',
      approvals: 2, panel_size: 3, reviewers: ['kilocode', 'kiro'],
      resolved_at: '2026-06-17T00:00:00Z',
    });
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.approved, 1);
    assert.strictEqual(s.successful.length, 1);
    assert.match(s.successful[0], /majority consensus approved A1 \(2\/3, kilocode\+kiro\)/);
    assert.strictEqual(s.avoided.length, 0);
  });

  test('rejected / changes-requested consensus becomes an avoided pattern', () => {
    writeJson(path.join(commsResolved(root), 'B2.json'), {
      task_id: 'B2', verdict: 'rejected', rule: 'unanimous', approvals: 1, panel_size: 3, reviewers: [],
    });
    writeJson(path.join(commsResolved(root), 'C3.json'), {
      task_id: 'C3', verdict: 'changes_requested', rule: 'majority', approvals: 1, panel_size: 3, reviewers: [],
    });
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.rejected, 1);
    assert.strictEqual(s.counts.changesRequested, 1);
    assert.strictEqual(s.avoided.length, 2);
    assert.ok(s.avoided.some(a => /B2 rejected by unanimous review/.test(a)));
    assert.ok(s.avoided.some(a => /C3 changes requested by majority review/.test(a)));
  });

  test('finding_report messages become avoided patterns, redacted', () => {
    writeJson(path.join(commsShared(root), 'f1.json'), {
      id: 'msg-1', type: 'finding_report', from: 'kilocode',
      payload: { severity: 'high', description: 'SEC-001 token leak; key=sk-ABC123SECRETVALUE0000' },
    });
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.findings, 1);
    assert.strictEqual(s.avoided.length, 1);
    assert.match(s.avoided[0], /Review finding \[high\] from kilocode:/);
    assert.ok(!s.avoided[0].includes('sk-ABC123SECRETVALUE0000'), 'secret must be redacted');
  });

  test('finding_reports de-dup across shared/ and processed/ by id', () => {
    const body = {
      id: 'msg-dup', type: 'finding_report', from: 'kiro',
      payload: { severity: 'medium', description: 'duplicate finding' },
    };
    writeJson(path.join(commsShared(root), 'a.json'), body);
    writeJson(path.join(commsShared(root), 'processed', 'a.json'), body);
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.findings, 1, 'same id counted once');
  });

  test('ignores non-finding messages', () => {
    writeJson(path.join(commsShared(root), 'tc.json'), {
      id: 'msg-tc', type: 'task_complete', from: 'claude-code', payload: {},
    });
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.findings, 0);
  });

  test('unrecognised verdict is treated as not-approved (fail-safe)', () => {
    writeJson(path.join(commsResolved(root), 'D4.json'), {
      task_id: 'D4', verdict: 'weird', rule: 'majority', approvals: 9, panel_size: 3, reviewers: [],
    });
    const s = collectCoordinationSignals(root);
    assert.strictEqual(s.counts.approved, 0);
    assert.strictEqual(s.counts.rejected, 1);
  });

  test('respects the max cap', () => {
    for (let i = 0; i < 30; i++) {
      writeJson(path.join(commsResolved(root), `T${i}.json`), {
        task_id: `T${i}`, verdict: 'approved', rule: 'majority',
        approvals: 2, panel_size: 3, reviewers: [], resolved_at: `2026-06-17T00:00:${String(i).padStart(2, '0')}Z`,
      });
    }
    const s = collectCoordinationSignals(root, { max: 5 });
    assert.strictEqual(s.successful.length, 5);
    assert.strictEqual(s.counts.approved, 30, 'count reflects all, list is capped');
  });
});
