/**
 * scaffold.ts — newcomer-agent scaffolder (Slice C).
 *
 * `provisionCrossAgentComms()` (extension.ts) only builds the comms tree when
 * >= 2 agents are *detected* from a hardcoded list of nine extension ids. A
 * brand-new agent — a freshly-invited Codex CLI, a Hermes service, another
 * IDE's chat session, or any id not in that fixed list — therefore arrives to
 * an empty project: no inbox, no registry row, no rules file. It cannot send a
 * message, claim a task, or be revived.
 *
 * This module is the floor-fix: it idempotently scaffolds the minimum a single
 * arbitrary agent needs to participate —
 *   1. its inbox tree (`inboxes/<agentId>/{_state,processed}/`) plus the
 *      shared coordination dirs a newcomer may need immediately (`claims/`,
 *      `beacons/`, `consensus/active/`, `invites/`),
 *   2. a `RegisteredAgent` row in `registry.json` (creating the file + the
 *      shared inbox + liveness dirs on first run), carrying the
 *      `loop_mechanism` + `keepalive_template` the revive flow needs,
 *   3. a bootstrap/rules file the agent reads on its first cycle.
 *
 * It is pure of `vscode` (fs + path + the comms types only) so it unit-tests in
 * plain Node/Mocha, and it reuses the schemas + writers from `../comms` rather
 * than redefining them. Every operation is safe to call repeatedly and safe to
 * call against a tree another agent already provisioned.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readRegistry,
  writeRegistry,
  type AgentRegistry,
  type RegisteredAgent,
  type AgentStatus,
} from '../comms';
import type { AgentType } from '../fabric/agentTypes';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Loop-mechanism + keepalive-template mapping (canonical, owned here)        */
/* -------------------------------------------------------------------------- */

/**
 * The keepalive loop mechanism the orchestrator's revive flow uses to wake an
 * agent. Mirrors the values documented in
 * `skills/orchestrate/templates/keepalive/README.md` and consumed by
 * `src/bridge/chatInjector.ts`:
 *
 *  - `slash-loop`     — host has a `/loop` skill (Claude Code).
 *  - `plain-message`  — chat-only; user/bridge hits send (Kilo, Cline, Continue).
 *  - `cli-headless`   — headless subprocess; the runner re-dispatches
 *                       (Codex, Cursor, Kiro, Gemini CLI, Claude Desktop).
 *  - `bridge-relayed` — a REST service / companion auto-submits (Hermes,
 *                       OpenClaw, AutoGPT).
 */
export type LoopMechanism =
  | 'slash-loop'
  | 'plain-message'
  | 'cli-headless'
  | 'bridge-relayed';

/** What the revive flow needs to wake an agent: its loop mechanism + template. */
export interface KeepaliveProfile {
  loop_mechanism: LoopMechanism;
  /**
   * Relative path (from `<extension-root>/skills/orchestrate/`) of the shipped
   * keepalive template, e.g. `templates/keepalive/codex.md`. The revive flow
   * resolves a per-project override first, then this shipped default.
   */
  keepalive_template: string;
}

/**
 * Canonical per-agent keepalive profile. Keyed by agent id. This is the single
 * place the codex→codex.md (etc.) mapping lives, so the scaffolder writes it
 * into every registry row it touches and the extension's provisioning floor can
 * import + reuse it. Derived from `src/runners/*.ts` loop styles:
 *
 *   claude-code     slash-loop      (has `/loop`)
 *   kilocode/cline/
 *   continue        plain-message   (chat-only hosts)
 *   claude-desktop  cli-headless    (--session-id resume)
 *   codex           cli-headless    (re-dispatch, no resume)
 *   cursor          cli-headless    (--no-interactive re-dispatch)
 *   kiro            cli-headless    (--resume-id re-dispatch)
 *   gemini-cli      cli-headless    (fresh subprocess re-dispatch)
 *   hermes          bridge-relayed  (REST POST /tasks)
 *   openclaw        bridge-relayed  (hybrid REST/CLI submit)
 *   autogpt         bridge-relayed  (REST service)
 */
export const KEEPALIVE_PROFILES: Readonly<Record<string, KeepaliveProfile>> = {
  'claude-code':    { loop_mechanism: 'slash-loop',     keepalive_template: 'templates/keepalive/claude-code.md' },
  'kilocode':       { loop_mechanism: 'plain-message',  keepalive_template: 'templates/keepalive/kilocode.md' },
  'cline':          { loop_mechanism: 'plain-message',  keepalive_template: 'templates/keepalive/kilocode.md' },
  'continue':       { loop_mechanism: 'plain-message',  keepalive_template: 'templates/keepalive/kilocode.md' },
  'claude-desktop': { loop_mechanism: 'cli-headless',   keepalive_template: 'templates/keepalive/claude-desktop.md' },
  'codex':          { loop_mechanism: 'cli-headless',   keepalive_template: 'templates/keepalive/codex.md' },
  'cursor':         { loop_mechanism: 'cli-headless',   keepalive_template: 'templates/keepalive/cursor.md' },
  'kiro':           { loop_mechanism: 'cli-headless',   keepalive_template: 'templates/keepalive/kiro.md' },
  'gemini-cli':     { loop_mechanism: 'cli-headless',   keepalive_template: 'templates/keepalive/gemini-cli.md' },
  'hermes':         { loop_mechanism: 'bridge-relayed', keepalive_template: 'templates/keepalive/hermes.md' },
  'openclaw':       { loop_mechanism: 'bridge-relayed', keepalive_template: 'templates/keepalive/openclaw.md' },
  'autogpt':        { loop_mechanism: 'bridge-relayed', keepalive_template: 'templates/keepalive/autogpt.md' },
};

/**
 * Resolve the keepalive profile for an agent id. Known ids return their
 * canonical profile; an unknown (brand-new) id gets a safe `plain-message`
 * default whose template path follows the by-id convention
 * (`templates/keepalive/<agentId>.md`). The revive flow will fall back to a
 * per-project override or surface "no template registered" if neither the
 * convention file nor an override exists — which is the correct, honest signal
 * for a truly unknown agent.
 */
export function keepaliveProfileFor(agentId: string): KeepaliveProfile {
  const known = KEEPALIVE_PROFILES[agentId];
  if (known) { return { ...known }; }
  return {
    loop_mechanism: 'plain-message',
    keepalive_template: `templates/keepalive/${agentId}.md`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Scaffolding                                                               */
/* -------------------------------------------------------------------------- */

/** Inputs to {@link scaffoldAgent}. Only `agentId` is required. */
export interface ScaffoldAgentOptions {
  /** Stable agent id, e.g. `codex`, `hermes`, or any newcomer id. */
  agentId: string;
  /** Human-readable name; defaults to a title-cased `agentId`. */
  name?: string;
  /** Fabric worker kind. Stamped onto the registry row when supplied. */
  agentType?: AgentType;
  /**
   * Coordination role hint written into the bootstrap file (e.g. `worker`,
   * `coordinator`). Defaults to `worker`. Free-form; not a fabric type.
   */
  role?: string;
}

/** What {@link scaffoldAgent} created or confirmed, for callers + logging. */
export interface ScaffoldAgentResult {
  agentId: string;
  /** Absolute path of the agent's inbox directory. */
  inboxDir: string;
  /** Absolute path of the bootstrap/rules file. */
  rulesPath: string;
  /** Absolute path of the local fallback protocol file. */
  localProtocolPath: string;
  /** True when a new registry row was added; false when one already existed. */
  registryRowAdded: boolean;
  /** True when the registry file itself was created by this call. */
  registryCreated: boolean;
  /** The keepalive profile stamped onto the row (loop_mechanism + template). */
  keepalive: KeepaliveProfile;
  /** Absolute paths of directories ensured by this call. */
  dirsEnsured: string[];
}

/** Best-effort title-case of an agent id for a default display name. */
function defaultName(agentId: string): string {
  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Render the bootstrap/rules file a newcomer agent reads on its first cycle.
 * Deliberately terse: it points the agent at the canonical protocol doc when
 * present, but also gives enough local fallback instruction for repos that were
 * scaffolded by AutoClaw without copying the full docs package.
 */
function renderBootstrap(agentId: string, name: string, role: string, kp: KeepaliveProfile): string {
  return `# Cross-Agent Coordination — ${name} (\`${agentId}\`)

You (\`agent_id = ${agentId}\`) have been added to this project's AutoClaw
fleet. Your coordination role: **${role}**.

**Authoritative contract:** docs/AGENT_SESSION_PROTOCOL.md when present.
If that file is absent in this checkout, treat this file plus the pasted join
prompt as the fallback contract for REGISTER -> SYNC -> CLAIM -> WORK -> REPORT
-> LOOP. The same fallback is also stored at
.autoclaw/orchestrator/AGENT_SESSION_PROTOCOL.md. Do not search outside the
workspace for AutoClaw docs.

## Your mailbox
- Inbox:   .autoclaw/orchestrator/comms/inboxes/${agentId}/
- Shared:  .autoclaw/orchestrator/comms/inboxes/shared/
- State:   .autoclaw/orchestrator/comms/inboxes/${agentId}/_state/
- Done:    .autoclaw/orchestrator/comms/inboxes/${agentId}/processed/

## Lifecycle (per cycle)
1. Write a heartbeat to
   .autoclaw/orchestrator/comms/heartbeats/${agentId}.json
   ({ agent_id, session_id, timestamp, status, current_task, sprint }).
2. SYNC your inbox + shared/; move handled messages to processed/.
3. CLAIM one in-scope, unclaimed, dependency-satisfied task with a
   create-exclusive write to comms/claims/<task-id>.json (fail if it
   exists — the filesystem is the mutex).
4. WORK in your claimed scope only.
5. REPORT: broadcast task_complete to shared/, send review_request to the
   other assigned agents, vote on open consensus/active/ items.

## How you are revived
- loop_mechanism:    ${kp.loop_mechanism}
- keepalive_template: ${kp.keepalive_template}

When your heartbeat goes stale, the orchestrator's \`/orchestrate revive
${agentId}\` renders that template (with your last task + stall duration)
and delivers it via the ${kp.loop_mechanism} path.

## Shared memory — the Knowledge Graph
This project keeps a durable, queryable Knowledge Graph of decisions, findings,
and learned patterns (fed by the orchestrator, \`/learn\`, and the \`kg.record\`
MCP tool). Before re-deriving something, recall what the team already knows:
- \`kg.search\` (MCP tool) — semantic recall of past decisions/findings/patterns.
- \`kg.traverse\` (MCP tool) — walk relations out from a recalled thought.
- Humans browse + visualize it via the **AutoClaw: Knowledge Graph — Browse &
  Visualize** command (\`autoclaw.kg.browse\`).

## Hard rules
- Never edit outside your claimed scope.
- Never re-process a message already in processed/.
- Never claim a task whose claim file you do not own.
- Report honestly — failed tests are reported as failed.
`;
}

function renderLocalProtocol(): string {
  return `# AutoClaw Agent Session Protocol — Local Fallback

This checkout does not need the full AutoClaw docs package for agents to join.
If docs/AGENT_SESSION_PROTOCOL.md exists, it is authoritative. Otherwise this
file is the local contract for invited agents.

## Required Loop

Run this cycle until a halt condition applies:

1. REGISTER: choose one session_id and reuse it for every heartbeat, beacon,
   claim, and message. Write a heartbeat/beacon for your agent_id.
2. SYNC: read your direct inbox and inboxes/shared/. Process each message once,
   record it in _state/ or state.json, then move it to processed/.
3. CLAIM: read needs.json if present; otherwise read board.json and
   sprints/plan-summary.yaml when present. Claim exactly one unclaimed,
   dependency-ready, in-scope task by create-exclusive write to
   comms/claims/<task-id>.json. If no task is addressed to you or in scope,
   stay registered and watch; do not take another agent's assignment.
4. WORK: edit only inside the claimed scope. For cross-scope changes, send a
   question message and wait.
5. REPORT: send task_complete plus evidence, request review where needed, and
   vote on consensus items you are eligible to review.
6. LOOP: refresh heartbeat/beacon, then repeat.

## Halt Conditions

Halt and report if the user stops you, the prompt changes, cycle >= 25, a
scope_violation is addressed to you, the comms tree is broken, an unresolved
merge conflict blocks your scope, or all sprints are merged with an empty
backlog.
`;
}

/**
 * Idempotently scaffold the minimum a single arbitrary agent needs to join the
 * fleet: its inbox tree, a registry row (carrying loop_mechanism +
 * keepalive_template), and a bootstrap/rules file.
 *
 * Safe to call repeatedly and safe to call against a comms tree another agent
 * already provisioned: existing dirs are left intact, an existing registry row
 * for the same id is NOT duplicated (it is refreshed in place), and an existing
 * bootstrap file is not overwritten.
 *
 * @param commsRoot Absolute path of the orchestrator comms dir, i.e.
 *                  `<workspace>/.autoclaw/orchestrator/comms`.
 * @param opts      Agent identity + optional metadata.
 */
export async function scaffoldAgent(
  commsRoot: string,
  opts: ScaffoldAgentOptions,
): Promise<ScaffoldAgentResult> {
  const agentId = opts.agentId.trim();
  if (!agentId) { throw new Error('scaffoldAgent: agentId is required'); }
  // Guard against path traversal in an id (newcomer ids are untrusted).
  if (agentId !== path.basename(agentId) || agentId === '.' || agentId === '..') {
    throw new Error(`scaffoldAgent: invalid agentId "${opts.agentId}"`);
  }

  const name = opts.name?.trim() || defaultName(agentId);
  const role = opts.role?.trim() || 'worker';
  const kp = keepaliveProfileFor(agentId);

  // 1. Ensure the comms skeleton + this agent's inbox tree. These are the dirs
  // the generated join prompts name, so a newcomer should not have to discover
  // and repair them before it can check in or use the filesystem fallback.
  const inboxDir = path.join(commsRoot, 'inboxes', agentId);
  const dirsEnsured = [
    path.join(commsRoot, 'inboxes', 'shared'),
    path.join(commsRoot, 'heartbeats'),
    path.join(commsRoot, 'beacons'),
    path.join(commsRoot, 'claims'),
    path.join(commsRoot, 'consensus'),
    path.join(commsRoot, 'consensus', 'active'),
    path.join(commsRoot, 'consensus', 'closed'),
    path.join(commsRoot, 'invites'),
    path.join(commsRoot, 'agents'),
    inboxDir,
    path.join(inboxDir, '_state'),
    path.join(inboxDir, 'processed'),
  ];
  for (const dir of dirsEnsured) {
    await fsp.mkdir(dir, { recursive: true });
  }

  // 2. Ensure a registry row (create the registry if it's missing).
  const inboxPathRel = `.autoclaw/orchestrator/comms/inboxes/${agentId}/`;
  const rulesRel = path.join('.autoclaw', 'orchestrator', 'comms', 'agents', agentId, 'rules.md');

  let registry: AgentRegistry | null = await readRegistry(commsRoot);
  let registryCreated = false;
  if (!registry || !Array.isArray(registry.agents)) {
    registry = { agents: [], ide: 'unknown', provisioned_at: new Date().toISOString(), schema_version: '2' };
    registryCreated = true;
  }

  const nowIso = new Date().toISOString();
  const existing = registry.agents.find(a => a.id === agentId);
  let registryRowAdded = false;
  if (existing) {
    // Refresh the fields we own without clobbering peer-set metadata.
    existing.name = existing.name || name;
    existing.inbox_path = existing.inbox_path || inboxPathRel;
    existing.rules_path = existing.rules_path || rulesRel;
    if (opts.agentType && !existing.agent_type) { existing.agent_type = opts.agentType; }
    existing.last_detected_at = nowIso;
    // Stamp keepalive fields (extra props the revive flow reads off the row).
    (existing as RegisteredAgent & KeepaliveProfile).loop_mechanism = kp.loop_mechanism;
    (existing as RegisteredAgent & KeepaliveProfile).keepalive_template = kp.keepalive_template;
  } else {
    const row: RegisteredAgent & KeepaliveProfile = {
      id: agentId,
      name,
      extension_id: null,
      detected: true,
      inbox_path: inboxPathRel,
      hooks_supported: false,
      last_heartbeat: null,
      status: 'detected' as AgentStatus,
      rules_path: rulesRel,
      last_detected_at: nowIso,
      loop_mechanism: kp.loop_mechanism,
      keepalive_template: kp.keepalive_template,
      ...(opts.agentType ? { agent_type: opts.agentType } : {}),
    };
    registry.agents.push(row);
    registryRowAdded = true;
  }
  await writeRegistry(commsRoot, registry);

  // 3. Write the bootstrap/rules file (do not overwrite a customised one).
  const rulesPath = path.join(commsRoot, 'agents', agentId, 'rules.md');
  await fsp.mkdir(path.dirname(rulesPath), { recursive: true });
  if (!fs.existsSync(rulesPath)) {
    await fsp.writeFile(rulesPath, renderBootstrap(agentId, name, role, kp), 'utf8');
  }

  const localProtocolPath = path.join(path.dirname(commsRoot), 'AGENT_SESSION_PROTOCOL.md');
  if (!fs.existsSync(localProtocolPath)) {
    await fsp.writeFile(localProtocolPath, renderLocalProtocol(), 'utf8');
  }

  return {
    agentId,
    inboxDir,
    rulesPath,
    localProtocolPath,
    registryRowAdded,
    registryCreated,
    keepalive: kp,
    dirsEnsured,
  };
}
