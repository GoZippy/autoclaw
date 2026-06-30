/**
 * joinPrompt.ts — One-click "Join this project as an agent" prompt generator (FF-2 / Slice A).
 *
 * The fleet-federation work (src/fleet/invites.ts, src/fleet/beacons.ts) lets an
 * OUTSIDE tool — Codex desktop chat, Claude Desktop / "cowork", OpenClaw, Hermes,
 * or any of the in-extension IDE hosts — JOIN an AutoClaw-orchestrated project as a
 * collaborating peer. The plumbing existed (issue a single-use invite token, write
 * a beacon, read needs.json, run the six-phase loop), but the human was left holding
 * a BARE TOKEN with no instructions for the target tool. This module closes that gap:
 * given a target tool, the workspace, a role/scope, and an issued invite token, it
 * renders ONE complete, ready-to-paste prompt tailored to that tool's join lane.
 *
 * Three join lanes, mirroring docs/AGENT_SESSION_PROTOCOL.md §10.2:
 *   - `mcp`  — mount AutoClaw's MCP server and call tools directly (presence.beacon,
 *              inbox.send/read, claim.task, consensus.vote). No file/HTTP plumbing.
 *   - `http` — REST bridge (src/bridge.ts): POST /api/v1/heartbeat, claim over HTTP,
 *              report with POST /api/v1/messages, subscribe to the SSE stream.
 *   - `fs`   — filesystem lane: write a beacon, drop message files into the comms
 *              inboxes following the §3 filename convention, honor idempotency.
 *
 * Pure module — NO vscode / fs imports — so the rendering is trivially unit-testable.
 * The vscode wiring (issuing the invite, the QuickPick, clipboard) lives in
 * extension.ts. The `Invite` type is imported type-only (erased at compile time), so
 * this stays free of runtime fs even though invites.ts touches fs.
 *
 * See docs/AGENT_SESSION_PROTOCOL.md §7 (bootstrap prompts) + §10 (peers without a
 * native bridge), and skills/orchestrate/templates/starter/worker.md (the loop body).
 */

import type { Invite } from './invites';
import { deriveAgentType } from './roleType';

/** The transport an invited tool uses to join. */
export type JoinLane = 'mcp' | 'http' | 'fs' | 'slash';

/** How a given join target prefers to be driven. */
export interface JoinTargetConvention {
  /** Stable agent_id the joining tool announces as. */
  agentId: string;
  /** Human label for the picker. */
  label: string;
  /** Primary lane (the steps rendered). */
  lane: JoinLane;
  /** A secondary lane to mention as a fallback (e.g. Codex: mcp else fs). */
  fallbackLane?: JoinLane;
  /** For `slash` lane (in-extension IDE hosts), whether the tool uses `/loop`. */
  slashLoop?: boolean;
}

/**
 * How each JOIN target prefers to be driven. Deliberately SEPARATE from
 * skillLauncher.ts's `HOST_SKILL_CONVENTIONS` (which describes how a host
 * references an installed *skill rule file* — a different concern, and one whose
 * tests assert `codex` is absent). The four federation targets (codex,
 * claude-desktop, openclaw, hermes) have no skill adapters; they join over a
 * transport lane, not a rule file.
 *
 * Lane choice follows docs/AGENT_SESSION_PROTOCOL.md §10.2:
 *   - codex          → MCP-capable CLI → mcp lane (file fallback if no MCP mount).
 *   - claude-desktop → MCP lane (Claude Desktop mounts MCP servers).
 *   - openclaw       → shell/file-only tool → fs lane.
 *   - hermes         → REST runner → http lane.
 */
export const JOIN_TARGETS: Record<string, JoinTargetConvention> = {
  // --- Federation peers (no in-extension skill adapter) -------------------
  codex:            { agentId: 'codex',          label: 'Codex (MCP-capable chat / CLI)',  lane: 'mcp',   fallbackLane: 'fs' },
  'codex-ide':      { agentId: 'codex',          label: 'Codex in IDE chat (file lane)',   lane: 'fs',    fallbackLane: 'mcp' },
  'codex-cli':      { agentId: 'codex-cli',      label: 'Codex CLI / spawned worker',      lane: 'fs',    fallbackLane: 'mcp' },
  'generic-mcp':    { agentId: 'external-mcp',   label: 'Generic MCP-capable agent',       lane: 'mcp',   fallbackLane: 'fs' },
  'claude-desktop': { agentId: 'claude-desktop', label: 'Claude Desktop / cowork',         lane: 'mcp' },
  openclaw:         { agentId: 'openclaw',       label: 'OpenClaw (file / REST)',          lane: 'fs',    fallbackLane: 'http' },
  hermes:           { agentId: 'hermes',         label: 'Hermes (REST runner)',            lane: 'http',  fallbackLane: 'fs' },

  // --- In-extension IDE hosts (kept working; they have skill adapters) -----
  'claude-code':    { agentId: 'claude-code',    label: 'Claude Code',                     lane: 'slash', slashLoop: true },
  cline:            { agentId: 'cline',           label: 'Cline',                           lane: 'fs' },
  kilocode:         { agentId: 'kilocode',        label: 'Kilo Code',                       lane: 'fs' },
  kiro:             { agentId: 'kiro',            label: 'Kiro',                            lane: 'fs' },
  cursor:           { agentId: 'cursor',          label: 'Cursor',                          lane: 'fs' },
  continue:         { agentId: 'continue',        label: 'Continue',                        lane: 'fs' },
  windsurf:         { agentId: 'windsurf',        label: 'Windsurf',                        lane: 'fs' },
  antigravity:      { agentId: 'gemini-cli',      label: 'Gemini CLI / Antigravity',        lane: 'fs' },
};

/** Inputs to {@link renderJoinPrompt}. All but `inviteToken` are optional-ish. */
export interface RenderJoinPromptInput {
  /** Target tool key into {@link JOIN_TARGETS}. Unknown ⇒ a safe fs-lane fallback. */
  host: string;
  /** Override the announced agent_id. Defaults to the target's convention id. */
  agentId?: string;
  /** Absolute workspace path the agent joins. */
  workspacePath: string;
  /** Suggested role (from the invite wizard). Free-text; fleet.json still wins. */
  role?: string;
  /**
   * Behavioural agent_type the agent announces (drives trust / consensus / admit).
   * DISTINCT from `role`: a `reviewer` role announces agent_type `auditor`. When
   * omitted, it is derived from `role` via {@link deriveAgentType} so the beacon
   * never collapses the two fields (a reviewer would otherwise wrongly announce
   * agent_type `reviewer` and miss the auditor unanimous rule).
   */
  agentType?: string;
  /** Path globs the agent may touch (seeds a scope-lease). */
  scope?: string[];
  /** The single-use invite token the agent must consume. REQUIRED. */
  inviteToken: string;
  /**
   * Optional REST base URL for the http lane (e.g. http://127.0.0.1:7878).
   * Defaults to a documented placeholder the user edits.
   */
  bridgeUrl?: string;
}

/** Resolve the convention for a host, falling back to a generic fs-lane peer. */
function conventionFor(host: string, agentIdOverride?: string): JoinTargetConvention {
  const conv = JOIN_TARGETS[host];
  if (conv) {
    return agentIdOverride ? { ...conv, agentId: agentIdOverride } : conv;
  }
  // Unknown tool: assume a file-only one-liner can join (the most universal lane).
  return {
    agentId: agentIdOverride || host || 'external-agent',
    label: host || 'external agent',
    lane: 'fs',
  };
}

/** Human label for a lane, used in the rendered header. */
function laneLabel(lane: JoinLane): string {
  switch (lane) {
    case 'mcp':  return 'MCP lane (mount the autoclaw-mcp server and call tools directly)';
    case 'http': return 'HTTP bridge lane (REST + SSE)';
    case 'fs':   return 'filesystem lane (write beacon + message files under the comms tree)';
    case 'slash': return 'native /loop lane (Claude Code skill)';
  }
}

const PROTOCOL_DOC = 'docs/AGENT_SESSION_PROTOCOL.md';
const LOCAL_PROTOCOL_DOC = '.autoclaw/orchestrator/AGENT_SESSION_PROTOCOL.md';
const WORKER_TEMPLATE = 'skills/orchestrate/templates/starter/worker.md';

/**
 * The six-phase loop body, in plain numbered imperative form (the same shape as
 * worker.md and §7's bootstrap prompts). `agentId` is interpolated so the agent
 * writes its own heartbeat/beacon path. This is what makes the pasted prompt
 * actually START the REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP cycle rather than just
 * describe it.
 */
function loopBody(agentId: string): string {
  return [
    `Then run the six-phase loop (REGISTER -> SYNC -> CLAIM -> WORK -> REPORT -> LOOP):`,
    `- SYNC: read your inbox (.autoclaw/orchestrator/comms/inboxes/${agentId}/) and inboxes/shared/.`,
    `  For each message: act on it, atomic-move it to processed/, record it in state.json's`,
    `  message_ledger. Never re-process anything already in processed/. Answer anything with`,
    `  requires_response before claiming new work.`,
    `- CLAIM: read .autoclaw/orchestrator/needs.json if present; otherwise read`,
    `  .autoclaw/orchestrator/board.json plus .autoclaw/orchestrator/sprints/plan-summary.yaml`,
    `  when present. Offer the role the project needs (capability_offer), then claim ONE unclaimed, in-scope,`,
    `  dependency-satisfied task via a create-exclusive write to comms/claims/<task-id>.json`,
    `  (fail if it exists -- the filesystem is the mutex). Confirm the claim's session_id is yours.`,
    `  If no task is addressed to you or in scope, stay registered, heartbeat, and watch; do not take`,
    `  vendor-specific task prompts meant for another agent.`,
    `- WORK: only inside your claimed scope, on the assignment branch. Do not edit a file outside scope;`,
    `  send a question message to the scope owner and wait instead.`,
    `- REPORT: broadcast task_complete to inboxes/shared/, send review_request to peers, vote on`,
    `  anything open in consensus/active/.`,
    `- LOOP: write a fresh heartbeat/beacon each cycle with an incremented cycle and your session_id.`,
    `  HALT on any of: user said stop / prompt changed; cycle >= 25; a scope_violation against you;`,
    `  an unresolved merge conflict in your scope; the comms tree is broken; all sprints merged with`,
    `  empty backlog. When idle, enter watch mode (review an open request, vote, gap-analysis, tests)`,
    `  then back off -- do NOT busy-spin.`,
  ].join('\n');
}

/**
 * The behavioural agent_type the prompt should announce: an explicit override if
 * the caller supplied one, otherwise DERIVED from the role (so a `reviewer` role
 * correctly announces `auditor`). Returns undefined only when there is no role at
 * all — never the role string masquerading as a type.
 */
function effectiveAgentType(input: RenderJoinPromptInput): string | undefined {
  const explicit = input.agentType?.trim();
  if (explicit) { return explicit; }
  const role = input.role?.trim();
  return role ? deriveAgentType(role) : undefined;
}

function roleGuidance(role: string | undefined, agentType: string | undefined): string | undefined {
  if (agentType === 'auditor') {
    return 'Role guidance: prefer review_request, consensus, test, and audit work; do not claim implementation tasks unless explicitly assigned.';
  }
  if (agentType === 'supervisor' || role === 'orchestrator') {
    return 'Role guidance: coordinate, assign, unblock, and review; do not take implementation work unless the project explicitly asks you to.';
  }
  if (agentType === 'assistant' || agentType === 'governance') {
    return 'Role guidance: operate human-in-the-loop by default; draft, analyze, or approve, but do not mutate code or claim build tasks without explicit scope.';
  }
  if (role === 'tester') {
    return 'Role guidance: prefer verification, failing-test reproduction, acceptance checks, and review support before claiming implementation tasks.';
  }
  if (role === 'docs' || role === 'researcher' || role === 'product') {
    return 'Role guidance: prefer documentation, research, requirements, and handoff artifacts; only edit code when a task explicitly includes that scope.';
  }
  return undefined;
}

/** A compact beacon JSON shape (fs/http lanes) the agent writes to check in. */
function beaconJson(
  agentId: string,
  workspacePath: string,
  role: string | undefined,
  agentType: string | undefined,
  transports: string[],
): string {
  const obj: Record<string, unknown> = {
    agent_id: agentId,
    session_id: '<your-session-uuid>',
    timestamp: '<iso-now>',
    status: 'active',
    host: agentId,
    workspace: workspacePath,
    transports,
  };
  if (role) { obj.role = role; }
  if (agentType) { obj.agent_type = agentType; }
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// Per-lane step renderers
// ---------------------------------------------------------------------------

/** MCP lane — Codex / Claude Desktop. Tool calls, no file or HTTP plumbing. */
function mcpSteps(conv: JoinTargetConvention, input: RenderJoinPromptInput): string {
  const { workspacePath, inviteToken } = input;
  const role = input.role;
  const agentType = effectiveAgentType(input);
  const ident = `${role ? `, role: "${role}"` : ''}${agentType ? `, agent_type: "${agentType}"` : ''}`;
  return [
    `REGISTER (MCP lane):`,
    `1. Mount AutoClaw's MCP server (\`autoclaw-mcp\`) scoped to this workspace, with writes enabled`,
    `   (.autoclaw/mcp/config.json -> { "allowWrites": true }, or AUTOCLAW_MCP_ALLOW_WRITES=true).`,
    `2. Generate one session UUID and reuse it all session. Stamp it on every call.`,
    `3. Check in and consume the invite in one call: call \`presence.beacon\` with`,
    `   { agent_id: "${conv.agentId}"${ident}, invite_token: "${inviteToken}",`,
    `   workspace: "${workspacePath}", transports: ["mcp"] }. The host stamps host + session_id; you`,
    `   become a visible fleet row. (presence.beacon is the tool that makes an MCP agent VISIBLE.)`,
    `   If you need a two-step handshake, call \`invite.consume\` first, then \`presence.beacon\`.`,
    `4. See peers with \`presence.fleet\`. Coordinate with \`inbox.send\` / \`inbox.read\`,`,
    `   take work with \`claim.task\`, and vote with \`consensus.vote\`. No file paths, no HTTP.`,
    ``,
    loopBody(conv.agentId),
  ].join('\n');
}

/** HTTP lane — Hermes / any REST runner. Heartbeat, claim, report over REST + SSE. */
function httpSteps(conv: JoinTargetConvention, input: RenderJoinPromptInput): string {
  const { workspacePath, inviteToken } = input;
  const role = input.role;
  const agentType = effectiveAgentType(input);
  const ident = `${role ? `, role: "${role}"` : ''}${agentType ? `, agent_type: "${agentType}"` : ''}`;
  const base = input.bridgeUrl || '<autoclaw-bridge-base-url, e.g. http://127.0.0.1:7878>';
  return [
    `REGISTER (HTTP bridge lane):`,
    `1. Generate one session UUID and reuse it all session; send it on every request.`,
    `2. Consume your single-use invite token "${inviteToken}": POST ${base}/api/v1/invites/consume`,
    `   with { token: "${inviteToken}", agent_id: "${conv.agentId}", session_id }. Save the returned`,
    `   bearer_token and use it as Authorization: Bearer <token> for all later calls.`,
    `3. Check in each cycle: POST ${base}/api/v1/heartbeat with`,
    `   { agent_id: "${conv.agentId}"${ident}, session_id, workspace: "${workspacePath}",`,
    `   transports: ["http"] }. A machine beacon is an accepted twin.`,
    `4. Serve your Agent Card at <your-endpoint>/.well-known/agent.json so the router can score you.`,
    `5. Receive messages: subscribe to the SSE stream ${base}/api/v1/messages/stream (or poll`,
    `   ${base}/api/v1/messages).`,
    `6. Take work over HTTP: POST ${base}/api/v1/claims/<task_id> (optional JSON { sprint_id, ttl_hours }).`,
    `   It is create-exclusive: 201 + claim_token on success, 409 { reason:"conflict", owner } if taken.`,
    `7. Report: POST ${base}/api/v1/messages with { type:"task_complete", payload:{ task_id } } (and`,
    `   review_request / consensus votes the same way).`,
    ``,
    loopBody(conv.agentId),
  ].join('\n');
}

/** Filesystem lane — OpenClaw / any one-liner / in-extension chat-only IDE host. */
function fsSteps(conv: JoinTargetConvention, input: RenderJoinPromptInput): string {
  const { workspacePath, inviteToken } = input;
  const role = input.role;
  const agentType = effectiveAgentType(input);
  const beacon = beaconJson(conv.agentId, workspacePath, role, agentType, ['fs']);
  return [
    `REGISTER (filesystem lane):`,
    `1. Generate one session UUID and reuse it all session. Stamp it on every file you write.`,
    `2. Consume your single-use invite token "${inviteToken}" (prefer the workspace copy at`,
    `   .autoclaw/orchestrator/comms/invites/; fall back to ~/.autoclaw/invites/. Mark every copy you can`,
    `   see as consumed by your agent_id + session_id -- single-use).`,
    `3. Ensure the comms tree exists -- create these if missing (all INSIDE the workspace, so no`,
    `   access outside it is needed): .autoclaw/orchestrator/comms/heartbeats/,`,
    `   .autoclaw/orchestrator/comms/beacons/, .autoclaw/orchestrator/comms/claims/,`,
    `   .autoclaw/orchestrator/comms/inboxes/shared/, .autoclaw/orchestrator/comms/inboxes/${conv.agentId}/{_state,processed}/,`,
    `   and an empty .autoclaw/orchestrator/comms/registry.json ({ "agents": [] }) if absent.`,
    `4. Check in INSIDE the workspace (no out-of-workspace permission needed) -- write this JSON to`,
    `   .autoclaw/orchestrator/comms/heartbeats/${conv.agentId}.json AND/OR`,
    `   .autoclaw/orchestrator/comms/beacons/${conv.agentId}.json. Only add a machine-global copy at`,
    `   ~/.autoclaw/beacons/${conv.agentId}.json for cross-workspace visibility if your IDE can reach $HOME:`,
    '```json',
    beacon,
    '```',
    `5. Register by name: append { "id": "${conv.agentId}"${role ? `, "role": "${role}"` : ''}${agentType ? `, "agent_type": "${agentType}"` : ''} } to the`,
    `   "agents" array in .autoclaw/orchestrator/comms/registry.json (the panel already counts you from step 4`,
    `   -- this adds your name + role to the roster).`,
    `6. Send messages by writing one JSON file per message into`,
    `   .autoclaw/orchestrator/comms/inboxes/<to>/ (or inboxes/shared/ to broadcast), with the filename`,
    `   <iso-ts-with-millis>-<type>-${conv.agentId}-<session-frag>.json (never whole-second timestamps).`,
    `7. Honor idempotency: read each inbox message once, write inboxes/${conv.agentId}/_state/<id>.json,`,
    `   act, then atomic-move the file to processed/. Never re-process a processed/ file.`,
    ``,
    loopBody(conv.agentId),
  ].join('\n');
}

/** Native /loop lane — Claude Code. Wrap the loop in the /loop skill. */
function slashSteps(conv: JoinTargetConvention, input: RenderJoinPromptInput): string {
  const { workspacePath, inviteToken } = input;
  const role = input.role;
  const agentType = effectiveAgentType(input);
  const ident = `${role ? `, role: "${role}"` : ''}${agentType ? `, agent_type: "${agentType}"` : ''}`;
  return [
    `REGISTER (Claude Code, native /loop lane):`,
    `1. Generate one session UUID and reuse it all session; stamp it on every message + heartbeat.`,
    `2. Consume your single-use invite token "${inviteToken}" from .autoclaw/orchestrator/comms/invites/`,
    `   if present, else ~/.autoclaw/invites/. Mark every visible copy consumed by your agent_id + session_id.`,
    `3. Write .autoclaw/orchestrator/comms/heartbeats/${conv.agentId}.json with`,
    `   { agent_id: "${conv.agentId}"${ident}, session_id, status:"active", cycle:0 } and ensure a`,
    `   row in comms/registry.json. Workspace: "${workspacePath}".`,
    `4. You have the Agent subagent primitive: a task spanning >=3 files MAY fan out to <=4 concurrent`,
    `   Agent subagents (Researcher -> Coder -> Reviewer -> Verifier). Small tasks: do them in-session.`,
    ``,
    loopBody(conv.agentId),
    ``,
    `To make the loop recur, wrap the cycle in \`/loop\` and keep cycle>=25 as the real ceiling.`,
  ].join('\n');
}

function renderSteps(conv: JoinTargetConvention, input: RenderJoinPromptInput): string {
  switch (conv.lane) {
    case 'mcp':   return mcpSteps(conv, input);
    case 'http':  return httpSteps(conv, input);
    case 'slash': return slashSteps(conv, input);
    case 'fs':
    default:      return fsSteps(conv, input);
  }
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render ONE complete, ready-to-paste "join this project" prompt for a target tool.
 *
 * The returned string always contains: the agent_id to announce, the workspace path,
 * the invite token, the lane to use + concrete steps for it (MCP tool calls OR HTTP
 * routes OR the comms file paths), a pointer to {@link PROTOCOL_DOC} for the full
 * contract, the suggested role/scope, and the worker-loop body so the agent actually
 * starts the six-phase cycle. Pure — safe to unit-test with no vscode/fs.
 */
export function renderJoinPrompt(input: RenderJoinPromptInput): string {
  const conv = conventionFor(input.host, input.agentId);
  const role = input.role?.trim();
  const agentType = effectiveAgentType(input);
  const scope = (input.scope ?? []).filter(Boolean);

  const header = [
    `You are joining an AutoClaw-orchestrated project as agent \`${conv.agentId}\`.`,
    `Start in the workspace below. First read ${PROTOCOL_DOC} if it exists; otherwise read`,
    `${LOCAL_PROTOCOL_DOC} and .autoclaw/orchestrator/comms/agents/${conv.agentId}/rules.md if present, then any host rules file`,
    `that exists (.claude/rules/cross-agent-protocol.md, .clinerules/cross-agent.md, or AGENTS.md).`,
    `If those files are missing, this pasted prompt is the fallback contract; report the missing file`,
    `and continue with REGISTER + SYNC instead of searching outside the workspace. The loop body below`,
    `is the same one in ${WORKER_TEMPLATE} when that template is available.`,
    ``,
    `Workspace: ${input.workspacePath}`,
    `Your agent_id: ${conv.agentId}`,
    `Invite token (single-use, scoped, TTL'd): ${input.inviteToken}`,
    role ? `Suggested role: ${role} (the project's fleet.json is authoritative; this is a hint).` : undefined,
    agentType ? `Behavioral type: ${agentType} (drives how your work is trusted + reviewed; announce this exact value).` : undefined,
    roleGuidance(role, agentType),
    scope.length ? `Scope you may touch (seeds a scope-lease): ${scope.join(', ')}.` : `Scope: whole repo unless the orchestrator narrows it.`,
    `Join lane: ${laneLabel(conv.lane)}.`,
    conv.fallbackLane
      ? `If that lane is unavailable, fall back to the ${laneLabel(conv.fallbackLane)}.`
      : undefined,
  ].filter((l): l is string => l !== undefined).join('\n');

  const steps = renderSteps(conv, input);

  const footer = [
    `Stamp your session_id on every message and heartbeat/beacon. Stay strictly in scope.`,
    `Coordinate cross-scope changes with a question message -- never edit first. Report honestly:`,
    `if tests fail, say so. Begin with REGISTER + SYNC and tell me what you found.`,
  ].join('\n');

  return `${header}\n\n${steps}\n\n${footer}\n`;
}

/**
 * Convenience: render a join prompt directly from an issued {@link Invite}, pulling
 * workspace / role / scope off the invite so the caller doesn't re-thread them. The
 * `host` still selects the lane (an invite is lane-agnostic). `bridgeUrl` is optional.
 */
export function renderJoinPromptForInvite(
  host: string,
  invite: Invite,
  opts: { agentId?: string; bridgeUrl?: string } = {},
): string {
  return renderJoinPrompt({
    host,
    agentId: opts.agentId,
    workspacePath: invite.workspace ?? invite.project,
    role: invite.suggested_role,
    // Thread the invite's DISTINCT behavioural type through to the beacon. The
    // invite layer already carries a correct `suggested_agent_type` (set by the
    // command); without this the renderer would re-derive from role only. Falls
    // back to role-derivation inside renderJoinPrompt when the invite omits it.
    agentType: invite.suggested_agent_type,
    scope: invite.scope,
    inviteToken: invite.token,
    bridgeUrl: opts.bridgeUrl,
  });
}
