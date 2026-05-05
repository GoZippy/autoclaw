# AutoClaw Orchestration — Improvement Brief
**Source:** Live end-to-end orchestration session on `zippycoin-core` (2026-05-03/05)
**Observed by:** Claude Code (claude-sonnet-4-6)
**For:** AutoClaw maintainer

Every gap below was observed live, not inferred. Priority order matches blast radius.

---

## P0 — Silent bugs that break the coordination loop

### 1. `init` does not create inbox directories

`orchestrate init` creates `config.yaml`, `manifests/`, `sprints/`, `reviews/`, `logs/` but never
creates `inboxes/claude-code/`, `inboxes/kilocode/`, `inboxes/shared/`.
Result: all `sendMessage()` calls fail silently — no agent can ever receive a message.

**Fix in** the `init` command handler (likely `src/extension.ts`):
```typescript
const inboxRoot = path.join(commsDir, 'inboxes');
const agents = (await readRegistry(commsDir))?.agents ?? [];
for (const agent of agents) {
  await fs.mkdir(path.join(inboxRoot, agent.id), { recursive: true });
}
await fs.mkdir(path.join(inboxRoot, 'shared'), { recursive: true });
```
Read `registry.json` for agent IDs so it's project-agnostic.

---

### 2. `assign` never calls `sendMessage` — agents get no notification

`planSprints()` assigns tasks and writes `.md` files. It never calls `comms.sendMessage()`.
Agents have no automated signal that work was handed to them.

**Fix:** After writing each `sprint-N-{agent}.md`, send a `task_assignment` message:
```typescript
// Add 'task_assignment' to MessageType union in comms.ts first
await sendMessage(commsDir, {
  id: `${Date.now()}-task_assignment-orchestrator`,
  type: 'task_assignment',
  from: 'orchestrator',
  to: resolvedAgentId,          // see fix #7 below
  timestamp: new Date().toISOString(),
  sprint: sprint.sprint,
  task_id: assignment.tasks.map(t => t.id).join(','),
  body: `Sprint ${sprint.sprint} assigned. Read: ${assignmentFilePath}`,
  requires_response: false,
});
await appendCommsLog(commsDir, { ... });
```

---

### 3. `state.json` not written after `plan`

`generatePlan()` returns a state object but the command handler never calls `writeStateFile()`.
`/orchestrate status` has nothing to read — it shows empty or errors.

**Fix in** the `plan` command handler — it already imports `writeStateFile`, just call it:
```typescript
const { sprints, summary, state } = generatePlan(manifest, config);
await writeStateFile(orchestratorDir, state);   // ← this line is missing
await writePlanSummary(orchestratorDir, summary);
for (const sprint of sprints) await writeSprintFile(orchestratorDir, sprint);
```

---

### 4. AutoClaw's heartbeat cycle overwrites agent-set fields with `null`

AutoClaw's background interval calls `writeHeartbeat()` and resets
`current_task` and `sprint` to `null` on every tick. Agents set these fields;
AutoClaw erases them ~90 seconds later.

**Observed:** Both heartbeats were set correctly at 21:44:36; by 21:46:06 both
`current_task` and `sprint` were `null` again.
At 05:58:17 the heartbeat set `current_task` to the IDE's open file path
(`extension-output-ZippyTechnologiesLLC.autoclaw-#1-AutoClaw Doctor`) for both agents —
AutoClaw picked up the open editor file rather than the actual task.

**Fix in** `comms.ts — writeHeartbeat()`: merge with existing, don't replace:
```typescript
export async function writeHeartbeat(commsDir: string, hb: Heartbeat): Promise<void> {
  const existing = await readHeartbeat(commsDir, hb.agent_id) ?? {};
  const merged = { ...existing, ...hb, timestamp: hb.timestamp };
  const p = path.join(commsDir, 'heartbeats', `${hb.agent_id}.json`);
  await fs.writeFile(p, JSON.stringify(merged, null, 2));
}
```
Or split into two files: `heartbeat-liveness.json` (AutoClaw owns: alive/dead, last_seen)
and `heartbeat-task.json` (agent owns: current_task, sprint, branch). AutoClaw never touches
the task file.

---

### 5. Blocked `assign` returns nothing — agent gets no feedback

Kilo Code ran `/orchestrate assign 2` while Sprint 1 was not yet merged.
The dependency gate correctly blocked it but returned no message.
From Kilo Code's perspective the command appeared to succeed silently.

**Fix in** the `assign` handler:
```typescript
if (!sprint.dependencies_met) {
  const blocking = getBlockingSprints(sprintNumber, allSprints);
  await sendMessage(commsDir, {
    type: 'answer', from: 'orchestrator', to: requestingAgent,
    body: `Sprint ${sprintNumber} blocked — waiting for: Sprint(s) ${blocking.join(', ')} to reach 'merged'.`,
    sprint: sprintNumber, requires_response: false,
  });
  return;
}
```

---

### 6. Wrong assignment filepath written to heartbeat

When both agents were assigned Sprint 1, the kilocode heartbeat `current_task`
was set to `sprint-1-claude-code.md` instead of `sprint-1-kilocode.md`.
The assign handler uses the same path string for all agents.

**Fix:** Resolve per-agent filepath before writing heartbeat:
```typescript
for (const assignment of sprint.assignments) {
  const agentId = resolveAgentId(assignment.agent, registry); // WA-N → real ID
  const file = `sprint-${sprint.sprint}-${agentId}.md`;       // agent-specific
  await writeHeartbeat(commsDir, {
    agent_id: agentId, timestamp: new Date().toISOString(),
    status: 'working', current_task: file, sprint: sprint.sprint,
  });
}
```

---

## P1 — Missing features (coordination loop stays open without them)

### 7. WA-N slot → real agent ID never resolved

Sprint plans assign to `WA-1`, `WA-2`. The real agents are `claude-code`, `kilocode`.
No runtime record maps slot → agent ID for a given sprint.

Add to `orchestrate.ts`:
```typescript
export function resolveAgentId(waSlot: string, registry: AgentRegistry): string {
  const idx = parseInt(waSlot.replace('WA-', ''), 10) - 1;
  return registry.agents[idx]?.id ?? waSlot;
}
```
Persist mapping in `state.json.agents`:
```json
"agents": {
  "claude-code": { "wa_slot": "WA-1", "sprint": 1, "tasks": ["T01"] },
  "kilocode":    { "wa_slot": "WA-2", "sprint": 1, "tasks": ["T02"] }
}
```

---

### 8. Missing `adapters/claude-code/orchestrate/SKILL.md`

`adapters/claude-code/` has `kdream/`, `autobuild/`, `mateam/` but no `orchestrate/`.
The generic `skills/orchestrate/SKILL.md` was used as fallback, but it lists Go quality gates
(`go build`, `go vet`, `go test`) which are wrong for Rust projects.

Create `adapters/claude-code/orchestrate/SKILL.md` that:
- Overrides quality gates: `cargo check --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`
- References Claude Code's native tools (Read, Edit, Write, Glob, Grep) over bash fallbacks
- Documents how to write `task_complete` + `review_request` messages when done
- Clarifies heartbeat merge behavior (fix #4 above)
- Includes the `resolveAgentId` step so Claude Code knows its own ID

---

### 9. No heartbeat monitoring — stalled agents are invisible

`readAllHeartbeats()` and `agentStatusFromHeartbeat()` exist in `comms.ts` but nothing
calls them on a schedule. A stalled agent is never surfaced.

Add to the background interval in `src/extension.ts` (alongside autobuild tick):
```typescript
setInterval(async () => {
  const statuses = await getAgentStatuses(commsDir);
  for (const s of statuses) {
    if (s.live_status === 'stalled') {
      await sendMessage(commsDir, {
        type: 'escalation', from: 'orchestrator', to: 'shared',
        body: `Agent ${s.id} stalled on sprint ${s.heartbeat?.sprint}. Last: ${s.heartbeat?.timestamp}`,
        requires_response: true,
      });
    }
  }
}, 5 * 60 * 1000);
```
`agentStatusFromHeartbeat()` already classifies `'stalled'` — just needs to be called.

---

### 10. `task_complete` messages not reacted to — sprint never transitions to review

Agents write `task_complete` to `inboxes/shared/` per protocol. Nothing reads it.
Sprint status never moves from `assigned` → `review`, so merge gate never fires.

Add a message handler in the background monitor:
```typescript
for (const msg of await readSharedInbox(commsDir)) {
  if (msg.type === 'task_complete') {
    const sprint = await readSprintFile(sprintsDir, msg.sprint);
    markAgentComplete(sprint, msg.from);
    if (allAgentsComplete(sprint)) {
      sprint.status = 'review';
      await writeSprintFile(sprintsDir, sprint);
      await sendMessage(commsDir, {
        type: 'review_request', from: 'orchestrator', to: 'shared', sprint: sprint.sprint,
        body: `Sprint ${sprint.sprint}: all agents complete. Review requested.`,
      });
    }
  }
}
```

---

## P2 — Production hardening

### 11. Quality gates inferred from project type, not hardcoded

`init` should detect the project language and set appropriate gates:
```typescript
function inferQualityGates(root: string): string[] {
  if (fs.existsSync(path.join(root, 'Cargo.toml')))
    return ['cargo check --workspace', 'cargo clippy --workspace -- -D warnings', 'cargo test --workspace'];
  if (fs.existsSync(path.join(root, 'go.mod')))
    return ['go build ./...', 'go vet ./...', 'go test ./...'];
  if (fs.existsSync(path.join(root, 'package.json')))
    return ['npm run build', 'npm test'];
  return [];
}
```

### 12. `mergeSprint()` needed to unblock downstream sprints

Without merge automation, `sprint.status` never reaches `'merged'`, so
`dependencies_met` is permanently `false` for all downstream sprints.
Minimum: checkout base branch, `git merge --no-ff {branch}`, update status, call
`updateDownstreamDependencies()` to flip `dependencies_met` on unblocked sprints.

### 13. KDream ↔ Orchestrate not wired

KDream tick should call `readAllHeartbeats()` → log `[WARN] Stalled: <agent> on sprint <N>`.
KDream autoDream should read `state.json` → append sprint progress to `## Facts` in MEMORY.md.

---

## Priority table

| # | File | Change | Why it matters |
|---|---|---|---|
| P0-1 | `extension.ts` (init) | Create `inboxes/{agent}/` + `inboxes/shared/` | Nothing can be sent/received without this |
| P0-2 | `extension.ts` (assign) | Call `sendMessage(task_assignment)` | Agents know they have work |
| P0-3 | `extension.ts` (plan) | Call `writeStateFile()` | `/status` works |
| P0-4 | `comms.ts` | Merge heartbeats, don't replace | Task fields survive AutoClaw cycle |
| P0-5 | `extension.ts` (assign) | Send `answer` on dependency gate block | Agents get feedback |
| P0-6 | `extension.ts` (assign) | Per-agent filepath in heartbeat | Wrong-file bug fixed |
| P1-7 | `orchestrate.ts` | `resolveAgentId(waSlot, registry)` | WA-N → real agent name |
| P1-8 | `adapters/claude-code/orchestrate/SKILL.md` | Create | Claude Code gets correct gates |
| P1-9 | `extension.ts` (interval) | Poll heartbeats → escalate on stall | Stalls become visible |
| P1-10 | `extension.ts` (message handler) | React to `task_complete` | Loop closes |
| P2-11 | `extension.ts` (init) | `inferQualityGates(root)` | Works across project types |
| P2-12 | `orchestrate.ts` | `mergeSprint()` + `updateDownstreamDependencies()` | Sprints actually unblock |
| P2-13 | `kdream-helpers.ts` | Stall detection + autoDream sprint state | KDream ↔ Orchestrate wired |

**Biggest single lever:** P0-2 + P1-10 together. Agents get work → agents signal done →
orchestrator transitions state. Everything else builds on top.
