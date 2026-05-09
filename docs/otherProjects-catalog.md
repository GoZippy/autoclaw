# otherProjects Catalog — Cross-Pollination Sources for AutoClaw

Source list: [otherProjects.md](./otherProjects.md). Repos under `github.com/GoZippy/` are clones, forks, or inspirations the user owns. This catalog captures which ones are worth mining for AutoClaw's distributed-agent fabric and which to skip. Treat upstream code as untrusted (possible telemetry / supply-chain risk) — borrow patterns, do not blind-copy.

Generated 2026-05-09. All entries derived from public READMEs via `gh api` and WebFetch. No code was modified outside this file.

---

## 1. Agent orchestration & coding-harness

### GoZippy/ralph-orchestrator
- **What:** Iterative "Ralph Wiggum"-style loop runner that drives multiple AI coding backends until tests/lints/typecheck all pass.
- **Stack:** Rust (76%) + TypeScript + Python; Claude Code, Gemini CLI, Codex backends; MCP server mode; web dashboard (alpha).
- **Coord/protocol ideas:** "Hat system" of personas (code-assist, debug, research, review) coordinated by events; backpressure gates that reject incomplete work.
- **Knowledge/memory ideas:** Persistent task tracking across iterations enabling continuous learning.
- **Borrow:** Backpressure-gate pattern (verify before advancing), iteration-loop runtime, MCP-as-control-surface idea, Telegram human-in-the-loop hook.
- **Risk:** Upstream `mikeyobrien/ralph-orchestrator`; MIT; no telemetry noted.

### GoZippy/agentflow
- **What:** Programmatic graph orchestrator for thousands of agents/harnesses with parallel `fanout`/`merge` operators and remote (EC2/ECS/SSH) execution.
- **Stack:** Python (90%) + Node; SSH/EC2/ECS Fargate auto-discovery.
- **Coord/protocol ideas:** Directed-graph pipelines, `on_failure` retry callbacks, success-criteria loops with max-iter caps, zero-config remote spawn.
- **Knowledge/memory ideas:** "Scratchboard" — shared mutable memory accessible to every agent in a graph (close cousin to AutoClaw's shared inbox).
- **Borrow:** DAG executor with fanout/merge primitives + scratchboard idea — very close fit for AutoClaw's orchestrate skill.
- **Risk:** Upstream `berabuddies/agentflow`; license/telemetry not specified — flag before vendoring.

### GoZippy/conducty
- **What:** Batch-planning orchestrator for Claude Code that turns prompt-loops into a Shape→Plan→Trace→Execute→Verify→Improve→Review→Ship cycle.
- **Stack:** JavaScript/Shell installer; uses Claude Code Task tool + Codex MCP server; Obsidian vault as context engine.
- **Coord/protocol ideas:** Tracer-first validation, evidence-based gates between phases, calibrated review intensity (verify-only / spec-review / full-review).
- **Knowledge/memory ideas:** Wikilinked Obsidian vault as persistent project knowledge; failure-pattern + improvement-kata learning loop.
- **Borrow:** Tracer-first execution pattern, calibrated review levels, Obsidian-vault-as-knowledge-graph idea.
- **Risk:** Upstream `robertbarclayy/conducty`; MIT; no telemetry.

### GoZippy/openaide
- **What:** Spawns isolated agent workspaces from {git worktree + tmux session + opencode agent} per branch.
- **Stack:** JavaScript (npm global), tmux, git, opencode.
- **Coord/protocol ideas:** Strict workspace isolation by name with idempotent re-creation; spec.md or inline prompt seeds the agent.
- **Knowledge/memory ideas:** None beyond per-branch filesystem state.
- **Borrow:** Worktree+tmux isolation primitive — directly relevant for AutoClaw's parallel-agent assignments to keep agents from clobbering each other.
- **Risk:** Upstream `trismegis7us/openaide`; license unclear; small project.

### GoZippy/oh-my-codex (OmX)
- **What:** Workflow layer / hooks plugin atop OpenAI Codex CLI providing `$team`, `$ralplan`, `$ralph`, `$ultragoal`, HUD.
- **Stack:** TypeScript; native Codex hooks via `.codex/hooks.json`.
- **Coord/protocol ideas:** `$team` parallel multi-agent execution via tmux on macOS/Linux; persistent `.omx/` state for handoffs.
- **Knowledge/memory ideas:** Durable multi-goal handoff artifacts.
- **Borrow:** Native-hooks integration pattern (don't replace CLI, extend via hooks) is AutoClaw-friendly.
- **Risk:** Upstream `Yeachan-Heo/oh-my-codex`; license unclear.

### GoZippy/everything-claude-code (ecc.tools)
- **What:** Mega-bundle harness optimization: 30 agents, 136 skills, 60+ commands, AgentShield security scanner, instinct-based learning.
- **Stack:** Cross-tool (Claude Code / Cursor / Codex / OpenCode) DRY adapter pattern.
- **Coord/protocol ideas:** Instinct extraction (auto-pattern from sessions w/ confidence scoring), token compaction strategy.
- **Knowledge/memory ideas:** Memory persistence auto save/load across sessions; skill evolution.
- **Borrow:** AgentShield security audit concept (scan agent configs for prompt-injection / misconfig); cross-harness adapter pattern.
- **Risk:** Upstream `affaan-m/everything-claude-code`; MIT; large surface area = larger supply-chain attack surface.

### GoZippy/Enterprise-Crew-skills
- **What:** Production-grade skill collection for OpenClaw including a "council" multi-agent debate skill and a model-orchestrator load balancer.
- **Stack:** Shell-heavy (86%) + JS + Python.
- **Coord/protocol ideas:** Council skill — topic-aware multi-agent structured debate/synthesis; Ralph autonomous loop; release-manager.
- **Knowledge/memory ideas:** Session-cleaner skill that distills raw sessions into readable transcripts.
- **Borrow:** Council debate pattern (multi-perspective synthesis) + model-orchestrator (route by complexity/health/quota/cost) — both highly relevant to AutoClaw's consensus protocol.
- **Risk:** Upstream `h-mascot/Enterprise-Crew-skills`; no license declared — confirm before reuse.

### GoZippy/STFU.md
- **What:** Tiny prompt that cuts agent verbosity ~80%.
- **Stack:** Markdown only.
- **Coord/protocol ideas:** none.
- **Knowledge/memory ideas:** none.
- **Borrow:** Drop into AutoClaw's default agent rules to reduce token usage in inter-agent messages.
- **Risk:** MIT, harmless.

---

## 2. Distributed runtime, bridges, A2A & cross-machine

### GoZippy/clawbridge-a2a
- **What:** Claude Code wrapper exposing it through Discord + Slack with NQA-1 (nuclear-grade quality assurance) audit trail and module-intercept chain.
- **Stack:** TypeScript/pnpm; Discord.js + Slack Bolt; Zod schemas; vector DB + hybrid search; Winston logging.
- **Coord/protocol ideas:** Gateway message router → module intercept chain → fallback to Claude Code; criticality levels (1=CRITICAL → 3=ROUTINE); swarming + model routing (Phase 5 done).
- **Knowledge/memory ideas:** Append-only `.nqa/audit.jsonl`; vector DB + hybrid search; NCR (non-conformance reports) and revisions.
- **Borrow:** Module-intercept-chain gateway, criticality-classified audit log, NCR/IV (independent verification) workflow, vector+hybrid memory layer.
- **Risk:** **License: Proprietary** — do not vendor; safe to study patterns only. Upstream `zsimmons-etumos/clawbridge-a2a`.

### GoZippy/zippymesh-llm-router (ZMLR)
- **What:** OpenAI-compatible local gateway routing across Ollama / OpenAI / Anthropic / Groq / Gemini / Kilo / OpenRouter with virtual keys, prompt cache, ZippyVault credentials, ZippyCoin P2P billing.
- **Stack:** Node 20+; dashboard at :20128; AES-256-GCM credential vault; testnet ZippyCoin mesh.
- **Coord/protocol ideas:** `X-Intent: code` header + constraint headers + automatic fallback chains; per-team virtual keys with token budgets/rate limits.
- **Knowledge/memory ideas:** Exact-match + semantic prompt cache.
- **Borrow:** Smart-routing header convention, virtual-key budget/quota model, fallback chain — drop in front of AutoClaw to centralize LLM access across agents on multiple machines.
- **Risk:** **License: source-available (NOASSERTION)** — review terms; ZippyCoin/billing scope can be disabled.

### GoZippy/Factory-Registry-v1 (Agent Factory)
- **What:** Multi-tenant AI-agent platform with per-customer AWS-account isolation, private Bedrock AgentCore registry, per-tenant MCP endpoint, conversational onboarding wizard, full SOC2/HIPAA/GDPR/PCI/ISO compliance evidence pipeline.
- **Stack:** AWS Lambda (70+ fns), DynamoDB, CloudFormation StackSets, AWS Organizations + SCPs, Cognito, Keycloak/SAML/OIDC/SCIM, OpenTelemetry, X-Ray; 6-region residency.
- **Coord/protocol ideas:** Tenant-router Lambda + AssumeRole SigV4; supervisor-routing + approval-workflow Lambdas; OAuth code flow + RFC 7009 token revocation for MCP marketplace; safety middleware chain (prompt-injection classifier, PII redactor, toxicity, secrets, anomaly).
- **Knowledge/memory ideas:** Per-tenant Athena trace queries (365-day), eval runner (exact/semantic/regex/LLM-judge), drift detector, red-team jailbreak suite.
- **Borrow:** Safety-middleware chain spec, eval-runner + drift detector design, MCP-marketplace OAuth pattern, supervisor-routing + approval-workflow as multi-agent governance primitives.
- **Risk:** Heavy AWS lock-in; license not stated in README. AutoClaw should adopt patterns, not the impl.

### GoZippy/zippy-mcp-kit
- **What:** Cross-platform MCP toolkit (LM Studio / Claude Desktop / Cursor / Windsurf / VS Code) bundling 20+ servers: web search, offline RAG, browser automation, sandboxed Python, notifier, skillport.
- **Stack:** Node + Python (uv) + Docker; PowerShell installer; CLI with 18 commands incl. `doctor`, `supervise` (auto-restart w/ exponential backoff), `tail-tools`, `metrics` (p50/p95/p99 latency).
- **Coord/protocol ideas:** Server supervisor with crash auto-restart; LLM tool-call observability via mcp-proxy wrapper; per-server health-check (`tools/list` round-trip + latency).
- **Knowledge/memory ideas:** Memory MCP server included; offline RAG.
- **Borrow:** **High-value:** the `doctor`/`supervise`/`test`/`metrics` CLI patterns are exactly what AutoClaw needs for fleet health; tool-call audit via mcp-proxy.
- **Risk:** GoZippy-owned, MIT — safe.

### GoZippy/portless
- **What:** Stable named `.localhost` URLs replacing port numbers; auto-CA, auto-`/etc/hosts`, mDNS LAN advertisement, Tailscale, git-worktree-aware subdomains.
- **Stack:** TypeScript pnpm/Turborepo; runs on :80/:443; macOS/Linux/Windows.
- **Coord/protocol ideas:** mDNS for team LAN discovery; worktree branch → subdomain mapping.
- **Knowledge/memory ideas:** none.
- **Borrow:** Stable cross-machine agent addressing (e.g. `agent-claude.localhost`) instead of brittle ports; mDNS advertisement = lightweight capability beacon.
- **Risk:** Upstream `vercel-labs/portless`; Apache-2.0; trustworthy origin.

### GoZippy/pve-gateway
- **What:** Multi-tenant Proxmox VE broker with per-client scoped tokens, allowlisted endpoints, plan→approve→apply pipeline, per-tenant response filtering, append-only SQLite audit log.
- **Stack:** Node 22 + Fastify 5 + better-sqlite3 + undici; systemd; runs as unprivileged user inside an LXC.
- **Coord/protocol ideas:** Plan/approve/apply state machine with admin gate for mutations; capacity checks before mutation; ownership-tag-based row filtering.
- **Knowledge/memory ideas:** SQLite audit log persisting every request and mutation.
- **Borrow:** **Plan→approve→apply** is a near-perfect template for AutoClaw's task review/consensus gate; scoped-token + allowlist pattern protects shared infra accessed by multiple agents.
- **Risk:** GoZippy-owned, MIT.

### GoZippy/pageindex (PageIndex)
- **What:** Vectorless reasoning-based RAG — builds a hierarchical "table of contents" tree per document; LLM navigates instead of vector similarity.
- **Stack:** Python + LiteLLM; OpenAI Agents SDK integration.
- **Coord/protocol ideas:** none.
- **Knowledge/memory ideas:** Tree-of-contents knowledge index; 98.7% on FinanceBench; better explainability/traceability than vectors.
- **Borrow:** Knowledge-graph design alternative for AutoClaw memory — a TOC tree is auditable and editable by humans (vs opaque embeddings).
- **Risk:** Upstream `VectifyAI/PageIndex`; MIT.

### GoZippy/hindsight
- **What:** Agent memory that learns. Three memory types (World Facts, Experiences, Mental Models); parallel Semantic+Keyword+Graph+Temporal recall with cross-encoder rerank; Retain/Recall/Reflect API.
- **Stack:** Python + TypeScript + Rust; PostgreSQL or Oracle backend; multi-LLM (OpenAI/Anthropic/Gemini/Groq/Ollama); embedded mode (no server needed).
- **Coord/protocol ideas:** none.
- **Knowledge/memory ideas:** **Standout** — biomimetic 3-type memory + 4-strategy parallel recall + Reflect-step that synthesizes new connections; SOTA on LongMemEval.
- **Borrow:** Adopt the Retain/Recall/Reflect API shape and 4-parallel-strategy recall pattern for AutoClaw's shared memory; can run embedded.
- **Risk:** Upstream `vectorize-io/hindsight`; MIT.

### GoZippy/beyond-the-token-bottleneck
- **What:** Obsidian research wiki (120+ pages, 1400+ xrefs) on latent-space reasoning and continuous-vector inter-agent communication.
- **Stack:** Obsidian + LaTeX/MathJax/Pandoc.
- **Coord/protocol ideas:** **Standout idea:** 10-level Communication-Depth Spectrum (~15 bits/pos for NL → ~40K bits/pos for hidden-state seqs); LatentMAS 471× compression without retraining.
- **Knowledge/memory ideas:** "LLM-as-active-maintainer" pattern (Karpathy) — LLMs do KB bookkeeping.
- **Borrow:** Long-term: latent-vector A2A channel as a fast-path between AutoClaw agents on the same machine. Near-term: LLM-maintained wiki for AutoClaw docs.
- **Risk:** Upstream `CompleteTech-LLC-AI-Research/...`; **dual license Apache-2.0 + CC BY 4.0** — research content, not code.

### GoZippy/jan-server
- **What:** Self-hosted enterprise agentic LLM platform (`janhq/server`).
- **Stack:** Go microservices (Gin) + PostgreSQL + Redis + Kong + Keycloak OIDC; OpenTelemetry/Prometheus/Jaeger/Grafana; Docker Compose / k8s.
- **Coord/protocol ideas:** Response API multi-step orchestration (max depth 8, 45s timeout); JSON-RPC + REST inter-service; distributed tracing across all services.
- **Knowledge/memory ideas:** S3-backed Media API with `jan_*` IDs and presigned URL resolution; MCP-tool integration native.
- **Borrow:** Distributed-tracing-everywhere for agent fleets; Response API depth/timeout gating; OpenAI-compatible drop-in surface.
- **Risk:** MIT (per writeup); upstream `janhq/server` — large project.

### GoZippy/openclaw-mission-control
- **What:** AI Agent Orchestration Dashboard — manage agents, assign tasks, coordinate via OpenClaw Gateway.
- **Stack:** TS frontend (55%) + Python backend (42%); Docker.
- **Coord/protocol ideas:** Approval-driven governance; gateway-aware orchestration for distributed envs; org→board-group→board→task hierarchy.
- **Knowledge/memory ideas:** Activity timeline / audit trail.
- **Borrow:** Org/board/board-group/task taxonomy for AutoClaw multi-team scenarios; approval-driven governance hooks.
- **Risk:** Upstream `abhi1693/openclaw-mission-control`; MIT.

---

## 3. Knowledge / memory / spec

### GoZippy/OpenSpec
- **What:** Spec-driven development framework — humans + AI align on specs (proposal/spec/design/tasks) before coding; works across 25+ AI tools.
- **Stack:** TypeScript / npm.
- **Coord/protocol ideas:** Slash-command surface (`/opsx:propose`) provider-agnostic; brownfield-ready.
- **Knowledge/memory ideas:** Structured change folders persist as markdown.
- **Borrow:** Folder layout `proposal/spec/design/tasks` is exactly what AutoClaw orchestrate already gestures at — lift the schema directly.
- **Risk:** Upstream `Fission-AI/OpenSpec`; MIT; **anonymous usage telemetry on by default** — opt-out via env var; strip before vendoring.

### GoZippy/awesome-design-md
- **What:** Curated DESIGN.md files extracted from popular sites; agents read them to build matching UIs.
- **Stack:** Markdown only.
- **Borrow:** Pattern of capturing design systems as plain MD for any agent — consider a similar `RUNTIME.md` / `PROTOCOL.md` per-machine spec for AutoClaw fleet.
- **Risk:** Upstream `VoltAgent/awesome-design-md`; MIT.

### GoZippy/awesome-llm-apps
- **What:** Curated catalog of LLM apps (RAG / agents / multi-agent teams).
- **Stack:** Reference repo only.
- **Borrow:** Reference patterns: agent specialization, MCP/function-calling, structured outputs via Pydantic, agent handoffs.
- **Risk:** Upstream `Shubhamsaboo/awesome-llm-apps`; Apache-2.0.

---

## 4. UI / dashboards / fleet visualization

### GoZippy/acc-agent-command-center
- **What:** Single dashboard auto-discovering MCP servers, agents, hooks, cron jobs, and repos from `~/.claude/`, settings.json, and standard project dirs.
- **Stack:** React 19 + TS 5.9 + Tailwind 4.2 + Vite 8 + React Flow; Python stdlib scanner.
- **Coord/protocol ideas:** Auto-sync hook on session close; 11-file gitignored JSON schema.
- **Knowledge/memory ideas:** Radial graph w/ LLM engine as hub; per-project deep dives.
- **Borrow:** **High-value UI**: radial-hub graph + auto-discovery scanner architecture for AutoClaw's fleet dashboard; copy the JSON schema shape.
- **Risk:** Upstream `seang1121/acc-agent-command-center`; MIT.

### GoZippy/hermes-workspace
- **What:** Native web workspace for Hermes Agent — chat / files / memory / skills / inspector / terminal.
- **Stack:** TS/JS (76%); REST + OpenAI-compatible `/v1/chat/completions`; Monaco editor; PTY terminal; Docker / PWA.
- **Coord/protocol ideas:** **Swarm Mode** — orchestrates multiple persistent agents via tmux workers; Tailscale VPN access; graceful degradation when upstream missing.
- **Knowledge/memory ideas:** Memory editor + skills marketplace (2,000+ skills).
- **Borrow:** Swarm-mode tmux-worker orchestration UI, graceful-degradation pattern, marketplace surface for skills.
- **Risk:** Upstream `outsourc-e/hermes-workspace`; MIT; community origin — review before vendoring.

### GoZippy/hermesworld
- **What:** Sidebar dashboard plugin embedding HermesWorld runtime into Hermes Agent's dashboard.
- **Stack:** Python plugin manifest + JS frontend bundle.
- **Borrow:** Dashboard-plugin manifest pattern (`plugin.yaml` + JS bundle) — useful for AutoClaw extensible UI.
- **Risk:** Upstream `outsourc-e/hermesworld`; MIT; pulls live content from hermes-world.ai (network telemetry surface).

### GoZippy/hermes-desktop-os1 (OS1)
- **What:** Native macOS app talking directly to Orgo cloud computers (HTTP API + per-VM websocket terminals) and SSH hosts; auto-installs Hermes Agent on fresh VMs.
- **Stack:** Swift 96%; Keychain credential store; WebRTC realtime voice via OpenAI; macOS 14+.
- **Coord/protocol ideas:** Per-VM websocket terminals; one-click cloud provisioning (60-90s); Kanban + cron + skills viewer.
- **Knowledge/memory ideas:** Sessions browser w/ full-text search.
- **Borrow:** Per-VM-websocket pattern for cross-machine agent terminal mux; Keychain-based credential storage; auto-install-on-fresh-VM bootstrap.
- **Risk:** Forked from `dodo-reach/hermes-desktop`; MIT; ties to Orgo cloud — fine to study, not vendor.

### GoZippy/hermes-agent
- **What:** Agent framework with built-in learning loop, autonomous skill creation, six terminal backends (local/Docker/SSH/Daytona/Singularity/Modal), gateway bridging Telegram/Discord/Slack/WhatsApp/Signal.
- **Stack:** Python + Node; FTS5 session search; Honcho dialectic memory.
- **Coord/protocol ideas:** Subagents via RPC; unified gateway across messaging platforms; agentskills.io standard.
- **Knowledge/memory ideas:** Procedural memory + autonomous skill creation; full-text recall via LLM-summarized FTS5; periodic memory-curation nudges.
- **Borrow:** Six-backend abstraction (incl. SSH + serverless hibernation) for AutoClaw remote execution; agentskills.io interop; FTS5 sessions.
- **Risk:** Upstream `NousResearch/hermes-agent`; MIT.

### GoZippy/cult-ui
- **What:** Tailwind+Shadcn copy-paste components, including 92+ "AI Agent Patterns" (research agent, data analysis, accessibility auditor).
- **Stack:** Tailwind/Shadcn React.
- **Borrow:** Component library for AutoClaw mission-control dashboard.
- **Risk:** Upstream `nolly-studio/cult-ui`; MIT.

### GoZippy/sleek-ui
- **What:** "Unsplash of design systems for AI agents" — point a JSON URL at your project to re-skin.
- **Stack:** JSON design tokens.
- **Borrow:** Design-token URL idea for theming AutoClaw dashboards.
- **Risk:** Upstream `luongnv89/sleek-ui`; MIT.

### GoZippy/open-design
- **What:** Local-first OSS alternative to Anthropic's Claude Design — 19 skills, 71 design systems; delegates to your laptop's coding agents.
- **Stack:** SQLite (`.od/app.sqlite`) gitignored; runs across Claude Code / Codex / Cursor / Gemini / OpenCode / Qwen / Copilot / Hermes / Kimi.
- **Borrow:** "Delegate to local agent harness" architecture — same shape AutoClaw could expose to any orchestrator.
- **Risk:** Upstream `nexu-io/open-design`; Apache-2.0; no telemetry noted.

### GoZippy/superada-ai
- **What:** Astro blog/timeline tracking SuperAda.ai milestones.
- **Stack:** Astro + TS + MDX.
- **Borrow:** Timeline UX pattern.
- **Risk:** Upstream `h-mascot/superada-ai`; license unstated.

---

## 5. Generalist agents & sandboxed runtimes (study, mostly)

### GoZippy/suna
- **What:** "Kortix Super Worker" — generalist AI agent with browser automation, file ops, web intelligence, sysops in isolated Docker containers.
- **Stack:** Next.js + FastAPI/Python + LiteLLM + Supabase; Dockerized agent execution.
- **Coord/protocol ideas:** none unique.
- **Knowledge/memory ideas:** Supabase conversation history + agent configs.
- **Borrow:** Visual agent builder UX; Docker-sandbox-per-agent isolation.
- **Risk:** Upstream `kortix-ai/suna`; **NOASSERTION license** — check before reuse.

### GoZippy/OpenRoom (VibeApps)
- **What:** Browser-based desktop where an Agent operates pre-built apps (Music, Chess, Email, Diary, Twitter, Album, News) via natural language; rapid app generation via 6-stage workflow.
- **Stack:** React 18 + TS + Vite + Tailwind + IndexedDB pnpm monorepo.
- **Coord/protocol ideas:** Standardized **Action system** every app implements; Vibe Workflow generates whole apps via Claude Code CLI.
- **Knowledge/memory ideas:** Local IndexedDB only; no backend.
- **Borrow:** Standard "Action" interface for apps an agent can drive — directly applicable as AutoClaw's tool/app contract.
- **Risk:** Upstream `MiniMax-AI/OpenRoom`; MIT; **optional Sentry telemetry** (default disabled).

### GoZippy/rowboat
- **What:** Local-first AI coworker that materializes work as an Obsidian-compatible Markdown knowledge graph and acts on it.
- **Stack:** TS (97%) + Python + Docker; MCP for tools; Composio integrations; Ollama/LM Studio/hosted APIs.
- **Coord/protocol ideas:** MCP-everywhere.
- **Knowledge/memory ideas:** **Markdown knowledge graph** w/ Live Notes auto-updating per person/company/topic; Meeting Prep briefings.
- **Borrow:** Markdown-as-KG persistent memory + Live-Notes auto-curation pattern.
- **Risk:** Upstream `rowboatlabs/rowboat`; Apache-2.0.

---

## 6. Domain-specific (DJ / video / 3D / blockchain / fine-tune) — likely skip

### GoZippy/ZippyVerse_DJ_Live_v1
- **What:** Microservices platform for live DJ requests, P2P node rewards, audio streaming.
- **Stack:** Polyglot microservices (api-gateway, orchestration-service, wallet-service, dj-request-service, media-delivery, analytics, payment, browser-extension, web-component).
- **Borrow:** `orchestration-service` naming + service decomposition; embeddable `<zippy-radio>` web-component pattern.
- **Risk:** GoZippy original; license not in extracted README — assume internal.

### GoZippy/openshorts
- **What:** OSS AI video platform (clip generator, AI Shorts UGC, YouTube Studio) self-hosted via Docker.
- **Borrow:** skip.
- **Risk:** Upstream `mutonby/openshorts`; MIT.

### GoZippy/hyperframes
- **What:** HTML→video composition framework "built for agents" with skills teaching CLI/GSAP.
- **Stack:** Apache-2.0; Docker / local render.
- **Borrow:** Skill-pack-as-docs pattern; agent-friendly deterministic pipeline.
- **Risk:** Upstream `heygen-com/hyperframes`; Apache-2.0.

### GoZippy/video-use
- **What:** Claude-driven video editing reading footage as transcripts (~12KB) + on-demand visual composites; spawns parallel sub-agents for animation.
- **Borrow:** **Compact-representation principle** — feed agents textual proxies of large media instead of raw bytes; applies to AutoClaw session recording observability.
- **Risk:** Upstream `browser-use/video-use`; license not stated.

### GoZippy/playcanvas_engine
- **What:** WebGL/WebGPU/WebXR/glTF graphics engine.
- **Borrow:** skip (unless 3D fleet visualization is desired).
- **Risk:** Upstream `playcanvas/engine`; MIT.

### GoZippy/orbit-3d-showcase (Orbit3D / ZippyVerse v2)
- **What:** React+Three.js+Supabase 3D space-trader/colony PWA.
- **Borrow:** skip; could inspire 3D agent-fleet visualization later.
- **Risk:** GoZippy original.

### GoZippy/gradient-bang
- **What:** Pipecat-driven multiplayer universe with LLM-NPCs, voice <500ms latency, cooperative PvE.
- **Stack:** Supabase + Pipecat + React.
- **Coord/protocol ideas:** Multi-agent + game-state sync via edge fns; Claude extended-thinking for strategy.
- **Borrow:** Voice-first low-latency pattern for human↔fleet command channel.
- **Risk:** Upstream `pipecat-ai/gradient-bang`; Apache-2.0; **optional W&B Weave + AWS S3 + Daily analytics** — disable for AutoClaw.

### GoZippy/lingbot-map
- **What:** Feed-forward 3D scene reconstruction foundation model from streaming video (~20 FPS).
- **Borrow:** skip.
- **Risk:** Upstream `Robbyant/lingbot-map`; Apache-2.0.

### GoZippy/DeepTutor
- **What:** Agent-native learning assistant (Chat / Deep Solve / Quiz / Deep Research / Math Animator / Visualize) with autonomous TutorBots.
- **Borrow:** "Independent workspaces per autonomous bot" pattern (similar to openaide).
- **Risk:** Upstream `HKUDS/DeepTutor`; Apache-2.0.

### GoZippy/LlamaFactory
- **What:** Unified efficient fine-tuning of 100+ LLMs/VLMs (ACL 2024).
- **Borrow:** skip — only relevant if AutoClaw trains custom adapters.
- **Risk:** Upstream `hiyouga/LlamaFactory`; Apache-2.0.

### GoZippy/zippycoin-core
- **What:** Quantum-resistant blockchain monorepo (Rust core, Solidity contracts, web/mobile/desktop apps, api-gateway, node-service, wallet-service, trust-engine).
- **Borrow:** **trust-engine** service — name + concept potentially reusable for AutoClaw inter-agent reputation; otherwise skip.
- **Risk:** GoZippy original; MIT/Apache-2.0 dual.

### GoZippy/databasement
- **What:** Self-hosted DB backup manager w/ web UI, REST API, MCP server.
- **Borrow:** Could underpin AutoClaw state-snapshot recovery; otherwise skip.
- **Risk:** Upstream `David-Crty/databasement`; MIT.

### GoZippy/nix-steipete-tools
- **What:** Nix packaging for openclaw plugin tools (summarize, discrawl, peekaboo, poltergeist, sag, imsg, CodexBar, ...).
- **Borrow:** Reproducible packaging for AutoClaw-side deps via Nix.
- **Risk:** Upstream `openclaw/nix-openclaw-tools`; MIT for packaging only.

---

## 7. Top 8 cross-pollination targets for AutoClaw

Ranked by direct fit with AutoClaw's distributed-agent fabric goals (orchestration, A2A, knowledge, heartbeat/health, fleet UI):

1. **agentflow** — DAG executor + `fanout`/`merge` + `scratchboard` shared memory. Closest match to the orchestrate skill's needs; lift the operator API shape.
2. **hindsight** — Retain/Recall/Reflect API and 4-strategy parallel recall (semantic+keyword+graph+temporal) with cross-encoder rerank. Drop-in candidate for AutoClaw shared memory.
3. **acc-agent-command-center** — Auto-discovery scanner + radial-hub React Flow dashboard. Direct UI template for AutoClaw fleet mission-control.
4. **zippy-mcp-kit** — `doctor`/`supervise`/`test`/`metrics` (p50/p95/p99) CLI + mcp-proxy tool-call observability. Best off-the-shelf health/heartbeat surface for AutoClaw agents.
5. **pve-gateway** — Plan→approve→apply pipeline with scoped tokens, allowlist, per-tenant filtering, append-only SQLite audit. Template for AutoClaw consensus/approval gates and shared-infra brokerage.
6. **clawbridge-a2a** — Module-intercept-chain gateway, NQA-1 criticality levels, NCR + IV workflow. Study only (proprietary) — but the architecture maps cleanly onto AutoClaw's review-gate consensus.
7. **conducty** — Tracer-first execution + calibrated review intensity + Obsidian wikilinked context. Borrow the cycle phases and review-tier idea for orchestrate sprint plans.
8. **portless** — Stable named-URL + mDNS LAN beacon. Cleanest cross-machine agent addressing primitive; pairs with hermes-desktop-os1's per-VM-websocket pattern.

Honorable mentions: **rowboat** (Markdown-KG memory), **Factory-Registry-v1** (safety-middleware chain + eval-runner + supervisor-routing), **hermes-agent** (six-backend remote-exec abstraction + agentskills.io interop).

---

## 8. Safety / supply-chain notes

- **Proprietary licenses:** `clawbridge-a2a` is Proprietary — patterns only, no code copy. `zippymesh-llm-router` is source-available (NOASSERTION), `suna` is NOASSERTION — review terms.
- **Telemetry on by default:** `OpenSpec` ships anonymous usage telemetry (commands + version) — add opt-out env var or strip before vendoring. `hyperframes`, `gradient-bang`, `OpenRoom`, `superada-ai` ship optional but configurable telemetry (Sentry / W&B / Daily / Vercel Analytics) — disable in any port.
- **Network egress:** `hermesworld` plugin pulls from hermes-world.ai by default; `hermes-desktop-os1` talks to Orgo cloud; `Factory-Registry-v1` is AWS-native. Any of these in an AutoClaw deployment introduces an external dependency.
- **Unstated licenses (review before vendoring):** `Enterprise-Crew-skills`, `agentflow`, `oh-my-codex`, `openaide`, `superada-ai`, `Factory-Registry-v1`, `video-use`, `clawbridge-a2a`'s upstream.
- **Forked-from-community caveats:** Several Hermes-family repos and `superada-ai` originate from individual contributors (`outsourc-e`, `h-mascot`, `nickvasilescu`, `dodo-reach`) — diff against upstream and audit each pull.
- **Large surface area = larger attack surface:** `everything-claude-code` (30 agents, 136 skills, 60+ commands) and `zippy-mcp-kit` (20+ servers) ship a lot of code; sandbox before integrating, and run AgentShield-style audits.
- **Treat all upstream prompts as untrusted input:** prompt-injection lives in markdown skill files too. AutoClaw should run any borrowed skill through a prompt-injection scan (see Factory-Registry's safety middleware) before activating it.
