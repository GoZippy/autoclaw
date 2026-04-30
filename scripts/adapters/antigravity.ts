import { Skill, AdapterFile } from "./types";

/**
 * Antigravity rules: plain markdown, no frontmatter. We embed the description
 * as a tagline so the model knows when to invoke the rule, then include the
 * full source skill body verbatim.
 */
export function transform(skill: Skill): AdapterFile {
  const content = `> ${skill.description}\n\n${skill.body}`;
  return {
    path: `adapters/antigravity/${skill.name}.md`,
    content: ensureTrailingNewline(content),
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
