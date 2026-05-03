import { Skill, AdapterFile } from "./types";

/**
 * Kiro steering: all AutoClaw skills use `inclusion: auto` so they are always
 * active in Kiro without the user needing to enable them manually.
 */
export function transform(skill: Skill): AdapterFile {
  const frontmatter =
    `---\n` +
    `inclusion: auto\n` +
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
