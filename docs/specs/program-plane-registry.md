# AutoClaw Program-Plane Registry (Phase 4 — pull-forward candidate)

> Status: **Proposal**, 2026-05-09. Phase 4 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap, with
> a defined pull-forward path to Phase 1.
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [nats-topic-conventions.md](./nats-topic-conventions.md),
> [biscuit-token-attenuation.md](./biscuit-token-attenuation.md),
> [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).

## 1. The need (one paragraph)

Today AutoClaw's `.autoclaw/orchestrator/` lives inside a single workspace.
A user with three repos open (e.g. `autoclaw`, `ZippyPanel`, `ZippyVoice`)
runs three independent orchestrators that cannot see each other. Kiro flags
this in [COORDINATION_IMPROVEMENTS.md §2.9](../COORDINATION_IMPROVEMENTS.md):
"An agent working autoclaw has no visibility into the ZippyPanel sprint."
The Distributed Agent Fabric synthesis carries this forward as **Phase 4**
([DISTRIBUTED_AGENT_FABRIC.md §3](../DISTRIBUTED_AGENT_FABRIC.md)). This
spec defines the **program plane** — a directory tier above any single
repo's orchestrator that stitches them together.

## 2. Schema for `program/registry.json`

The program-plane state lives at a user-chosen root, conventionally
`~/.autoclaw/programs/<program_id>/`. Inside it, `registry.json`:

```json
{
  "schema_version": "1.0",
  "program_id": "prog_2026-05-09_eric-zippy",
  "program_name": "Eric's Zippy stack",
  "created_at": "2026-05-09T18:00:00Z",
  "updated_at": "2026-05-09T18:32:00Z",
  "bus_driver": "fs",
  "kg_daemon_url": "http://127.0.0.1:21128",
  "participants": [
    {
      "repo_path": "K:\\Projects\\autoclaw",
      "role": "orchestrator",
      "linked_at": "2026-05-09T18:00:00Z",
      "last_seen": "2026-05-09T18:32:00Z"
    },
    {
      "repo_path": "K:\\Projects\\ZippyPanel",
      "role": "orchestrator",
      "linked_at": "2026-05-09T18:05:00Z",
      "last_seen": "2026-05-09T18:31:55Z"
    },
    {
      "repo_path": "K:\\Projects\\ZippyVoice",
      "role": "observer",
      "linked_at": "2026-05-09T18:10:00Z",
      "last_seen": "2026-05-09T18:30:42Z"
    }
  ],
  "notes": "Cross-repo program for the Zippy product surface."
}
```

Field semantics:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | yes | Pinned `"1.0"` for Phase 4. |
| `program_id` | string | yes | Stable opaque identifier; UUID-ish. |
| `program_name` | string | yes | Human-readable; rendered in the panel header. |
| `created_at` | ISO-8601 | yes | Set on creation; never mutated. |
| `updated_at` | ISO-8601 | yes | Bumped on any mutation. |
| `bus_driver` | `"fs" \| "ws" \| "nats"` | yes | Mirrors workspace setting; informs program-level fan-in. |
| `kg_daemon_url` | string (URI) | optional | Knowledge-graph daemon address. Localhost by default. |
| `participants[]` | object[] | yes | One entry per linked workspace. |
| `participants[].repo_path` | absolute string | yes | Filesystem absolute path; uniqueness key. |
| `participants[].role` | `"orchestrator" \| "observer"` | yes | Orchestrators receive task assignments; observers only watch. |
| `participants[].linked_at` | ISO-8601 | yes | When the user added the workspace. |
| `participants[].last_seen` | ISO-8601 | yes | Updated by the program-plane daemon's tail process. |
| `notes` | string | optional | Free text. |

## 3. Discovery — how a participant learns about the program

Two options were considered. We chose option (a).

### 3.a Explicit add via Command Palette (chosen)

User flow:

1. Open the workspace that should join (e.g. `ZippyPanel`).
2. Run **AutoClaw: Join Program…** from the Command Palette.
3. The extension shows a picker of `~/.autoclaw/programs/*/registry.json`
   files (one per program).
4. User picks the program. Extension writes a backref:
   `<repo>/.autoclaw/program-link.json`:
   ```json
   { "program_id": "prog_2026-05-09_eric-zippy",
     "registry_path": "C:\\Users\\eric\\.autoclaw\\programs\\prog_2026-05-09_eric-zippy" }
   ```
5. Extension appends the workspace to `program/registry.json`'s
   `participants[]` (atomic write with file lock).

Rationale: explicit consent matches AutoClaw's local-first promise. Nothing
crosses workspace boundaries unless the user takes an action.

### 3.b Zeroconf via mDNS (rejected)

Auto-discovery on the LAN was tempting but rejected for three reasons:

1. **Multicast permissions.** mDNS requires firewall rules / privileged
   sockets that fail silently on locked-down corporate machines.
2. **Trust model.** A program-plane join silently widens a workspace's
   visibility to peer repos. This must be a deliberate user act.
3. **Cross-platform fragility.** macOS / Windows / Linux all ship distinct
   mDNS stacks; debugging cross-platform timeouts is rabbit-hole work
   AutoClaw should not own.

The same logic applies to UPnP / SSDP variants. **No multicast**.

## 4. Comms-log fan-in

Each participating repo continues to write
`<repo>/.autoclaw/orchestrator/comms-log.jsonl` as today. The program-plane
daemon (`autoclaw-program-daemon`, optional companion process) tails every
participant's log and merges into:

```
<program_root>/comms-log.jsonl
```

Merge rules:

- Each line is a JSONL entry from a participant; **prepend** a `_repo`
  field (`{ "_repo": "K:\\Projects\\autoclaw", ...originalEntry }`).
- Order is best-effort timestamp ordering; ties broken by `_repo` lexicographic.
- The daemon is restartable — it tracks per-repo file offsets in
  `<program_root>/.fan-in-state.json` so a crash mid-tail doesn't dupe.
- If a repo's drive is unmounted, the daemon retries every 60 s and marks
  the participant `unreachable` (see §7).

When `bus_driver` is `nats`, a parallel program-plane subject prefix is
introduced: `acp.<program_id>.>` mirrors `ac.>` from each participant.
**This keeps program traffic separate from per-repo traffic** so an
observer can subscribe to one without the other. Detail in
[nats-topic-conventions.md](./nats-topic-conventions.md) — §2 wildcards.

## 5. Panel UX

One Agents table across all repos. Columns:

| Column | Source |
|---|---|
| `agent_id` | Agent Card |
| `repo` | participant the heartbeat came from |
| `status` | from heartbeat (`active` / `idle` / `stalled` / `unreachable`) |
| `current task` | session heartbeat |
| `llm` | Agent Card / heartbeat |
| `last seen` | merged comms-log |

Per-repo orchestrator state stays in each repo's `.autoclaw/`. The program
panel never modifies a participant's sprint YAMLs — it only reads them
through the fan-in stream. Sprint editing remains a per-repo action.

A sticky header shows the program name and per-repo health dots
(green/amber/red). Clicking a dot opens that repo's standalone panel.

## 6. Identity — globally unique agent IDs

Agent IDs must be unique across the whole program. We adopt:

```
<machine_id>::<platform>::<window_id>
```

Examples:

```
a3f9c1b87d24::claude-code::win3
a3f9c1b87d24::kilocode::win1
b2841a07e9e5::cursor::win2     # different machine
```

This matches the Agent Card schema's `x-autoclaw.machine_id`
([agent-card-schema.md §2](./agent-card-schema.md)) plus the IDE platform
key plus a per-window discriminator. Two laptops with the same hostname
but different installs derive different `machine_id` values (the hash
includes `install_uuid`), so collisions across the program are
cryptographically improbable.

Identity tokens (Biscuits) issued at the program plane carry an extra
fact:

```
program("prog_2026-05-09_eric-zippy")
```

so a verifier can refuse a token from another program even if the
underlying agent_id collides. See
[biscuit-token-attenuation.md §2](./biscuit-token-attenuation.md).

## 7. Failure mode — participant disappears

Trigger: participant repo's filesystem path is unreachable for ≥ 90 s
(drive unmounted, repo deleted, network share dropped).

Daemon behaviour:

1. Mark participant `last_seen` as the last successful read.
2. Set `status: "unreachable"` in an in-memory program-plane status map
   (not persisted into `registry.json` — that file is config, not status).
3. Lock new task assignments to that repo: the program-plane router refuses
   to dispatch any task with `target_repo == <unreachable>` until the
   participant comes back. Existing in-flight tasks are not auto-cancelled
   (their orchestrator might come back and resume); they are flagged
   `at-risk` in the panel.
4. Banner appears: *"K:\\Projects\\ZippyPanel unreachable since 18:30Z —
   no new work routed there."*
5. On recovery, fan-in resumes from the saved offset; existing tasks
   re-evaluate health on next heartbeat.

If a participant has been `unreachable` for > 7 days, the panel surfaces
a **Remove from program** action (does not delete files; only edits the
registry). Removal is reversible by re-running **Join Program**.

## 8. Pull-forward decision matrix

The program plane lives in Phase 4 because Phase 0/1 must stabilize the
single-repo case first. But it is the most "user wants this now" item we
have, and the synthesis flagged it as a candidate
([DISTRIBUTED_AGENT_FABRIC.md §6 q5](../DISTRIBUTED_AGENT_FABRIC.md)).

Pull this spec forward into Phase 1 when **any one** of these triggers fires:

| Trigger | Measurement | Why it warrants pulling forward |
|---|---|---|
| **Active multi-repo orchestration ≥ 2 repos within 7 days** | Count distinct workspaces with `/.autoclaw/orchestrator/` modified in the trailing week. ≥ 2 → fire. | The user is already paying the manual context-switching cost; the program plane removes it. |
| **Cross-repo subcontract requested** | A subcontract message body lists files outside the sender's workspace. | The protocol assumes program scope; without it, the subcontract has no addressable target. |
| **Two agents on different repos write conflicting changes to a shared dependency** | Git push hook in either repo detects edits to a co-owned package; comms-log lacks any cross-repo coordination message. | The cost of *not* having program scope is now measurable as a real conflict. |

If two triggers fire simultaneously, the spec is auto-promoted to Phase 1
priority and program-scope ships with the next minor release. **One** trigger
warrants reopening the discussion with the user; two warrant pulling forward
without further consultation (the data has already shown the cost is real).

Conversely, do **not** pull forward when:

- Only one repo is active in any given week.
- The user has explicitly stated single-repo focus (per IDEAS_LOG.md §B,
  default 3: program-scope stays in Phase 4).

## 9. Migration plan

Adding program scope is additive; no per-repo state changes:

1. Phase 4 ships `~/.autoclaw/programs/` directory + Command Palette
   actions.
2. Existing repos work unchanged. Joining a program writes
   `program-link.json` but does not modify any orchestrator file.
3. Removing a workspace from a program also leaves orchestrator state
   intact; only `program-link.json` is deleted.
4. The fan-in daemon is a separate optional process (mirrors the
   kg-daemon shape from [DISTRIBUTED_AGENT_FABRIC.md §3 / Phase 3](../DISTRIBUTED_AGENT_FABRIC.md)).

## 10. Cross-references

- Master synthesis:
  [../DISTRIBUTED_AGENT_FABRIC.md §3 / Phase 4](../DISTRIBUTED_AGENT_FABRIC.md).
- Original gap report:
  [../COORDINATION_IMPROVEMENTS.md §2.9](../COORDINATION_IMPROVEMENTS.md).
- Agent identity used in §6:
  [agent-card-schema.md §2](./agent-card-schema.md).
- Bus subject prefixes for program plane:
  [nats-topic-conventions.md §4](./nats-topic-conventions.md).
- Token `program` fact:
  [biscuit-token-attenuation.md §2](./biscuit-token-attenuation.md).
- Mapping table entry for §2.9:
  [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).
