import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasOrchestratorManifest } from '../manifest-probe';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-probe-'));
}

suite('Extension — manifest probe', () => {
  test('returns false when .autoclaw/orchestrator/manifests does not exist', async () => {
    const dir = tmpDir();
    assert.strictEqual(await hasOrchestratorManifest(dir), false);
  });

  test('returns true when a .yaml file is present', async () => {
    const dir = tmpDir();
    const mdir = path.join(dir, '.autoclaw', 'orchestrator', 'manifests');
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'project.yaml'), 'tasks: []\n');
    assert.strictEqual(await hasOrchestratorManifest(dir), true);
  });

  test('returns true for the .yml extension as well', async () => {
    const dir = tmpDir();
    const mdir = path.join(dir, '.autoclaw', 'orchestrator', 'manifests');
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'project.yml'), 'tasks: []\n');
    assert.strictEqual(await hasOrchestratorManifest(dir), true);
  });

  test('ignores non-YAML files', async () => {
    const dir = tmpDir();
    const mdir = path.join(dir, '.autoclaw', 'orchestrator', 'manifests');
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'README.md'), '# notes\n');
    assert.strictEqual(await hasOrchestratorManifest(dir), false);
  });

  test('returns false for an empty workspace root string', async () => {
    assert.strictEqual(await hasOrchestratorManifest(''), false);
  });
});
