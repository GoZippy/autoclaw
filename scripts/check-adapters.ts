import * as fs from "fs";
import * as path from "path";
import { loadSkills, generateAll } from "./adapters";

/**
 * CI gate: regenerates every adapter file in memory and compares to disk.
 * Exits 0 if all files match, 1 with a diff summary otherwise.
 *
 * Usage:
 *   npm run adapters:check
 */
function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");

  const skills = loadSkills(repoRoot);
  const files = generateAll(skills);

  const drifted: { path: string; diff: string }[] = [];

  for (const f of files) {
    const abs = path.join(repoRoot, f.path);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (existing === f.content) continue;

    drifted.push({
      path: f.path,
      diff: makeDiffSummary(existing, f.content),
    });
  }

  if (drifted.length === 0) {
    process.stdout.write("Adapters in sync with skills/.\n");
    return;
  }

  process.stderr.write(
    `\nAdapter drift detected in ${drifted.length} file(s).\n` +
      `Run \`npm run adapters:build\` and commit the result.\n\n`
  );
  for (const d of drifted) {
    process.stderr.write(`--- ${d.path}\n`);
    process.stderr.write(d.diff + "\n");
  }
  process.exit(1);
}

function makeDiffSummary(existing: string | null, expected: string): string {
  if (existing === null) {
    return `(file missing on disk; expected ${expected.split("\n").length} lines)`;
  }

  const a = existing.split("\n");
  const b = expected.split("\n");
  const max = Math.max(a.length, b.length);

  const out: string[] = [];
  let shown = 0;
  for (let i = 0; i < max && shown < 20; i++) {
    if (a[i] !== b[i]) {
      out.push(`  L${i + 1}:`);
      out.push(`    - ${formatLine(a[i])}`);
      out.push(`    + ${formatLine(b[i])}`);
      shown++;
    }
  }
  if (shown === 20) out.push("  (further differences truncated)");
  return out.join("\n");
}

function formatLine(line: string | undefined): string {
  if (line === undefined) return "(no line)";
  return JSON.stringify(line);
}

main();
