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

// Re-export the kill-switch surface so consumers can import everything
// hook-related from one module.
export { HALT_FILE_REL, isFleetHalted, setFleetHalted } from './fleetHalt';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookOn = 'message' | 'heartbeat_stall' | 'claim_stale' | 'consensus' | 'autobuild_fail';
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
  /** Per-rule re-fire floor. Default 300s. */
  cooldown_seconds?: number;
}

export interface HookEvent {
  on: HookOn;
  payload: Record<string, unknown>;
  /**
   * Set when the event was produced by a hook/loop action. Tagged events never
   * match any rule — a hook cannot trigger a hook (spec: no self-amplification).
   */
  via_hook?: string;
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
 * Execute one decision. Suppressed decisions are audited and skipped. Fired
 * decisions perform their action via the injected deps; unimplemented actions
 * (launch_skill / spawn_runner / relay — HKS-4/5) audit as hook_error.
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
    default:
      await auditHook(
        deps.workspaceRoot, decision, 'hook_error',
        `action "${decision.rule.action}" not implemented yet (HKS-4/5)`
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

export interface TriggerHooksRuntime {
  /** Loaded rule count (0 ⇒ inert; no watcher was started). */
  readonly ruleCount: number;
  stop(): Promise<void>;
}

export interface TriggerHooksRuntimeOptions {
  workspaceRoot: string;
  /** Output line sink (extension output channel). */
  log?: (line: string) => void;
  /** notify-action sink (VS Code toast). */
  notify?: (message: string) => void;
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
  };

  let busy = Promise.resolve();
  const watcher: InboxWatcher = createInboxWatcher({
    commsDir: path.join(opts.workspaceRoot, COMMS_DIR_REL),
    onFileAdded: (filePath) => {
      // Serialize handling so audit/cooldown state updates stay ordered.
      busy = busy.then(async () => {
        const event = await buildHookEventFromMessageFile(filePath);
        if (!event) { return; }
        state.halted = isFleetHalted(opts.workspaceRoot);
        const decisions = matchHooks(rules, event, state);
        for (const d of decisions) {
          await executeHook(d, deps);
          log(`[hooks] ${d.outcome === 'fire' ? 'fired' : d.outcome}: ${d.rule.id} (${event.payload.type} → ${d.target ?? '-'})`);
        }
      }).catch((e) => log(`[hooks] handler error: ${e instanceof Error ? e.message : String(e)}`));
    },
    onFallback: (reason) => log(`[hooks] watcher fell back to polling: ${reason}`),
  });
  await watcher.start();
  log(`[hooks] runtime started — ${rules.length} rule(s) active${watcher.isFallback ? ' (polling mode)' : ''}`);

  return {
    ruleCount: rules.length,
    stop: async () => { await watcher.stop(); },
  };
}
