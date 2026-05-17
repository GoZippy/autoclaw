/**
 * Public types for the AutoClaw Knowledge Graph daemon.
 *
 * Mirrors the contract from `docs/DISTRIBUTED_AGENT_FABRIC.md` §2.4
 * and the synthesis in `docs/research/knowledge-graph-stack.md` §6.
 * Tier 1 (this package) and Tier 2 (KuzuDB swap-in) share this shape.
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
  /** Bi-temporal validity window (Graphiti Phase 4). When omitted, valid from created_at onwards. */
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
 * Multi-strategy recall mode (Hindsight-inspired — §4 cross-pollination).
 * "multi" runs vec + fts + graph in parallel and merges by score.
 * "vec" and "fts" use only the named strategy.
 * Defaults to "multi" when the field is omitted.
 */
export type SearchStrategy = "multi" | "vec" | "fts";

export interface SearchOpts {
  k?: number;
  project?: string;
  agent?: string;
  since?: string;       // ISO 8601
  /** Time-travel query: only return thoughts that were valid at this ISO instant. */
  at?: string;          // ISO 8601 — bi-temporal validity filter
  includeText?: boolean;
  /** Retrieval strategy. Defaults to "multi" (parallel vec+fts merge). */
  strategy?: SearchStrategy;
  /** Seed thought ID for graph-traversal arm of multi-strategy recall. */
  graph_seed?: string;
  /** Edge kinds to follow during graph traversal arm. */
  graph_edge_kinds?: string[];
  /** Graph traversal depth (max 8). Defaults to 2. */
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

  export(opts?: {
    project?: string;
    format?: "jsonl" | "md";
  }): AsyncIterable<string>;
}

export interface Capabilities {
  sqlite: boolean;
  vec: boolean;
  fts: boolean;
}

export interface KGErrorBody {
  error: { code: number; message: string };
}
