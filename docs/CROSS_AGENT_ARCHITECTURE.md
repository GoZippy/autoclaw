# AutoClaw Cross-Agent Architecture

## Vision

AutoClaw is a universal multi-agent coordination layer. Install it once in any
VS Code-compatible IDE, and it automatically detects installed AI coding agents,
provisions communication channels between them, and provides a unified dashboard
for monitoring, reviewing, and reverting multi-agent work.

## Design Principles

1. **Zero-config for users** — Install AutoClaw, open a workspace, everything works.
2. **Filesystem is the bus** — Local agents communicate through JSON files in a
   shared directory. No servers, no ports, no configuration.
3. **Remote agents bridge in** — OpenClaw and other remote frameworks connect via
   HTTP webhook bridge that translates to/from the filesystem protocol.
4. **Every action is reversible** — Git worktrees isolate agent work. The comms
   log enables point-in-time revert of any agent's contributions.
5. **Agents are peers, not hierarchy** — Any agent can review any other agent's
   work. Consensus is democratic (configurable threshold).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    AutoClaw Extension Host                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Agent    │  │  Comms   │  │ Orchestr │  │ Dashboard│       │
│  │ Detector  │  │  Engine  │  │  Engine  │  │  Panel   │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       ▼              ▼              ▼              ▼              │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              Unified Message Bus                      │       │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────────┐       │       │
│  │  │Filesystem│  │ Webhook  │  │  Git Worktree │       │       │
│  │  │ Adapter  │  │ Bridge   │  │   Manager     │       │       │
│  │  └─────────┘  └──────────┘  └───────────────┘       │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
           │              │               │
           ▼              ▼               ▼
    Local Agents    Remote Agents    Git Worktrees
    (Kiro, Kilo,    (OpenClaw,       (feat/wa-1,
     Claude, Codex)  custom hosted)   feat/wa-2...)
```

## Gaps and Mitigations

| Gap | Risk | Mitigation |
|-----|------|------------|
| Agent compliance | Agent ignores inbox | Validate messages, show last-check in dashboard |
| Concurrent writes | Two agents same dir | Unique filenames (timestamp + random suffix) |
| Large workspaces | Comms dir grows | 7-day retention, JSONL log is durable record |
| Identity spoofing | Agent impersonates | Low risk locally; API key scoping for remote |
| Revert cascades | Revert breaks downstream | Dependency chains shown, sprint-level revert |
| Network reliability | Bridge unreachable | Local queue with retry, heartbeat timeout |

## Implementation Phases

**Phase 1 (v1.3.x)** — Local Multi-Agent ✅ Mostly Done
**Phase 2 (v1.4.0)** — Dashboard + Comms Log
**Phase 3 (v1.5.0)** — Git Time-Travel
**Phase 4 (v2.0.0)** — OpenClaw Bridge + Remote Agents
