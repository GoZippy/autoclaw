import { Skill, AdapterFile } from "./types";

/**
 * Kiro steering: frontmatter with `inclusion: manual`, then the skill body.
 */
export function transform(skill: Skill): AdapterFile {
  const frontmatter =
    `---\n` +
    `inclusion: manual\n` +
    `name: ${skill.name}\n` +
    `description: ${skill.description}\n` +
    `---\n\n`;
  return {
    path: `adapters/kiro/${skill.name}.md`,
    content: ensureTrailingNewline(frontmatter + skill.body),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
