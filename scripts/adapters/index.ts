import * as fs from "fs";
import * as path from "path";
import { Skill, AdapterFile } from "./types";
import * as claudeCode from "./claude-code";
import * as cline from "./cline";
import * as cursor from "./cursor";
import * as antigravity from "./antigravity";
import * as windsurf from "./windsurf";
import * as kiro from "./kiro";
import * as continueAdapter from "./continue";
import * as kilocode from "./kilocode";

const SKILL_NAMES = [
  "kdream",
  "autobuild",
  "mateam",
  "orchestrate",
  "security-auditor",
  "doc-writer",
] as const;

/**
 * Load every source skill from skills/<name>/SKILL.md and return them with
 * frontmatter parsed.
 */
export function loadSkills(repoRoot: string): Skill[] {
  return SKILL_NAMES.map((name) => loadSkill(repoRoot, name));
}

function loadSkill(repoRoot: string, name: string): Skill {
  const file = path.join(repoRoot, "skills", name, "SKILL.md");
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  const fm = parseFrontmatter(raw);
  if (!fm) {
    throw new Error(`skills/${name}/SKILL.md is missing frontmatter`);
  }

  return {
    name,
    description: fm.fields.description ?? "",
    body: fm.body,
    raw,
  };
}

interface ParsedFrontmatter {
  fields: Record<string, string>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;

  const fmText = raw.slice(4, end);
  // Body starts after the closing `---\n`. Strip any number of leading blank
  // lines so transforms can reliably prepend their own frontmatter + blank
  // separator without producing double blanks.
  let body = raw.slice(end + 5);
  body = body.replace(/^\n+/, "");

  const fields: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return { fields, body };
}

/** Generate every adapter file from the loaded skills, returning them in memory. */
export function generateAll(skills: Skill[]): AdapterFile[] {
  const files: AdapterFile[] = [];

  for (const skill of skills) {
    pushOne(files, claudeCode.transform(skill));
    pushOne(files, cline.transform(skill));
    pushOne(files, cursor.transform(skill));
    pushOne(files, antigravity.transform(skill));
    pushOne(files, windsurf.transform(skill));
    pushOne(files, kiro.transform(skill));
    pushOne(files, continueAdapter.transform(skill));
  }

  // Combined adapters (one file across all skills).
  pushOne(files, kilocode.transformAll(skills));

  return files;
}

function pushOne(arr: AdapterFile[], item: AdapterFile | AdapterFile[]) {
  if (Array.isArray(item)) {
    arr.push(...item);
  } else {
    arr.push(item);
  }
}
