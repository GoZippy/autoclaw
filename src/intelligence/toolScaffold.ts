/**
 * toolScaffold.ts — scaffold a new skill/tool stub seeded with the project's
 * learned conventions, so anything you build inherits how THIS project likes to
 * work. Host-free string building; the command layer gathers the conventions
 * (from the latest learn insight) and writes the result.
 */

export interface SkillScaffoldInput {
  /** Skill display name. */
  name: string;
  /** One-line purpose. */
  purpose: string;
  /** Project the conventions were learned from. */
  projectName: string;
  /** Learned "follow" conventions to honor. */
  conventions: string[];
  /** Learned "avoid" patterns. */
  avoid?: string[];
  /** ISO timestamp (stamped by the caller for determinism). */
  generatedAt?: string;
}

/** Lower-kebab a name for a filename/id. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

function bullets(items: string[] | undefined, empty: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of items ?? []) {
    const t = (raw ?? '').trim();
    if (t === '' || seen.has(t.toLowerCase())) {
      continue;
    }
    seen.add(t.toLowerCase());
    lines.push(`- ${t}`);
  }
  return lines.length > 0 ? lines.join('\n') : empty;
}

/**
 * Build a SKILL.md-style scaffold. Deterministic (no clock unless `generatedAt`
 * is supplied) so it is diff-friendly and testable.
 */
export function buildSkillScaffold(input: SkillScaffoldInput): string {
  const slug = slugify(input.name);
  const parts: string[] = [];
  parts.push('---');
  parts.push(`name: ${slug}`);
  parts.push(`description: ${input.purpose.trim() || 'TODO: one-line purpose'}`);
  parts.push('---');
  parts.push('');
  parts.push(`# ${input.name} Skill`);
  parts.push('');
  parts.push(
    `> Scaffolded by AutoClaw Intelligence, seeded with **${input.projectName}** learned ` +
      `conventions.${input.generatedAt ? ` Generated: ${input.generatedAt}.` : ''} ` +
      'Fill in the TODO sections.',
  );
  parts.push('');
  parts.push('## Purpose');
  parts.push(input.purpose.trim() || '_TODO: what this skill/tool does._');
  parts.push('');
  parts.push('## When to use');
  parts.push('- _TODO: triggers / situations._');
  parts.push('');
  parts.push('## Steps');
  parts.push('1. _TODO: first step._');
  parts.push('');
  parts.push('## Conventions to honor (learned)');
  parts.push(bullets(input.conventions, '- _(none learned yet — run Learn first)_'));
  if (input.avoid && input.avoid.length > 0) {
    parts.push('');
    parts.push('## Avoid (learned)');
    parts.push(bullets(input.avoid, '_(none)_'));
  }
  parts.push('');
  return parts.join('\n');
}
