/**
 * hookBus.ts — In-process emitter for non-message hook events (HKS-5).
 *
 * The `message` source is file-driven (InboxWatcher). The other sources
 * (`consensus`, `autobuild_fail`) originate inside the extension host — the
 * bridge consensus path and autobuild's run loop. Rather than have those modules
 * hold hook state (and risk an import cycle through triggerHooks), they emit
 * through this tiny leaf bus: the active hooks runtime registers a handler bound
 * to its workspace, and emit sites fire-and-forget. No active runtime ⇒ no-op.
 *
 * Best-effort by contract: a handler that throws never propagates to the emitter
 * (an emit must never break consensus evaluation or an autobuild run).
 */

import type { HookEvent } from './hookEvents';

type HookHandler = (event: HookEvent) => void | Promise<void>;
interface Registration { root: string; handler: HookHandler; }

const registrations = new Set<Registration>();

/**
 * Register a handler for emitted events, bound to `workspaceRoot`. Returns an
 * unregister function (call it on runtime stop).
 */
export function registerHookHandler(workspaceRoot: string, handler: HookHandler): () => void {
  const reg: Registration = { root: workspaceRoot, handler };
  registrations.add(reg);
  return () => { registrations.delete(reg); };
}

/**
 * Emit an event to registered handlers. When `workspaceRoot` is given, only
 * handlers bound to that root receive it (correct for multi-root windows);
 * otherwise every handler does. Always resolves — handler errors are swallowed.
 */
export async function emitHookEvent(event: HookEvent, workspaceRoot?: string): Promise<void> {
  for (const reg of registrations) {
    if (workspaceRoot && reg.root !== workspaceRoot) { continue; }
    try { await reg.handler(event); } catch { /* best-effort: never break the emit site */ }
  }
}

/** Test/diagnostic aid: number of active handler registrations. */
export function activeHookHandlerCount(): number {
  return registrations.size;
}
