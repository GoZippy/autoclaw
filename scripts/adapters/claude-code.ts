import { Skill, AdapterFile } from "./types";

/**
 * Claude Code wants the Anthropic skill format verbatim:
 * frontmatter + body, written to adapters/claude-code/<name>/SKILL.md.
 */
export function transform(skill: Skill): AdapterFile {
  return {
    path: `adapters/claude-code/${skill.name}/SKILL.md`,
    content: ensureTrailingNewline(skill.raw),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
