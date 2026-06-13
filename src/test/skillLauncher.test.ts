import * as assert from 'assert';
import {
  renderSkillPrompt,
  renderInboxPrompt,
  HOST_SKILL_CONVENTIONS,
  SHIPPED_SKILLS,
} from '../skillLauncher';

suite('skillLauncher — renderSkillPrompt', () => {
  test('Claude Code renders a slash command, never a .clinerules path', () => {
    const p = renderSkillPrompt('claude-code', 'kdream', 'kdream start');
    assert.strictEqual(p, '/kdream start');
    assert.ok(!p.includes('.clinerules'), 'must not point Claude Code at .clinerules');
  });

  test('Cline points at .clinerules/<skill>.md', () => {
    assert.strictEqual(
      renderSkillPrompt('cline', 'kdream', 'kdream start'),
      'Follow the instructions in .clinerules/kdream.md — run kdream start'
    );
  });

  test('KiloCode shares the Cline .clinerules convention', () => {
    assert.strictEqual(
      renderSkillPrompt('kilocode', 'orchestrate', 'orchestrate next'),
      'Follow the instructions in .clinerules/orchestrate.md — run orchestrate next'
    );
  });

  test('Kiro points at .kiro/steering/<skill>.md', () => {
    assert.strictEqual(
      renderSkillPrompt('kiro', 'mateam', 'mateam launch "'),
      'Follow the instructions in .kiro/steering/mateam.md — run mateam launch "'
    );
  });

  test('Cursor uses the .mdc extension', () => {
    assert.strictEqual(
      renderSkillPrompt('cursor', 'kdream', 'kdream ps'),
      'Follow the instructions in .cursor/rules/kdream.mdc — run kdream ps'
    );
  });

  test('Continue uses the .prompt extension', () => {
    assert.strictEqual(
      renderSkillPrompt('continue', 'autobuild', 'autobuild run'),
      'Follow the instructions in .continue/prompts/autobuild.prompt — run autobuild run'
    );
  });

  test('Windsurf and Antigravity use their own rules dirs', () => {
    assert.strictEqual(
      renderSkillPrompt('windsurf', 'kdream', 'kdream start'),
      'Follow the instructions in .windsurf/rules/kdream.md — run kdream start'
    );
    assert.strictEqual(
      renderSkillPrompt('antigravity', 'kdream', 'kdream start'),
      'Follow the instructions in .agent/rules/kdream.md — run kdream start'
    );
  });

  test('the two newly-shipped skills render for every host', () => {
    for (const skill of ['security-auditor', 'doc-writer']) {
      assert.strictEqual(renderSkillPrompt('claude-code', skill, `${skill} go`), `/${skill} go`);
      assert.ok(renderSkillPrompt('cursor', skill, `${skill} go`).includes(`.cursor/rules/${skill}.mdc`));
    }
  });

  test('adapter-less host (e.g. codex) falls back to a plain instruction', () => {
    assert.strictEqual(renderSkillPrompt('codex', 'kdream', 'kdream start'), 'Run kdream start.');
    assert.ok(!HOST_SKILL_CONVENTIONS['codex'], 'codex must not claim a skill convention');
  });

  test('every rule-file host declares a dir and a dotted extension', () => {
    for (const [host, conv] of Object.entries(HOST_SKILL_CONVENTIONS)) {
      if (conv.style === 'rule-file') {
        assert.ok(conv.dir, `${host} needs a rules dir`);
        assert.ok(conv.ext && conv.ext.startsWith('.'), `${host} ext must start with a dot`);
      }
    }
  });
});

suite('skillLauncher — renderInboxPrompt', () => {
  test('Claude Code references the always-on protocol, no file path', () => {
    const p = renderInboxPrompt('claude-code');
    assert.ok(p.includes('.autoclaw/orchestrator/comms/inboxes/'), 'must name the inbox path');
    assert.ok(!p.includes('.clinerules'), 'no rule-file pointer for Claude Code');
    assert.ok(/protocol/i.test(p));
  });

  test('rule-file hosts reference their own cross-agent file', () => {
    assert.ok(renderInboxPrompt('cursor').includes('.cursor/rules/cross-agent.mdc'));
    assert.ok(renderInboxPrompt('cline').includes('.clinerules/cross-agent.md'));
    assert.ok(renderInboxPrompt('continue').includes('.continue/prompts/cross-agent.prompt'));
  });
});

suite('skillLauncher — shipped set', () => {
  test('SHIPPED_SKILLS matches the generator (kdream/autobuild/mateam/orchestrate + security-auditor/doc-writer)', () => {
    assert.deepStrictEqual(
      [...SHIPPED_SKILLS].sort(),
      ['autobuild', 'doc-writer', 'kdream', 'mateam', 'orchestrate', 'security-auditor']
    );
  });
});
