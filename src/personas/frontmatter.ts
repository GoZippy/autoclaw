/**
 * Minimal frontmatter parser for SKILL.md files.
 *
 * Per the persona-loader spec, this is deliberately scoped to the keys
 * that PersonaProfile uses — no new dependency is added. Handles the
 * subset of YAML actually written in skills/<id>/SKILL.md frontmatter:
 *
 *   key: value
 *   key: "quoted value"
 *   key: [a, b, c]
 *   key:
 *     - item1
 *     - item2
 *
 * Anything more exotic (nested maps, multiline strings, JSON in YAML)
 * is intentionally unsupported — keep frontmatter shallow.
 *
 * @see docs/specs/persona-loader/spec.md
 */

/** Parse the `---...---` frontmatter block at the top of `content`. */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return null;
  }
  return parseShallowYaml(match[1]);
}

function parseShallowYaml(s: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = s.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blanks and comments.
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([\w_-]+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const valueRaw = m[2].trimEnd();
    if (valueRaw === '') {
      // Either an empty value or the start of a list/block.
      const listItems: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        listItems.push(stripQuotes(lines[j].replace(/^\s+-\s+/, '').trim()));
        j++;
      }
      if (listItems.length > 0) {
        result[key] = listItems;
        i = j;
        continue;
      }
      result[key] = '';
      i++;
      continue;
    }
    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      const inner = valueRaw.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }
    result[key] = stripQuotes(valueRaw);
    i++;
  }
  return result;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
