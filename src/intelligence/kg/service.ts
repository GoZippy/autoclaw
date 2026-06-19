/**
 * kg/service.ts — process-level accessor for the in-process Knowledge Graph.
 *
 * The KG is consumed by three independent surfaces (bridge HTTP routes, MCP
 * tools, panel/doctor health) that may live in different processes (the MCP
 * server runs as its own stdio process). This module gives each PROCESS one
 * lazily-opened, cached {@link KgHandle} keyed by db path. Multiple processes
 * opening the same `.autoclaw/kg/kg.db` is safe: SQLite WAL supports concurrent
 * readers + serialized writers, and KG writes are infrequent.
 *
 * `getKnowledgeGraph` never throws — on driver failure it returns the degraded
 * handle from {@link openKnowledgeGraph}. Call `closeKnowledgeGraph` on
 * extension deactivation.
 */

import { openKnowledgeGraph, type KgHandle, type OpenKgOptions } from "./index";

let cached: KgHandle | null = null;
let cachedKey = "";

function keyOf(opts: OpenKgOptions): string {
  return opts.dbPath ?? opts.workspaceRoot ?? process.cwd();
}

/**
 * Return this process's shared KG handle, opening it on first use. Re-opens if
 * called with a different db path / workspace (the previous handle is closed).
 */
export function getKnowledgeGraph(opts: OpenKgOptions = {}): KgHandle {
  const key = keyOf(opts);
  if (cached && cachedKey === key) return cached;
  if (cached) {
    try { cached.close(); } catch { /* ignore */ }
  }
  cached = openKnowledgeGraph(opts);
  cachedKey = key;
  return cached;
}

/** Close + clear the cached handle (extension deactivation / tests). */
export function closeKnowledgeGraph(): void {
  if (cached) {
    try { cached.close(); } catch { /* ignore */ }
  }
  cached = null;
  cachedKey = "";
}

/** Test-only: current handle without opening one. */
export function peekKnowledgeGraph(): KgHandle | null {
  return cached;
}
