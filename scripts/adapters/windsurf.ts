import { Skill, AdapterFile } from "./types";

/**
 * Windsurf rules: frontmatter with name + description + trigger: model_decision,
 * followed by the full skill body verbatim.
 */
export function transform(skill: Skill): AdapterFile {
  const frontmatter =
    `---\n` +
    `name: ${skill.name}\n` +
    `description: ${skill.description}\n` +
    `trigger: model_decision\n` +
    `---\n\n`;
  return {
    path: `adapters/windsurf/${skill.name}.md`,
    content: ensureTrailingNewline(frontmatter + skill.body),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
