/**
 * contract.ts — the single, host-free source of truth for what AutoClaw IS and
 * how its on-disk artifacts behave.
 *
 * WHY THIS EXISTS
 * Foreign agents (other IDEs / tools) reverse-engineer AutoClaw from the
 * observable `.autoclaw/` tree. That tree under-describes the *dynamic* behavior
 * — which command writes which store — and it contains opaque binary stores
 * (`kg.db`, `db.sqlite`) whose contents can't be inferred by looking. So agents
 * confabulate. A real-world example: an agent in a consumer workspace wrote a
 * steering file claiming "the `/index` command updates the knowledge graph
 * `kg.db`" — wrong command name, wrong store, wrong semantics. Everything it got
 * RIGHT was self-describing (a JSON board, a markdown insight); everything it got
 * WRONG was non-inferable (command→store mapping, the contents of an opaque db).
 *
 * THE FIX
 * State the non-inferable facts authoritatively, and render them into EVERY
 * surface an agent might read — host-native steering files, a committed
 * `.autoclaw/AGENT-ORIENTATION.md`, and per-store `README.md` stubs that sit at
 * the exact point of confusion. All of those are generated from THIS file so
 * they can never drift from each other or from the code.
 *
 * Pure data + deterministic string renderers. No `vscode`, no `fs`, no clock.
 */

/** Bumped whenever the rendered contract changes; stamped into generated files so staleness is detectable. */
export const CONTRACT_VERSION = '1';

/** One-paragraph "what AutoClaw is" — the identity every agent should start from. */
export const AUTOCLAW_IDENTITY =
  'AutoClaw is a local-first coordination, memory, and learning layer for AI ' +
  'coding agents. It lets multiple agents (across different IDEs/tools) work the ' +
  'same repo without colliding, gives the project institutional memory that ' +
  'survives across sessions, and serves distilled context back to each agent to ' +
  'cut token waste. It operates entirely through files under `.autoclaw/` plus ' +
  'host-native rule/steering files — there is no hidden server you must call.';

// ---------------------------------------------------------------------------
// Command surface — the command→store mapping that is NOT inferable from the tree
// ---------------------------------------------------------------------------

export interface CommandFact {
  /** Exact invocation, e.g. `/index-code`. Use this verbatim — wrong names are the #1 mistake. */
  command: string;
  /** Implemented / Planned. */
  status: 'Implemented' | 'Planned';
  /** What this command WRITES (be exact about the store path). */
  writes: string;
  /** Stores this command is commonly *assumed* to write but does NOT. */
  doesNotWrite?: string;
  /** What it is for. */
  purpose: string;
}

export const COMMANDS: readonly CommandFact[] = [
  {
    command: '/learn',
    status: 'Implemented',
    writes:
      'distilled patterns → `.autoclaw/learnings/insight-<ts>.md`, regenerates ' +
      '`.autoclaw/agent-style.md`, merges `.autoclaw/vector/preferences.json`, records ' +
      'coordination facts → `.autoclaw/kg/kg.db`, appends `.autoclaw/kdream/memory/MEMORY.md`',
    purpose:
      'Distill kept-vs-discarded patterns from past AI sessions (any tool) into durable, reusable guidance.',
  },
  {
    command: '/index-code',
    status: 'Implemented',
    writes: 'the VECTOR store → `.autoclaw/vector/db.sqlite` (+ `last-index.json`, `index-health.json`)',
    doesNotWrite: 'the Knowledge Graph `.autoclaw/kg/kg.db` — `/index-code` never touches the KG',
    purpose: 'Chunk + embed the workspace codebase so `/retrieve` can do semantic code search.',
  },
  {
    command: '/retrieve <query>',
    status: 'Implemented',
    writes: 'nothing (read-only)',
    purpose: 'Return the most relevant code + learning chunks for a query from the vector store.',
  },
  {
    command: '/search <query>',
    status: 'Implemented',
    writes: 'nothing (read-only)',
    purpose: 'Semantic search over distilled learnings.',
  },
  {
    command: '/metrics',
    status: 'Implemented',
    writes: 'nothing (read-only)',
    purpose: 'Show learning-run counts, kept-rate, and token usage from `.autoclaw/metrics/`.',
  },
];

// ---------------------------------------------------------------------------
// On-disk contract — what each store IS, who writes it, and what it is NOT
// ---------------------------------------------------------------------------

export interface StoreFact {
  /** Workspace-relative path (forward slashes). Used as the map key for per-store READMEs. */
  path: string;
  /** Human label. */
  label: string;
  /** What writes/owns it. */
  writtenBy: string;
  /** What it contains. */
  contains: string;
  /** The thing it is most often mistaken FOR (the anti-confabulation line). */
  isNot?: string;
  /** True when the file is generated runtime state (typically gitignored by consumers). */
  gitignored: boolean;
}

export const STORES: readonly StoreFact[] = [
  {
    path: '.autoclaw/agent-style.md',
    label: 'Learned style guide (READ THIS FIRST)',
    writtenBy: '`/learn` (regenerated each run)',
    contains: 'Successful patterns, patterns to avoid, and preferred tools distilled from past sessions.',
    gitignored: false,
  },
  {
    path: '.autoclaw/vector/db.sqlite',
    label: 'Vector store',
    writtenBy: '`/index-code` (code chunks) and `/learn` (learning embeddings)',
    contains: 'Embeddings of code + learnings for semantic retrieval (`/retrieve`, `/search`).',
    isNot: 'NOT a knowledge graph — it holds vectors, not nodes/edges.',
    gitignored: true,
  },
  {
    path: '.autoclaw/kg/kg.db',
    label: 'Knowledge Graph',
    writtenBy: '`/learn` (coordination outcomes) and the orchestrator',
    contains:
      'Multi-agent COORDINATION facts as nodes/edges: consensus verdicts, review findings, and related decisions.',
    isNot:
      'NOT a code-symbol / dependency / cross-reference graph, and `/index-code` does NOT write here. ' +
      'For code relationships use vector retrieval (`/retrieve`).',
    gitignored: true,
  },
  {
    path: '.autoclaw/learnings/',
    label: 'Session insights',
    writtenBy: '`/learn`',
    contains: 'Timestamped `insight-<ts>.md` files: sessions analyzed, patterns discovered, reflection.',
    gitignored: false,
  },
  {
    path: '.autoclaw/metrics/',
    label: 'Metrics',
    writtenBy: '`/learn` and the dashboard',
    contains: '`token-metrics.json` (usage, kept-rate) and `effectiveness.json` (tool×project effectiveness).',
    gitignored: false,
  },
  {
    path: '.autoclaw/orchestrator/board.json',
    label: 'Agendaboard (machine-readable; `board.md` is the human view)',
    writtenBy: 'the orchestrator',
    contains: 'Active tasks, assignments, and sprint status. Read this to know what to work on.',
    gitignored: false,
  },
  {
    path: '.autoclaw/orchestrator/comms/inboxes/',
    label: 'Mailboxes',
    writtenBy: 'every agent',
    contains:
      'Per-agent inbox `inboxes/<agent>/` plus broadcast `inboxes/shared/`. Check at task start and after finishing.',
    gitignored: false,
  },
  {
    path: '.autoclaw/orchestrator/comms/consensus/',
    label: 'Consensus',
    writtenBy: 'every agent',
    contains: 'Votes under `active/`, decided proposals under `resolved/`. 2/3 to approve; unanimous for security.',
    gitignored: false,
  },
  {
    path: '.autoclaw/orchestrator/config.yaml',
    label: 'Orchestrator config',
    writtenBy: '`/orchestrate`',
    contains: 'Global settings: agents, git, planning, quality gates, review, scope, logging.',
    gitignored: false,
  },
  {
    path: '.autoclaw/kdream/memory/MEMORY.md',
    label: 'KDream persistent memory',
    writtenBy: 'KDream + `/learn` (appended only)',
    contains: 'Long-lived project memory. APPEND only — never overwrite this file.',
    gitignored: false,
  },
];

// ---------------------------------------------------------------------------
// Common mistakes — the exact confabulations to pre-empt (drawn from real cases)
// ---------------------------------------------------------------------------

export interface PitfallFact {
  mistake: string;
  reality: string;
}

export const COMMON_MISTAKES: readonly PitfallFact[] = [
  {
    mistake: 'The indexing command is `/index`.',
    reality: 'It is `/index-code`. Use the exact name — `/index` does not exist.',
  },
  {
    mistake: '`/index-code` (or `/index`) updates the knowledge graph `kg.db`.',
    reality:
      '`/index-code` writes ONLY the vector store `.autoclaw/vector/db.sqlite`. The KG (`.autoclaw/kg/kg.db`) ' +
      'is written by `/learn` and the orchestrator, and it holds coordination facts, not code.',
  },
  {
    mistake: 'The knowledge graph stores code symbols, dependencies, or cross-references.',
    reality:
      'It stores multi-agent coordination outcomes (consensus verdicts, review findings). ' +
      'For code relationships, use vector retrieval (`/retrieve`).',
  },
  {
    mistake: 'Hand-writing your own AutoClaw steering file keeps you current.',
    reality:
      'AutoClaw generates and refreshes its own files (`.autoclaw/agent-style.md`, `.autoclaw/AGENT-ORIENTATION.md`, ' +
      'and host-native steering). Read those — a hand-authored copy is a snapshot that drifts.',
  },
  {
    mistake: 'A coordination message only needs `from`, `to`, and `type`.',
    reality:
      'Every message MUST carry a unique `id` and your `session_id` (plus `timestamp`). The `session_id` is how two ' +
      'concurrent windows of the same agent are told apart and how idempotency works.',
  },
];

// ---------------------------------------------------------------------------
// Renderers (deterministic) — every agent-facing surface is built from these
// ---------------------------------------------------------------------------

/** Markdown table of the command→store mapping. */
export function renderCommandTable(): string {
  const rows = COMMANDS.map((c) => {
    const writes = c.doesNotWrite ? `${c.writes}. **Does NOT write:** ${c.doesNotWrite}` : c.writes;
    return `| \`${c.command}\` | ${c.status} | ${writes} | ${c.purpose} |`;
  });
  return ['| Command | Status | Writes | Purpose |', '|---|---|---|---|', ...rows].join('\n');
}

/** Markdown table of the on-disk contract. */
export function renderStoreTable(): string {
  const rows = STORES.map((s) => {
    const contains = s.isNot ? `${s.contains} **${s.isNot}**` : s.contains;
    return `| \`${s.path}\` | ${s.label} | ${s.writtenBy} | ${contains} |`;
  });
  return ['| Path | What | Written by | Contains |', '|---|---|---|---|', ...rows].join('\n');
}

/** Markdown list of the common mistakes → corrections. */
export function renderMistakes(): string {
  return COMMON_MISTAKES.map((m) => `- ❌ ${m.mistake}\n  - ✅ ${m.reality}`).join('\n');
}

export interface OrientationOptions {
  /** Project name to title the doc. */
  projectName?: string;
  /** ISO timestamp stamped by the caller (kept out of the pure renderer for determinism). */
  generatedAt?: string;
}

/**
 * The full, host-neutral orientation document body (no host frontmatter). This is
 * the canonical text written to `.autoclaw/AGENT-ORIENTATION.md` and wrapped per
 * host for steering files.
 */
export function renderOrientationMarkdown(opts: OrientationOptions = {}): string {
  const title = opts.projectName
    ? `# Working in an AutoClaw project — ${opts.projectName}`
    : '# Working in an AutoClaw project';
  const stamp =
    `> Auto-generated by AutoClaw (contract v${CONTRACT_VERSION}). This is the authoritative description of ` +
    `AutoClaw in this repo — do not hand-author your own; it regenerates and would overwrite a manual copy.` +
    (opts.generatedAt ? `\n> Generated: ${opts.generatedAt}` : '');

  return [
    title,
    '',
    stamp,
    '',
    '## What AutoClaw is',
    '',
    AUTOCLAW_IDENTITY,
    '',
    '**You are not stateless and you are not alone.** Other agents may be working this repo in parallel; ' +
      'what you learn persists for future sessions, and what they learn is available to you.',
    '',
    '## Before you start work',
    '',
    '1. Read `.autoclaw/agent-style.md` — distilled successful patterns, patterns to avoid, and preferred tools.',
    '2. Read `.autoclaw/orchestrator/board.json` (or `board.md`) — active tasks, assignments, sprint status.',
    '3. Check your mailbox: `.autoclaw/orchestrator/comms/inboxes/<your-agent-id>/` and `.../inboxes/shared/`.',
    '4. Stay inside your assigned scope; coordinate cross-scope changes by message before editing.',
    '',
    '## Commands (and exactly what each one writes)',
    '',
    renderCommandTable(),
    '',
    '## On-disk contract (`.autoclaw/`)',
    '',
    renderStoreTable(),
    '',
    '## Common mistakes to avoid',
    '',
    renderMistakes(),
    '',
    '## Coordination',
    '',
    'Full protocol: `docs/AGENT_SESSION_PROTOCOL.md` (authoritative) and the cross-agent rules file your host ' +
      'auto-loads. Every message you write needs a unique `id`, your `session_id`, a `timestamp`, `from`, `to`, ' +
      'and `type`. On task completion: broadcast `task_complete` to `inboxes/shared/`, then send `review_request` ' +
      'to the other assigned agents. Vote on open items in `consensus/active/`.',
    '',
  ].join('\n');
}

/**
 * A compact block injected into the always-emitted cross-agent rules file, so the
 * one file guaranteed to reach a host carries the identity + command→store
 * contract, not just the comms protocol.
 */
export function renderOrientationBlock(): string {
  return [
    '## About AutoClaw (orientation)',
    '',
    AUTOCLAW_IDENTITY,
    '',
    'Commands and exactly what they write:',
    '',
    renderCommandTable(),
    '',
    'Do not confuse the stores:',
    '',
    renderMistakes(),
    '',
    'Full contract: `.autoclaw/AGENT-ORIENTATION.md`. Do not hand-author your own AutoClaw steering — read the ' +
      'generated files; they refresh and a manual copy drifts.',
  ].join('\n');
}

/**
 * Body of a per-store `README.md` that sits next to an opaque store (e.g. inside
 * `.autoclaw/kg/`), so an agent browsing the tree finds the truth at the exact
 * point of confusion. Returns null when no store with that key exists.
 */
export function renderStoreReadme(storePath: string): string | null {
  const store = STORES.find((s) => s.path === storePath || s.path.startsWith(storePath.replace(/\/$/, '') + '/'));
  if (!store) {
    return null;
  }
  const lines = [
    `# \`${store.path}\` — ${store.label}`,
    '',
    `> Auto-generated by AutoClaw (contract v${CONTRACT_VERSION}).`,
    '',
    `**Written by:** ${store.writtenBy}`,
    '',
    `**Contains:** ${store.contains}`,
  ];
  if (store.isNot) {
    lines.push('', `**What it is NOT:** ${store.isNot}`);
  }
  lines.push('', 'See `.autoclaw/AGENT-ORIENTATION.md` for the full command + store contract.', '');
  return lines.join('\n');
}
