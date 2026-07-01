# TaskSpec `tasks.yaml` Contract

Status: active
Owner: product-architecture
Created: 2026-07-01

## Summary

TaskSpec is AutoClaw's canonical task-list contract for spec-driven work.
VoidSpec remains a compatible external producer of the same `tasks.yaml` shape;
AutoClaw consumes that file, mirrors tasks into its own execution state, and
writes status back when execution progresses.

The boundary is deliberate:

- TaskSpec/VoidSpec owns **what** to build: IDs, titles, descriptions,
  dependencies, acceptance gates, intent, and constraints.
- AutoClaw owns **how far** execution has progressed: pending, in progress,
  blocked, or complete.

AutoClaw must not rewrite task meaning, dependencies, or acceptance criteria as
part of sync. It may write execution status back to the task file.

## File Location

Default:

```text
<workspace>/.voidspec/tasks.yaml
```

AutoClaw may also consume a user-selected path, but the parsed document shape is
the same.

## Document Shape

```yaml
project: example-api
version: "1.0"
tasks:
  - id: T-001
    title: Build OAuth callback handler
    status: todo
    description: |
      Add the callback route, token exchange, session write, and failure path.
      Keep provider-specific secrets outside source control.
    depends_on:
      - T-000
    owner: claude-code
    tags: [auth, backend]
    intent: code
    success:
      gates:
        - npm run compile
        - npm run test:unit
    constraints:
      routing_profile: balanced
      allowed_localities: [local, lan]
      privacy_locality: [local]
      max_cost_cents: 25
      prompt_harness_id: qwen-local
    preferred_scaffold: scaffold-code-balanced
    priority: high
```

## Top-Level Fields

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `project` | string | no | Project/spec name. |
| `version` | string | no | Free-form document version. |
| `tasks` | array | yes | Ordered task list. Missing or non-array tasks parse as empty. |

## Task Fields

| Field | Type | Required | Parsed as | Notes |
|---|---:|---:|---|---|
| `id` | string | yes | `VoidSpecTask.id` | Stable ID. Tasks without `id` are dropped. |
| `title` | string | no | `VoidSpecTask.title` | Falls back to `name`, then `id`. |
| `name` | string | no | `VoidSpecTask.title` | Compatibility alias for `title`. |
| `status` | string | no | `VoidSpecTask.status` | Normalized; defaults to `todo`. |
| `description` | string | no | `VoidSpecTask.description` | Supports quoted, plain, literal, and folded YAML scalars. |
| `desc` | string | no | `VoidSpecTask.description` | Compatibility alias for `description`. |
| `depends_on` | array/string | no | `VoidSpecTask.dependsOn` | Preferred dependency field. |
| `dependsOn` | array/string | no | `VoidSpecTask.dependsOn` | Compatibility alias. |
| `deps` | array/string | no | `VoidSpecTask.dependsOn` | Compatibility alias. |
| `owner` | string | no | `VoidSpecTask.owner` | Human/agent owner hint. |
| `assignee` | string | no | `VoidSpecTask.owner` | Compatibility alias. |
| `tags` | array/string | no | `VoidSpecTask.tags` | Free-form labels. |
| `intent` | string | no | `VoidSpecTask.intent` | Must match an AutoClaw workflow intent. |
| `success` | map | no | `VoidSpecTask.success` | Success metadata, currently `gates`. |
| `success_criteria` | map | no | `VoidSpecTask.success` | Compatibility alias for `success`. |
| `successCriteria` | map | no | `VoidSpecTask.success` | Compatibility alias for `success`. |
| `success_gates` | array/string | no | `VoidSpecTask.success.gates` | Shortcut for gate names/commands. |
| `successGates` | array/string | no | `VoidSpecTask.success.gates` | Compatibility alias. |
| `constraints` | map | no | `VoidSpecTask.constraints` | Routing/model/scaffold constraints. |
| `preferred_scaffold` | string | no | `VoidSpecTask.preferredScaffold` | Historical field for preferred Workflow Playbook/scaffold ID. |
| `preferredScaffold` | string | no | `VoidSpecTask.preferredScaffold` | Compatibility alias. |

Unknown scalar task fields are preserved in `VoidSpecTask.extra` for safe
round-trips. Unknown nested maps are ignored by the current parser rather than
stored in `extra`.

## Status Vocabulary

Canonical statuses:

| TaskSpec status | AutoClaw execution status |
|---|---|
| `todo` | `pending` |
| `in_progress` | `in_progress` |
| `blocked` | `blocked` |
| `done` | `complete` |

Accepted synonyms normalize as follows:

| Normalized | Accepted inputs |
|---|---|
| `done` | `done`, `complete`, `completed`, `finished` |
| `in_progress` | `in_progress`, `inprogress`, `doing`, `active`, `wip` |
| `blocked` | `blocked`, `waiting`, `on_hold` |
| `todo` | `todo`, `pending`, `open`, `new`, empty, unknown |

Whitespace and hyphens normalize to underscores before matching, so `on hold`
and `on-hold` both normalize to `blocked`.

## Constraints

`constraints` is optional. Supported fields:

| Field | Type | Notes |
|---|---:|---|
| `routing_profile` / `routingProfile` / `profile` | string | One of `cheap`, `balanced`, `quality`, `local-only`, `air-gapped`, `release-critical`. |
| `allowed_localities` / `allowedLocalities` | array/string | Valid values: `local`, `lan`, `cloud`. |
| `privacy_locality` / `privacyLocality` | array/string | Valid values: `local`, `lan`, `cloud`. |
| `max_cost_cents` / `maxCostCents` | number/string | Parsed as a finite number. |
| `prompt_harness_id` / `promptHarnessId` | string | Prompt harness contract ID. |

## Workflow Intent

`intent` is optional. Supported values follow `WorkflowIntent`:

```text
plan, code, debug, test, review, security, docs, release, refactor, research,
summarize, coordination, benchmark, vision, tool-use, long-context, creative,
cheap-grade
```

Unknown intents are ignored rather than stored.

## Sync Rules

When AutoClaw syncs a TaskSpec/VoidSpec document:

1. Every task with an `id` maps to shared AutoClaw ID `VS-<id>`.
2. Dependencies map through the same shared namespace.
3. Task descriptions split into AutoClaw subtask lines for sprint surfaces.
4. New tasks flow from TaskSpec/VoidSpec into AutoClaw.
5. AutoClaw writes execution status back when its execution state differs.
6. If both sides differ, the conflict is recorded, but AutoClaw execution status
   still wins for status only.
7. TaskSpec/VoidSpec remains authoritative for title, description,
   dependencies, success gates, intent, and constraints.

## Privacy And Safety

TaskSpec files are project artifacts. They should contain acceptance criteria,
requirements, and routing hints, not private prompt bodies, hidden
chain-of-thought, provider API keys, or raw model responses.

Secrets must stay in the user's configured secret store or environment. If a
task needs secret-backed behavior, reference the expected secret name or gate,
not the secret value.

## Compatibility Notes

The current code names are still `VoidSpecDocument`, `VoidSpecTask`, and
`parseVoidSpecYaml` for backward compatibility. New user-facing docs should use
TaskSpec unless specifically referring to the external VoidSpec project or the
compatibility layer.
