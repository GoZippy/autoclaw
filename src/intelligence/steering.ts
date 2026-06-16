/**
 * steering.ts — turn distilled intelligence (learned patterns + cross-project
 * system knowledge) into a steering file an agent can consume.
 *
 * Host-free: pure string building. The command layer gathers the inputs (from the
 * latest learn insight + the optional system tier) and writes the result to disk.
 */

export interface SteeringInput {
  projectName: string;
  /** ISO timestamp, stamped by the caller (kept out for determinism/testability). */
  generatedAt?: string;
  /** "Successful Patterns" — conventions to follow. */
  patterns: string[];
  /** "Patterns to Avoid". */
  avoid: string[];
  /** "Preferred Tools". */
  tools: string[];
  /** Optional cross-project system learnings to graft in. */
  systemLearnings?: Array<{ text: string; kind: string; project: string }>;
}

function bulletList(items: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of items) {
    const t = (raw ?? '').trim();
    if (t === '' || seen.has(t.toLowerCase())) {
      continue;
    }
    seen.add(t.toLowerCase());
    lines.push(`- ${t}`);
  }
  return lines.length > 0 ? lines.join('\n') : '_(none learned yet)_';
}

/**
 * Build a steering markdown document. Stable, deterministic output (no clock
 * unless `generatedAt` is provided), so it is diff-friendly and testable.
 */
export function buildSteeringMarkdown(input: SteeringInput): string {
  const parts: string[] = [];
  parts.push(`# AutoClaw Intelligence — Steering for ${input.projectName}`);
  parts.push('');
  parts.push(
    '> Generated from learned sessions by AutoClaw Intelligence. Regenerate after ' +
      '`Learn` to refresh. Safe to edit; regeneration overwrites this file.' +
      (input.generatedAt ? `\n> Generated: ${input.generatedAt}` : ''),
  );
  parts.push('');
  parts.push('## Conventions to follow');
  parts.push(bulletList(input.patterns));
  parts.push('');
  parts.push('## Things to avoid');
  parts.push(bulletList(input.avoid));
  parts.push('');
  parts.push('## Preferred tools');
  parts.push(bulletList(input.tools));

  const sys = input.systemLearnings ?? [];
  if (sys.length > 0) {
    parts.push('');
    parts.push('## Cross-project knowledge (system tier)');
    const seen = new Set<string>();
    for (const l of sys) {
      const key = l.text.trim().toLowerCase();
      if (key === '' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      parts.push(`- [${l.kind}] ${l.text.trim()} _(from ${l.project})_`);
    }
  }
  parts.push('');
  return parts.join('\n');
}
