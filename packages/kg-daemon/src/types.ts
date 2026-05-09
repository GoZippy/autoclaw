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
  meta?: Record<string, unknown>;
}

export interface Edge {
  from: ThoughtId;
  kind: string; // "mentions" | "supersedes" | "derives_from" | ...
  to: ThoughtId;
  meta?: Record<string, unknown>;
}

export interface SearchOpts {
  k?: number;
  project?: string;
  agent?: string;
  since?: string;       // ISO 8601
  includeText?: boolean;
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
