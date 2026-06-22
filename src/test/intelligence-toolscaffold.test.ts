/**
 * intelligence-toolscaffold.test.ts — the skill/tool scaffold generator (P3) and
 * a structural check that the `intelligence.retrieve` MCP tool is registered.
 */

import * as assert from 'assert';

import { buildSkillScaffold, slugify } from '../intelligence/toolScaffold';
import { READ_ONLY_TOOLS } from '../mcp/tools';

suite('intelligence — tool scaffold + MCP retrieve tool', () => {
  suite('slugify', () => {
    test('lower-kebabs a name and falls back to "skill"', () => {
      assert.strictEqual(slugify('Release Checklist'), 'release-checklist');
      assert.strictEqual(slugify('  Foo / Bar!!  '), 'foo-bar');
      assert.strictEqual(slugify('!!!'), 'skill');
    });
  });

  suite('buildSkillScaffold', () => {
    test('emits SKILL frontmatter + sections seeded with learned conventions', () => {
      const md = buildSkillScaffold({
        name: 'Release Checklist',
        purpose: 'Run the release steps in order',
        projectName: 'autoclaw',
        conventions: ['Verify with tests before moving on', 'Verify with tests before moving on'],
        avoid: ['Skipping CI'],
        generatedAt: '2026-06-16T00:00:00Z',
      });
      assert.ok(md.startsWith('---\nname: release-checklist'));
      assert.ok(md.includes('description: Run the release steps in order'));
      assert.ok(md.includes('# Release Checklist Skill'));
      assert.ok(md.includes('## Conventions to honor (learned)'));
      assert.ok(md.includes('- Verify with tests before moving on'));
      // deduped
      assert.strictEqual(md.split('- Verify with tests before moving on').length - 1, 1);
      assert.ok(md.includes('## Avoid (learned)'));
      assert.ok(md.includes('- Skipping CI'));
      assert.ok(md.includes('Generated: 2026-06-16T00:00:00Z'));
    });

    test('no conventions → a clear placeholder, no Avoid section when empty', () => {
      const md = buildSkillScaffold({ name: 'x', purpose: '', projectName: 'p', conventions: [] });
      assert.ok(md.includes('_(none learned yet — run Learn first)_'));
      assert.ok(!md.includes('## Avoid (learned)'));
      assert.ok(md.includes('description: TODO: one-line purpose'));
    });
  });

  suite('intelligence.retrieve MCP tool', () => {
    test('is registered read-only with a required query input', () => {
      const tool = READ_ONLY_TOOLS.find((t) => t.definition.name === 'intelligence.retrieve');
      assert.ok(tool, 'intelligence.retrieve must be in READ_ONLY_TOOLS');
      const schema = tool!.definition.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties && 'query' in schema.properties, 'has a query input');
      assert.deepStrictEqual(schema.required, ['query']);
    });

    test('rejects an empty query without touching the backend', async () => {
      const tool = READ_ONLY_TOOLS.find((t) => t.definition.name === 'intelligence.retrieve')!;
      const ctx = { workspaceRoot: 'K:/nope', autoclawDir: 'K:/nope/.autoclaw', scope: 'workspace', host: 'test' } as never;
      const res = await tool.run(ctx, { query: '   ' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'invalid_params');
    });
  });

  suite('intelligence.contextPack MCP tool', () => {
    test('is registered read-only with a required task input', () => {
      const tool = READ_ONLY_TOOLS.find((t) => t.definition.name === 'intelligence.contextPack');
      assert.ok(tool, 'intelligence.contextPack must be in READ_ONLY_TOOLS');
      const schema = tool!.definition.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties && 'task' in schema.properties, 'has a task input');
      assert.deepStrictEqual(schema.required, ['task']);
    });

    test('rejects an empty task without touching the backend', async () => {
      const tool = READ_ONLY_TOOLS.find((t) => t.definition.name === 'intelligence.contextPack')!;
      const ctx = { workspaceRoot: 'K:/nope', autoclawDir: 'K:/nope/.autoclaw', scope: 'workspace', host: 'test' } as never;
      const res = await tool.run(ctx, { task: '   ' });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'invalid_params');
    });
  });
});
