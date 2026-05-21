/**
 * sprintMarkdownGenerator.ts — Generate sprint-N.md from sprint-N.yaml.
 *
 * Reads:
 *   - .autoclaw/orchestrator/sprints/sprint-N.yaml
 *
 * Writes:
 *   - .autoclaw/orchestrator/sprints/sprint-N.md
 *
 * Idempotent: if the generated markdown is byte-for-byte identical to the
 * existing file, the write is skipped.
 *
 * A7 — Sprint-1 / WA-2 (Single source of truth generators).
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SprintTask {
  id: string;
  name: string;
  status: string;
  subtasks: string[];
}

interface SprintAssignment {
  agent: string;
  role: string;
  branch: string;
  scope: string[];
  tasks: SprintTask[];
}

interface SprintYaml {
  sprint: number;
  level: number;
  status: string;
  description: string;
  depends_on_sprints: number[];
  estimated_days: number;
  assignments: SprintAssignment[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Best-effort YAML parser (no external deps)
// ---------------------------------------------------------------------------

function parseSprintYaml(content: string): SprintYaml {
  const getScalar = (key: string, def = ''): string => {
    const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : def;
  };

  const getInt = (key: string, def = 0): number => {
    const v = parseInt(getScalar(key, String(def)), 10);
    return isNaN(v) ? def : v;
  };

  const sprint = getInt('sprint');
  const level = getInt('level');
  const status = getScalar('status', 'pending');
  const description = getScalar('description');
  const estimatedDays = getInt('estimated_days');

  const dependsOnM = content.match(/^depends_on_sprints:\s*\[([^\]]*)\]/m);
  const dependsOnSprints: number[] = dependsOnM
    ? dependsOnM[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];

  // Extract notes (block scalar or flow scalar on a single line).
  const notesM = content.match(/^notes:\s*>\s*\n([\s\S]*?)(?=\n\w|\n$|$)/m);
  const notes = notesM ? notesM[1].split('\n').map(l => l.trim()).join(' ').trim() : undefined;

  // Parse assignments — each starts with `  - agent:`.
  const assignments: SprintAssignment[] = [];
  const assignmentBlocks = content.split(/\n\s{2}-\s+agent:/g).slice(1);

  for (const block of assignmentBlocks) {
    const agentM = block.match(/^\s*([\w-]+)/);
    if (!agentM) { continue; }
    const agent = agentM[1].trim();

    const roleM = block.match(/\n\s*role:\s*"?([^"\n]+)"?/);
    const role = roleM ? roleM[1].trim() : '';

    const branchM = block.match(/\n\s*branch:\s*"?([^"\n]+)"?/);
    const branch = branchM ? branchM[1].trim() : '';

    // Scope list: `  - "..."` under scope:.
    const scopeSection = block.match(/\bscope:\s*\n((?:\s+- [^\n]+\n?)*)/);
    const scope: string[] = [];
    if (scopeSection) {
      const scopeLines = scopeSection[1].matchAll(/\s+-\s+"?([^"\n]+)"?/g);
      for (const m of scopeLines) { scope.push(m[1].trim()); }
    }

    // Tasks list.
    const tasks: SprintTask[] = [];
    // Find the tasks section within this assignment block.
    const tasksSectionM = block.match(/\btasks:\s*\n([\s\S]*?)(?=\n\s{4}scope:|\n\s{4}branch:|\n\s{4}migration_range:|$)/);
    if (tasksSectionM) {
      // Prepend \n so the first "- id:" always has a leading newline for the split.
      const tasksContent = '\n' + tasksSectionM[1];
      const taskBlocks = tasksContent.split(/\n\s{6}-\s+id:/g).slice(1);
      for (const tb of taskBlocks) {
        const idM = tb.match(/^\s*([\w.-]+)/);
        if (!idM) { continue; }
        const id = idM[1].trim();

        const nameM = tb.match(/\bname:\s*"?([^"\n]+)"?/);
        const name = nameM ? nameM[1].trim() : id;

        const statusM = tb.match(/\bstatus:\s*"?([^"\n]+)"?/);
        const taskStatus = statusM ? statusM[1].trim() : 'pending';

        // Subtasks.
        const subtasks: string[] = [];
        const subtasksSection = tb.match(/\bsubtasks:\s*\n((?:\s+-\s+[^\n]+\n?)*)/);
        if (subtasksSection) {
          const stLines = subtasksSection[1].matchAll(/\s+-\s+"?([^"\n]+)"?/g);
          for (const m of stLines) { subtasks.push(m[1].trim()); }
        }

        tasks.push({ id, name, status: taskStatus, subtasks });
      }
    }

    assignments.push({ agent, role, branch, scope, tasks });
  }

  return { sprint, level, status, description, depends_on_sprints: dependsOnSprints, estimated_days: estimatedDays, assignments, notes };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderSprintMarkdown(data: SprintYaml): string {
  const lines: string[] = [];

  // Header.
  const sprintLabel = `Sprint ${data.sprint}`;
  lines.push(`# ${sprintLabel} — ${data.description || 'Sprint'}`);
  lines.push('');

  // Meta line.
  const blocksNext = data.depends_on_sprints.length > 0
    ? `| **Depends on:** Sprint ${data.depends_on_sprints.join(', ')}`
    : '';
  lines.push(`**Status:** ${data.status} | **Level:** ${data.level} | **Est. days:** ${data.estimated_days}${blocksNext}`);
  lines.push('');
  lines.push(`_Generated from sprint-${data.sprint}.yaml — edit the YAML, not this file._`);
  lines.push('');

  // Agent assignments.
  lines.push('## Agent Assignments');
  lines.push('');

  for (const assignment of data.assignments) {
    lines.push(`### ${assignment.agent} — ${assignment.role}`);
    if (assignment.branch) {
      lines.push(`**Branch:** \`${assignment.branch}\``);
    }
    if (assignment.scope.length > 0) {
      lines.push(`**Scope:** ${assignment.scope.map(s => `\`${s}\``).join(', ')}`);
    }
    lines.push('');
    lines.push('**Tasks:**');
    for (const task of assignment.tasks) {
      const sprintComplete = ['merged', 'done', 'approved', 'complete'].includes(data.status);
      const blockLabel = (sprintComplete || ['merged', 'done', 'approved', 'complete', 'in_progress', 'in-review', 'review'].includes(task.status)) ? '[x]' : '[ ]';
      lines.push(`- ${blockLabel} **${task.id}** ${task.name}`);
      for (const sub of task.subtasks) {
        lines.push(`  - ${sub}`);
      }
    }
    lines.push('');
  }

  // Notes.
  if (data.notes) {
    lines.push('## Notes');
    lines.push('');
    lines.push(data.notes);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SprintMarkdownResult {
  /** True when the file was actually written (content changed or new). */
  written: boolean;
  /** The generated markdown string. */
  markdown: string;
  /** Absolute path to the output .md file. */
  outputPath: string;
}

/**
 * Generate sprint-N.md from sprint-N.yaml.
 * Idempotent: skips the write when content is unchanged.
 *
 * @param sprintsDir   Absolute path to the sprints directory.
 * @param sprintNumber The sprint number (integer).
 */
export async function generateSprintMarkdown(
  sprintsDir: string,
  sprintNumber: number
): Promise<SprintMarkdownResult> {
  const yamlPath = path.join(sprintsDir, `sprint-${sprintNumber}.yaml`);
  const outputPath = path.join(sprintsDir, `sprint-${sprintNumber}.md`);

  const content = await fsPromises.readFile(yamlPath, 'utf8');
  const data = parseSprintYaml(content);
  const markdown = renderSprintMarkdown(data);

  // Idempotent write.
  let existing = '';
  try { existing = await fsPromises.readFile(outputPath, 'utf8'); } catch { /* no existing file */ }

  if (existing === markdown) {
    return { written: false, markdown, outputPath };
  }

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  await fsPromises.writeFile(outputPath, markdown, 'utf8');
  return { written: true, markdown, outputPath };
}

/**
 * Regenerate all sprint-N.md files found in sprintsDir.
 *
 * @param sprintsDir  Absolute path to the sprints directory.
 * @returns Array of results for each sprint YAML found.
 */
export async function generateAllSprintMarkdowns(sprintsDir: string): Promise<SprintMarkdownResult[]> {
  let files: string[];
  try {
    files = (await fsPromises.readdir(sprintsDir))
      .filter(f => /^sprint-\d+\.yaml$/.test(f))
      .sort();
  } catch {
    return [];
  }

  const results: SprintMarkdownResult[] = [];
  for (const f of files) {
    const n = parseInt(f.match(/\d+/)![0], 10);
    try {
      const result = await generateSprintMarkdown(sprintsDir, n);
      results.push(result);
    } catch { /* skip unprocessable */ }
  }
  return results;
}
