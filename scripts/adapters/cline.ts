import { Skill, AdapterFile } from "./types";

/**
 * Cline rules: a plain markdown file (no frontmatter). We embed the description
 * as an italicised tagline at the top so the model knows when to invoke the rule,
 * then ship the full skill body verbatim — including Operating Rules and
 * sub-commands — so cline stays in sync with the source skill.
 */
export function transform(skill: Skill): AdapterFile {
  const content = `> ${skill.description}\n\n${skill.body}`;
  return {
    path: `adapters/cline/${skill.name}.md`,
    content: ensureTrailingNewline(content),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
