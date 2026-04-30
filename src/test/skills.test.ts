/**
 * Skill source / adapter dispatch language tests.
 *
 * Asserts that the host-detection dispatch wording is present in the source
 * skill files (skills/mateam/SKILL.md, skills/kdream/SKILL.md) and is
 * propagated through to at least one regenerated adapter copy. This is the
 * gate for tasks S2 (MAteam → real subagent calls) and S3 (/kdream work
 * dispatcher) — without these strings, the agent has no instruction telling
 * it when to invoke `Agent` vs run in-session.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

function readFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

suite('Skill dispatch language', function () {
  test('skills/mateam/SKILL.md describes Agent + in-session fork', function () {
    const text = readFile('skills/mateam/SKILL.md');
    assert.ok(
      text.includes('Host detection & dispatch'),
      'mateam SKILL.md missing "Host detection & dispatch" section header'
    );
    assert.ok(
      /\bAgent\b/.test(text) && text.includes('Claude Code'),
      'mateam SKILL.md missing reference to the Agent tool under Claude Code'
    );
    assert.ok(
      text.includes('in-session'),
      'mateam SKILL.md missing in-session fallback wording'
    );
    assert.ok(
      text.includes('do NOT fabricate') ||
        text.includes('NOT fabricate') ||
        text.includes('not fabricate'),
      'mateam SKILL.md missing the "do not fabricate Agent calls" hard rule'
    );
    assert.ok(
      text.includes('Reporting') &&
        (text.includes('via Agent tool') || text.includes('Agent tool')),
      'mateam SKILL.md missing Reporting section that names the dispatch path'
    );
  });

  test('skills/kdream/SKILL.md `## work` section has the same fork', function () {
    const text = readFile('skills/kdream/SKILL.md');
    const workIdx = text.indexOf('## work');
    assert.ok(workIdx >= 0, 'kdream SKILL.md missing "## work" section');
    // Slice from "## work" until the next top-level heading.
    const after = text.slice(workIdx);
    const next = after.search(/\n## [^#]/);
    const workSection = next > 0 ? after.slice(0, next) : after;

    assert.ok(
      /\bAgent\b/.test(workSection),
      'kdream `## work` section missing reference to the Agent tool'
    );
    assert.ok(
      workSection.includes('in-session'),
      'kdream `## work` section missing in-session fallback wording'
    );
    assert.ok(
      workSection.toLowerCase().includes('dispatch'),
      'kdream `## work` section missing the explicit Dispatch sub-step'
    );
  });

  test('regenerated adapter (cline/mateam.md) carries dispatch language', function () {
    const text = readFile('adapters/cline/mateam.md');
    assert.ok(
      text.includes('Host detection & dispatch'),
      'adapters/cline/mateam.md missing host-detection section — adapters likely stale, run `npm run adapters:build`'
    );
    assert.ok(
      /\bAgent\b/.test(text) && text.includes('in-session'),
      'adapters/cline/mateam.md missing Agent / in-session dispatch wording'
    );
  });
});
