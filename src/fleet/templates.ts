/**
 * templates.ts — the agent template store + spawn-fresh / mutate / re-life (HR-2).
 *
 * A template is the reusable "DNA" for a kind of worker: the base role, agent
 * type, LLM preference, skills, tools, the persona/steering "soul" (context_seed),
 * and which runner spins it up. Two ways a template is used:
 *   1. Hire fresh — instantiate a brand-new pool Worker from the best-fit template
 *      (`spawnWorkerSpec`), which the runner layer then dispatches.
 *   2. Mutate / re-life — `mutateTemplate` improves a template in place (add a
 *      skill, swap the LLM, refresh the seed, bump version), and `reLifeWorker`
 *      re-spawns an existing worker from the (updated) template while carrying its
 *      earned résumé forward — so the pool improves over time rather than ossifying.
 *
 * Pure core (spawnWorkerSpec / reLifeWorker / bestTemplateForRole — `now` injected,
 * no fs/clock) + fs persistence under `~/.autoclaw/workforce/templates/<id>.json`.
 * Malformed-tolerant like listWorkers; no vscode.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.3.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyResume, type Worker } from './workforce';

const fsp = fs.promises;

/** The reusable "DNA" for a kind of worker. */
export interface AgentTemplate {
  template_id: string;
  base_role: string;
  agent_type: string;
  default_llm?: string;
  skills: string[];
  tools: string[];
  /** Path/ref to the persona/steering "soul" the worker boots with. */
  context_seed?: string;
  /** Runner id that instantiates it: 'openclaw' | 'hermes' | 'claude-code' | ... */
  spawn_via: string;
  /** Semver-ish, e.g. '1.0'. */
  version: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** The machine-global templates directory (`~/.autoclaw/workforce/templates`). */
export function templatesDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.autoclaw', 'workforce', 'templates');
}

/** Path to a single template file. */
export function templatePath(templateId: string, homeDir: string = os.homedir()): string {
  return path.join(templatesDir(homeDir), `${templateId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

// ---------------------------------------------------------------------------
// Read / write / list
// ---------------------------------------------------------------------------

/** Read one template by id. Returns null if missing or malformed. */
export async function readTemplate(templateId: string, homeDir?: string): Promise<AgentTemplate | null> {
  try {
    const raw = await fsp.readFile(templatePath(templateId, homeDir), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as AgentTemplate;
  } catch {
    return null;
  }
}

/** Write a template. Returns the file path. */
export async function writeTemplate(template: AgentTemplate, homeDir?: string): Promise<string> {
  const file = templatePath(template.template_id, homeDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(template, null, 2) + '\n', 'utf8');
  return file;
}

/** List every template in the store. Malformed files are skipped. */
export async function listTemplates(homeDir?: string): Promise<AgentTemplate[]> {
  const dir = templatesDir(homeDir);
  let files: string[];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out: AgentTemplate[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const t = JSON.parse(raw.replace(/^﻿/, '')) as AgentTemplate;
      if (t && typeof t.template_id === 'string' && typeof t.base_role === 'string') { out.push(t); }
    } catch { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create / mutate
// ---------------------------------------------------------------------------

export interface CreateTemplateInput {
  template_id: string;
  base_role: string;
  agent_type: string;
  default_llm?: string;
  skills?: string[];
  tools?: string[];
  context_seed?: string;
  spawn_via: string;
  /** Override the default starting version ('1.0'). */
  version?: string;
}

/**
 * Create + persist a new template. Stamps `created_at` and defaults `version`
 * to '1.0'. `now` is injectable.
 */
export async function createTemplate(
  input: CreateTemplateInput,
  opts: { now?: number; homeDir?: string } = {},
): Promise<AgentTemplate> {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const template: AgentTemplate = {
    template_id: input.template_id,
    base_role: input.base_role,
    agent_type: input.agent_type,
    ...(input.default_llm ? { default_llm: input.default_llm } : {}),
    skills: input.skills ?? [],
    tools: input.tools ?? [],
    ...(input.context_seed ? { context_seed: input.context_seed } : {}),
    spawn_via: input.spawn_via,
    version: input.version ?? '1.0',
    created_at: now,
  };
  await writeTemplate(template, opts.homeDir);
  return template;
}

/** Fields a mutation may patch onto a template. */
export interface TemplatePatch {
  /** Skills to ADD (de-duplicated, existing skills retained). */
  add_skills?: string[];
  /** Tools to ADD (de-duplicated, existing tools retained). */
  add_tools?: string[];
  /** Swap the preferred LLM. */
  default_llm?: string;
  /** Swap the persona/steering seed. */
  context_seed?: string;
  /** Swap the base role. */
  base_role?: string;
  /** Swap the agent type. */
  agent_type?: string;
}

/**
 * Bump a semver-ish version with a minor bump: '1.0' -> '1.1', '1.3' -> '1.4'.
 * If the string is unparseable as `<major>.<minor>`, append '.1'.
 */
export function bumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (m) { return `${m[1]}.${Number(m[2]) + 1}`; }
  return `${version}.1`;
}

/**
 * Mutate a template in place: merge the patch (add skills/tools, swap
 * llm/seed/role/type), BUMP the version (minor bump), and write it back. This is
 * the "mutate a template" path — how the pool improves over time. Returns the
 * updated template, or null if the template is absent. `now` is unused (the
 * created_at is preserved), kept in opts for signature parity.
 */
export async function mutateTemplate(
  templateId: string,
  patch: TemplatePatch,
  opts: { now?: number; homeDir?: string } = {},
): Promise<AgentTemplate | null> {
  const existing = await readTemplate(templateId, opts.homeDir);
  if (!existing) { return null; }

  const skills = [...existing.skills];
  for (const s of patch.add_skills ?? []) { if (s && !skills.includes(s)) { skills.push(s); } }
  const tools = [...existing.tools];
  for (const t of patch.add_tools ?? []) { if (t && !tools.includes(t)) { tools.push(t); } }

  const updated: AgentTemplate = {
    ...existing,
    base_role: patch.base_role ?? existing.base_role,
    agent_type: patch.agent_type ?? existing.agent_type,
    ...(patch.default_llm ? { default_llm: patch.default_llm } : {}),
    ...(patch.context_seed ? { context_seed: patch.context_seed } : {}),
    skills,
    tools,
    version: bumpVersion(existing.version),
  };
  await writeTemplate(updated, opts.homeDir);
  return updated;
}

// ---------------------------------------------------------------------------
// Selection + instantiation (PURE)
// ---------------------------------------------------------------------------

/**
 * Pure: pick the best template for a role. Matches `base_role` case-insensitively;
 * among ties, prefers the template covering the most of `opts.skills`; final
 * tie-break is deterministic by `template_id` (ascending). Returns null when no
 * template plays the role.
 */
export function bestTemplateForRole(
  templates: AgentTemplate[],
  role: string,
  opts: { skills?: string[] } = {},
): AgentTemplate | null {
  const wantRole = role.toLowerCase();
  const wantSkills = (opts.skills ?? []).map(s => s.toLowerCase());
  const matches = templates.filter(t => t.base_role.toLowerCase() === wantRole);
  if (matches.length === 0) { return null; }

  const coverage = (t: AgentTemplate): number => {
    if (wantSkills.length === 0) { return 0; }
    const have = new Set(t.skills.map(s => s.toLowerCase()));
    return wantSkills.reduce((n, s) => n + (have.has(s) ? 1 : 0), 0);
  };

  return matches.slice().sort((a, b) => {
    const cov = coverage(b) - coverage(a);
    if (cov !== 0) { return cov; }
    return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
  })[0];
}

/**
 * Pure: instantiate a fresh pool Worker from a template — the "hire fresh" spec.
 * The runner layer dispatches it; this just returns the Worker to register. The
 * worker arrives with an empty résumé (it has earned nothing yet), trust off, and
 * status available. `now` is injectable.
 */
export function spawnWorkerSpec(
  template: AgentTemplate,
  agentId: string,
  opts: { now?: number } = {},
): Worker {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  return {
    agent_id: agentId,
    origin_tool: template.spawn_via,
    roles_can_play: [template.base_role],
    skills: [...template.skills],
    llms: template.default_llm ? [template.default_llm] : [],
    tools: [...template.tools],
    spun_from_template: template.template_id,
    resume: emptyResume(),
    status: 'available',
    trust: 'off',
    created_at: now,
  };
}

/**
 * Pure: give an existing worker a fresh life — carry its RÉSUMÉ and agent_id
 * forward (earned history survives) but refresh its skills/tools/llms/
 * roles_can_play and re-stamp `spun_from_template` from the (updated) template.
 * Status returns to available. `now` is injectable.
 */
export function reLifeWorker(
  worker: Worker,
  template: AgentTemplate,
  opts: { now?: number } = {},
): Worker {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  return {
    ...worker,
    origin_tool: template.spawn_via,
    roles_can_play: [template.base_role],
    skills: [...template.skills],
    llms: template.default_llm ? [template.default_llm] : [],
    tools: [...template.tools],
    spun_from_template: template.template_id,
    resume: worker.resume, // preserved — earned history carries over
    status: 'available',
    last_engaged: now,
  };
}
