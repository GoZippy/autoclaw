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
  sanitizeTaskId,
  type HandoffNote,
} from '../orchestrator/handoff';
import { buildPackagePrompt } from '../handoff_factory';
import type { WorkPackage } from '../orchestratorLoop';
import type { DispatchContext } from '../handoff_factory';

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

suite('handoff — sanitizeTaskId', () => {
  test('alphanumeric, dots, dashes, underscores pass through', () => {
    assert.strictEqual(sanitizeTaskId('S3-WA-2-panel'), 'S3-WA-2-panel');
    assert.strictEqual(sanitizeTaskId('task_1.0'), 'task_1.0');
  });

  test('path separators are replaced', () => {
    assert.strictEqual(sanitizeTaskId('../../evil'), '______evil');
    assert.strictEqual(sanitizeTaskId('task/sub'), 'task_sub');
  });

  test('Windows illegal characters are replaced', () => {
    assert.strictEqual(sanitizeTaskId('task:config'), 'task_config');
    assert.strictEqual(sanitizeTaskId('task<x>'), 'task_x_');
    assert.strictEqual(sanitizeTaskId('task|pipe'), 'task_pipe');
  });
});

suite('handoff — handoffFilename', () => {
  test('produces <sanitized-task-id>-<session-frag>.json', () => {
    const name = handoffFilename('editor-command-api', 'abcd1234');
    assert.strictEqual(name, 'editor-command-api-abcd1234.json');
  });

  test('sanitizes task id containing path separators', () => {
    const name = handoffFilename('../../evil', 'deadbeef');
    assert.ok(!name.includes('..'), 'path traversal must not survive into filename');
    assert.ok(name.endsWith('-deadbeef.json'));
  });

  test('sanitizes Windows-illegal chars', () => {
    const name = handoffFilename('task:config', 'deadbeef');
    assert.ok(!name.includes(':'), 'colon must be removed');
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

  test('returns the sidecar with the latest TIMESTAMP, not the lex-latest filename', async () => {
    const root = mkWorkspace();
    // zzzz session_id is lex-latest, but aaaa has the newer timestamp.
    // readHandoffNote must sort by timestamp field, not filename.
    const older = noteFixture({
      session_id: 'zzzz9999-9999-9999-9999-999999999999',
      timestamp: '2026-01-01T00:00:00.000Z',
      summary: 'older but lex-latest',
    });
    const newer = noteFixture({
      session_id: 'aaaa0000-0000-0000-0000-000000000000',
      timestamp: '2026-06-27T12:00:00.000Z',
      summary: 'newer but lex-earliest',
    });
    await writeHandoffNote(root, older);
    await writeHandoffNote(root, newer);
    const result = await readHandoffNote(root, 'editor-command-api');
    assert.strictEqual(result!.summary, 'newer but lex-earliest', 'timestamp wins over lex order');
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

  test('template uses a parseable ISO timestamp example (not literal "ISO-8601")', () => {
    const tpl = handoffNoteTemplate('t', 'a', 's');
    const parsed = JSON.parse(tpl) as HandoffNote;
    assert.ok(!isNaN(Date.parse(parsed.timestamp)), 'timestamp must be a real parseable ISO string');
    assert.ok(parsed.timestamp !== 'ISO-8601', 'must not use opaque placeholder');
  });

  test('template includes placeholder text that agents must replace', () => {
    const tpl = handoffNoteTemplate('t', 'a', 's');
    assert.ok(tpl.includes('workspace-relative'), 'files_changed placeholder present');
  });
});

// ---------------------------------------------------------------------------
// buildPackagePrompt — handoff note template injection
// ---------------------------------------------------------------------------

function makePkg(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    type: 'work_package',
    taskId: 'editor-cmd',
    taskName: 'Editor Command API',
    description: 'Implement the editor command API.',
    filePaths: ['src/commands/editor.ts'],
    successCriteria: ['npm run test:unit passes'],
    sprint: 1,
    assignToVendor: 'claude-code',
    priority: 'medium',
    timeBudgetMs: 3_600_000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceRoot: '/tmp/test',
    vendor: 'claude-code',
    agentId: 'claude-code',
    sprint: 1,
    commitmentText: 'I will not stop until all criteria pass.',
    ...overrides,
  };
}

suite('handoff_factory — buildPackagePrompt template injection', () => {
  test('prompt includes the handoff note schema template', () => {
    const prompt = buildPackagePrompt(makePkg(), makeCtx());
    assert.ok(prompt.includes('handoff_note'), 'handoff_note field must appear in prompt');
    assert.ok(prompt.includes('files_changed'), 'files_changed must appear in prompt');
    assert.ok(prompt.includes('files_not_touched'), 'files_not_touched must appear in prompt');
    assert.ok(prompt.includes('Handoff Note (REQUIRED'), 'section header must appear');
  });

  test('prompt instructs agents to write handoff note BEFORE task_complete', () => {
    const prompt = buildPackagePrompt(makePkg(), makeCtx());
    const handoffIdx = prompt.indexOf('Handoff Note (REQUIRED');
    const completeIdx = prompt.indexOf('Task Complete Message');
    assert.ok(handoffIdx > -1, 'handoff section must exist');
    assert.ok(completeIdx > -1, 'task_complete section must exist');
    assert.ok(handoffIdx < completeIdx, 'handoff note section must come BEFORE task_complete section');
  });

  test('prompt includes priorBrief context when provided', () => {
    const priorBrief = noteFixture({
      summary: 'Implemented the read half of the API.',
      files_changed: ['src/commands/editorRead.ts'],
      risks: ['write path not yet implemented'],
    });
    const prompt = buildPackagePrompt(makePkg(), makeCtx({ priorBrief }));
    assert.ok(prompt.includes('Prior Agent Handoff Brief'), 'prior brief section must appear');
    assert.ok(prompt.includes('Implemented the read half'), 'summary from prior brief must appear');
    assert.ok(prompt.includes('editorRead.ts'), 'changed files from prior brief must appear');
    assert.ok(prompt.includes('write path not yet implemented'), 'risks from prior brief must appear');
  });

  test('prompt does NOT include priorBrief section when none provided', () => {
    const prompt = buildPackagePrompt(makePkg(), makeCtx());
    assert.ok(!prompt.includes('Prior Agent Handoff Brief'), 'prior brief section must be absent');
  });
});
