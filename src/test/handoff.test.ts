/**
 * handoff.test.ts — Tests for the HandoffNote sidecar system.
 *
 * Validates the write/read round-trip, the template builder, and the
 * filename conventions that prevent agent-racing on shared files.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeHandoffNote,
  readHandoffNote,
  handoffNoteTemplate,
  handoffsDir,
  handoffFilename,
  type HandoffNote,
} from '../orchestrator/handoff';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-handoff-'));
}

function noteFixture(overrides: Partial<HandoffNote> = {}): HandoffNote {
  return {
    task_id: 'editor-command-api',
    agent_id: 'claude-code',
    session_id: 'abcd1234-efgh-5678-ijkl-mnop90123456',
    timestamp: '2026-06-27T12:00:00.000Z',
    files_changed: ['src/commands/editorApi.ts', 'src/test/editorApi.test.ts'],
    files_not_touched: ['src/views/fleetPanel.ts'],
    integration_points: ['EditorCommand interface exported from src/commands/index.ts'],
    tests_run: [{ suite: 'npm run test:unit', passed: 12, failed: 0 }],
    risks: [],
    summary: 'Implemented EditorCommand API with create/update/delete operations.',
    branch: 'feat/editor-command-api',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handoffFilename
// ---------------------------------------------------------------------------

suite('handoff — handoffFilename', () => {
  test('produces <task-id>-<session-frag>.json', () => {
    const name = handoffFilename('editor-command-api', 'abcd1234');
    assert.strictEqual(name, 'editor-command-api-abcd1234.json');
  });

  test('task ids with special chars are preserved as-is', () => {
    const name = handoffFilename('S3-WA-2-panel', 'deadbeef');
    assert.strictEqual(name, 'S3-WA-2-panel-deadbeef.json');
  });
});

// ---------------------------------------------------------------------------
// handoffsDir
// ---------------------------------------------------------------------------

suite('handoff — handoffsDir', () => {
  test('resolves to .autoclaw/orchestrator/comms/handoffs/ under workspace root', () => {
    const root = mkWorkspace();
    const dir = handoffsDir(root);
    assert.ok(dir.includes('handoffs'), 'should contain "handoffs"');
    assert.ok(dir.startsWith(root), 'should be under workspace root');
  });
});

// ---------------------------------------------------------------------------
// writeHandoffNote + readHandoffNote round-trip
// ---------------------------------------------------------------------------

suite('handoff — writeHandoffNote', () => {
  test('creates the handoffs directory if absent', async () => {
    const root = mkWorkspace();
    const note = noteFixture();
    await writeHandoffNote(root, note);
    const dir = handoffsDir(root);
    assert.ok(fs.existsSync(dir), 'handoffs directory should be created');
  });

  test('writes a valid JSON sidecar with the correct filename', async () => {
    const root = mkWorkspace();
    const note = noteFixture();
    const { sidecarPath } = await writeHandoffNote(root, note);

    assert.ok(fs.existsSync(sidecarPath), 'sidecar file should exist');
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as HandoffNote;
    assert.strictEqual(parsed.task_id, note.task_id);
    assert.strictEqual(parsed.agent_id, note.agent_id);
    assert.deepStrictEqual(parsed.files_changed, note.files_changed);
  });

  test('handoffRef is a forward-slash relative path (cross-platform safe)', async () => {
    const root = mkWorkspace();
    const { handoffRef } = await writeHandoffNote(root, noteFixture());
    assert.ok(!handoffRef.includes('\\'), 'must use forward slashes for protocol portability');
    assert.ok(handoffRef.startsWith('.autoclaw/orchestrator/comms/handoffs/'));
    assert.ok(handoffRef.endsWith('.json'));
  });

  test('session_id prefix is the first 8 chars of session_id', async () => {
    const root = mkWorkspace();
    const note = noteFixture({ session_id: 'feedcafe-dead-beef-cafe-babe00000000' });
    const { sidecarPath } = await writeHandoffNote(root, note);
    assert.ok(path.basename(sidecarPath).includes('feedcafe'), 'filename should contain session frag');
  });
});

// ---------------------------------------------------------------------------
// readHandoffNote
// ---------------------------------------------------------------------------

suite('handoff — readHandoffNote', () => {
  test('returns null when no handoffs directory exists', async () => {
    const root = mkWorkspace();
    const result = await readHandoffNote(root, 'nonexistent-task');
    assert.strictEqual(result, null);
  });

  test('returns null when directory exists but has no matching file', async () => {
    const root = mkWorkspace();
    await writeHandoffNote(root, noteFixture({ task_id: 'other-task' }));
    const result = await readHandoffNote(root, 'editor-command-api');
    assert.strictEqual(result, null);
  });

  test('round-trips the full HandoffNote', async () => {
    const root = mkWorkspace();
    const original = noteFixture({
      next_agent_requested: 'kilocode',
      next_task_suggested: 'editor-viewport',
      risks: ['viewport renderer not yet updated'],
    });
    await writeHandoffNote(root, original);
    const result = await readHandoffNote(root, original.task_id);

    assert.ok(result !== null);
    assert.strictEqual(result!.task_id, original.task_id);
    assert.deepStrictEqual(result!.files_changed, original.files_changed);
    assert.deepStrictEqual(result!.files_not_touched, original.files_not_touched);
    assert.deepStrictEqual(result!.integration_points, original.integration_points);
    assert.deepStrictEqual(result!.tests_run, original.tests_run);
    assert.deepStrictEqual(result!.risks, original.risks);
    assert.strictEqual(result!.next_agent_requested, 'kilocode');
    assert.strictEqual(result!.next_task_suggested, 'editor-viewport');
    assert.strictEqual(result!.branch, original.branch);
  });

  test('returns the latest sidecar when multiple sessions wrote for the same task', async () => {
    const root = mkWorkspace();
    const note1 = noteFixture({ session_id: 'aaaa0000-0000-0000-0000-000000000000', summary: 'first' });
    const note2 = noteFixture({ session_id: 'zzzz9999-9999-9999-9999-999999999999', summary: 'latest' });
    await writeHandoffNote(root, note1);
    await writeHandoffNote(root, note2);
    const result = await readHandoffNote(root, 'editor-command-api');
    // Lexicographically latest session frag wins ('zzzz' > 'aaaa').
    assert.strictEqual(result!.summary, 'latest');
  });

  test('returns null gracefully on a malformed sidecar', async () => {
    const root = mkWorkspace();
    const dir = handoffsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'editor-command-api-broken.json'), '{ bad json', 'utf8');
    const result = await readHandoffNote(root, 'editor-command-api');
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// handoffNoteTemplate
// ---------------------------------------------------------------------------

suite('handoff — handoffNoteTemplate', () => {
  test('produces valid JSON', () => {
    const tpl = handoffNoteTemplate('my-task', 'claude-code', 'session-123');
    const parsed = JSON.parse(tpl);
    assert.strictEqual(parsed.task_id, 'my-task');
    assert.strictEqual(parsed.agent_id, 'claude-code');
  });

  test('all required HandoffNote fields are present in template', () => {
    const tpl = handoffNoteTemplate('t', 'a', 's');
    const parsed = JSON.parse(tpl) as HandoffNote;
    assert.ok(Array.isArray(parsed.files_changed));
    assert.ok(Array.isArray(parsed.files_not_touched));
    assert.ok(Array.isArray(parsed.integration_points));
    assert.ok(Array.isArray(parsed.tests_run));
    assert.ok(Array.isArray(parsed.risks));
    assert.ok(typeof parsed.summary === 'string');
  });

  test('template includes placeholder text that agents must replace', () => {
    const tpl = handoffNoteTemplate('t', 'a', 's');
    assert.ok(tpl.includes('ISO-8601'), 'timestamp placeholder present');
    assert.ok(tpl.includes('workspace-relative'), 'files_changed placeholder present');
  });
});
