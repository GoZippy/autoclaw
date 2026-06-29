/**
 * voidspec-yaml.test.ts — Tests for the js-yaml-backed parseVoidSpecYaml (BL-20).
 *
 * These cases specifically exercise YAML features the previous hand-rolled
 * parser could not handle: nested mappings, multiline block scalars, block
 * sequence depends_on, and graceful handling of malformed input.
 *
 * The existing voidspec.test.ts covers the flat-YAML happy path; this file
 * focuses on what js-yaml unlocks.
 */

import * as assert from 'assert';
import { parseVoidSpecYaml } from '../voidspec/sync';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * YAML with a multiline block-scalar description and a block-sequence
 * depends_on (not inline `[...]` syntax). The old hand-rolled parser could not
 * handle either of these correctly.
 */
const NESTED_MULTILINE_YAML = `
project: complex-spec
version: "2.0"
tasks:
  - id: T-100
    title: "Implement auth layer"
    status: in_progress
    description: |
      This task covers the full authentication layer.
      It includes OAuth2, session management, and token refresh.
      See also: design doc AUTH-42.
    owner: claude-code
    depends_on:
      - T-099
      - T-098
    tags:
      - auth
      - security
    priority: high
  - id: T-101
    title: "Write integration tests"
    status: todo
    description: >
      Folded scalar description:
      this line and the next are folded into a single paragraph
      by js-yaml's folded-block handling.
    depends_on:
      - T-100
`.trim();

/** A deeply nested mapping inside a task (extra fields with nested object). */
const NESTED_MAPPING_YAML = `
project: nested-spec
tasks:
  - id: N-001
    title: Task with nested metadata
    status: todo
    metadata:
      sprint: 3
      team: backend
`.trim();

/** Malformed YAML — should return empty document without throwing. */
const MALFORMED_YAML = `
tasks:
  - id: [broken: yaml: here
    title: "this is invalid YAML
`.trim();

/** Empty string — should return empty document without throwing. */
const EMPTY_YAML = '';

/** YAML with a BOM prefix — should be stripped cleanly. */
const BOM_YAML = '﻿project: bom-spec\ntasks:\n  - id: B-1\n    title: BOM task\n    status: todo\n';

// ---------------------------------------------------------------------------

suite('VoidSpec — parseVoidSpecYaml (js-yaml, BL-20)', () => {

  suite('nested + multiline YAML', () => {
    test('parses project and version from nested doc', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      assert.strictEqual(doc.project, 'complex-spec');
      assert.strictEqual(doc.version, '2.0');
    });

    test('parses both tasks', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      assert.strictEqual(doc.tasks.length, 2);
    });

    test('block-scalar description is preserved (multiline)', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      const t = doc.tasks[0];
      assert.ok(
        t.description && t.description.includes('authentication layer'),
        'description should contain multiline content',
      );
      assert.ok(
        t.description!.includes('token refresh'),
        'description should include second line of block scalar',
      );
    });

    test('block-sequence depends_on parsed as array', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      const t = doc.tasks[0];
      assert.deepStrictEqual(t.dependsOn, ['T-099', 'T-098']);
    });

    test('block-sequence tags parsed as array', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      const t = doc.tasks[0];
      assert.deepStrictEqual(t.tags, ['auth', 'security']);
    });

    test('status is normalised correctly', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      assert.strictEqual(doc.tasks[0].status, 'in_progress');
      assert.strictEqual(doc.tasks[1].status, 'todo');
    });

    test('extra scalar fields are preserved (not dropped)', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      const t = doc.tasks[0];
      assert.ok(t.extra, 'extra should be defined for tasks with unknown fields');
      assert.strictEqual(t.extra!['priority'], 'high');
    });

    test('single depends_on item in second task', () => {
      const doc = parseVoidSpecYaml(NESTED_MULTILINE_YAML);
      assert.deepStrictEqual(doc.tasks[1].dependsOn, ['T-100']);
    });
  });

  suite('nested mapping in extra fields', () => {
    test('nested object inside task does not crash parser', () => {
      // Nested objects cannot round-trip via the scalar `extra`, but the
      // parser must not throw — it simply omits non-coercible values from extra.
      assert.doesNotThrow(() => parseVoidSpecYaml(NESTED_MAPPING_YAML));
    });

    test('id and title are still parsed despite nested metadata', () => {
      const doc = parseVoidSpecYaml(NESTED_MAPPING_YAML);
      assert.strictEqual(doc.tasks.length, 1);
      assert.strictEqual(doc.tasks[0].id, 'N-001');
      assert.strictEqual(doc.tasks[0].title, 'Task with nested metadata');
    });
  });

  suite('malformed input — no throw', () => {
    test('malformed YAML returns empty document without throwing', () => {
      let doc: ReturnType<typeof parseVoidSpecYaml> | undefined;
      assert.doesNotThrow(() => {
        doc = parseVoidSpecYaml(MALFORMED_YAML);
      });
      assert.ok(doc, 'should return a document object');
      assert.strictEqual(doc!.tasks.length, 0);
      assert.strictEqual(doc!.project, undefined);
    });

    test('empty string returns empty document without throwing', () => {
      let doc: ReturnType<typeof parseVoidSpecYaml> | undefined;
      assert.doesNotThrow(() => {
        doc = parseVoidSpecYaml(EMPTY_YAML);
      });
      assert.ok(doc, 'should return a document object');
      assert.strictEqual(doc!.tasks.length, 0);
    });

    test('a task with no id is silently dropped', () => {
      const yaml = 'tasks:\n  - title: "no id here"\n    status: todo\n';
      const doc = parseVoidSpecYaml(yaml);
      assert.strictEqual(doc.tasks.length, 0);
    });
  });

  suite('BOM handling', () => {
    test('BOM prefix is stripped before parsing', () => {
      const doc = parseVoidSpecYaml(BOM_YAML);
      assert.strictEqual(doc.project, 'bom-spec');
      assert.strictEqual(doc.tasks.length, 1);
      assert.strictEqual(doc.tasks[0].id, 'B-1');
    });
  });

});
