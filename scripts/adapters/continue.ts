import { Skill, AdapterFile } from "./types";

/**
 * Continue prompt: name+description frontmatter, body wrapped in <s>...</s>,
 * followed by `{{{ input }}}` so the user message becomes the prompt input.
 *
 * Continue's prompt format treats the <s> block as the system message and the
 * trailing template as the user input. We pass the entire source skill body
 * verbatim inside the <s>...</s> wrapper so the model receives the full
 * Operating Rules and sub-command details.
 */
export function transform(skill: Skill): AdapterFile {
  const frontmatter =
    `---\n` +
    `name: ${skill.name}\n` +
    `description: ${skill.description}\n` +
    `---\n\n`;

  const content =
    frontmatter +
    `<s>\n` +
    skill.body.trimEnd() +
    `\n</s>\n\n` +
    `${capitalize(skill.name)} command: {{{ input }}}\n`;

  return {
    path: `adapters/continue/${skill.name}.prompt`,
    content,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
