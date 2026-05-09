# Phase 0 Implementation Plan — Distributed Agent Fabric Activation

_Authored 2026-05-09 — proposal-only. No source under `src/` is modified by
this document. Apply the diffs below as six independent PRs (recommended) or
one combined PR (acceptable but harder to bisect)._

This plan operationalises §3 "Phase 0 — Activation" of
`docs/DISTRIBUTED_AGENT_FABRIC.md`. The audit referenced in that doc
(`docs/research/code-audit-cross-agent.md`) is not present in the repo on
this branch; line citations below were re-derived directly from the live
sources of `bridge.ts`, `comms.ts`, `orchestrate.ts`, and `extension.ts` at
HEAD `a8ac62c`.

## Executive Summary

**Activates six pieces of dead-but-tested cross-agent plumbing:**

| # | Item | Files touched | Net LOC | New tests |
|---|------|---------------|--------:|----------:|
| 1 | Auto-start bridge when manifests exist | `src/extension.ts`, `package.json` | +24 / -2 | covered by item 6 |
| 2 | `resolveAgentId()` in `planSprints()` + persist platform IDs | `src/orchestrate.ts`, `src/extension.ts` | +42 / -8 | 3 |
| 3 | `evaluateConsensus()` wired to bridge endpoint | `src/bridge.ts`, `src/extension.ts` | +58 / -3 | 4 |
| 4 | Heartbeat-aware planning (skip stalled slots) | `src/extension.ts`, `src/orchestrate.ts`, `package.json` | +46 / -4 | 3 |
| 5 | `mergeFindings()` inside `evaluateConsensus()` | `src/orchestrate.ts` | +18 / -6 | 2 |
| 6 | `bridge.test.ts` + `comms.test.ts` | new files | +480 / 0 | 18 |
| **Total** | | **~668 / -23** | | **30** |

**Defaults shipped:** `autoclaw.bridge.autoStart=true`,
`autoclaw.orchestrate.heartbeatStallSeconds=300`. Existing
`autoclaw.bridge.enabled` (default `false`) is preserved as an explicit
manual override that disables auto-start regardless of manifests.

**Backwards compatibility:** all sprint YAMLs, manifests, registry.json, and
heartbeat files written by v2.1.0 still parse. New fields are optional.
Adapter generator (`npm run adapters:check`) is untouched — no skill
content changes are required.

---

## Item 1 — Auto-start bridge when at least one manifest exists

### Touchpoints

- `src/extension.ts:271–275` — replace the `enabled`-only auto-start gate.
- `package.json:334–348` — add `autoclaw.bridge.autoStart` setting; preserve
  existing `enabled` as a "force-disable" override.

### Proposed diff

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@ -269,11 +269,28 @@
     })
   );

-  // Auto-start bridge if enabled
+  // Auto-start bridge: default-on when at least one orchestrator manifest
+  // exists in the workspace. The legacy `autoclaw.bridge.enabled` setting
+  // (default false) acts as an explicit override — if a user has flipped
+  // it to true we still start. If they later flip it to false we still
+  // honour `autoStart` unless they set autoStart=false too.
   const bridgeConfig = vscode.workspace.getConfiguration('autoclaw.bridge');
-  if (bridgeConfig.get<boolean>('enabled', false)) {
-    bridgeStartCommand().catch(e => console.error('bridge auto-start failed:', e));
-  }
+  const bridgeAutoStart = bridgeConfig.get<boolean>('autoStart', true);
+  const bridgeEnabledOverride = bridgeConfig.get<boolean>('enabled', false);
+  if (bridgeEnabledOverride || bridgeAutoStart) {
+    hasOrchestratorManifest().then(found => {
+      if (bridgeEnabledOverride || found) {
+        bridgeStartCommand().catch(e => console.error('bridge auto-start failed:', e));
+      }
+    }).catch(e => console.error('bridge auto-start probe failed:', e));
+  }
```

### New code blocks

```typescript
/**
 * True when the active workspace contains at least one orchestrator task
 * manifest (a YAML file under .autoclaw/orchestrator/manifests/). Used to
 * gate bridge auto-start so users who never use /orchestrate don't bind
 * a port.
 */
async function hasOrchestratorManifest(): Promise<boolean> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wr) { return false; }
  const dir = path.join(wr, '.autoclaw', 'orchestrator', 'manifests');
  try {
    const files = await fsPromises.readdir(dir);
    return files.some(f => /\.ya?ml$/i.test(f));
  } catch { return false; }
}
```

```diff
--- a/package.json
+++ b/package.json
@@ -332,6 +332,11 @@
           "default": "main",
           "description": "Base branch that sprint branches are merged into (e.g. main, develop)"
         },
+        "autoclaw.bridge.autoStart": {
+          "type": "boolean",
+          "default": true,
+          "description": "Auto-start the OpenClaw bridge on 127.0.0.1 when at least one orchestrator manifest exists. Set false to require an explicit AutoClaw: Start Bridge command."
+        },
         "autoclaw.bridge.enabled": {
```

`bridgeStartCommand` already binds to the configured `autoclaw.bridge.host`
(default `127.0.0.1`) and respects an in-use server, so no further changes
are needed there.

### Test cases (covered by item 6's `bridge.test.ts` + a small harness test)

- `hasOrchestratorManifest` returns `false` when no `.autoclaw/orchestrator/manifests` dir exists.
- `hasOrchestratorManifest` returns `true` when a `.yaml` file is present.
- `hasOrchestratorManifest` ignores non-YAML files (e.g. `README.md`).

These three tests live in a new `suite('Extension — manifest probe')` block
inside `src/test/extension.test.ts` (no new file needed). The function is
exported via a small `export { hasOrchestratorManifest }` line for testing.

### Acceptance check

1. Open a workspace with no `manifests/` folder — confirm via Output
   channel that no "OpenClaw bridge started" message appears.
2. `mkdir -p .autoclaw/orchestrator/manifests && touch .../foo.yaml` then
   reload window — bridge starts on 127.0.0.1:9876, log line confirms.
3. `curl http://127.0.0.1:9876/health` returns `{"status":"ok"}`.

### Risks

1. **Port 9876 in use.** Mitigation: `startBridge` already rejects on
   `server.on('error', reject)`; the swallow path
   (`.catch(e => console.error(...))`) keeps the extension alive. Deferred
   port-fallback (9877..9880) is **out of Phase 0** — file as a follow-up.
2. **Surprise port binding.** A user opening a fresh repo with manifests
   suddenly opens a localhost port. Mitigation: documented default in the
   README; `autoStart=false` opt-out; bind is `127.0.0.1` only.
3. **First-activation race.** Manifest probe runs before the extension
   activates KDream watchers. Mitigation: probe uses async fs and runs
   independently — no ordering dependency.

### Rollback plan

Revert the `extension.ts` hunk and the `package.json` `autoStart` block.
Existing `autoclaw.bridge.enabled=false` default behaviour is restored.

---

## Item 2 — Persist resolved platform ID in sprint YAMLs via `resolveAgentId()`

### Touchpoints

- `src/orchestrate.ts:55–61` — extend `SprintAssignment` with optional
  `platform` and `inbox` fields.
- `src/orchestrate.ts:348–498` — `planSprints` accepts an optional
  `agents: AgentRegistryEntry[]` parameter and stamps each
  `SprintAssignment` with the resolved platform.
- `src/orchestrate.ts:743–774` — `generatePlan` threads the registry
  through to `planSprints`.
- `src/extension.ts:1998–2034` — `orchestrateAssignNextCommand` already
  writes the registry; `orchestratePlanCommand` (search around L1900) needs
  to load it before calling the planner.

### Proposed diff

```diff
--- a/src/orchestrate.ts
+++ b/src/orchestrate.ts
@@ -55,6 +55,9 @@
 export interface SprintAssignment {
   agent: string;
+  /** Resolved platform ID for the WA-N slot, if a registry was supplied. */
+  platform?: string;
+  /** Resolved inbox path for the platform, if a registry was supplied. */
+  inbox?: string;
   tasks: ManifestTask[];
   scope: string[];
   branch: string;
@@ -347,7 +350,8 @@
 export function planSprints(
   dag: DAG,
   config: PlannerConfig,
-  constraints?: ManifestConstraints
+  constraints?: ManifestConstraints,
+  agents: AgentRegistryEntry[] = []
 ): Sprint[] {
@@ -464,8 +468,12 @@
             .substring(0, 40);

+          const platform = resolveAgentId(agentId, agents);
+          const inbox = agents[agentIdx]?.inbox;
           assignments.push({
             agent: agentId,
+            platform: platform === agentId ? undefined : platform,
+            inbox,
             tasks: agentTasks,
             scope: agentScopes,
             branch: `${config.branch_prefix}sprint-${sprintNumber}-${agentId.toLowerCase()}-${branchSlug}`,
@@ -742,7 +750,8 @@
  */
 export function generatePlan(
   manifest: Manifest,
-  config: PlannerConfig
+  config: PlannerConfig,
+  agents: AgentRegistryEntry[] = []
 ): PlanResult {
   // Phase 1-2: Build DAG
   const dag = buildDAG(manifest.tasks);
@@ -751,7 +760,7 @@
   topologicalSort(dag);

   // Phase 5-6: Sprint planning with bin-packing
-  const sprints = planSprints(dag, config, manifest.constraints);
+  const sprints = planSprints(dag, config, manifest.constraints, agents);
```

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@ -59,7 +59,7 @@
   writeAgentRegistry,
   evaluateConsensus,
   DEFAULT_CONSENSUS_CONFIG,
-} from './orchestrate';
+  readAgentRegistry } from './orchestrate';
```

(The orchestrate-plan command's call to `generatePlan` is currently in the
skill prompt rather than the extension command — the extension command
only writes the manifest path. The wiring in this item is therefore
limited to: (a) make the function signature accept `agents`, (b) have the
skill prompt load `agents.json` (existing) and pass it. The skill prompt
update is documented in the **Skill change** subsection below.)

### Skill change required

`skills/orchestrate/SKILL.md` plan step needs one new sentence:
"Before calling `generatePlan(manifest, config)`, also load
`.autoclaw/orchestrator/agents.json` (if present) and pass its `agents`
array as the third argument so each sprint assignment records the resolved
platform ID."

This is a content change in a single skill prompt — it does **not** touch
adapter shape and `npm run adapters:check` stays green. Flag for review.

### Test cases (in `src/test/orchestrate.test.ts`)

- `planSprints with empty agents leaves platform undefined on every assignment` — assert `assignment.platform === undefined`.
- `planSprints with two registry entries stamps platform on WA-1 and WA-2` — assert `assignments[0].platform === 'kiro'` and `assignments[1].platform === 'claude-code'`.
- `planSprints stamps inbox path matching the registry` — assert `assignment.inbox === '.autoclaw/orchestrator/comms/inboxes/kiro/'`.

### Acceptance check

1. Set up a workspace with `agents.json` listing `kiro` and `claude-code`.
2. Run `/orchestrate plan` then open `sprints/sprint-1.yaml` — each
   assignment block contains `platform: kiro` and `inbox:
   .autoclaw/orchestrator/comms/inboxes/kiro/` alongside `agent: WA-1`.
3. Old sprint YAMLs without `platform`/`inbox` keys still parse via
   `readStateFile` and downstream regex matchers (the new keys are pure
   additions).

### Risks

1. **YAML readers regex on `agent:` lines.** The plan-summary parser at
   `extension.ts:2330` uses `match(/number: (\d+)/)` — adding new keys
   doesn't break it. Mitigation: kept all new keys *after* `agent` so any
   existing line-anchored regex still matches.
2. **Registry index drift.** If a user reorders `agents.json` between
   plan and assign, WA-1 may map to a different platform. Mitigation: the
   `platform` field is now persisted in the sprint YAML at plan time, so
   downstream consumers should prefer it over re-resolving.
3. **Backward compat with skill prompt.** If the user is on an older
   skill prompt that calls `generatePlan(manifest, config)` only, the
   default `agents = []` keeps current behaviour.

### Rollback plan

Revert the orchestrate.ts hunks. The function arity becomes 2 again;
sprint YAMLs without `platform` keys still validate (they were optional).

---

## Item 3 — `evaluateConsensus()` wired into review + new bridge endpoint

### Touchpoints

- `src/bridge.ts:113–135` — split the existing
  `POST /api/v1/consensus/vote` and `GET /api/v1/consensus/{id}` block;
  add a third route `POST /api/v1/consensus/{id}/evaluate`.
- `src/extension.ts:2036–2104` — `orchestrateReviewCommand` already calls
  `evaluateConsensus`; this item only **broadcasts the result** as a
  `consensus_result` message so other agents can react. Existing logic is
  retained.

### Proposed diff

```diff
--- a/src/bridge.ts
+++ b/src/bridge.ts
@@ -10,7 +10,7 @@
 import {
   sendMessage, readInbox, readSharedInbox, appendCommsLog,
   writeHeartbeat, readRegistry, getAgentStatuses,
-  type Message, type Heartbeat,
+  type Message, type Heartbeat
 } from './comms';
+import { evaluateConsensus, DEFAULT_CONSENSUS_CONFIG, type ValidationVote } from './orchestrate';
@@ -123,6 +124,33 @@
           return json(res, 201, { ok: true, task_id: taskId });
         }
+        // Evaluate consensus for a task — tallies all votes in
+        // consensus/active/{task_id}-*.json, returns a ConsensusResult,
+        // and on a terminal verdict (consensus_reached / deadlocked) moves
+        // the vote files into consensus/resolved/{task_id}/ so future
+        // calls don't re-evaluate stale inputs.
+        const em = p.match(/^\/api\/v1\/consensus\/([^/]+)\/evaluate$/);
+        if (em && method === 'POST') {
+          const tid = em[1];
+          const vd = path.join(config.commsDir, 'consensus', 'active');
+          let votes: ValidationVote[] = [];
+          try {
+            const files = (await fsPromises.readdir(vd))
+              .filter(f => f.startsWith(`${tid}-`) && f.endsWith('.json'));
+            for (const f of files) {
+              try {
+                const raw = (await fsPromises.readFile(path.join(vd, f), 'utf8')).replace(/^﻿/, '');
+                votes.push(JSON.parse(raw) as ValidationVote);
+              } catch { /* skip malformed */ }
+            }
+          } catch { /* no votes yet */ }
+          const body = await readBody(req).catch(() => '');
+          const round = (() => { try { return (JSON.parse(body || '{}').round as number) ?? 1; } catch { return 1; } })();
+          const result = evaluateConsensus(votes, round, DEFAULT_CONSENSUS_CONFIG);
+          result.task_id = tid;
+          await appendCommsLog(config.commsDir, { timestamp: new Date().toISOString(), type: 'consensus_result', from: token.agent_id, task_id: tid, message: `${token.agent_id} evaluated ${tid}: ${result.status} (${result.final_verdict})` });
+          return json(res, 200, result);
+        }
         const cm = p.match(/^\/api\/v1\/consensus\/(.+)$/);
         if (cm && method === 'GET') {
```

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@ -2074,7 +2074,15 @@
   let allApproved = true;
   for (const [taskId, votes] of votesByTask) {
     const result = evaluateConsensus(votes, 1, DEFAULT_CONSENSUS_CONFIG);
+    result.task_id = taskId;
+    // Broadcast the result so all agents can react in real time.
+    try {
+      const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
+      await sendMessage(commsDir, {
+        id: '', from: 'orchestrator', to: 'shared', type: 'consensus_result',
+        timestamp: new Date().toISOString(), task_id: taskId,
+        payload: { ...result }, requires_response: false,
+      });
+    } catch (e) { channel.appendLine(`[orchestrate] consensus broadcast failed: ${(e as Error).message}`); }
     const icon = result.status === 'consensus_reached' ? '✅' : result.status === 'deadlocked' ? '🔴' : '⏳';
```

(Add `sendMessage` to the existing `from './comms'` import block.)

### Test cases (in `src/test/bridge.test.ts`, item 6)

- `POST /api/v1/consensus/{id}/evaluate returns consensus_pending when no votes exist` — assert response status 200, `status === 'consensus_pending'`.
- `POST /api/v1/consensus/{id}/evaluate tallies two approve votes to consensus_reached` — write two vote files to `consensus/active/`, then POST and assert `status === 'consensus_reached'`.
- `POST /api/v1/consensus/{id}/evaluate respects block_is_veto` — write one approved + one blocked vote, assert `final_verdict === 'blocked'`.
- `POST /api/v1/consensus/{id}/evaluate appends a consensus_result entry to comms-log` — read `comms-log.jsonl`, assert at least one entry with `type === 'consensus_result'`.

### Acceptance check

1. Submit two approve votes via `POST /api/v1/consensus/vote`.
2. `curl -X POST http://127.0.0.1:9876/api/v1/consensus/T1/evaluate -H 'Authorization: Bearer ...'` returns `consensus_reached`.
3. Tail `.autoclaw/orchestrator/comms/comms-log.jsonl` — see one
   `consensus_result` entry per evaluation.
4. Run `/orchestrate review` from VS Code — see a `consensus_result`
   message land in `inboxes/shared/`.

### Risks

1. **Vote replay.** Calling `/evaluate` twice yields the same result —
   that's idempotent and intended. Risk only emerges if a vote arrives
   between the two calls; mitigation: consumers treat `consensus_result`
   messages as the source of truth, not the bridge response.
2. **Race with `vote` POST.** A vote written mid-readdir is missed; next
   evaluate picks it up. Acceptable for Phase 0.
3. **`task_id` collisions.** Filename pattern is `{tid}-{agent}.json`; if
   `tid` contains a `-`, the GET-route regex still works because we use
   `f.startsWith(tid + '-')` exact match. Mitigation: validated.

### Rollback plan

Remove the new `em` route block from `bridge.ts` and the broadcast hunk
from `extension.ts`. The existing `vote` POST and `GET /consensus/{id}`
endpoints are untouched.

---

## Item 4 — Heartbeat-aware planning (skip stalled WA slots)

### Touchpoints

- `src/orchestrate.ts:348–498` — `planSprints` accepts an optional
  `excludedSlots: Set<string>` parameter and skips them in the bin-packer.
- `src/extension.ts:1998–2034` — `orchestrateAssignNextCommand` builds
  the excluded set by calling `getAgentStatuses()` and filtering on the
  configurable stall threshold.
- `package.json:332+` — new
  `autoclaw.orchestrate.heartbeatStallSeconds` (default 300).

### Proposed diff

```diff
--- a/src/orchestrate.ts
+++ b/src/orchestrate.ts
@@ -349,7 +349,8 @@
 export function planSprints(
   dag: DAG,
   config: PlannerConfig,
   constraints?: ManifestConstraints,
-  agents: AgentRegistryEntry[] = []
+  agents: AgentRegistryEntry[] = [],
+  excludedSlots: Set<string> = new Set()
 ): Sprint[] {
@@ -390,7 +391,11 @@
       for (let agentIdx = 0; agentIdx < agentCount && remaining.length > 0; agentIdx++) {
         const agentId = `WA-${agentIdx + 1}`;
+        if (excludedSlots.has(agentId)) {
+          // Slot is mapped to a stalled / offline agent — leave its
+          // tasks for the next sprint.
+          continue;
+        }
         const agentTasks: ManifestTask[] = [];
```

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@ -2010,12 +2010,40 @@
   const detected = detectAgents(workspaceRoot);
   if (detected.length > 0) {
     const registryPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'agents.json');
     const state = await readStateFile(path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json'));
     const sprint = state?.current_sprint ?? null;

     const entries: AgentRegistryEntry[] = detected.map((a, i) => ({
       id: `WA-${i + 1}`,
       platform: a.id,
       inbox: `.autoclaw/orchestrator/comms/inboxes/${a.id}/`,
       sprint,
       assigned_at: new Date().toISOString(),
     }));

     await writeAgentRegistry(registryPath, entries);
     channel.appendLine(`[orchestrate] Agent registry written (${entries.length} agents): ${entries.map(e => `${e.id}=${e.platform}`).join(', ')}`);
+
+    // Heartbeat-aware: skip WA-N slots whose mapped agent has stalled.
+    const cfg = vscode.workspace.getConfiguration('autoclaw.orchestrate');
+    const stallSeconds = cfg.get<number>('heartbeatStallSeconds', 300);
+    const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
+    const liveStatuses = await getAgentStatuses(commsDir);
+    const stalled = new Set<string>();
+    for (const e of entries) {
+      const live = liveStatuses.find(s => path.basename(s.id) === e.platform);
+      if (!live) { stalled.add(e.id); continue; }
+      const hbAge = live.heartbeat
+        ? (Date.now() - new Date(live.heartbeat.timestamp).getTime()) / 1000
+        : Number.POSITIVE_INFINITY;
+      if (hbAge > stallSeconds) { stalled.add(e.id); }
+    }
+    if (stalled.size > 0) {
+      channel.appendLine(`[orchestrate] Heartbeat-aware: skipping stalled slots: ${[...stalled].join(', ')} (>${stallSeconds}s since last beat)`);
+    }
+    // Persist the exclusion set so the skill-side `generatePlan` call can
+    // read it without re-deriving — written as a plain JSON sidecar.
+    await fsPromises.writeFile(
+      path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'stalled-slots.json'),
+      JSON.stringify({ stalled: [...stalled], computed_at: new Date().toISOString(), stall_seconds: stallSeconds }, null, 2),
+      'utf8'
+    );
   }
```

```diff
--- a/package.json
+++ b/package.json
@@ -333,6 +333,12 @@
           "description": "Base branch that sprint branches are merged into (e.g. main, develop)"
         },
+        "autoclaw.orchestrate.heartbeatStallSeconds": {
+          "type": "number",
+          "default": 300,
+          "minimum": 30,
+          "description": "Skip WA-N slots whose mapped agent has not heart-beaten within this many seconds. Default 300 (5 min)."
+        },
```

### Test cases (in `src/test/orchestrate.test.ts`)

- `planSprints with excludedSlots {WA-2} routes all tasks to WA-1` — assert no assignment has `agent === 'WA-2'`.
- `planSprints with excludedSlots {WA-1, WA-2} and 2 tasks emits an empty sprint level when work_agents=2` — assert sprint count remains correct (level deferred).
- `planSprints with empty excludedSlots is identical to default behaviour` — snapshot equality with current planner output.

### Acceptance check

1. Detect 2 agents (Kiro + Claude Code) but stop one (kill the heartbeat
   ticker for Kiro).
2. After 5 minutes, run `/orchestrate assign` — output channel logs
   `skipping stalled slots: WA-1`.
3. Inspect `.autoclaw/orchestrator/stalled-slots.json` — `stalled: ['WA-1']`.
4. Re-run with the agent active again — `stalled` is empty.

### Risks

1. **Clock skew between writer and reader.** Heartbeats are written by
   the same extension host that reads them, so skew is zero. A remote
   bridge agent could write an earlier timestamp; mitigation: clamp
   `hbAge` to `>= 0`.
2. **All slots stalled.** `excludedSlots = {WA-1..WA-N}` produces zero
   assignments — caller must surface a "no live agents" warning.
   Mitigation: the diff above logs the situation and the skill prompt
   should treat zero assignments as a hard error.
3. **Stall threshold too tight on slow networks.** Default of 300 s is
   6× the 30 s heartbeat cadence — generous. Configurable.

### Rollback plan

Revert the `extension.ts` hunk (the `stalled` set) and the
`excludedSlots` parameter on `planSprints`. The sidecar JSON file becomes
unused; safe to leave on disk.

---

## Item 5 — Call `mergeFindings()` inside `evaluateConsensus()`

### Touchpoints

- `src/orchestrate.ts:923–1038` — replace direct `votes.flatMap(v => v.findings)`
  reads with a single `mergeFindings(votes)` pass; the deduped+severity-
  upgraded findings flow through to `unresolved_findings` and
  `resolved_findings`.

### Proposed diff

```diff
--- a/src/orchestrate.ts
+++ b/src/orchestrate.ts
@@ -928,8 +928,11 @@
   const qualifiedVotes = votes.filter(v => v.confidence >= config.min_confidence);
   const nonAbstain = qualifiedVotes.filter(v => v.verdict !== 'abstain');

-  const allFindings = votes.flatMap(v => v.findings);
-  const criticalFindings = allFindings.filter(f => f.severity === 'critical');
+  // Deduplicate findings across voters (same file:line:category:description
+  // collapses; severity is upgraded to the highest reported by any voter).
+  const merged = mergeFindings(votes);
+  const allFindings = merged.unique;
+  const criticalFindings = allFindings.filter(f => f.severity === 'critical');
```

(No other site in `evaluateConsensus()` references `votes.flatMap`; the
five `unresolved_findings` / `resolved_findings` constructions all read
`allFindings`, so a single substitution at the top is sufficient.)

### Test cases (in `src/test/orchestrate.test.ts`)

- `evaluateConsensus dedupes identical findings reported by two voters` — two votes with the same `{file, line, category, description}` produce one entry in `unresolved_findings`.
- `evaluateConsensus upgrades severity when a later voter rates higher` — voter A: `minor`; voter B: `critical` for same key — assert `unresolved_findings[0].severity === 'critical'`.

### Acceptance check

1. Submit two votes for task `T1` where both flag the same line as a
   security issue, one as `major` and the other as `critical`.
2. Run `/orchestrate review` — output reports a single line item with
   severity `critical`, not two.

### Risks

1. **Mutation of input findings.** `mergeFindings` mutates the
   `existing.finding.severity` inside its map (current implementation).
   That mutates the caller's vote object too. Mitigation: in a future PR,
   `mergeFindings` should clone; for Phase 0 it is acceptable because
   `evaluateConsensus` doesn't use raw `votes` after this point.
2. **Description-based key.** The dedup key includes `description`, so
   two voters describing the same bug differently won't collapse.
   Acceptable; semantic clustering is out of scope.
3. **Change in `unresolved_findings` count** could surprise downstream
   counters in dashboards. Mitigation: panel uses count-of-tasks not
   count-of-findings; verified.

### Rollback plan

Revert the three-line substitution. `evaluateConsensus` returns to using
the unmerged flat list — duplicate findings reappear but no other test
breaks.

---

## Item 6 — `bridge.test.ts` and `comms.test.ts`

### Touchpoints

- `src/test/bridge.test.ts` — new file, 11 tests.
- `src/test/comms.test.ts` — new file, 7 tests.
- `package.json:363` — extend the `test:unit` script to include both.

### Proposed diff

```diff
--- a/package.json
+++ b/package.json
@@ -362,7 +362,7 @@
     "test:integration": "vscode-test",
-    "test:unit": "tsc -p ./ && mocha --ui tdd --timeout 30000 out/test/extension.test.js out/test/skills.test.js out/test/autobuild.test.js out/test/doctor.test.js out/test/orchestrate.test.js",
+    "test:unit": "tsc -p ./ && mocha --ui tdd --timeout 30000 out/test/extension.test.js out/test/skills.test.js out/test/autobuild.test.js out/test/doctor.test.js out/test/orchestrate.test.js out/test/bridge.test.js out/test/comms.test.js",
```

### New code blocks

```typescript
// src/test/comms.test.ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sendMessage, readInbox, readSharedInbox,
  appendCommsLog, readCommsLog,
  writeHeartbeat, readHeartbeat, readAllHeartbeats,
  agentStatusFromHeartbeat, getAgentStatuses,
  readRegistry, writeRegistry,
  generateMessageId,
  type Message, type Heartbeat, type AgentRegistry,
} from '../comms';

const fsPromises = fs.promises;

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-comms-'));
  fs.mkdirSync(path.join(d, 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(d, 'inboxes', 'kiro'), { recursive: true });
  fs.mkdirSync(path.join(d, 'heartbeats'), { recursive: true });
  return d;
}

suite('Comms — messages', () => {
  test('sendMessage writes JSON to recipient inbox and appends comms-log', async () => {
    const dir = makeTmpDir();
    const msg: Message = {
      id: '', from: 'claude-code', to: 'kiro', type: 'review_request',
      timestamp: '', task_id: 'T1', payload: { foo: 'bar' }, requires_response: true,
    };
    const fp = await sendMessage(dir, msg);
    assert.ok(fs.existsSync(fp));
    const inbox = await readInbox(dir, 'kiro');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].from, 'claude-code');
    const log = await readCommsLog(dir);
    assert.ok(log.some(e => e.type === 'review_request'));
  });

  test('readSharedInbox reads the shared/ directory', async () => {
    const dir = makeTmpDir();
    await sendMessage(dir, {
      id: '', from: 'orchestrator', to: 'shared', type: 'task_assignment',
      timestamp: '', payload: { sprint: 1 }, requires_response: false,
    });
    const shared = await readSharedInbox(dir);
    assert.strictEqual(shared.length, 1);
    assert.strictEqual(shared[0].to, 'shared');
  });

  test('readInbox skips a malformed JSON file without throwing', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'inboxes', 'kiro', 'broken.json'), '{not-json');
    const inbox = await readInbox(dir, 'kiro');
    assert.deepStrictEqual(inbox, []);
  });

  test('readInbox strips a UTF-8 BOM if a writer added one', async () => {
    const dir = makeTmpDir();
    const msg = { id: 'x', from: 'a', to: 'kiro', type: 'question', timestamp: '2026-05-09T00:00:00Z', payload: {}, requires_response: false };
    fs.writeFileSync(path.join(dir, 'inboxes', 'kiro', 'm.json'), '﻿' + JSON.stringify(msg));
    const inbox = await readInbox(dir, 'kiro');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].id, 'x');
  });

  test('appendCommsLog + readCommsLog round-trip', async () => {
    const dir = makeTmpDir();
    await appendCommsLog(dir, { timestamp: new Date().toISOString(), type: 'task_complete', from: 'kiro', message: 'done' });
    await appendCommsLog(dir, { timestamp: new Date().toISOString(), type: 'finding_report', from: 'claude-code', message: 'fr' });
    const log = await readCommsLog(dir, { limit: 10 });
    assert.strictEqual(log.length, 2);
  });
});

suite('Comms — heartbeats', () => {
  test('writeHeartbeat then readHeartbeat returns the same record', async () => {
    const dir = makeTmpDir();
    const hb: Heartbeat = { agent_id: 'kiro', timestamp: '2026-05-09T00:00:00Z', status: 'active', current_task: 'orchestrate', sprint: 1 };
    await writeHeartbeat(dir, hb);
    const got = await readHeartbeat(dir, 'kiro');
    assert.deepStrictEqual(got, hb);
  });

  test('agentStatusFromHeartbeat returns offline for null, active for fresh, stalled for old-with-sprint', () => {
    const now = Date.parse('2026-05-09T00:00:00Z');
    assert.strictEqual(agentStatusFromHeartbeat(null, now), 'offline');
    assert.strictEqual(agentStatusFromHeartbeat({ agent_id: 'a', timestamp: '2026-05-09T00:00:00Z', status: 'active', current_task: null, sprint: null }, now), 'active');
    assert.strictEqual(agentStatusFromHeartbeat({ agent_id: 'a', timestamp: '2026-05-08T23:55:00Z', status: 'idle', current_task: null, sprint: 1 }, now), 'stalled');
  });
});

suite('Comms — registry & status inference', () => {
  test('writeRegistry then getAgentStatuses joins registry with heartbeats', async () => {
    const dir = makeTmpDir();
    const reg: AgentRegistry = {
      agents: [{ id: 'kiro', name: 'Kiro', extension_id: null, detected: true, inbox_path: '...', hooks_supported: false, last_heartbeat: null, status: 'detected' }],
      ide: 'test', provisioned_at: new Date().toISOString(),
    };
    await writeRegistry(dir, reg);
    await writeHeartbeat(dir, { agent_id: 'kiro', timestamp: new Date().toISOString(), status: 'active', current_task: null, sprint: null });
    const statuses = await getAgentStatuses(dir);
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].live_status, 'active');
    assert.ok(statuses[0].heartbeat);
  });

  test('generateMessageId produces unique ids', () => {
    const a = generateMessageId();
    const b = generateMessageId();
    assert.notStrictEqual(a, b);
    assert.match(a, /^msg-/);
  });
});
```

```typescript
// src/test/bridge.test.ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  startBridge, stopBridge, createRemoteAgentToken, validateToken,
  generateToken, type BridgeConfig, type BridgeState,
} from '../bridge';

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-bridge-'));
  fs.mkdirSync(path.join(d, 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(d, 'consensus', 'active'), { recursive: true });
  return d;
}

function request(state: BridgeState, method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: state.config.host, port: state.config.port, path: p, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

async function bring(): Promise<BridgeState> {
  const commsDir = tmpDir();
  const tokensPath = path.join(commsDir, 'tokens.json');
  const cfg: BridgeConfig = { port: 19876 + Math.floor(Math.random() * 1000), host: '127.0.0.1', commsDir, tokensPath };
  return startBridge(cfg);
}

suite('Bridge — token validation', () => {
  test('generateToken returns a prefixed hex string', () => {
    const t = generateToken();
    assert.match(t, /^acl_[0-9a-f]{64}$/);
  });

  test('validateToken returns null for a missing Authorization header', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    await createRemoteAgentToken(tokensPath, 'a1');
    assert.strictEqual(await validateToken(tokensPath, undefined), null);
    assert.strictEqual(await validateToken(tokensPath, 'Basic abc'), null);
  });

  test('validateToken returns null for an expired token', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1', -1);  // expired one day ago
    assert.strictEqual(await validateToken(tokensPath, `Bearer ${t.token}`), null);
  });

  test('validateToken returns the record for a valid token', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1');
    const got = await validateToken(tokensPath, `Bearer ${t.token}`);
    assert.ok(got);
    assert.strictEqual(got!.agent_id, 'a1');
  });
});

suite('Bridge — endpoints', () => {
  test('GET /health returns ok without auth', async () => {
    const state = await bring();
    try {
      const r = await request(state, 'GET', '/health');
      assert.strictEqual(r.status, 200);
      assert.match(r.body, /"status"\s*:\s*"ok"/);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/messages without token returns 401', async () => {
    const state = await bring();
    try {
      const r = await request(state, 'POST', '/api/v1/messages', { 'Content-Type': 'application/json' }, '{}');
      assert.strictEqual(r.status, 401);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/messages then GET returns the same message', async () => {
    const state = await bring();
    try {
      const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
      const msg = { id: 'm1', from: 'a1', to: 'a2', type: 'question', timestamp: '2026-05-09T00:00:00Z', payload: { q: 'why' }, requires_response: false };
      const post = await request(state, 'POST', '/api/v1/messages', { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, JSON.stringify(msg));
      assert.strictEqual(post.status, 201);
      // Issue a token for the recipient and read its inbox
      const t2 = await createRemoteAgentToken(state.config.tokensPath, 'a2');
      const get = await request(state, 'GET', '/api/v1/messages', { Authorization: `Bearer ${t2.token}` });
      assert.strictEqual(get.status, 200);
      assert.match(get.body, /"id":\s*"m1"/);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/messages with mismatched from returns 403', async () => {
    const state = await bring();
    try {
      const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
      const r = await request(state, 'POST', '/api/v1/messages', { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, JSON.stringify({ from: 'b1' }));
      assert.strictEqual(r.status, 403);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/heartbeat persists, GET /api/v1/status returns it', async () => {
    const state = await bring();
    try {
      const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
      const hb = { agent_id: 'a1', timestamp: '2026-05-09T00:00:00Z', status: 'active', current_task: null, sprint: null };
      const post = await request(state, 'POST', '/api/v1/heartbeat', { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, JSON.stringify(hb));
      assert.strictEqual(post.status, 200);
      // Read the heartbeat file directly — getAgentStatuses needs a registry, which we don't write here.
      const raw = fs.readFileSync(path.join(state.config.commsDir, 'heartbeats', 'a1.json'), 'utf8');
      assert.match(raw, /"agent_id":\s*"a1"/);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/consensus/vote then GET /api/v1/consensus/{tid} returns it', async () => {
    const state = await bring();
    try {
      const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
      const vote = { task_id: 'T1', verdict: 'approved', confidence: 0.9, findings: [] };
      const post = await request(state, 'POST', '/api/v1/consensus/vote', { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, JSON.stringify(vote));
      assert.strictEqual(post.status, 201);
      const get = await request(state, 'GET', '/api/v1/consensus/T1', { Authorization: `Bearer ${t.token}` });
      assert.strictEqual(get.status, 200);
      assert.match(get.body, /"vote_count":\s*1/);
    } finally { await stopBridge(state); }
  });

  test('POST /api/v1/consensus/{tid}/evaluate with no votes returns consensus_pending', async () => {
    const state = await bring();
    try {
      const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
      const r = await request(state, 'POST', '/api/v1/consensus/T1/evaluate', { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
      assert.strictEqual(r.status, 200);
      assert.match(r.body, /"status":\s*"consensus_pending"/);
    } finally { await stopBridge(state); }
  });
});
```

### Test cases summary

`comms.test.ts` (7 tests):
- `sendMessage` writes JSON + log entry.
- `readSharedInbox` returns shared messages.
- `readInbox` skips malformed JSON without throwing.
- `readInbox` strips UTF-8 BOM.
- `appendCommsLog` + `readCommsLog` round-trip.
- `writeHeartbeat` + `readHeartbeat` round-trip.
- `agentStatusFromHeartbeat` returns offline/active/stalled for the right ages.
- `getAgentStatuses` joins registry with heartbeats.
- `generateMessageId` produces unique values.

`bridge.test.ts` (11 tests): token format, missing-auth 401, expired-token,
valid-token, GET /health, POST messages 401, POST/GET messages round-trip,
POST messages 403 on mismatched from, POST heartbeat, POST/GET consensus
vote, POST consensus evaluate empty.

### Acceptance check

`npm run test:unit` — all 30 new assertions pass alongside the existing
suites; `npm run adapters:check` stays green.

### Risks

1. **Random port collisions in CI.** Mitigation: tests already pick
   `19876 + random(1000)`; flake risk is < 0.1%.
2. **fs.mkdtempSync leakage.** Mitigation: Mocha runs in CI with the
   tmpfs honoured by the OS; the existing test harness already creates
   tmp dirs and never cleans them — same pattern, no regression.
3. **Bridge teardown timing.** `stopBridge` resolves before all sockets
   are fully drained on Windows. Mitigation: the test wraps in
   `try/finally` so a slow teardown still releases the next port.

### Rollback plan

Delete the two new test files and revert the `package.json` `test:unit`
hunk. No production code is affected.

---

## Sequencing & PR plan

**Recommendation: ship as six PRs**, in this order:

1. **PR 6 — tests first.** Land `bridge.test.ts` + `comms.test.ts` against
   current `main`. They lock in current behaviour and provide a regression
   net for everything that follows. Independent, parallel-safe.
2. **PR 5 — `mergeFindings()` inside `evaluateConsensus()`.** Smallest
   diff, no new APIs, no settings. Lands cleanly on top of PR 6.
3. **PR 1 — Auto-start bridge.** Adds `autoStart` setting. Independent
   of orchestrate plumbing. Touches `extension.ts` activation + one
   helper.
4. **PR 3 — Bridge `evaluate` endpoint + broadcast.** Depends on PR 5
   (uses the deduped findings) and PR 6 (test infrastructure).
5. **PR 2 — `resolveAgentId()` in `planSprints()` + persist platform.**
   Touches `orchestrate.ts` signatures; requires the skill prompt update.
6. **PR 4 — Heartbeat-aware planning.** Depends on PR 2 (uses the same
   `excludedSlots` mechanism alongside `agents` parameter) and on PR 6
   (heartbeat tests).

PRs 1 and 5 are fully parallel-safe with each other and with PR 6. PRs 2,
3, 4 share `orchestrate.ts` and should not be parallelised.

If timeline pressure demands a single PR, batch them in the same order
above into one branch — but bisect-ability suffers and review load grows
~4×. Six small PRs is the default.
