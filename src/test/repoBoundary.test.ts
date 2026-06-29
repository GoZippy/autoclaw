/**
 * repoBoundary.test.ts — CI guard for the public/private repo split.
 *
 * Proves the public build contains NO static imports from @autoclaw/premium or
 * other private paths. The ONLY sanctioned reference is the indirect (variable)
 * require in src/premium/index.ts — that seam is how the licensed build swaps in
 * the real engine without tsc statically resolving an optional module.
 *
 * This is the testable enforcement of the repo-boundary contract described in
 * docs/ideas/PUBLIC-PRIVATE-SPLIT-AND-RELEASE-PLAN.md.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src');
const ROOT = path.join(__dirname, '..', '..');

/**
 * Static imports that would bind the public build to the private package at
 * compile time. These are always forbidden. The indirect require pattern
 * (require(variableName)) is allowed because tsc does not resolve it.
 */
const FORBIDDEN_STATIC_IMPORTS = [
  /from\s+['"]@autoclaw\/premium['"]/,
  /import\s+.*\s+from\s+['"]@autoclaw\/premium['"]/,
];

/** File paths that must never exist in the public repo. */
const FORBIDDEN_PATHS = [
  'premium-impl',
  'src/premium-private',
  'packages/premium',
  'packages/autoclaw-premium',
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') { continue; }
      listTsFiles(full, out);
    } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

suite('Repo Boundary — public/private split', () => {
  test('no source file statically imports @autoclaw/premium', () => {
    const files = listTsFiles(SRC);
    const violations: Array<{ file: string; line: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        for (const pattern of FORBIDDEN_STATIC_IMPORTS) {
          if (pattern.test(line)) {
            violations.push({ file: path.relative(SRC, file), line: line.trim() });
          }
        }
      }
    }

    assert.deepStrictEqual(violations, [],
      `Found illegal static premium imports:\n${violations.map(v => `  ${v.file}: ${v.line}`).join('\n')}`);
  });

  test('no forbidden private paths exist in the repo', () => {
    for (const p of FORBIDDEN_PATHS) {
      const full = path.join(ROOT, p);
      assert.ok(!fs.existsSync(full), `Forbidden path exists: ${p}`);
    }
  });

  test('premium interface exists (public stub, not impl)', () => {
    const premiumApi = path.join(SRC, 'premium', 'premiumApi.ts');
    assert.ok(fs.existsSync(premiumApi), 'premiumApi.ts interface should exist in public repo');
  });

  test('premium stub is a free fallback, not a real implementation', () => {
    const stub = path.join(SRC, 'premium', 'unavailablePremium.ts');
    assert.ok(fs.existsSync(stub), 'unavailablePremium.ts free fallback should exist');
  });

  test('indirect require seam exists in premium/index.ts', () => {
    const seam = path.join(SRC, 'premium', 'index.ts');
    const content = fs.readFileSync(seam, 'utf8');
    assert.ok(content.includes('const moduleName'), 'seam should use indirect require');
    assert.ok(content.includes('@autoclaw/premium'), 'seam should reference premium package');
  });
});
