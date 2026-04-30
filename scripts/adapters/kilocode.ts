import { Skill, AdapterFile, CombinedAdapterTransform } from "./types";

/**
 * Kilocode customModes: a single YAML file with one entry per skill.
 *
 * Each entry has `name`, `slug`, `description`, `roleDefinition`, and `groups`.
 * `roleDefinition` carries the full source skill body verbatim, embedded as a
 * YAML literal block (`|`). This keeps Kilocode in sync with the source skill
 * including the Operating Rules section and sub-commands.
 */
export const transformAll: CombinedAdapterTransform = (skills: Skill[]): AdapterFile => {
  // Stable, alphabetic ordering by slug so re-runs produce identical bytes.
  const ordered = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  const entries = ordered.map(toCustomModeEntry).join("\n");
  const content = `customModes:\n${entries}`;

  return {
    path: `adapters/kilocode/autoclaw-modes.yaml`,
    content: content.endsWith("\n") ? content : content + "\n",
  };
};

function toCustomModeEntry(skill: Skill): string {
  const displayName = displayNameFor(skill.name);
  const description = skill.description;
  const roleDefinition = skill.body.trimEnd();

  // 4-space indent under list item dash for the literal block lines.
  const roleIndented = indent(roleDefinition, "      ");

  return (
    `  - name: ${displayName}\n` +
    `    slug: ${skill.name}\n` +
    `    description: ${escapeYamlScalar(description)}\n` +
    `    roleDefinition: |\n` +
    `${roleIndented}\n` +
    `    groups:\n` +
    `      - read\n` +
    `      - edit\n` +
    `      - command\n`
  );
}

function displayNameFor(slug: string): string {
  // Match the casing used in the existing on-disk file.
  switch (slug) {
    case "kdream":
      return "KDream";
    case "autobuild":
      return "AutoBuild";
    case "mateam":
      return "MAteam";
    default:
      return slug.charAt(0).toUpperCase() + slug.slice(1);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : prefix + line))
    .join("\n");
}

function escapeYamlScalar(s: string): string {
  // The descriptions don't have leading/trailing whitespace or block-style
  // indicators, but they do contain quotes and slashes. YAML accepts these in
  // a plain scalar as long as the string doesn't start with a special char or
  // contain `: ` / ` #`. Defensively quote (double) if any of those appear.
  if (/(^[\s>|*&!%@`]|: |\s#|\n)/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}
