/**
 * triggerHooks.ts — Event-driven trigger hooks (HKS-1..3).
 *
 * Implements docs/specs/agent-trigger-hooks.spec.md:
 *   - HookRule loading from `.autoclaw/orchestrator/hooks.yaml` (flat YAML
 *     subset, mirroring autobuild's parseWorkflowYaml — no YAML dependency)
 *   - Pure `matchHooks` matcher: filters (equality + *_gte/*_lte), per-rule
 *     cooldown, global firings-per-hour cap, fleet HALT, via_hook exclusion
 *   - `executeHook` executor with injected deps (dispatch/notify) — every
 *     firing AND suppression is audited (comms-log + hooks/audit.jsonl)
 *   - Fleet HALT kill switch: `.autoclaw/orchestrator/HALT` stops all hook
 *     firings and (via orchestratorLoop.dispatchWork) all loop dispatching
 *   - `startTriggerHooksRuntime`: InboxWatcher-backed runtime. Zero-config
 *     no-op — when hooks.yaml is absent or empty, no watcher is started.
 *
 * Hooks wake agents; they never edit files or run repo-mutating commands.
 * `launch_skill` / `spawn_runner` / `relay` actions are HKS-4/5 (not yet
 * implemented) — rules using them load fine but firings audit as hook_error.
 */

import * as fs from 'fs';
import * as path from 'path';
import { appendCommsLog } from '../comms';
import { createInboxWatcher, InboxWatcher } from '../daemon/watcher';
import { dispatchWork, WorkPackage, VendorKind } from '../orchestratorLoop';
import { isFleetHalted } from './fleetHalt';
import {
  type HookOn, type HookEvent,
  buildHeartbeatStallEvents, buildClaimStaleEvents, DEFAULT_STALL_THRESHOLD_SECONDS,
} from './hookEvents';
import { registerHookHandler } from './hookBus';

// Re-export the kill-switch surface so consumers can import everything
// hook-related from one module.
export { HALT_FILE_REL, isFleetHalted, setFleetHalted } from './fleetHalt';
// Re-export the event surface (types + builders + bus) so consumers keep a
// single import site even though the leaf modules break the import cycle.
export {
  type HookOn, type HookEvent,
  buildHeartbeatStallEvents, buildClaimStaleEvents, buildConsensusEvent, buildAutobuildFailEvent,
  DEFAULT_STALL_THRESHOLD_SECONDS,
} from './hookEvents';
export { registerHookHandler, emitHookEvent, activeHookHandlerCount } from './hookBus';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookAction = 'dispatch' | 'notify' | 'launch_skill' | 'spawn_runner' | 'relay';

export interface HookRule {
  id: string;
  on: HookOn;
  /**
   * Equality match on event payload fields. Keys ending `_gte`/`_lte` compare
   * numerically against the base field (e.g. `seconds_stale_gte: 600` matches
   * payload.seconds_stale >= 600). Values compare string-coerced otherwise.
   */
  filter?: Record<string, string | number | boolean>;
  action: HookAction;
  /** "{{field}}" templates render from the event payload (e.g. "{{to}}"). */
  target?: string;
  /** launch_skill: which shipped skill to open (e.g. "orchestrate"). */
  skill?: string;
  /** launch_skill: a pre-filled prompt; overrides the default skill prompt. */
  prompt?: string;
  /** spawn_runner: runner id to start (defaults to `target`). */
  runner?: string;
  /** Per-rule re-fire floor. Default 300s. */
  cooldown_seconds?: number;
}

/** Mutable runtime state. `matchHooks` updates it for `fire` decisions. */
export interface HookRuntimeState {
  halted: boolean;
  /** rule id → epoch ms of last fire (cooldown source). */
  lastFiredAtMs: Record<string, number>;
  firingsThisHour: number;
  hourWindowStartMs: number;
}

export type HookOutcome = 'fire' | 'suppressed_halt' | 'suppressed_cooldown' | 'suppressed_cap';

export interface HookDecision {
  rule: HookRule;
  event: HookEvent;
  /** Rendered target (templates resolved). Undefined when the rule has none. */
  target?: string;
  outcome: HookOutcome;
}

export const DEFAULT_COOLDOWN_SECONDS = 300;
export const DEFAULT_MAX_FIRINGS_PER_HOUR = 30;

const VALID_ON: HookOn[] = ['message', 'heartbeat_stall', 'claim_stale', 'consensus', 'autobuild_fail'];
const VALID_ACTIONS: HookAction[] = ['dispatch', 'notify', 'launch_skill', 'spawn_runner', 'relay'];

// ---------------------------------------------------------------------------
// hooks.yaml loading (flat YAML subset — autobuild parseWorkflowYaml pattern)
// ---------------------------------------------------------------------------

/**
 * Parse the hooks.yaml text into rules. Supported shape (two-space indents):
 *
 *   hooks:
 *     - id: wake-reviewer
 *       on: message
 *       filter: { type: review_request }     # inline map, OR:
 *       filter:
 *         type: review_request
 *       action: dispatch
 *       target: "{{to}}"
 *       cooldown_seconds: 300
 *
 * Invalid rules (unknown `on`/`action`, missing id) are dropped with a warning
 * via `onWarn`; the parser never throws.
 */
export function parseHooksYaml(text: string, onWarn?: (msg: string) => void): HookRule[] {
  const warn = onWarn ?? (() => { /* silent by default */ });
  const lines = text.split(/\r?\n/);
  const rules: HookRule[] = [];
  let current: Partial<HookRule> & { filter?: Record<string, string | number | boolean> } | null = null;
  let inFilterBlock = false;

  const flush = () => {
    if (!current) { return; }
    const r = current;
    current = null;
    if (typeof r.id !== 'string' || r.id.length === 0) { warn('hooks.yaml: rule missing id — dropped'); return; }
    if (!VALID_ON.includes(r.on as HookOn)) { warn(`hooks.yaml: rule "${r.id}" has unknown on: ${String(r.on)} — dropped`); return; }
    if (!VALID_ACTIONS.includes(r.action as HookAction)) { warn(`hooks.yaml: rule "${r.id}" has unknown action: ${String(r.action)} — dropped`); return; }
    rules.push(r as HookRule);
  };

  const coerce = (raw: string): string | number | boolean => {
    const v = raw.trim().replace(/^["']|["']$/g, '');
    if (v === 'true') { return true; }
    if (v === 'false') { return false; }
    if (/^-?\d+(\.\d+)?$/.test(v)) { return Number(v); }
    return v;
  };

  for (const line of lines) {
    if (/^\s*(#|$)/.test(line)) { continue; }
    if (/^hooks:\s*$/.test(line)) { continue; }

    // New rule item: "  - id: wake-reviewer" (or bare "  -")
    const itemStart = line.match(/^\s*-\s*(?:(\w+):\s*(.*))?$/);
    if (itemStart) {
      flush();
      current = {};
      inFilterBlock = false;
      if (itemStart[1]) { assign(itemStart[1], itemStart[2] ?? ''); }
      continue;
    }
    if (!current) { continue; }

    // Nested filter block entries: "      type: review_request"
    const kv = line.match(/^(\s+)(\w+):\s*(.*)$/);
    if (!kv) { continue; }
    const indent = kv[1].length;
    const key = kv[2];
    const rawVal = kv[3];

    if (inFilterBlock && indent >= 6) {
      current.filter = current.filter ?? {};
      current.filter[key] = coerce(rawVal);
      continue;
    }
    inFilterBlock = false;
    assign(key, rawVal);
  }
  flush();
  return rules;

  function assign(key: string, rawVal: string): void {
    if (!current) { return; }
    const val = rawVal.trim();
    switch (key) {
      case 'id': current.id = String(coerce(val)); break;
      case 'on': current.on = String(coerce(val)) as HookOn; break;
      case 'action': current.action = String(coerce(val)) as HookAction; break;
      case 'target': current.target = String(coerce(val)); break;
      case 'skill': current.skill = String(coerce(val)); break;
      case 'prompt': current.prompt = String(coerce(val)); break;
      case 'runner': current.runner = String(coerce(val)); break;
      case 'cooldown_seconds': {
        const n = Number(coerce(val));
        if (Number.isFinite(n) && n >= 0) { current.cooldown_seconds = n; }
        break;
      }
      case 'filter': {
        if (val === '' ) { inFilterBlock = true; current.filter = current.filter ?? {}; break; }
        // Inline map: { type: review_request, to: kilocode }
        const inline = val.replace(/^\{|\}$/g, '');
        current.filter = current.filter ?? {};
        for (const part of inline.split(',')) {
          const m = part.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
          if (m) { current.filter[m[1]] = coerce(m[2]); }
        }
        break;
      }
      default: /* unknown keys ignored (forward compat) */ break;
    }
  }
}

/** Path of the rules file. */
export const HOOKS_FILE_REL = path.join('.autoclaw', 'orchestrator', 'hooks.yaml');

/** Load rules for a workspace. Missing/unreadable file ⇒ [] (zero-config no-op). */
export async function loadHookRules(
  workspaceRoot: string,
  onWarn?: (msg: string) => void
): Promise<HookRule[]> {
  try {
    const text = await fsPromises.readFile(path.join(workspaceRoot, HOOKS_FILE_REL), 'utf8');
    return parseHooksYaml(text.replace(/^﻿/, ''), onWarn);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure matcher
// ---------------------------------------------------------------------------

export function freshHookState(now: number = Date.now()): HookRuntimeState {
  return { halted: false, lastFiredAtMs: {}, firingsThisHour: 0, hourWindowStartMs: now };
}

/** Render "{{field}}" templates from the event payload. Unknown fields → ''. */
export function renderTarget(template: string | undefined, payload: Record<string, unknown>): string | undefined {
  if (template === undefined) { return undefined; }
  return template.replace(/\{\{(\w+)\}\}/g, (_, f: string) => {
    const v = payload[f];
    return v === undefined || v === null ? '' : String(v);
  });
}

function filterMatches(filter: HookRule['filter'], payload: Record<string, unknown>): boolean {
  if (!filter) { return true; }
  for (const [key, expected] of Object.entries(filter)) {
    const gte = key.endsWith('_gte');
    const lte = key.endsWith('_lte');
    if (gte || lte) {
      const base = key.slice(0, -4);
      const actual = Number(payload[base]);
      const bound = Number(expected);
      if (!Number.isFinite(actual) || !Number.isFinite(bound)) { return false; }
      if (gte && !(actual >= bound)) { return false; }
      if (lte && !(actual <= bound)) { return false; }
    } else {
      const actual = payload[key];
      if (actual === undefined || String(actual) !== String(expected)) { return false; }
    }
  }
  return true;
}

/**
 * Decide which rules fire for an event. Pure over its inputs except that it
 * UPDATES `state` (lastFiredAtMs, firingsThisHour, hour window) for every
 * `fire` decision — callers hold one state object per workspace.
 *
 * Order of precedence per matching rule: HALT > cooldown > hourly cap > fire.
 * Events tagged `via_hook` never match anything (no self-amplification).
 */
export function matchHooks(
  rules: HookRule[],
  event: HookEvent,
  state: HookRuntimeState,
  now: number = Date.now(),
  maxFiringsPerHour: number = DEFAULT_MAX_FIRINGS_PER_HOUR
): HookDecision[] {
  if (event.via_hook) { return []; }

  // Roll the hourly window.
  if (now - state.hourWindowStartMs >= 3_600_000) {
    state.hourWindowStartMs = now;
    state.firingsThisHour = 0;
  }

  const decisions: HookDecision[] = [];
  for (const rule of rules) {
    if (rule.on !== event.on) { continue; }
    if (!filterMatches(rule.filter, event.payload)) { continue; }

    const target = renderTarget(rule.target, event.payload);

    if (state.halted) {
      decisions.push({ rule, event, target, outcome: 'suppressed_halt' });
      continue;
    }
    const cooldownMs = (rule.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
    const last = state.lastFiredAtMs[rule.id];
    if (last !== undefined && now - last < cooldownMs) {
      decisions.push({ rule, event, target, outcome: 'suppressed_cooldown' });
      continue;
    }
    if (state.firingsThisHour >= maxFiringsPerHour) {
      decisions.push({ rule, event, target, outcome: 'suppressed_cap' });
      continue;
    }

    state.lastFiredAtMs[rule.id] = now;
    state.firingsThisHour++;
    decisions.push({ rule, event, target, outcome: 'fire' });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Executor (deps-injected; every outcome audited)
// ---------------------------------------------------------------------------

export interface HookDeps {
  workspaceRoot: string;
  /**
   * Perform a `dispatch` action for the rendered target agent. The runtime
   * wires this to orchestratorLoop.dispatchWork (full AF-8 gating + journal);
   * tests inject a recorder.
   */
  dispatch?: (target: string, decision: HookDecision) => Promise<void>;
  /** Surface a `notify` action (VS Code toast + output channel in the runtime). */
  notify?: (message: string, decision: HookDecision) => void;
  /**
   * `launch_skill` (HKS-4): open a pre-filled skill session for the target host.
   * The runtime wires this to the launchSkill flow (renderSkillPrompt → clipboard
   * + toast); tests inject a recorder. The decision carries rule.skill/prompt/target.
   */
  launchSkill?: (decision: HookDecision) => Promise<void> | void;
  /**
   * `spawn_runner` (HKS-4): start a registered runner for the target. The runtime
   * resolves the runner from the registry and wakes it via the dispatch path.
   */
  spawnRunner?: (decision: HookDecision) => Promise<void> | void;
  /**
   * `relay` (HKS-5): forward the event to the target machine's inbox over the
   * cloud relay (cross-machine wake). Inert unless the relay is configured.
   */
  relay?: (decision: HookDecision) => Promise<void> | void;
}

const COMMS_DIR_REL = path.join('.autoclaw', 'orchestrator', 'comms');

async function auditHook(
  workspaceRoot: string,
  decision: HookDecision,
  result: 'hook_fired' | 'hook_suppressed' | 'hook_error',
  detail?: string
): Promise<void> {
  const commsDirAbs = path.join(workspaceRoot, COMMS_DIR_REL);
  const entry = {
    timestamp: new Date().toISOString(),
    rule_id: decision.rule.id,
    on: decision.rule.on,
    action: decision.rule.action,
    target: decision.target,
    outcome: decision.outcome,
    result,
    detail,
    event_payload: decision.event.payload,
  };
  // hooks/audit.jsonl — the dedicated instrument.
  const auditDir = path.join(commsDirAbs, 'hooks');
  try {
    await fsPromises.mkdir(auditDir, { recursive: true });
    await fsPromises.appendFile(path.join(auditDir, 'audit.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* audit must never throw into the watcher */ }
  // comms-log mirror so the panel's activity feed sees firings.
  try {
    await appendCommsLog(commsDirAbs, {
      timestamp: entry.timestamp,
      type: result,
      from: 'trigger-hooks',
      to: decision.target,
      message: `${result}: rule=${decision.rule.id} on=${decision.rule.on} action=${decision.rule.action}${detail ? ` — ${detail}` : ''}`,
    });
  } catch { /* ditto */ }
}

/**
 * Run an injected action dep, auditing fired/error. Shared by the deps-backed
 * actions (launch_skill / spawn_runner / relay). When `requireTarget`, an empty
 * rendered target is a hook_error; a missing dep is always a hook_error.
 */
async function runActionDep(
  decision: HookDecision,
  deps: HookDeps,
  fn: ((decision: HookDecision) => Promise<void> | void) | undefined,
  name: string,
  requireTarget: boolean
): Promise<void> {
  if (requireTarget && !decision.target) {
    await auditHook(deps.workspaceRoot, decision, 'hook_error', `${decision.rule.action} action with empty target`);
    return;
  }
  if (!fn) {
    await auditHook(deps.workspaceRoot, decision, 'hook_error', `no ${name} dep wired`);
    return;
  }
  try {
    await fn(decision);
    await auditHook(deps.workspaceRoot, decision, 'hook_fired');
  } catch (e) {
    await auditHook(deps.workspaceRoot, decision, 'hook_error', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Execute one decision. Suppressed decisions are audited and skipped. Fired
 * decisions perform their action via the injected deps; an action whose dep is
 * not wired audits as hook_error (never throws into the watcher).
 */
export async function executeHook(decision: HookDecision, deps: HookDeps): Promise<void> {
  if (decision.outcome !== 'fire') {
    await auditHook(deps.workspaceRoot, decision, 'hook_suppressed');
    return;
  }
  switch (decision.rule.action) {
    case 'dispatch': {
      if (!decision.target) {
        await auditHook(deps.workspaceRoot, decision, 'hook_error', 'dispatch action with empty target');
        return;
      }
      if (!deps.dispatch) {
        await auditHook(deps.workspaceRoot, decision, 'hook_error', 'no dispatch dep wired');
        return;
      }
      try {
        await deps.dispatch(decision.target, decision);
        await auditHook(deps.workspaceRoot, decision, 'hook_fired');
      } catch (e) {
        await auditHook(deps.workspaceRoot, decision, 'hook_error', e instanceof Error ? e.message : String(e));
      }
      return;
    }
    case 'notify': {
      const msg = `AutoClaw hook "${decision.rule.id}": ${decision.rule.on} event${decision.target ? ` → ${decision.target}` : ''}`;
      try { deps.notify?.(msg, decision); } catch { /* notify is best-effort */ }
      await auditHook(deps.workspaceRoot, decision, 'hook_fired');
      return;
    }
    // HKS-4: open a pre-filled skill session (target host optional — defaults to current host).
    case 'launch_skill':
      await runActionDep(decision, deps, deps.launchSkill, 'launchSkill', false);
      return;
    // HKS-4: start a registered runner (target = runner id).
    case 'spawn_runner':
      await runActionDep(decision, deps, deps.spawnRunner, 'spawnRunner', true);
      return;
    // HKS-5: cross-machine wake over the cloud relay (target = machine/agent).
    case 'relay':
      await runActionDep(decision, deps, deps.relay, 'relay', true);
      return;
    default:
      await auditHook(
        deps.workspaceRoot, decision, 'hook_error',
        `unknown action "${String(decision.rule.action)}"`
      );
  }
}

// ---------------------------------------------------------------------------
// Runtime (InboxWatcher → matcher → executor). No vscode imports.
// ---------------------------------------------------------------------------

/**
 * Build a `message` HookEvent from an inbox file. Returns null for unreadable/
 * non-message files. Events from the orchestrator-loop's own dispatch path
 * (task_claim wakes) are tagged via_hook so hooks can't re-trigger on them.
 */
export async function buildHookEventFromMessageFile(filePath: string): Promise<HookEvent | null> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse((await fsPromises.readFile(filePath, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof msg.type !== 'string') { return null; }
  const event: HookEvent = {
    on: 'message',
    payload: {
      type: msg.type,
      from: msg.from,
      to: msg.to ?? path.basename(path.dirname(filePath)),
      task_id: msg.task_id,
      sprint: msg.sprint,
      requires_response: msg.requires_response,
    },
  };
  const payloadViaHook = (msg.payload as Record<string, unknown> | undefined)?.via_hook;
  if (typeof msg.via_hook === 'string') { event.via_hook = msg.via_hook; }
  else if (typeof payloadViaHook === 'string') { event.via_hook = payloadViaHook; }
  else if (msg.from === 'orchestrator-loop' && msg.type === 'task_claim') {
    // Loop/hook-generated wake — never re-triggerable (no self-amplification).
    event.via_hook = 'orchestrator-loop';
  }
  return event;
}

/**
 * Run the matcher + executor for one event (shared by the message watcher, the
 * stall/claim tick, and the in-process bus). Refreshes HALT from disk (override
 * for tests), executes every decision, and logs the outcome. Returns the
 * decisions so callers/tests can assert.
 */
export async function processHookEvent(
  event: HookEvent,
  rules: HookRule[],
  state: HookRuntimeState,
  deps: HookDeps,
  opts: { isHalted?: () => boolean; log?: (line: string) => void; maxFiringsPerHour?: number; now?: number } = {}
): Promise<HookDecision[]> {
  state.halted = (opts.isHalted ?? (() => isFleetHalted(deps.workspaceRoot)))();
  const decisions = matchHooks(rules, event, state, opts.now ?? Date.now(), opts.maxFiringsPerHour);
  for (const d of decisions) {
    await executeHook(d, deps);
    const label = event.payload.type ? `${event.on}:${String(event.payload.type)}` : event.on;
    opts.log?.(`[hooks] ${d.outcome === 'fire' ? 'fired' : d.outcome}: ${d.rule.id} (${label} → ${d.target ?? '-'})`);
  }
  return decisions;
}

/** Read heartbeats + claims and build the tick's stall/claim_stale events. */
async function scanTickEvents(workspaceRoot: string, now: number, thresholdSeconds: number): Promise<HookEvent[]> {
  const commsAbs = path.join(workspaceRoot, COMMS_DIR_REL);
  const readJsonDir = async (sub: string): Promise<Record<string, unknown>[]> => {
    const dir = path.join(commsAbs, sub);
    const out: Record<string, unknown>[] = [];
    let names: string[];
    try { names = await fsPromises.readdir(dir); } catch { return out; }
    for (const n of names) {
      if (!n.endsWith('.json')) { continue; }
      try {
        out.push(JSON.parse((await fsPromises.readFile(path.join(dir, n), 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>);
      } catch { /* skip malformed */ }
    }
    return out;
  };
  const heartbeats = (await readJsonDir('heartbeats')) as Array<{ agent_id?: string; timestamp?: string }>;
  const claims = (await readJsonDir('claims')) as Array<{ task_id?: string; claimed_by?: string; agent_id?: string; claimed_at?: string }>;
  const hbByAgent = new Map<string, string>();
  for (const hb of heartbeats) { if (hb.agent_id && hb.timestamp) { hbByAgent.set(hb.agent_id, hb.timestamp); } }
  return [
    ...buildHeartbeatStallEvents(heartbeats, now, thresholdSeconds),
    ...buildClaimStaleEvents(claims, hbByAgent, now, thresholdSeconds),
  ];
}

export interface TriggerHooksRuntime {
  /** Loaded rule count (0 ⇒ inert; no watcher was started). */
  readonly ruleCount: number;
  stop(): Promise<void>;
}

export const DEFAULT_HOOK_TICK_MS = 60_000;

export interface TriggerHooksRuntimeOptions {
  workspaceRoot: string;
  /** Output line sink (extension output channel). */
  log?: (line: string) => void;
  /** notify-action sink (VS Code toast). */
  notify?: (message: string) => void;
  /** launch_skill action sink (HKS-4) — render + open/copy a skill prompt. */
  launchSkill?: (decision: HookDecision) => Promise<void> | void;
  /** spawn_runner action sink (HKS-4) — start/wake a registered runner. */
  spawnRunner?: (decision: HookDecision) => Promise<void> | void;
  /** relay action sink (HKS-5) — forward a wake to a remote machine's inbox. */
  relay?: (decision: HookDecision) => Promise<void> | void;
  /** Stall/claim scan interval (ms). Default 60s. */
  tickIntervalMs?: number;
  /** heartbeat_stall / claim_stale staleness floor (seconds). Default 600. */
  stallThresholdSeconds?: number;
  /** setInterval override for tests (returns a handle passed to clearTimer). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Start the hooks runtime for a workspace. Zero-config no-op: when hooks.yaml
 * is missing or yields no rules, NO watcher is created and the returned handle
 * is inert. Each incoming inbox message refreshes the HALT state from disk,
 * runs the matcher, and executes decisions; the dispatch action reuses
 * orchestratorLoop.dispatchWork (AF-8 gating + sidecar + shared-inbox wake).
 */
export async function startTriggerHooksRuntime(
  opts: TriggerHooksRuntimeOptions
): Promise<TriggerHooksRuntime> {
  const log = opts.log ?? (() => { /* silent */ });
  const rules = await loadHookRules(opts.workspaceRoot, (w) => log(`[hooks] ${w}`));
  if (rules.length === 0) {
    return { ruleCount: 0, stop: async () => { /* inert */ } };
  }

  const state = freshHookState();
  const deps: HookDeps = {
    workspaceRoot: opts.workspaceRoot,
    notify: (m) => { log(`[hooks] ${m}`); opts.notify?.(m); },
    dispatch: async (target, decision) => {
      // WorkPackage.assignToVendor is a VendorKind union; hook targets are free
      // agent ids. Known vendors pass through; anything else rides as 'other'
      // (dispatchWork's registry lookup + AF-8 gating use the raw id elsewhere).
      const KNOWN_VENDORS: VendorKind[] = ['kilocode', 'claude-code', 'kiro', 'cursor', 'antigravity'];
      const vendor: VendorKind = (KNOWN_VENDORS as string[]).includes(target) ? target as VendorKind : 'other';
      const pkg: WorkPackage = {
        type: 'work_package',
        taskId: `next-${target}`,
        taskName: `Hook wake: ${decision.rule.id}`,
        description: `Auto-dispatched by trigger hook "${decision.rule.id}" on ${decision.rule.on} event. via_hook:${decision.rule.id}`,
        filePaths: [],
        successCriteria: ['Check inbox and begin assigned work', 'task_complete written to shared inbox'],
        sprint: Number(decision.event.payload.sprint ?? 1) || 1,
        assignToVendor: vendor,
        priority: 'low',
        timeBudgetMs: 0,
      };
      const res = await dispatchWork(opts.workspaceRoot, pkg);
      if (res === null) { throw new Error('dispatch gated or halted (see loop journal/audit)'); }
    },
    launchSkill: opts.launchSkill,
    spawnRunner: opts.spawnRunner,
    relay: opts.relay,
  };

  // Serialize all event handling (message / bus / tick) so cooldown + audit
  // state updates stay ordered.
  let busy = Promise.resolve();
  const runOnQueue = (make: () => Promise<unknown>): void => {
    busy = busy.then(make).then(() => undefined)
      .catch((e) => log(`[hooks] handler error: ${e instanceof Error ? e.message : String(e)}`));
  };

  const watcher: InboxWatcher = createInboxWatcher({
    commsDir: path.join(opts.workspaceRoot, COMMS_DIR_REL),
    onFileAdded: (filePath) => {
      runOnQueue(async () => {
        const event = await buildHookEventFromMessageFile(filePath);
        if (!event) { return; }
        await processHookEvent(event, rules, state, deps, { log });
      });
    },
    onFallback: (reason) => log(`[hooks] watcher fell back to polling: ${reason}`),
  });
  await watcher.start();

  // In-process bus: consensus / autobuild_fail events emitted by the bridge and
  // autobuild run through the same serialized queue.
  const unregisterBus = registerHookHandler(opts.workspaceRoot, (event) => {
    runOnQueue(() => processHookEvent(event, rules, state, deps, { log }));
  });

  // Stall/claim tick — only when a rule actually listens for those sources.
  const needsTick = rules.some(r => r.on === 'heartbeat_stall' || r.on === 'claim_stale');
  const tickMs = opts.tickIntervalMs ?? DEFAULT_HOOK_TICK_MS;
  const threshold = opts.stallThresholdSeconds ?? DEFAULT_STALL_THRESHOLD_SECONDS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  let tickHandle: unknown;
  if (needsTick) {
    tickHandle = setTimer(() => {
      runOnQueue(async () => {
        const events = await scanTickEvents(opts.workspaceRoot, Date.now(), threshold);
        for (const ev of events) { await processHookEvent(ev, rules, state, deps, { log }); }
      });
    }, tickMs);
  }

  log(`[hooks] runtime started — ${rules.length} rule(s) active${watcher.isFallback ? ' (polling mode)' : ''}${needsTick ? `; stall tick ${Math.round(tickMs / 1000)}s` : ''}`);

  return {
    ruleCount: rules.length,
    stop: async () => {
      unregisterBus();
      if (tickHandle !== undefined) { clearTimer(tickHandle); }
      await watcher.stop();
    },
  };
}
