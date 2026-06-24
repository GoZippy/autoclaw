/**
 * teamTemplates.ts — ready-made multi-agent TEAM recipes ("start from a team,
 * not one blank agent at a time").
 *
 * Every SOTA multi-agent system leads with a gallery (MetaGPT's standard company,
 * AutoGen Studio's team gallery, Roo's mode marketplace, Continue's Hub, CrewAI's
 * scaffolded crews). AutoClaw had zero presets — each agent was configured from a
 * blank picker, which is the core onboarding complaint for a tool whose whole value
 * is composing a TEAM. This module is the data layer for the gallery: a small set of
 * named squads, each seat pre-filled with role + behavioural type + suggested tool +
 * scope hint + admit policy, plus a consensus note describing how the team reviews.
 *
 * Pure module: no fs / vscode imports, so it unit-tests in plain node. The vscode
 * gallery + per-seat invite fan-out live in extension.ts (autoclaw.fleet.addTeam).
 *
 * INVARIANTS (enforced by teamTemplates.test.ts):
 *  - every seat.role ∈ the 13 canonical roles (src/roles.ts)
 *  - every seat.agentType ∈ the 6 agent types (src/fabric/agentTypes.ts) AND is
 *    either the role's derived default (src/fleet/roleType.ts) or a declared
 *    alternate (ROLE_TYPE_ALTERNATES) — never a silent contradiction
 *  - every seat.tool ∈ the JOIN_TARGETS keys
 *  - every seat.admit ∈ the 3 admit policies (no `open` — invites are single-use,
 *    so an open per-seat token is meaningless; read-only fan-out is auto-preapproved)
 *  - ids are unique; exactly one template is the recommended default
 *
 * Design + rationale: docs/ideas/JOIN-UX-AND-TEAM-TEMPLATES.md.
 */

import type { CanonicalRole } from '../roles';
import type { AgentType } from '../fabric/agentTypes';

/** A single seat in a team template — one agent's pre-filled configuration. */
export interface TeamSeat {
  /** Board-facing role (one of the 13). */
  role: CanonicalRole;
  /** Behavioural type (one of the 6); the role's derived default or a declared alternate. */
  agentType: AgentType;
  /** Suggested tool to fill the seat (a JOIN_TARGETS key); the user may swap it. */
  tool: string;
  /** Path-scope hint seeding a scope-lease (free text → globs in the wizard). */
  scope: string;
  /** Admit policy for this seat. `manual` for sensitive seats; `auto-preapproved` for scoped workers. */
  admit: Exclude<'manual' | 'auto-preapproved', never>;
  /** One-line reason this seat is configured the way it is (shown in the preview). */
  rationale: string;
  /** Optional hint for how a coder/tester seat's work is verified (e.g. a test command). */
  verifyHint?: string;
}

/** A named team recipe: a small squad with every seat pre-filled. */
export interface TeamTemplate {
  /** Stable id (kebab-case). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line summary of the squad. */
  description: string;
  /** When this recipe is the right reach. */
  whenToUse: string;
  /** How review / consensus is intended to work for this squad. */
  consensusNote: string;
  /** The seats, in the order they should be admitted. */
  seats: readonly TeamSeat[];
  /** Exactly one template sets this — the safe starting point for new users. */
  recommended?: boolean;
}

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: 'solo-reviewer-starter',
    name: 'Solo + Reviewer Starter',
    description: 'One coder does the work; one read-only reviewer gates it. The smallest team that still gives you a second set of eyes.',
    whenToUse: "You're working one feature or fix at a time and want a separate agent to catch mistakes before they land — without the overhead of a full squad. Start here if you're new.",
    consensusNote: 'Actor-critic loop: the coder produces, the reviewer (an auditor) checks. With one reviewer, unanimous just means that reviewer must approve before a merge. Admit manual so you let each agent in personally.',
    recommended: true,
    seats: [
      { role: 'coder', agentType: 'coder', tool: 'claude-code', scope: 'the feature or fix (blank = whole repo on a small project)', admit: 'manual', rationale: 'Does the editing. Claude Code joins in-window on the native /loop lane — no extra setup.', verifyHint: 'the project test command (e.g. npm test)' },
      { role: 'reviewer', agentType: 'auditor', tool: 'claude-desktop', scope: "same paths as the coder, read-only", admit: 'manual', rationale: "Reads the coder's diff and approves or requests changes; never edits. Claude Desktop on MCP with writes OFF matches an auditor's read-only posture." },
    ],
  },
  {
    id: 'feature-build-squad',
    name: 'Feature Build Squad',
    description: 'A small-org pipeline: a supervisor coordinates, an architect frames the design, two coders build in parallel on separate scopes, a tester writes tests, a reviewer gates the merge.',
    whenToUse: 'A sizeable feature that splits into a few independent files or modules, built, tested, and reviewed in one coordinated pass.',
    consensusNote: 'Supervisor-routed (orchestrator-worker). The two coders are majority-reviewed; the reviewer gives the final unanimous gate. Auto-admit the coders for speed; keep the supervisor manual. Cap parallel coders at 4.',
    seats: [
      { role: 'orchestrator', agentType: 'supervisor', tool: 'claude-desktop', scope: 'whole repo (read) — dispatches + aggregates, does not edit directly', admit: 'manual', rationale: 'Splits the feature into tasks, hands them out, assembles the result. supervisor is the only type that can orchestrate.' },
      { role: 'architect', agentType: 'coder', tool: 'codex', scope: 'design notes + the module interfaces/scaffolding', admit: 'auto-preapproved', rationale: 'Frames the structure and writes the interface scaffolding the coders fill in. Codex on the MCP lane.' },
      { role: 'coder', agentType: 'coder', tool: 'claude-code', scope: 'one half of the feature (e.g. src/featureA/**)', admit: 'auto-preapproved', rationale: 'Implements its slice on an isolated scope so it never collides with the other coder.', verifyHint: 'the feature test command' },
      { role: 'coder', agentType: 'coder', tool: 'cursor', scope: 'the other half (e.g. src/featureB/**)', admit: 'auto-preapproved', rationale: 'Second builder on a non-overlapping scope, so the two run truly in parallel.', verifyHint: 'the feature test command' },
      { role: 'tester', agentType: 'coder', tool: 'kilocode', scope: 'test/** and tests/** for the feature', admit: 'auto-preapproved', rationale: 'Writes and runs the tests; a coder type because it edits + runs test files.', verifyHint: 'the new test files must pass' },
      { role: 'reviewer', agentType: 'auditor', tool: 'claude-desktop', scope: 'all changed paths, read-only', admit: 'manual', rationale: 'Final read-only gate over the assembled change (trust off, unanimous — its approval is mandatory).' },
    ],
  },
  {
    id: 'code-review-gauntlet',
    name: 'Code-Review Gauntlet',
    description: 'Three independent reviewers run over one diff and must all agree before it passes. A debate-to-consensus cell for changes you cannot get wrong.',
    whenToUse: 'A high-stakes diff is ready (a tricky refactor, a payment path, a release candidate) and you want unanimous sign-off from several independent auditors.',
    consensusNote: 'Pure verification cell, no coders. All three are auditor type, so each carries the unanimous rule — the diff only passes when all approve. Admit manual; scope each to the changed paths, read-only.',
    seats: [
      { role: 'reviewer', agentType: 'auditor', tool: 'claude-desktop', scope: 'changed paths only, read-only', admit: 'manual', rationale: 'First independent reviewer (trust off, unanimous). Claude Desktop on MCP with writes off.' },
      { role: 'reviewer', agentType: 'auditor', tool: 'codex', scope: 'changed paths only, read-only', admit: 'manual', rationale: 'Second reviewer on a different engine, so the diff is judged by genuinely separate reasoning.' },
      { role: 'security', agentType: 'auditor', tool: 'claude-code', scope: 'changed paths only, read-only', admit: 'manual', rationale: 'Third reviewer wearing a security hat — same auditor type, but its role tells the board it checks for vulnerabilities.' },
    ],
  },
  {
    id: 'test-hardening-pair',
    name: 'Test-Hardening Pair',
    description: 'One coder writes and strengthens tests; one auditor gates coverage and quality. Aimed squarely at the test tree.',
    whenToUse: 'Working code with thin coverage that you want to raise deliberately — new tests, edge cases, regression guards — with a reviewer making sure the new tests actually assert something.',
    consensusNote: 'Producer + verifier pair, scoped to tests. The coder writes tests (majority); the auditor checks they are real (unanimous). Auto-preapprove the coder since it only touches the test tree; keep the auditor manual.',
    seats: [
      { role: 'tester', agentType: 'coder', tool: 'claude-code', scope: 'test/**, tests/**, *.test.* — never production code', admit: 'auto-preapproved', rationale: 'Adds and hardens tests, scoped to the test tree so it cannot drift into shipping code.', verifyHint: 'the new tests must pass and cover the target behavior' },
      { role: 'reviewer', agentType: 'auditor', tool: 'claude-desktop', scope: 'test/** and the code under test, read-only', admit: 'manual', rationale: "Checks new tests genuinely cover the behavior and don't just pass trivially (trust off, unanimous)." },
    ],
  },
  {
    id: 'security-audit-cell',
    name: 'Security Audit Cell',
    description: 'Two security auditors review read-only for vulnerabilities and must agree unanimously, with a governance actor giving the final human-confirmed sign-off.',
    whenToUse: 'Before a release, after touching auth, crypto, secrets, or network code, or any time you need a documented security gate. The strictest review team in the catalog.',
    consensusNote: 'Highest bar in the playbook. All security reviewers are auditor (trust off, unanimous) and never edit. The governance member is human-in-the-loop, so a real person signs off last. Admit manual throughout; read-only scope.',
    seats: [
      { role: 'security', agentType: 'auditor', tool: 'claude-desktop', scope: 'auth/**, crypto/**, network/**, secrets handling — read-only', admit: 'manual', rationale: 'Primary security reviewer. auditor = read-only + unanimous, exactly the posture security work needs.' },
      { role: 'security', agentType: 'auditor', tool: 'codex', scope: 'same sensitive paths, read-only', admit: 'manual', rationale: "Second independent security reviewer on a different engine, so one model's blind spot can't pass the gate." },
      { role: 'product', agentType: 'governance', tool: 'hermes', scope: 'no code scope — reads the findings and approves or blocks', admit: 'manual', rationale: "The sign-off actor. governance is human-in-the-loop and is the control, not the controlled. Hermes joins on the HTTP bridge as a non-IDE actor." },
    ],
  },
  {
    id: 'docs-sweep',
    name: 'Docs Sweep',
    description: 'One writer brings the docs back in line with the code; one reviewer checks accuracy. Scoped to docs and markdown only.',
    whenToUse: 'The code has moved ahead of the docs — new commands, changed APIs, stale README — and you want a pass that updates the prose without touching shipping code.',
    consensusNote: 'Producer + reviewer, scoped to docs. The writer is a coder (edits files); to make it draft-only, switch it to assistant (a person then confirms). The reviewer auditor gives the accuracy gate.',
    seats: [
      { role: 'docs', agentType: 'coder', tool: 'claude-code', scope: 'docs/**, *.md, README — never src/', admit: 'auto-preapproved', rationale: 'Writes and updates documentation, scoped so it stays out of code. For draft-only, switch type to assistant.' },
      { role: 'reviewer', agentType: 'auditor', tool: 'kilocode', scope: 'docs/** plus the code the docs describe, read-only', admit: 'manual', rationale: 'Checks the docs match reality and read clearly (trust off, unanimous).' },
    ],
  },
  {
    id: 'research-synthesis',
    name: 'Research + Synthesis',
    description: 'Two runner agents fan out to investigate in parallel and return structured findings; one supervisor synthesizes them into a single answer.',
    whenToUse: 'An open question to investigate — comparing approaches, surveying prior art, gathering options — with several agents digging at once, then one bringing it together. No repo editing.',
    consensusNote: 'Gather-and-synthesize, not a review gate. The researchers are runner type: one job each, return a result, no session, no consensus review (validated by the synthesizer). The supervisor aggregates. Researchers are read/fetch-only, so they are safe to auto-preapprove.',
    seats: [
      { role: 'researcher', agentType: 'runner', tool: 'hermes', scope: 'no write scope — investigates and returns a structured report', admit: 'auto-preapproved', rationale: 'A callable investigator: one question, one structured result, no session. Hermes is a REST runner ideal for fan-out.' },
      { role: 'researcher', agentType: 'runner', tool: 'openclaw', scope: 'no write scope — investigates a second angle', admit: 'auto-preapproved', rationale: 'Second parallel investigator on a different question or source. OpenClaw on the filesystem lane.' },
      { role: 'orchestrator', agentType: 'supervisor', tool: 'claude-desktop', scope: 'reads all returned reports; writes the synthesis doc only', admit: 'manual', rationale: 'Collects the findings and writes one coherent synthesis. supervisor because it coordinates the fan-out and aggregates.' },
    ],
  },
  {
    id: 'bug-hunt-swarm',
    name: 'Bug-Hunt Swarm',
    description: 'A supervisor splits a bug into isolated scopes and fans several coders out to chase it in parallel, with one auditor confirming the fix.',
    whenToUse: 'A bug spans several modules, or a batch of small defects, and the work parallelizes cleanly across non-overlapping paths.',
    consensusNote: 'Orchestrator-worker swarm. The supervisor decomposes and hands each coder an isolated scope so they never collide; coders majority-reviewed; one auditor confirms each fix (unanimous). Auto-preapprove the coders; keep supervisor + auditor manual. Cap at 4 coders.',
    seats: [
      { role: 'orchestrator', agentType: 'supervisor', tool: 'claude-desktop', scope: 'whole repo (read) — splits the bug into per-coder scopes', admit: 'manual', rationale: "Breaks the bug into isolated slices and assigns them, so the swarm doesn't step on itself." },
      { role: 'coder', agentType: 'coder', tool: 'claude-code', scope: 'one isolated module suspected of the bug (e.g. src/moduleA/**)', admit: 'auto-preapproved', rationale: 'Hunts and fixes in its own scope. Isolated paths keep the parallel coders collision-free.', verifyHint: 'a regression test reproducing the bug' },
      { role: 'coder', agentType: 'coder', tool: 'cursor', scope: 'a second isolated module (e.g. src/moduleB/**)', admit: 'auto-preapproved', rationale: 'Second hunter on a non-overlapping scope.', verifyHint: 'a regression test reproducing the bug' },
      { role: 'reviewer', agentType: 'auditor', tool: 'codex', scope: 'all fixed paths plus a regression test, read-only', admit: 'manual', rationale: "Confirms each fix actually resolves the bug and doesn't regress (trust off, unanimous)." },
    ],
  },
  {
    id: 'refactor-migration-crew',
    name: 'Refactor / Migration Crew',
    description: 'An architect plans, two coders carry it out across isolated areas, a tester guards behavior with characterization tests, and a reviewer confirms nothing changed that should not have.',
    whenToUse: 'A large mechanical change — a framework upgrade, an API rename, a directory restructure — that must preserve behavior across many files.',
    consensusNote: 'Plan-then-execute with a behavior guard. Architect frames the plan; coders execute on isolated scopes (majority); the tester locks current behavior in tests before the change; the reviewer confirms behavior is preserved (unanimous). Run the tester FIRST so there is a safety net.',
    seats: [
      { role: 'architect', agentType: 'coder', tool: 'codex', scope: 'migration plan doc + shared shims/adapters', admit: 'auto-preapproved', rationale: 'Plans the migration and writes shared scaffolding the coders build on.' },
      { role: 'tester', agentType: 'coder', tool: 'kilocode', scope: 'test/** — characterization tests that pin current behavior', admit: 'auto-preapproved', rationale: 'Captures current behavior in tests BEFORE the refactor so any drift is caught.', verifyHint: 'characterization tests pass against current behavior' },
      { role: 'coder', agentType: 'coder', tool: 'claude-code', scope: 'first area (e.g. src/api/**)', admit: 'auto-preapproved', rationale: 'Carries out the mechanical change in its scope.', verifyHint: 'characterization tests still pass' },
      { role: 'coder', agentType: 'coder', tool: 'continue', scope: 'second area (e.g. src/ui/**)', admit: 'auto-preapproved', rationale: 'Second migrator on a non-overlapping scope so the two run in parallel.', verifyHint: 'characterization tests still pass' },
      { role: 'reviewer', agentType: 'auditor', tool: 'claude-desktop', scope: 'all changed paths plus the characterization tests, read-only', admit: 'manual', rationale: 'Confirms the migration preserved behavior and the tests still pass (trust off, unanimous).' },
    ],
  },
  {
    id: 'design-build-pair',
    name: 'Design + Build Pair',
    description: 'A designer shapes the UI/UX and a coder implements it, working the same surface together. A focused two-agent loop for front-end work.',
    whenToUse: 'Building or reworking a screen, component, or visual flow and you want the look-and-feel decided and implemented in one tight loop.',
    consensusNote: 'Two builders on one surface, so they share a scope — coordinate via scope-leases so they take turns rather than colliding. Both majority-reviewed coders. Auto-preapprove for a fast loop; add a reviewer from another template if the UI is high-stakes.',
    seats: [
      { role: 'designer', agentType: 'coder', tool: 'claude-code', scope: 'the component or screen — styles, markup, layout', admit: 'auto-preapproved', rationale: 'Shapes the UI/UX and writes the styling and layout; a coder type because it edits the repo.' },
      { role: 'coder', agentType: 'coder', tool: 'cursor', scope: 'the same component — wiring, state, behavior', admit: 'auto-preapproved', rationale: 'Implements the behavior behind the design on the same surface. They share files, so lean on scope-leases to take turns.' },
    ],
  },
];

/** Look up a template by id. Returns undefined if unknown. */
export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find(t => t.id === id);
}

/** The recommended default template (the safe starting point). */
export function recommendedTemplate(): TeamTemplate {
  return TEAM_TEMPLATES.find(t => t.recommended) ?? TEAM_TEMPLATES[0];
}

/** A compact one-line seat summary, e.g. "coder/coder → claude-code". For previews. */
export function seatSummary(seat: TeamSeat): string {
  return `${seat.role}/${seat.agentType} → ${seat.tool}`;
}
