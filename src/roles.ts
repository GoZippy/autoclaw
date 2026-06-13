/**
 * roles.ts — Canonical role taxonomy for fleet agents.
 *
 * Agents arrive with role strings from many sources (registry `role` rows,
 * fabric `agent_type`, sprint YAML assignments, persona names). The panel
 * needs ONE small, stable vocabulary so a team of 2 or 50 agents can be
 * grouped, color-coded, and counted at a glance.
 *
 * Pure module: no fs / vscode imports. Rendering helpers that consume these
 * live in webview-render.ts; colors are defined per `cssClass` in
 * kdream-dashboard.css.
 */

/** The closed set of roles the panel knows how to display. */
export type CanonicalRole =
  | 'orchestrator' // coordinates other agents (supervisor / governance)
  | 'architect'    // tech-lead / system design
  | 'coder'        // implements changes
  | 'reviewer'     // reviews / audits peer work
  | 'tester'       // test & QA
  | 'security'     // security analysis / hardening
  | 'designer'     // UI / UX / visual design
  | 'creative'     // copy, naming, ideation
  | 'docs'         // documentation
  | 'researcher'   // investigation / analysis
  | 'product'      // product owner / requirements
  | 'ops'          // release / infra / runner
  | 'generalist';  // no specific role known

/** Display metadata for one canonical role. */
export interface RoleMeta {
  id: CanonicalRole;
  /** Human label, e.g. "Reviewer". */
  label: string;
  /** Two/three-letter tag for dense layouts, e.g. "REV". */
  abbrev: string;
  /** Decorative glyph prefix for chips. */
  glyph: string;
  /** CSS class carrying the role color (defined in kdream-dashboard.css). */
  cssClass: string;
}

/** Stable display order — leadership first, then build/verify, then support. */
export const ROLE_ORDER: readonly CanonicalRole[] = [
  'orchestrator', 'architect', 'product',
  'coder', 'reviewer', 'tester', 'security',
  'designer', 'creative', 'docs', 'researcher',
  'ops', 'generalist',
];

export const ROLE_META: Record<CanonicalRole, RoleMeta> = {
  orchestrator: { id: 'orchestrator', label: 'Orchestrator', abbrev: 'ORC', glyph: '◎', cssClass: 'role-orchestrator' },
  architect:    { id: 'architect',    label: 'Architect',    abbrev: 'ARC', glyph: '◇', cssClass: 'role-architect' },
  product:      { id: 'product',      label: 'Product',      abbrev: 'PRD', glyph: '★', cssClass: 'role-product' },
  coder:        { id: 'coder',        label: 'Coder',        abbrev: 'COD', glyph: '⌨', cssClass: 'role-coder' },
  reviewer:     { id: 'reviewer',     label: 'Reviewer',     abbrev: 'REV', glyph: '✓', cssClass: 'role-reviewer' },
  tester:       { id: 'tester',       label: 'Test/QA',      abbrev: 'QA',  glyph: '⚗', cssClass: 'role-tester' },
  security:     { id: 'security',     label: 'Security',     abbrev: 'SEC', glyph: '⛨', cssClass: 'role-security' },
  designer:     { id: 'designer',     label: 'UI/UX',        abbrev: 'UIX', glyph: '✎', cssClass: 'role-designer' },
  creative:     { id: 'creative',     label: 'Creative',     abbrev: 'CRE', glyph: '✦', cssClass: 'role-creative' },
  docs:         { id: 'docs',         label: 'Docs',         abbrev: 'DOC', glyph: '¶', cssClass: 'role-docs' },
  researcher:   { id: 'researcher',   label: 'Research',     abbrev: 'RES', glyph: '◌', cssClass: 'role-researcher' },
  ops:          { id: 'ops',          label: 'Ops/Release',  abbrev: 'OPS', glyph: '⚙', cssClass: 'role-ops' },
  generalist:   { id: 'generalist',   label: 'Generalist',   abbrev: 'GEN', glyph: '•', cssClass: 'role-generalist' },
};

/** Exact-match synonyms (after lowercasing + stripping separators). */
const ROLE_SYNONYMS: Record<string, CanonicalRole> = {
  // orchestration / leadership
  orchestrator: 'orchestrator', supervisor: 'orchestrator', coordinator: 'orchestrator',
  governance: 'orchestrator', suborchestrator: 'orchestrator', manager: 'orchestrator',
  // architecture
  architect: 'architect', techlead: 'architect', lead: 'architect',
  // product
  product: 'product', productowner: 'product', po: 'product', pm: 'product',
  // build
  coder: 'coder', developer: 'coder', dev: 'coder', engineer: 'coder', implementer: 'coder',
  // verify
  reviewer: 'reviewer', auditor: 'reviewer', critic: 'reviewer',
  tester: 'tester', qa: 'tester', test: 'tester', verifier: 'tester', qaverifier: 'tester',
  quality: 'tester',
  // security
  security: 'security', securityauditor: 'security', sec: 'security', pentester: 'security',
  // design / creative
  designer: 'designer', design: 'designer', ui: 'designer', ux: 'designer', uiux: 'designer',
  creative: 'creative',
  // support
  docs: 'docs', doc: 'docs', docwriter: 'docs', documentation: 'docs', writer: 'docs',
  researcher: 'researcher', research: 'researcher', analyst: 'researcher',
  // ops (fabric 'runner' executes jobs → ops bucket)
  ops: 'ops', devops: 'ops', release: 'ops', releasemanager: 'ops', infra: 'ops', runner: 'ops',
  // generalist (fabric 'assistant')
  generalist: 'generalist', assistant: 'generalist', general: 'generalist',
};

/** Substring fallbacks, checked in order — first hit wins. */
const ROLE_HINTS: ReadonlyArray<[string, CanonicalRole]> = [
  ['orchestr', 'orchestrator'], ['supervis', 'orchestrator'], ['coordinat', 'orchestrator'],
  ['sec', 'security'],          // before 'audit' so "security-auditor" → security
  ['audit', 'reviewer'], ['review', 'reviewer'],
  ['research', 'researcher'],
  ['archit', 'architect'], ['techlead', 'architect'], ['lead', 'architect'],
  ['product', 'product'], ['owner', 'product'],
  ['test', 'tester'], ['qa', 'tester'], ['verif', 'tester'], ['qualit', 'tester'],
  ['design', 'designer'], ['uiux', 'designer'], ['frontenddesign', 'designer'],
  ['creativ', 'creative'],
  ['doc', 'docs'],
  ['release', 'ops'], ['ops', 'ops'], ['infra', 'ops'], ['deploy', 'ops'],
  ['cod', 'coder'], ['dev', 'coder'], ['eng', 'coder'], ['impl', 'coder'],
];

/**
 * Map a free-form role string to a canonical role.
 * Unknown / empty input → 'generalist'.
 */
export function normalizeRole(raw?: string | null): CanonicalRole {
  if (!raw) { return 'generalist'; }
  const key = String(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (key.length === 0) { return 'generalist'; }
  const exact = ROLE_SYNONYMS[key];
  if (exact) { return exact; }
  for (const [hint, role] of ROLE_HINTS) {
    if (key.includes(hint)) { return role; }
  }
  return 'generalist';
}

/** The loose fields a registry/heartbeat row may carry that hint at a role. */
export interface RoleSource {
  /** Explicit `role` string, when the registry row has one. */
  role?: string | null;
  /** Fabric worker taxonomy (`agent_type` on RegisteredAgent v2). */
  agent_type?: string | null;
  /** Supervisors may orchestrate even without an explicit role. */
  can_orchestrate?: boolean;
}

/**
 * Resolve an agent's canonical role with precedence:
 * explicit `role` → fabric `agent_type` → `can_orchestrate` → generalist.
 */
export function resolveAgentRole(agent: RoleSource): CanonicalRole {
  if (agent.role) {
    const r = normalizeRole(agent.role);
    if (r !== 'generalist') { return r; }
  }
  if (agent.agent_type) {
    const r = normalizeRole(agent.agent_type);
    if (r !== 'generalist') { return r; }
  }
  if (agent.can_orchestrate) { return 'orchestrator'; }
  return 'generalist';
}

/**
 * Pick the most senior role from a set of free-form role strings (e.g. an
 * agent's sprint assignments). "Senior" = earliest in {@link ROLE_ORDER}.
 * Generalist is only returned when nothing more specific is found. Used to
 * derive a single display role for an agent that wears several hats.
 */
export function pickSeniorRole(texts: readonly (string | null | undefined)[]): CanonicalRole {
  let best: CanonicalRole | null = null;
  let bestRank = Infinity;
  for (const t of texts) {
    const role = normalizeRole(t);
    if (role === 'generalist') { continue; }
    const rank = ROLE_ORDER.indexOf(role);
    if (rank < bestRank) { best = role; bestRank = rank; }
  }
  return best ?? 'generalist';
}

/** Count roles, returned in {@link ROLE_ORDER} order with zero-counts dropped. */
export function summarizeRoles(
  roles: readonly CanonicalRole[]
): Array<{ role: CanonicalRole; count: number }> {
  const counts = new Map<CanonicalRole, number>();
  for (const r of roles) { counts.set(r, (counts.get(r) ?? 0) + 1); }
  const out: Array<{ role: CanonicalRole; count: number }> = [];
  for (const role of ROLE_ORDER) {
    const count = counts.get(role);
    if (count) { out.push({ role, count }); }
  }
  return out;
}
