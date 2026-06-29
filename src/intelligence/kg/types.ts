/**
 * kg/types.ts — public contract for the in-process AutoClaw Knowledge Graph.
 *
 * Ported verbatim (shape-compatible) from `packages/kg-daemon/src/types.ts`
 * so the standalone daemon and this in-process store speak the same language.
 * The KG was historically a spawned Node process on `better-sqlite3`; this
 * module backs the same contract with the Intelligence Layer's ABI-proof
 * `node:sqlite` driver and embedding provider, in-process — no child process,
 * no native addon, nothing excluded from the `.vsix`.
 *
 * See `docs/ideas/KG-INTELLIGENCE-CONVERGENCE.md`.
 */

export type AgentId = string;
export type ProjectId = string;
export type ThoughtId = string;

export type ThoughtKind =
  | "thought"
  | "finding"
  | "observation"
  | "decision"
  | "question"
  | "answer"
  | string;

export interface Thought {
  id: ThoughtId;
  project: ProjectId;
  agent: AgentId;
  sprint?: string;
  task_id?: string;
  kind: ThoughtKind;
  text: string;
  embedding?: number[];
  created_at: string; // ISO 8601
  /** Bi-temporal validity window. When omitted, valid from created_at onwards. */
  valid_from?: string;
  /** When the assertion was retracted/superseded. Null = still valid. */
  valid_to?: string;
  meta?: Record<string, unknown>;
}

export interface Edge {
  from: ThoughtId;
  kind: string; // "mentions" | "supersedes" | "derives_from" | ...
  to: ThoughtId;
  meta?: Record<string, unknown>;
}

/**
 * Multi-strategy recall mode. "multi" runs vec + fts (+ optional graph) in
 * parallel and merges by rank. "vec"/"fts" use only the named strategy.
 * Defaults to "multi" when omitted.
 */
export type SearchStrategy = "multi" | "vec" | "fts";

export interface SearchOpts {
  k?: number;
  project?: string;
  agent?: string;
  since?: string;       // ISO 8601
  /** Time-travel query: only return thoughts valid at this ISO instant. */
  at?: string;          // ISO 8601 — bi-temporal validity filter
  includeText?: boolean;
  strategy?: SearchStrategy;
  graph_seed?: string;
  graph_edge_kinds?: string[];
  graph_depth?: number;
}

export interface KnowledgeGraph {
  recordThought(t: Omit<Thought, "id" | "created_at"> & {
    id?: string;
    created_at?: string;
  }): Promise<ThoughtId>;

  recordRelation(
    from: string,
    kind: string,
    to: string,
    meta?: Record<string, unknown>,
  ): Promise<void>;

  searchSimilar(text: string, opts?: SearchOpts): Promise<Thought[]>;

  traverseFrom(
    seed: string,
    edgeKinds: string[],
    depth?: number,
  ): Promise<Thought[]>;

  forAgent(agent: string, opts?: { since?: string }): Promise<Thought[]>;
  forProject(project: string, opts?: { since?: string }): Promise<Thought[]>;
  since(iso: string): Promise<Thought[]>;

  /** All thoughts, newest first — for the viewer/visualizer. Bounded by `limit` (default 2000). */
  allThoughts(opts?: { limit?: number }): Promise<Thought[]>;
  /** All stored relations/edges — for the viewer/visualizer. Bounded by `limit` (default 5000). */
  listEdges(opts?: { limit?: number }): Promise<Edge[]>;

  export(opts?: {
    project?: string;
    format?: "jsonl" | "md";
  }): AsyncIterable<string>;
}

/** Backend capabilities, surfaced through `/api/v1/kg/health` + the panel. */
export interface KgCapabilities {
  sqlite: boolean;
  vec: boolean;
  fts: boolean;
}

export interface KGErrorBody {
  error: { code: number; message: string };
}
