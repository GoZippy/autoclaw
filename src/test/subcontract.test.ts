/**
 * subcontract.test.ts — Sprint 3 B5 (WA-3).
 *
 * Covers the subcontract protocol state machine: legal/illegal transitions,
 * message construction, bus I/O, and reconstruction from a message stream.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SubcontractDriver,
  buildSubcontractMessage,
  isLegalTransition,
  isTerminalPhase,
  newSubcontractId,
  sendSubcontractMessage,
  type SubcontractMessage,
} from '../orchestrator/subcontract';

suite('subcontract — transition rules', () => {
  test('only request is legal from the null state', () => {
    assert.ok(isLegalTransition(null, 'request'));
    assert.ok(!isLegalTransition(null, 'accept'));
    assert.ok(!isLegalTransition(null, 'deliver'));
  });

  test('happy path request → accept → deliver → ack', () => {
    assert.ok(isLegalTransition('request', 'accept'));
    assert.ok(isLegalTransition('accept', 'deliver'));
    assert.ok(isLegalTransition('deliver', 'ack'));
  });

  test('reject_with_fixes returns the contract to a deliver-able state', () => {
    assert.ok(isLegalTransition('deliver', 'reject_with_fixes'));
    assert.ok(isLegalTransition('reject_with_fixes', 'deliver'));
  });

  test('illegal jumps are rejected', () => {
    assert.ok(!isLegalTransition('request', 'deliver'));
    assert.ok(!isLegalTransition('accept', 'ack'));
    assert.ok(!isLegalTransition('ack', 'deliver'));
  });

  test('ack is terminal, request is not', () => {
    assert.ok(isTerminalPhase('ack'));
    assert.ok(!isTerminalPhase('request'));
    assert.ok(!isTerminalPhase('reject_with_fixes'));
  });
});

suite('subcontract — message construction', () => {
  test('request flows parent → child and requires a response', () => {
    const msg = buildSubcontractMessage('request', {
      subcontract_id: newSubcontractId(),
      task_id: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    assert.strictEqual(msg.from, 'claude-code');
    assert.strictEqual(msg.to, 'kilocode');
    assert.strictEqual(msg.type, 'subcontract_request');
    assert.strictEqual(msg.requires_response, true);
    assert.strictEqual(msg.payload.subcontract_phase, 'request');
  });

  test('accept flows child → parent', () => {
    const msg = buildSubcontractMessage('accept', {
      subcontract_id: 'sc1',
      task_id: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    assert.strictEqual(msg.from, 'kilocode');
    assert.strictEqual(msg.to, 'claude-code');
  });

  test('reject_with_fixes rides on a finding_report type but carries the real phase', () => {
    const msg = buildSubcontractMessage('reject_with_fixes', {
      subcontract_id: 'sc1',
      task_id: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
      fixes: [{ detail: 'add tests', severity: 'major' }],
    });
    assert.strictEqual(msg.type, 'finding_report');
    assert.strictEqual(msg.payload.subcontract_phase, 'reject_with_fixes');
    assert.strictEqual(msg.from, 'claude-code'); // parent-driven
  });

  test('ack is terminal — requires_response is false', () => {
    const msg = buildSubcontractMessage('ack', {
      subcontract_id: 'sc1',
      task_id: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    assert.strictEqual(msg.requires_response, false);
  });
});

suite('subcontract — SubcontractDriver', () => {
  test('open mints an id and produces a request', () => {
    const { driver, message } = SubcontractDriver.open({
      taskId: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
      brief: 'do the thing',
    });
    assert.strictEqual(message.payload.subcontract_phase, 'request');
    assert.strictEqual(driver.view().state, 'proposed');
  });

  test('full happy-path drive ends completed', () => {
    const { driver } = SubcontractDriver.open({
      taskId: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    driver.accept();
    assert.strictEqual(driver.view().state, 'accepted');
    driver.deliver({ kind: 'branch', ref: 'feat/x' });
    assert.strictEqual(driver.view().state, 'delivered');
    driver.ack('looks good');
    assert.strictEqual(driver.view().state, 'completed');
    assert.deepStrictEqual(driver.view().history, ['request', 'accept', 'deliver', 'ack']);
  });

  test('reject_with_fixes loops back to delivered on re-deliver', () => {
    const { driver } = SubcontractDriver.open({
      taskId: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    driver.accept();
    driver.deliver({ kind: 'branch', ref: 'feat/x' });
    driver.rejectWithFixes([{ detail: 'fix the bug' }]);
    assert.strictEqual(driver.view().state, 'rework');
    driver.deliver({ kind: 'branch', ref: 'feat/x' });
    assert.strictEqual(driver.view().state, 'delivered');
  });

  test('an illegal transition throws', () => {
    const { driver } = SubcontractDriver.open({
      taskId: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    assert.throws(() => driver.deliver({ kind: 'branch', ref: 'x' }));
  });

  test('fromMessages reconstructs the contract state', () => {
    const id = newSubcontractId();
    const base = { subcontract_id: id, task_id: 'B5', parent: 'claude-code', child: 'kilocode' };
    const msgs: SubcontractMessage[] = [
      buildSubcontractMessage('request', base, { now: new Date(1000) }),
      buildSubcontractMessage('accept', base, { now: new Date(2000) }),
      buildSubcontractMessage('deliver', { ...base, deliverable: { kind: 'b', ref: 'r' } }, { now: new Date(3000) }),
    ];
    const rebuilt = SubcontractDriver.fromMessages(id, msgs.slice().reverse());
    assert.ok(rebuilt);
    assert.strictEqual(rebuilt!.view().state, 'delivered');
  });

  test('fromMessages returns null for an unknown id', () => {
    assert.strictEqual(SubcontractDriver.fromMessages('missing', []), null);
  });
});

suite('subcontract — bus I/O', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sc-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sendSubcontractMessage writes a conformant file into the recipient inbox', async () => {
    const msg = buildSubcontractMessage('request', {
      subcontract_id: 'sc1',
      task_id: 'B5',
      parent: 'claude-code',
      child: 'kilocode',
    });
    const { path: file } = await sendSubcontractMessage(dir, msg);
    assert.ok(file.includes(path.join('inboxes', 'kilocode')));
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as SubcontractMessage;
    assert.strictEqual(written.payload.subcontract_id, 'sc1');
    assert.strictEqual(written.type, 'subcontract_request');
  });
});
