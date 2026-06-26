### How an AutoClaw team works

AutoClaw puts several AI coding agents to work on **one repo at the same time**, and keeps them out of each other's way.

You give each agent a **role** — what it works on (coder, reviewer, security, ops…). AutoClaw derives its **behavioral type** — how it's trusted and reviewed:

| role | becomes | meaning |
|---|---|---|
| reviewer / security | **auditor** | read-only · needs sign-off |
| coder / tester / docs | **coder** | edits the repo · majority review |
| orchestrator | **supervisor** | coordinates others |
| researcher / ops | **runner** | one job, returns a result |

You almost never set the type yourself — pick the role and take the suggestion.
