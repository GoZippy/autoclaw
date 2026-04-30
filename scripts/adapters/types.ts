export interface Skill {
  /** Skill slug, e.g. "kdream". */
  name: string;
  /** Description from frontmatter (single line). */
  description: string;
  /** The skill body — everything after the closing `---` of frontmatter, with leading
   * whitespace trimmed but trailing newline preserved. */
  body: string;
  /** Raw original file (frontmatter + body) for hosts that pass it through verbatim. */
  raw: string;
}

export interface AdapterFile {
  /** Path relative to repo root, using forward slashes. */
  path: string;
  /** File contents to write. Should always end with a single trailing newline. */
  content: string;
}

export type AdapterTransform = (skill: Skill) => AdapterFile | AdapterFile[];

export type CombinedAdapterTransform = (skills: Skill[]) => AdapterFile | AdapterFile[];
