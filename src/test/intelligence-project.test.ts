/**
 * intelligence-project.test.ts — unit tests for resolveProjectKey().
 *
 * Verifies that the function:
 * - Returns the git root (forward-slashed) when inside a git repo.
 * - Falls back to the workspace path (forward-slashed) when not a git repo.
 * - Never throws, regardless of environment.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { resolveProjectKey } from '../intelligence/project';
import { toForwardSlash } from '../intelligence/paths';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-project-'));
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

suite('intelligence: resolveProjectKey', function () {
  let tempDir: string;

  setup(function () {
    tempDir = makeTempRoot();
  });

  teardown(function () {
    rmrf(tempDir);
  });

  test('returns forward-slashed git root when inside a git repo', function () {
    // Initialize a git repo in the temp dir.
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });

    const key = resolveProjectKey(tempDir);

    // Must equal the resolved temp dir path with forward slashes.
    const expected = toForwardSlash(path.resolve(tempDir));
    assert.strictEqual(key, expected);
    assert.ok(!key.includes('\\'), 'key must use forward slashes');
  });

  test('returns forward-slashed git root when called from a subdirectory', function () {
    // Initialize a git repo and create a sub-directory.
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    const sub = path.join(tempDir, 'packages', 'core');
    fs.mkdirSync(sub, { recursive: true });

    const key = resolveProjectKey(sub);

    // Must resolve to the repo root, not the sub-directory.
    const expected = toForwardSlash(path.resolve(tempDir));
    assert.strictEqual(key, expected);
  });

  test('falls back to workspace path when not inside a git repo', function () {
    // tempDir is just a plain directory — no git init.
    const key = resolveProjectKey(tempDir);

    const expected = toForwardSlash(path.resolve(tempDir));
    assert.strictEqual(key, expected);
    assert.ok(!key.includes('\\'), 'fallback key must use forward slashes');
  });

  test('produces a stable key for the same directory across calls', function () {
    const key1 = resolveProjectKey(tempDir);
    const key2 = resolveProjectKey(tempDir);
    assert.strictEqual(key1, key2, 'same dir should produce the same key');
  });

  test('never throws even for a non-existent directory', function () {
    const bogus = path.join(tempDir, 'does-not-exist');
    // Should not throw; just return the resolved fallback.
    assert.doesNotThrow(() => resolveProjectKey(bogus));
  });
});
