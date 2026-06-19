/**
 * intelligence-steering.test.ts — buildSteeringMarkdown (P3 steering generation).
 */

import * as assert from 'assert';

import { buildSteeringMarkdown } from '../intelligence/steering';

suite('intelligence — steering generation', () => {
  test('renders the three sections with deduped bullets', () => {
    const md = buildSteeringMarkdown({
      projectName: 'demo',
      patterns: ['Make focused changes', 'Make focused changes', 'Write tests first'],
      avoid: ['Avoid speculative rewrites'],
      tools: ['general-purpose coding agent'],
    });
    assert.ok(md.includes('# AutoClaw Intelligence — Steering for demo'));
    assert.ok(md.includes('## Conventions to follow'));
    assert.ok(md.includes('- Make focused changes'));
    assert.ok(md.includes('- Write tests first'));
    assert.ok(md.includes('## Things to avoid'));
    assert.ok(md.includes('- Avoid speculative rewrites'));
    assert.ok(md.includes('## Preferred tools'));
    assert.ok(md.includes('- general-purpose coding agent'));
    // dedup: "Make focused changes" appears once
    assert.strictEqual(md.split('- Make focused changes').length - 1, 1);
  });

  test('empty inputs render a "(none learned yet)" placeholder, never crash', () => {
    const md = buildSteeringMarkdown({ projectName: 'empty', patterns: [], avoid: [], tools: [] });
    assert.ok(md.includes('_(none learned yet)_'));
    // no system section when no system learnings
    assert.ok(!md.includes('## Cross-project knowledge'));
  });

  test('grafts cross-project system knowledge when provided (deduped)', () => {
    const md = buildSteeringMarkdown({
      projectName: 'demo',
      patterns: ['Local convention'],
      avoid: [],
      tools: [],
      systemLearnings: [
        { text: 'Pin dependency versions', kind: 'pattern', project: 'alpha' },
        { text: 'Pin dependency versions', kind: 'pattern', project: 'beta' }, // dup text
        { text: 'Prefer node:sqlite', kind: 'pattern', project: 'gamma' },
      ],
    });
    assert.ok(md.includes('## Cross-project knowledge (system tier)'));
    assert.ok(md.includes('Pin dependency versions'));
    assert.ok(md.includes('_(from alpha)_'));
    assert.ok(md.includes('Prefer node:sqlite'));
    // deduped by text → "Pin dependency versions" line appears once
    assert.strictEqual(md.split('- [pattern] Pin dependency versions').length - 1, 1);
  });

  test('generatedAt is included only when provided (deterministic otherwise)', () => {
    const without = buildSteeringMarkdown({ projectName: 'x', patterns: [], avoid: [], tools: [] });
    assert.ok(!without.includes('Generated:'));
    const withTs = buildSteeringMarkdown({
      projectName: 'x',
      generatedAt: '2026-06-16T00:00:00Z',
      patterns: [],
      avoid: [],
      tools: [],
    });
    assert.ok(withTs.includes('Generated: 2026-06-16T00:00:00Z'));
  });
});
