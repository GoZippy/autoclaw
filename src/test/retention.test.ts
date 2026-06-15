/**
 * retention.test.ts — shared-inbox retention sweep.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sweepSharedInbox } from '../orchestrator/retention';

function makeComms(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-retention-'));
  fs.mkdirSync(path.join(root, 'inboxes', 'shared'), { recursive: true });
  return root;
}

function writeMsg(commsDir: string, file: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(commsDir, 'inboxes', 'shared', file), JSON.stringify(body), 'utf8');
}

const NOW = new Date('2026-06-14T20:00:00.000Z');
function ageHoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

suite('retention sweep', () => {
  test('dry-run reports but deletes nothing', async () => {
    const comms = makeComms();
    writeMsg(comms, 'a.json', { type: 'task_claim', from: 'orchestrator-loop', timestamp: ageHoursAgo(48) });
    const report = await sweepSharedInbox({ commsDir: comms, now: () => NOW, keepRecent: 0 });
    assert.strictEqual(report.applied, false);
    assert.strictEqual(report.deleted, 0);
    assert.strictEqual(report.matched, 1);
    assert.ok(fs.existsSync(path.join(comms, 'inboxes', 'shared', 'a.json')));
  });

  test('deletes only aged task_claim files when applied', async () => {
    const comms = makeComms();
    writeMsg(comms, 'old.json', { type: 'task_claim', timestamp: ageHoursAgo(48) });
    writeMsg(comms, 'young.json', { type: 'task_claim', timestamp: ageHoursAgo(1) });
    const report = await sweepSharedInbox({ commsDir: comms, now: () => NOW, keepRecent: 0, maxAgeHours: 24, apply: true });
    assert.strictEqual(report.deleted, 1);
    assert.strictEqual(report.keptYoung, 1);
    assert.ok(!fs.existsSync(path.join(comms, 'inboxes', 'shared', 'old.json')));
    assert.ok(fs.existsSync(path.join(comms, 'inboxes', 'shared', 'young.json')));
  });

  test('keepRecent always keeps the newest N matching files', async () => {
    const comms = makeComms();
    writeMsg(comms, 'm1.json', { type: 'task_claim', timestamp: ageHoursAgo(100) });
    writeMsg(comms, 'm2.json', { type: 'task_claim', timestamp: ageHoursAgo(99) });
    writeMsg(comms, 'm3.json', { type: 'task_claim', timestamp: ageHoursAgo(98) });
    const report = await sweepSharedInbox({ commsDir: comms, now: () => NOW, keepRecent: 2, maxAgeHours: 24, apply: true });
    assert.strictEqual(report.keptRecent, 2);
    assert.strictEqual(report.deleted, 1);
  });

  test('never touches non-matching message types', async () => {
    const comms = makeComms();
    writeMsg(comms, 'review.json', { type: 'review_request', timestamp: ageHoursAgo(500) });
    const report = await sweepSharedInbox({ commsDir: comms, now: () => NOW, keepRecent: 0, apply: true });
    assert.strictEqual(report.matched, 0);
    assert.strictEqual(report.deleted, 0);
    assert.ok(fs.existsSync(path.join(comms, 'inboxes', 'shared', 'review.json')));
  });

  test('missing shared dir ⇒ empty report, no throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-retention-empty-'));
    const report = await sweepSharedInbox({ commsDir: root, now: () => NOW });
    assert.strictEqual(report.scanned, 0);
    assert.strictEqual(report.deleted, 0);
  });
});
