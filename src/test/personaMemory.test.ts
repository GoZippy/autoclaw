/**
 * personaMemory.test.ts — PA-1/PA-6 (integrate-automate-v3.2, Lane C).
 * Per-persona memory engine: tiers, promotion, privacy-gated global mirror.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  personaMemoryRoot,
  personaGlobalRoot,
  personaMemoryPaths,
  containsSecret,
  isPromotableToGlobal,
  appendLesson,
  readAllLessons,
  promoteLessons,
  mirrorToGlobal,
  writeDigest,
  defaultPersonaPromotionConfig,
} from '../memory/personas';
import type { PersonaMemoryEntry, PersonaPrivacy } from '../personas/types';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-pmem-'));
}

function entry(over: Partial<PersonaMemoryEntry> & { content: string; privacy: PersonaPrivacy }): PersonaMemoryEntry {
  return {
    subject: `persona.architect.lesson.${Math.random().toString(36).slice(2)}`,
    persona: 'architect',
    valid_from: '2026-06-05T00:00:00Z',
    recorded_at: '2026-06-05T00:00:00Z',
    citations: [],
    ...over,
  };
}

suite('persona memory — paths', () => {
  test('project + global roots are namespaced by id', () => {
    assert.ok(personaMemoryRoot('/ws/.autoclaw', 'architect').replace(/\\/g, '/').endsWith('.autoclaw/memory/personas/architect'));
    assert.ok(personaGlobalRoot('/home/.autoclaw', 'architect').replace(/\\/g, '/').endsWith('.autoclaw/personas/architect'));
    const p = personaMemoryPaths('/r');
    assert.ok(p.scratch.replace(/\\/g, '/').endsWith('/r/scratch/lessons.jsonl'));
    assert.ok(p.digest.replace(/\\/g, '/').endsWith('/r/lessons.md'));
  });
});

suite('persona memory — secret scan + privacy gate', () => {
  test('containsSecret catches tokens, keys, private endpoints', () => {
    assert.ok(containsSecret('use ghp_abcdefghijklmnop1234'));
    assert.ok(containsSecret('api_key = supersecretvalue'));
    assert.ok(containsSecret('-----BEGIN RSA PRIVATE KEY-----'));
    assert.ok(containsSecret('relay at http://10.0.0.5:8080'));
    assert.ok(!containsSecret('the architect persona drafts RFCs'));
  });

  test('isPromotableToGlobal: project never, secrets blocked, candidate/global ok', () => {
    assert.strictEqual(isPromotableToGlobal(entry({ content: 'fine lesson', privacy: 'project' })), false);
    assert.strictEqual(isPromotableToGlobal(entry({ content: 'token sk-abcdefghijkl', privacy: 'global' })), false);
    assert.strictEqual(isPromotableToGlobal(entry({ content: 'generic best practice', privacy: 'global-candidate' })), true);
    assert.strictEqual(isPromotableToGlobal(entry({ content: 'generic best practice', privacy: 'global' })), true);
  });
});

suite('persona memory — append + promotion', () => {
  test('appendLesson writes to scratch; readAllLessons reads all tiers', async () => {
    const root = personaMemoryRoot(tmp(), 'architect');
    await appendLesson(root, entry({ content: 'a', privacy: 'project' }));
    await appendLesson(root, entry({ content: 'b', privacy: 'global-candidate' }));
    const all = await readAllLessons(root);
    assert.strictEqual(all.length, 2);
  });

  test('promoteLessons moves aged scratch → recall, superseded → archive', async () => {
    const root = personaMemoryRoot(tmp(), 'architect');
    // session 0 entries; current session 5 ⇒ older than promoteAfter (2)
    await appendLesson(root, { ...entry({ content: 'old', privacy: 'project' }), ...( { session: 0 } as object) } as PersonaMemoryEntry);
    await appendLesson(root, { ...entry({ content: 'fresh', privacy: 'project' }), ...( { session: 5 } as object) } as PersonaMemoryEntry);

    const res = await promoteLessons(root, defaultPersonaPromotionConfig(5));
    assert.strictEqual(res.promoted, 1, 'one aged lesson promoted to recall');

    const p = personaMemoryPaths(root);
    const recall = fs.readFileSync(p.recall, 'utf8').trim().split('\n').filter(Boolean);
    const scratch = fs.readFileSync(p.scratch, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(recall.length, 1);
    assert.strictEqual(scratch.length, 1, 'fresh lesson stays in scratch');
  });
});

suite('persona memory — global mirror', () => {
  test('mirrors only privacy-cleared entries; project + secrets blocked', async () => {
    const projectRoot = personaMemoryRoot(tmp(), 'architect');
    const globalRoot = personaGlobalRoot(tmp(), 'architect');
    await appendLesson(projectRoot, entry({ content: 'shareable insight', privacy: 'global-candidate' }));
    await appendLesson(projectRoot, entry({ content: 'project only', privacy: 'project' }));
    await appendLesson(projectRoot, entry({ content: 'token sk-abcdefghijkl', privacy: 'global' }));

    const res = await mirrorToGlobal(projectRoot, globalRoot);
    assert.strictEqual(res.mirrored, 1, 'only the clean global-candidate is mirrored');
    assert.strictEqual(res.blocked, 2, 'project + secret entries blocked');

    const globalFile = path.join(globalRoot, 'recall', 'lessons.jsonl');
    const lines = fs.readFileSync(globalFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual((JSON.parse(lines[0]) as PersonaMemoryEntry).privacy, 'global', 'mirrored entry marked global');
  });

  test('mirror is idempotent (keyed by subject)', async () => {
    const projectRoot = personaMemoryRoot(tmp(), 'architect');
    const globalRoot = personaGlobalRoot(tmp(), 'architect');
    const e = entry({ content: 'stable insight', privacy: 'global-candidate' });
    await appendLesson(projectRoot, e);
    await mirrorToGlobal(projectRoot, globalRoot);
    await mirrorToGlobal(projectRoot, globalRoot);
    const lines = fs.readFileSync(path.join(globalRoot, 'recall', 'lessons.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'no duplicate on re-mirror');
  });
});

suite('persona memory — digest', () => {
  test('writeDigest emits a markdown digest of recent lessons', async () => {
    const root = personaMemoryRoot(tmp(), 'architect');
    await appendLesson(root, entry({ content: 'first', privacy: 'project', recorded_at: '2026-06-01T00:00:00Z' }));
    await appendLesson(root, entry({ content: 'second', privacy: 'global', recorded_at: '2026-06-05T00:00:00Z' }));
    await writeDigest(root, 'architect', 5);
    const md = fs.readFileSync(personaMemoryPaths(root).digest, 'utf8');
    assert.match(md, /# architect — lessons/);
    assert.match(md, /second/);
    assert.ok(md.indexOf('second') < md.indexOf('first'), 'newest first');
    assert.match(md, /project-only/);
  });
});
