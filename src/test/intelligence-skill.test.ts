/**
 * intelligence-skill.test.ts — asserts the `intelligence` skill package exists
 * with the expected frontmatter, operating rules, and command-surface wording,
 * and that the regenerated host adapters carry it through. This is the
 * adapter/test gate for the foundation skill.
 *
 * NEW test file — the existing src/test/skills.test.ts is never modified.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function readFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function frontmatter(text: string): Record<string, string> {
  assert.ok(text.startsWith('---\n'), 'SKILL.md must start with YAML frontmatter');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'SKILL.md frontmatter must be closed with ---');
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      fields[m[1]] = m[2];
    }
  }
  return fields;
}

suite('intelligence skill package', function () {
  test('skills/intelligence/SKILL.md exists with the expected frontmatter', function () {
    const text = readFile('skills/intelligence/SKILL.md');
    const fm = frontmatter(text);
    assert.strictEqual(fm.name, 'intelligence', 'frontmatter name must be "intelligence"');
    assert.ok(fm.description && fm.description.length > 0, 'frontmatter description required');
    // Trigger phrases the dispatcher keys on.
    assert.ok(/\/learn/.test(fm.description), 'description should advertise /learn trigger');
    assert.ok(
      /\/index-code/.test(fm.description) || /index my code/i.test(fm.description),
      'description should advertise the code-indexing trigger',
    );
    assert.ok(/\/retrieve/.test(fm.description), 'description should advertise /retrieve trigger');
  });

  test('SKILL.md documents the planned command surface with status', function () {
    const text = readFile('skills/intelligence/SKILL.md');
    for (const cmd of ['/learn', '/sources', '/scaffold', '/search', '/index-code', '/retrieve', '/rag-generate', '/metrics', '/service']) {
      assert.ok(text.includes(cmd), `command surface should list ${cmd}`);
    }
    assert.ok(/Planned/.test(text), 'command surface should mark commands as Planned');
    assert.ok(/Phase 0|foundation/i.test(text), 'SKILL.md should state it is the Phase 0 foundation');
  });

  test('SKILL.md carries the AutoClaw operating rules', function () {
    const text = readFile('skills/intelligence/SKILL.md');
    assert.ok(/Operating Rules/i.test(text), 'missing Operating Rules section');
    assert.ok(/file tools, not shell/i.test(text), 'missing file-tools-not-shell rule');
    assert.ok(/forward slashes/i.test(text), 'missing forward-slashes rule');
    assert.ok(/idempotent/i.test(text), 'missing idempotency rule');
    assert.ok(/Never invent/i.test(text), 'missing never-invent rule');
  });

  test('regenerated kiro adapter carries the intelligence skill', function () {
    const text = readFile('adapters/kiro/intelligence.md');
    const fm = frontmatter(text);
    assert.strictEqual(fm.inclusion, 'auto', 'kiro adapter should be inclusion: auto');
    assert.strictEqual(fm.name, 'intelligence');
    assert.ok(
      /AutoClaw Intelligence/i.test(text),
      'adapters/kiro/intelligence.md missing body — adapters likely stale, run `npm run adapters:build`',
    );
  });

  test('regenerated kilocode combined adapter includes the intelligence mode', function () {
    const text = readFile('adapters/kilocode/autoclaw-modes.yaml');
    assert.ok(/slug: intelligence/.test(text), 'kilocode modes missing the intelligence slug');
  });
});
