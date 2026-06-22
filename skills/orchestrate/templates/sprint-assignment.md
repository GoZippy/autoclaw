# Sprint {{sprint_number}} Assignment — {{agent_id}}

**Project:** {{project_name}}
**Tasks:** {{task_list}}
**Branch:** {{branch_name}}
**Migration range:** {{migration_range}}
**Packages owned:** {{package_list}}
**Dependencies:** {{dependency_list}}
**Estimated completion:** {{estimated_days}} days

## Intelligence Context Pack
**Read this first:** `.autoclaw/orchestrator/sprints/{{context_pack_path}}`

A grounded pack the orchestrator assembled for you — relevant code retrieved from
this repo, the team's proven patterns, the learned style guide, recent project
memory, and durable knowledge-graph facts. Treat it as retrieved hints, not
authority: verify against the current code before relying on it. If the path
reads `none`, no pack was generated for this assignment.

## Context Files
- Orchestrator config: `.autoclaw/orchestrator/config.yaml`
- Plan summary: `.autoclaw/orchestrator/sprints/plan-summary.yaml`
- Cross-agent protocol — read whichever your host installed: `.claude/rules/cross-agent-protocol.md` (Claude Code), `.clinerules/cross-agent.md` (Cline/KiloCode), `.cursor/rules/cross-agent.mdc` (Cursor), `.kiro/steering/cross-agent.md` (Kiro), `.windsurf/rules/cross-agent.md` (Windsurf), `.agent/rules/cross-agent.md` (Antigravity), `.continue/prompts/cross-agent.prompt` (Continue), or `AGENTS.md`

## Scope Rules
You may ONLY modify files matching these patterns:
{{scope_patterns}}

For shared files (package.json, tsconfig.json, README.md), make only minimal additive changes and notify the orchestrator via the shared inbox.

## Quality Gates
Before signaling completion:
- [ ] `npm run compile` passes (no TypeScript errors)
- [ ] `npm test` passes (all unit + integration tests green)
- [ ] `npm run adapters:check` passes (no adapter drift)
- [ ] All sub-tasks implemented with tests

## Completion Signal
When done:
1. List files created/modified
2. Test count and pass/fail status
3. Any known issues or deferred items
4. Write `task_complete` message to `.autoclaw/orchestrator/comms/inboxes/shared/`
5. Confirm: "Sprint {{sprint_number}} ready for review"
