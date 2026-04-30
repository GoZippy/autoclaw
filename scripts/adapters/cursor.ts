import { Skill, AdapterFile } from "./types";

/**
 * Cursor rules: .mdc with `description:` and `alwaysApply:` frontmatter.
 * Body is the source skill body verbatim.
 */
export function transform(skill: Skill): AdapterFile {
  const frontmatter = `---\ndescription: ${skill.description}\nalwaysApply: false\n---\n\n`;
  return {
    path: `adapters/cursor/${skill.name}.mdc`,
    content: ensureTrailingNewline(frontmatter + skill.body),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
