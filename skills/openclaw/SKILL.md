---
name: openclaw
description: Onboards the OpenClaw platform as a typed fabric worker (agent_type coder) and directs repo work to it through the runner-openclaw adapter. OpenClaw is a hybrid host — REST endpoint when OPENCLAW_ENDPOINT is set, otherwise the openclaw CLI — that runs coding tasks under its own trust levels (gated/supervised/unattended) and mints its own job IDs, which the adapter maps back to AutoClaw task IDs. Triggered when the orchestrator routes a coder-typed task to the openclaw runner. Local-first; no direct LLM calls — OpenClaw is the agent host.
trigger: /persona openclaw, "dispatch to openclaw", "openclaw job", runner routing to `openclaw`
tools:
  - read
  - grep
  - glob
  - write_in_claimed_scope
trust: auto
preferred_provider: "openclaw-runner"
provider_fallback: "claude-code-runner"
---

# OpenClaw — Platform Worker (agent_type: coder)

## Mission
Let the fabric hand a scoped coding task to an OpenClaw host and get a
reviewable result back. OpenClaw edits a repo under a task + scope + verify
command, so it registers as `agent_type: coder` — default trust `auto`,
majority consensus on its output, no human-in-loop gate. AutoClaw never calls
an LLM here; OpenClaw is the agent host and this skill only describes how work
goes in and results come out.

## When invoked
1. **By the orchestrator**: a sprint task is routed to the `openclaw` runner
   (capability match on `code`/`edit`/`test`, or an explicit
   `preferred_provider: openclaw-runner` on the task).
2. **By the user**: "dispatch this to openclaw" / a fleet command that targets
   the OpenClaw host.
3. **On registration**: when the fabric onboards an OpenClaw host as a typed
   worker, this pack is its profile.

## How work is dispatched and returned
- **Detection** — REST first: if `OPENCLAW_ENDPOINT` is set, `GET /health`
  (Bearer `OPENCLAW_TOKEN` if present). If the endpoint is unset or
  unreachable, fall back to probing the `openclaw` CLI on PATH
  (`openclaw --version`).
- **REST mode** — `POST /jobs` with `{ prompt, trust, working_dir,
  autoclaw_task_id, agent_profile, trust_allow_list, trust_deny_list,
  require_mcp, env }`, then poll `GET /jobs/{id}` every 2 s until a terminal
  state (ceiling: 2× the task timeout, default 10 min).
- **CLI mode** — write a job manifest to a temp file and run
  `openclaw submit --manifest <file> --trust <level>`; the result is the
  process exit code plus the stdout tail.
- **Trust translation** — AutoClaw presets map 1:1 onto OpenClaw levels:
  `off → gated`, `auto → supervised`, `turbo → unattended`.
- **ID mapping** — OpenClaw mints its own job IDs; the adapter keeps a
  bidirectional map (AutoClaw task id ↔ OpenClaw job id) so resume/cancel work
  by either key.

## Inputs you must load
- The task brief: prompt, working dir, scope, verify command, trust preset.
- `OPENCLAW_ENDPOINT` / `OPENCLAW_TOKEN` (REST) or the `openclaw` binary
  (CLI) — whichever surface `detect()` finds.
- The type profile for `coder` in
  [src/fabric/agentTypes.ts](../../src/fabric/agentTypes.ts) (trust, consensus,
  capability tags).

## Outputs you produce
- A normalized `DispatchResult`: ok/exit code, duration, stdout tail, and a
  classed error (`auth`, `timeout`, `tool_denied`, `mcp_startup`, `internal`)
  on failure.
- A `task_complete` + `review_request` into the comms tree, like any other
  coder — OpenClaw output is reviewed by **majority** consensus.

## Boundaries (never violate)
1. **Coder scope rules apply.** OpenClaw edits only inside the claimed task
   scope; cross-scope changes are a `question` to the scope owner, not an edit.
2. **No direct LLM calls from the adapter.** OpenClaw hosts its own agents;
   AutoClaw submits jobs and reads results.
3. **Token only in the Authorization header.** `OPENCLAW_TOKEN` never goes in
   a URL, a manifest file, a log line, or a report.
4. **Majority review is not skippable.** A coder-typed result merges only
   after the normal review gate.

## Known runner caveats (be honest about these)
- The task↔job ID map is **in-memory only** — it does not survive an
  extension-host restart, so resume-by-job-id is best-effort across restarts.
- In CLI mode, `cancel()` is a no-op (the orchestrator times the job out) and
  `listSessions()` only reports locally-mapped tasks.
- CLI mode recovers the minted job id by regex (`job: <id>`) from a
  tail-truncated stdout buffer — a chatty job can push the id line out of the
  buffer, leaving the mapping unset.

## Memory growth
Append one line per non-obvious platform behaviour to
`.autoclaw/memory/personas/openclaw/lessons.md`:
`2026-MM-DD: <behaviour> — <where it bit> — <workaround>`. Mark anything
naming a real endpoint or token location `privacy: project`.

## Cross-references
- The platform fabric RFC: [docs/rfc/agent-fabric-platforms.md](../../docs/rfc/agent-fabric-platforms.md).
- The type taxonomy: [src/fabric/agentTypes.ts](../../src/fabric/agentTypes.ts).
- The adapter itself: [src/runners/openclaw.ts](../../src/runners/openclaw.ts).
- The runner contract: [docs/rfc/runner-bridge-contract.md](../../docs/rfc/runner-bridge-contract.md).
