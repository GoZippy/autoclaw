import * as fs from "fs";
import * as path from "path";
import { loadSkills, generateAll } from "./adapters";

/**
 * AutoClaw adapter generator.
 *
 * Reads skills/<name>/SKILL.md (single source of truth) and writes the eight
 * derivative formats under adapters/. Idempotent; re-running with no source
 * changes is a no-op on disk.
 *
 * Usage:
 *   npm run adapters:build
 */
function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");

  const skills = loadSkills(repoRoot);
  const files = generateAll(skills);

  let written = 0;
  for (const f of files) {
    const abs = path.join(repoRoot, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (existing === f.content) continue;

    fs.writeFileSync(abs, f.content, "utf8");
    written++;
    process.stdout.write(`wrote ${f.path}\n`);
  }

  if (written === 0) {
    process.stdout.write("All adapter files already up to date.\n");
  } else {
    process.stdout.write(`Wrote ${written} adapter file(s).\n`);
  }
}

main();
