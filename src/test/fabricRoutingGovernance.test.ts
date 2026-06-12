/**
 * fabricRoutingGovernance.test.ts — AF-3 (route by type) + AF-5 (governance).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  rankAgentsForCapabilities,
  selectReviewers,
  reviewConsensusRuleFor,
  type RoutableAgent,
} from '../fabric/routing';
import {
  gateDispatch,
  appendAuditLog,
  readAuditLog,
} from '../fabric/governance';

const agents: RoutableAgent[] = [
  { id: 'coder-a', agent_type: 'coder', capabilities: ['typescript', 'react'] },
  { id: 'auditor-a', agent_type: 'auditor', capabilities: ['security-review'] },
  { id: 'auditor-b', agent_type: 'auditor', capabilities: [] },
  { id: 'runner-a', agent_type: 'runner', capabilities: ['deploy'] },
];

suite('AF-3 routing by type', () => {
  test('ranks by capability overlap incl. type tags; best first', () => {
    const ranked = rankAgentsForCapabilities(agents, ['typescript', 'edit']);
    assert.strictEqual(ranked[0].id, 'coder-a', 'coder has typescript + type tag "edit"');
    assert.ok(ranked[0].score > 0);
  });

  test('requiredType filters to that kind only', () => {
    const ranked = rankAgentsForCapabilities(agents, ['audit'], 'auditor');
    assert.deepStrictEqual(ranked.map(r => r.id).sort(), ['auditor-a', 'auditor-b']);
    // auditors get the 'audit' tag from their type profile ⇒ non-zero score.
    assert.ok(ranked.every(r => r.score > 0));
  });

  test('selectReviewers + consensus rule: auditors review unanimously', () => {
    const reviewers = selectReviewers(agents, 'auditor');
    assert.strictEqual(reviewers.length, 2);
    assert.strictEqual(reviewConsensusRuleFor('auditor'), 'unanimous');
    assert.strictEqual(reviewConsensusRuleFor('coder'), 'majority');
  });

  test('agents with no agent_type default to coder for routing', () => {
    const ranked = rankAgentsForCapabilities([{ id: 'x' }], ['code']);
    assert.strictEqual(ranked[0].agent_type, 'coder');
  });
});

suite('AF-5 governance gate + audit log', () => {
  test('governance control level always needs approval', () => {
    const d = gateDispatch('coder', 'governance');
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.needsApproval, true);
  });

  test('human-in-loop types need approval; coders/runners proceed', () => {
    assert.strictEqual(gateDispatch('assistant').needsApproval, true);
    assert.strictEqual(gateDispatch('governance').needsApproval, true);
    assert.strictEqual(gateDispatch('coder').allowed, true);
    assert.strictEqual(gateDispatch('runner').allowed, true);
  });

  test('audit log appends + reads back same-day rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-audit-'));
    const ts = '2026-06-09T10:00:00.000Z';
    await appendAuditLog(dir, { actor: 'coder-a', agent_type: 'coder', action: 'dispatch', task_id: 'B1', allowed: true, ts });
    await appendAuditLog(dir, { actor: 'auditor-a', agent_type: 'auditor', action: 'review', task_id: 'B1', allowed: true, ts });
    const rows = await readAuditLog(dir, new Date(ts));
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].actor, 'coder-a');
    assert.strictEqual(rows[1].action, 'review');
    // The file is the date-stamped JSONL.
    assert.ok(fs.existsSync(path.join(dir, 'orchestrator', 'audit', '2026-06-09.jsonl')));
  });

  test('readAuditLog tolerates a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-audit2-'));
    assert.deepStrictEqual(await readAuditLog(dir), []);
  });
});
