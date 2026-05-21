/**
 * fleet-templates.test.ts — Unit tests for fleet quick-config templates and the
 * "AutoClaw: Start Fleet" command (H2).
 *
 * Covers:
 *  1. Template YAML round-trip (serialise -> parse)
 *  2. writeFleetTemplates materialises all three templates idempotently
 *  3. Template picker helpers (pick items, first-run detection)
 *  4. applyTemplateToRegistry writes a registry.json fleetStart can read
 *  5. startFleetCommand dry-run + picker-cancel paths
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FLEET_TEMPLATES,
  FLEET_TEMPLATE_ORDER,
  templateToYaml,
  parseTemplateYaml,
  writeFleetTemplates,
  loadFleetTemplate,
  templatesDir,
  buildTemplatePickItems,
  shouldShowTemplatePicker,
  applyTemplateToRegistry,
  startFleetCommand,
} from '../cli/fleet-templates';

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-fleet-tpl-'));
}

// ---------------------------------------------------------------------------

suite('Fleet templates — definitions', () => {
  test('three built-in templates exist', () => {
    assert.deepStrictEqual(FLEET_TEMPLATE_ORDER, [
      'solo-sprint', 'full-fleet', 'voidspec-sync',
    ]);
    for (const id of FLEET_TEMPLATE_ORDER) {
      assert.strictEqual(FLEET_TEMPLATES[id].id, id);
      assert.ok(FLEET_TEMPLATES[id].runners.length > 0);
    }
  });

  test('voidspec-sync enables the voidspec watcher; solo-sprint does not', () => {
    assert.strictEqual(FLEET_TEMPLATES['voidspec-sync'].voidspecWatch, true);
    assert.strictEqual(FLEET_TEMPLATES['solo-sprint'].voidspecWatch, false);
    assert.strictEqual(FLEET_TEMPLATES['solo-sprint'].lmd, false);
    assert.strictEqual(FLEET_TEMPLATES['full-fleet'].lmd, true);
  });
});

suite('Fleet templates — YAML round-trip', () => {
  test('templateToYaml then parseTemplateYaml is lossless', () => {
    for (const id of FLEET_TEMPLATE_ORDER) {
      const original = FLEET_TEMPLATES[id];
      const parsed = parseTemplateYaml(templateToYaml(original));
      assert.ok(parsed, `parse failed for ${id}`);
      assert.strictEqual(parsed!.id, original.id);
      assert.deepStrictEqual(parsed!.runners, original.runners);
      assert.strictEqual(parsed!.lmd, original.lmd);
      assert.strictEqual(parsed!.voidspecWatch, original.voidspecWatch);
    }
  });

  test('parseTemplateYaml returns null without an id', () => {
    assert.strictEqual(parseTemplateYaml('label: "no id"\n'), null);
  });
});

suite('Fleet templates — materialisation', () => {
  test('writeFleetTemplates writes all three files', () => {
    const dir = tmpDir();
    const changed = writeFleetTemplates(dir);
    assert.strictEqual(changed.length, 3);
    for (const id of FLEET_TEMPLATE_ORDER) {
      assert.ok(fs.existsSync(path.join(templatesDir(dir), `${id}.yaml`)));
    }
  });

  test('writeFleetTemplates is idempotent (no changes on re-run)', () => {
    const dir = tmpDir();
    writeFleetTemplates(dir);
    const second = writeFleetTemplates(dir);
    assert.strictEqual(second.length, 0);
  });

  test('loadFleetTemplate reads from disk, falls back to built-in', () => {
    const dir = tmpDir();
    writeFleetTemplates(dir);
    const loaded = loadFleetTemplate(dir, 'full-fleet');
    assert.strictEqual(loaded.id, 'full-fleet');
    // Absent file -> built-in fallback.
    const fresh = tmpDir();
    assert.strictEqual(loadFleetTemplate(fresh, 'solo-sprint').id, 'solo-sprint');
  });
});

suite('Fleet templates — picker helpers', () => {
  test('buildTemplatePickItems yields one item per template', () => {
    const items = buildTemplatePickItems();
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].id, 'solo-sprint');
    assert.ok(items[0].label.length > 0 && items[0].detail.length > 0);
  });

  test('shouldShowTemplatePicker true before a registry exists', () => {
    const dir = tmpDir();
    assert.strictEqual(shouldShowTemplatePicker(dir), true);
    applyTemplateToRegistry(dir, FLEET_TEMPLATES['solo-sprint']);
    assert.strictEqual(shouldShowTemplatePicker(dir), false);
  });
});

suite('Fleet templates — registry', () => {
  test('applyTemplateToRegistry writes the runner list', () => {
    const dir = tmpDir();
    const regPath = applyTemplateToRegistry(dir, FLEET_TEMPLATES['full-fleet']);
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    assert.deepStrictEqual(reg.runners, FLEET_TEMPLATES['full-fleet'].runners);
    assert.strictEqual(reg._source_template, 'full-fleet');
  });
});

suite('Fleet templates — startFleetCommand', () => {
  test('dry-run with explicit template prepares without booting', async () => {
    const dir = tmpDir();
    const r = await startFleetCommand({
      workspaceRoot: dir,
      templateId: 'solo-sprint',
      dryRun: true,
      logger: SILENT,
    });
    assert.strictEqual(r.started, true);
    assert.strictEqual(r.template!.id, 'solo-sprint');
    assert.ok(!r.fleet); // dry-run never boots
    // Registry + templates were still materialised.
    assert.ok(fs.existsSync(path.join(dir, '.autoclaw', 'program', 'registry.json')));
    assert.ok(fs.existsSync(path.join(templatesDir(dir), 'solo-sprint.yaml')));
  });

  test('picker is consulted on first run; cancel aborts', async () => {
    const dir = tmpDir();
    let pickerCalled = false;
    const r = await startFleetCommand({
      workspaceRoot: dir,
      dryRun: true,
      logger: SILENT,
      pickTemplate: async (items) => {
        pickerCalled = true;
        assert.strictEqual(items.length, 3);
        return null; // user cancelled
      },
    });
    assert.ok(pickerCalled);
    assert.strictEqual(r.started, false);
    assert.ok(r.summary.toLowerCase().includes('cancel'));
  });

  test('picker selection is honoured', async () => {
    const dir = tmpDir();
    const r = await startFleetCommand({
      workspaceRoot: dir,
      dryRun: true,
      logger: SILENT,
      pickTemplate: async () => 'voidspec-sync',
    });
    assert.strictEqual(r.started, true);
    assert.strictEqual(r.template!.id, 'voidspec-sync');
  });

  test('non-first-run without picker defaults to full-fleet', async () => {
    const dir = tmpDir();
    // Pre-create a registry so it is no longer a "first run".
    applyTemplateToRegistry(dir, FLEET_TEMPLATES['solo-sprint']);
    const r = await startFleetCommand({
      workspaceRoot: dir,
      dryRun: true,
      logger: SILENT,
    });
    assert.strictEqual(r.template!.id, 'full-fleet');
  });
});
