# Multi-Agent Team Playbook

AutoClaw lets you put several AI coding agents to work on the **same repo at the same time** — and have them stay out of each other's way, review each other's work, and hand off cleanly. This playbook shows you how to put a team together, what the pieces mean, and which ready-made team to reach for.

You don't have to read all of it. If you just want to get going, jump to [Quick start](#quick-start).

---

## The two words you need: role and agent_type

Every agent you add answers two small questions. They sound similar but they're doing different jobs, and once you see the difference the rest is easy.

**Role = what hat the agent wears on the team.** It's the job title you'd put on a board: coder, reviewer, tester, architect, docs, and so on. It's there so you (and the panel) can see at a glance who's doing what. There are **13 roles**:

`orchestrator · architect · product · coder · reviewer · tester · security · designer · creative · docs · researcher · ops · generalist`

**agent_type = how the team treats that agent's work.** It's the safety-and-trust setting. It decides three things automatically:

- **Trust** — is the agent allowed to edit the repo, or read-only?
- **Review rule** — does its output need a majority to approve, a unanimous sign-off, or no formal review?
- **Human-in-the-loop** — does a person have to confirm before its actions count?

There are **6 agent_types**, each with a fixed, built-in posture:

| agent_type | What it is | Edits repo? | Review needed | Person must confirm? |
|---|---|---|---|---|
| **coder** | Builds things | Yes | Majority | No |
| **runner** | One job, returns a result, no session | Yes (its task) | None (result-checked) | No |
| **auditor** | Reviews / audits, never edits | No (read-only) | Unanimous | No |
| **supervisor** | Coordinates other agents | Yes | Majority | No |
| **assistant** | Drafts, schedules, answers | No by default | None | Yes |
| **governance** | Approves, signs off, sets policy | No | None (it's the approver) | Yes |

### Why two fields instead of one?

Because a job title and a trust setting are genuinely different things, and **several roles share the same posture**. A *reviewer* and a *security* analyst are two different jobs on your board — but both are read-only and both should require sign-off, so both are the **auditor** type. Keeping role separate from agent_type lets you label the work clearly *and* get the right safety behavior, without one choice fighting the other.

### You usually only pick the role

For most agents the agent_type follows naturally from the role, and AutoClaw fills it in for you:

| If the role is… | the agent_type becomes… | because… |
|---|---|---|
| orchestrator | supervisor | it coordinates others |
| reviewer / security | auditor | it reads and gates, never edits |
| ops | runner | it runs a job and returns a result |
| researcher | runner | it investigates and returns findings |
| coder / architect / tester / designer / docs | coder | it edits the repo |
| product | governance | it approves and sets requirements |
| creative / generalist | assistant | it drafts and answers, person confirms |

So in practice: **pick the role, take the suggested type, and only override it in the rare case where you want a different posture** — for example a *docs* agent you want to *draft only* (switch it from coder to assistant so a person confirms before anything lands).

---

## Pick a team, not one agent at a time

The fastest way to start is to grab one of the ready-made **team templates** below instead of configuring agents from scratch. Each template is a small squad with the roles, types, scopes, and review rules already chosen and matched to sensible tools. Start from a template, adjust if you need to, go.

### How many agents? (the honest answer: fewer than you think)

More agents is **not** automatically better. Every extra agent adds coordination overhead, and on a single tight problem a strong solo agent plus one reviewer often beats a crowd. Specialization pays off mainly when the work **splits cleanly into parallel pieces** — many files to build, many modules to audit, a bug spread across modules.

Rules of thumb:

- **Default to small.** Solo + Reviewer covers a surprising amount.
- **Add agents only when the work parallelizes.** Two coders only help if they can work on *non-overlapping* paths at the same time.
- **Always pair a builder with a separate checker.** A second agent catches what the first is blind to.
- **Cap parallel workers at 4.** Beyond that the coordination cost outweighs the speedup.

### Which tool for which job?

When a template suggests a tool, it's matched to how that tool joins the team (its "lane") and what it's good at. You can swap in any tool you prefer — the role and type are what matter — but here's the lay of the land:

| Tool | Joins via | Good as |
|---|---|---|
| **Claude Code** | native /loop (in-window) | coder, reviewer — zero extra setup, runs right in your editor |
| **Codex** | MCP server | coder, reviewer — strong second engine for independent review |
| **Claude Desktop** | MCP server | reviewer, supervisor — keep MCP writes OFF for a clean read-only auditor |
| **Hermes** | HTTP bridge | runner, governance — a REST runner, great for fan-out research and sign-off actors |
| **OpenClaw** | filesystem | runner, coder — file-based, good for parallel investigators |
| **Cursor, Cline, Kilo Code, Kiro, Continue, Windsurf, Gemini CLI / Antigravity** | filesystem | coder, tester, reviewer — IDE hosts that drop into the shared comms folder |

A small but useful trick: **use two different tools for the builder and the reviewer.** A review from a different engine is a genuinely independent second opinion.

---

## The team templates

Each template lists its members as **role / agent_type → suggested tool**, with the scope and review rule baked in. Run **AutoClaw: Add Agent Team from Template…** (or the **Add team** button in the panel) to pick one — you'll see the full squad and confirm before anything is created.

### Solo + Reviewer Starter — *recommended default*
The smallest team that still gives you a second set of eyes.
- coder / coder → Claude Code — does the work
- reviewer / auditor → Claude Desktop (read-only) — gates it

One builder, one checker. The reviewer's sign-off is required before a merge. If you're new, start here.

### Feature Build Squad
A full small-org pipeline for shipping a feature.
- orchestrator / supervisor → Claude Desktop — splits and assembles
- architect / coder → Codex — frames the design and interfaces
- coder / coder → Claude Code — builds half (e.g. `src/featureA/**`)
- coder / coder → Cursor — builds the other half (e.g. `src/featureB/**`)
- tester / coder → Kilo Code — writes and runs the tests
- reviewer / auditor → Claude Desktop (read-only) — final unanimous gate

The two coders work on **separate scopes** so they never collide. Auto-admit the coders for speed; keep the supervisor manual.

### Code-Review Gauntlet
Three independent reviewers over one diff; all must agree.
- reviewer / auditor → Claude Desktop
- reviewer / auditor → Codex (different engine)
- security / auditor → Claude Code (security hat)

No builders — just a hard, unanimous gate for a change you can't get wrong. Each is read-only and scoped to the changed paths.

### Test-Hardening Pair
Raise coverage deliberately, scoped to the test tree.
- tester / coder → Claude Code (scope: `test/**`, never production code)
- reviewer / auditor → Claude Desktop — checks the new tests actually assert something

### Security Audit Cell
The strictest team here — for releases and anything touching auth, crypto, secrets, or network.
- security / auditor → Claude Desktop (read-only)
- security / auditor → Codex (read-only, different engine)
- product / governance → Hermes — a **person** signs off last

Two independent read-only security reviews, unanimous, then a human-confirmed governance sign-off.

### Docs Sweep
Bring docs back in line with the code, no shipping code touched.
- docs / coder → Claude Code (scope: `docs/**`, `*.md`, README)
- reviewer / auditor → Kilo Code — checks the docs match reality

If you want the writer to *draft only*, switch its type from coder to **assistant** (a person then confirms before anything lands).

### Research + Synthesis
Investigate in parallel, then bring it together. No repo editing.
- researcher / runner → Hermes — one question, returns a structured report
- researcher / runner → OpenClaw — a second angle
- orchestrator / supervisor → Claude Desktop — synthesizes the findings into one answer

The researchers are runners (one job, no session, no formal review); the supervisor aggregates.

### Bug-Hunt Swarm
Chase a bug across modules in parallel.
- orchestrator / supervisor → Claude Desktop — splits the bug into isolated scopes
- coder / coder → Claude Code (e.g. `src/moduleA/**`)
- coder / coder → Cursor (e.g. `src/moduleB/**`)
- reviewer / auditor → Codex — confirms each fix and a regression test

Best when the bug **decomposes** into non-overlapping paths. Cap at 4 hunters.

### Refactor / Migration Crew
A large mechanical change that must preserve behavior.
- architect / coder → Codex — plans the migration and shared shims
- tester / coder → Kilo Code — pins current behavior in tests **first** (safety net)
- coder / coder → Claude Code (e.g. `src/api/**`)
- coder / coder → Continue (e.g. `src/ui/**`)
- reviewer / auditor → Claude Desktop — confirms behavior is preserved

Run the tester first so there's a net before anything changes.

### Design + Build Pair
A tight front-end loop.
- designer / coder → Claude Code — shapes the UI/UX, styles, layout
- coder / coder → Cursor — wires up behavior on the same surface

Because both touch the same files, they take turns using **scope-leases** rather than working the exact same file at once.

---

## The ground rules every team follows

These are the few rules that keep a team from tripping over itself. AutoClaw enforces them on the shared comms folder (`.autoclaw/orchestrator/comms/`); you mostly just need to understand them.

### 1. Scope-leases — one agent per area at a time
Before an agent edits files, it declares the paths it's working on. If two agents reach for the same files, that's flagged instead of letting them overwrite each other. **This is why templates put each coder on a separate scope.** When two agents genuinely must share a surface (like Design + Build), they take turns — the lease makes the hand-off explicit.

### 2. Claims — the filesystem is the lock
There's a pool of tasks. To pick one up, an agent writes a claim file for it; if the file already exists, someone else got there first and the agent moves on. No two agents work the same task. Simple, and it can't double-book.

### 3. Consensus — how work gets approved
This is the agent_type's review rule in action:
- **majority** (coders, supervisors) — most reviewers approving is enough.
- **unanimous** (auditors) — *every* reviewer must approve. This is why review and security gates are strict by design.
- **none** (runners, assistants, governance) — runners are checked by their result, not a vote; governance *is* the approver.

### 4. Admit policy — who gets to join
When you set up an agent you choose how it's let in:
- **manual** — you personally admit it. Use for supervisors, reviewers, security, and anything sensitive.
- **auto-preapproved** — it can pick up scoped work without you clicking each time. Use for coders on a known scope, so the squad moves fast.
- **open** — anyone matching can join. Reasonable for short-lived, trusted invites only. (Team templates never use `open` — each seat gets its own single-use token instead.)

### 5. The six-phase loop — what each agent actually does
Every agent runs the same simple cycle, then stops (it is **not** an endless loop):

1. **Register** — announce itself to the team.
2. **Sync** — read its inbox and the latest state.
3. **Claim** — grab one unclaimed, in-scope task.
4. **Work** — do it.
5. **Report** — post what it did, request review, vote on others' work.
6. **Loop** — decide whether to go again, or halt.

It halts when you say stop, when its scope hits a conflict, or after a set number of cycles — so a team always reaches a stopping point on its own.

---

## Quick start

1. **Run `AutoClaw: Add Agent Team from Template…`** (Command Palette) or click **Add team** in the agent panel — don't add one agent at a time.
2. **Pick a template.** If unsure, choose **Solo + Reviewer Starter** (the recommended default).
3. **Confirm the squad.** You'll see each member's role, agent_type, suggested tool, scope, and admit policy before anything is created. Nothing is minted until you confirm.
4. **Paste each seat's join prompt** into its tool, from the document AutoClaw opens. For Claude Code this runs in-window on the native /loop; other tools join over MCP, HTTP, or the shared comms folder. Tokens are single-use and expire in 24 hours — re-run the command to mint fresh ones if any expire.
5. **Watch the board.** Agents register, claim scoped work, build, and review each other. Read and security gates won't pass without sign-off.
6. **When you need more hands,** add agents only where the work splits into separate paths — and always keep a separate reviewer in the loop.

That's the whole model: pick roles, let the types set the safety, keep scopes apart, and let the team's review gates do the rest.
