# Agent-Daemon Critique & Orchestrator Redesign Sketch

_Author: Claude Code (Opus 4.7), session 2026-05-19. Status: notes / proposal._

Complements [COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) (Kiro, 2026-05-08).
That doc enumerates pain points observed running AutoClaw v2.1 on ZippyPanel.
This doc critiques a specific artifact — `agent-daemon.py` that Kiro produced in
the GovCon project at `<local-projects>/GovCon/zippy-govcon-os-spec/.autoclaw/orchestrator/agent-daemon.py`
— and proposes what the equivalent component should look like inside AutoClaw
itself, most likely in `adapters/claude-code/`.

The user surfaced both because they keep having to hand-tap every agent
(Kilo, Kiro, Cursor, occasionally Claude Code) to check its inbox. Kiro's
recommendation was "add the daemon as a default AutoClaw component, like
KDream." That recommendation is wrong as stated; the daemon as written cannot
play that role. Detail below.

---

## 1. What the daemon actually is

Despite its name, `agent-daemon.py` is **not** an orchestrator. It's a single
agent's polling loop:

```python
self.my_id = "kiro"
self.partner_id = "kilocode"
```

Hardcoded role. It watches its own inbox, occasionally writes to its partner's,
and that's it. It cannot fan out to four agents.

Meanwhile the GovCon `config.yaml` declares four work agents
(`kiro, kilocode, claude-code, windsurf`) with `consensus_threshold: 0.67`.
Only Kiro and Kilo actually participate (`consensus/active/sprint-1-*.json`
contains votes from only those two), which makes the threshold effectively
unanimous-of-two. `claude-code` and `windsurf` are config aspiration, not
behavior.

And it still does not solve the original problem: **polling an inbox does
not wake the IDE chat agent that needs to read the inbox.** Kilo, Kiro,
Cursor are chat agents tied to a human-typed prompt. A polling daemon can
observe "Kilo has mail." It cannot cause Kilo to read it.

## 2. Concrete bugs in the current daemon

Anyone porting this code anywhere must fix these first.

### 2.1 No idempotency — the worst bug

`tick()` handles `task_complete` by sending a fresh `review_request` and never
moves the source file. Every 30s, for every unmoved `task_complete` in the
inbox, it sends another `review_request`. The GovCon inboxes already have
several unmoved `task_complete` and `review_response` files; if this daemon
had actually run continuously, the partner's inbox would now have hundreds of
duplicate review requests.

Fix shape: on first successful read, rename the file into a sibling
`processed/` directory. Rename is atomic on a single filesystem. Also keep
a `state.json` message ledger keyed by `msg.id` recording what's been
responded to, so even a duplicate delivery doesn't double-fire.

### 2.2 Filename collisions under any concurrency

```python
filename = f"{msg_type}-{int(time.time())}.json"
msg["id"] = f"msg-{self.my_id}-{int(time.time())}"
```

Second precision. Two sends in the same second silently overwrite each other.
Use `time.time_ns()` for filenames, `uuid4()` for `msg.id`.

### 2.3 No atomic claim

Two agents reading the same inbox file can both "take" it. The
processed/-rename fix above gives you this for free; whichever process wins
the rename wins the message.

### 2.4 Two sources of truth for sprint status

GovCon's `plan-summary.yaml` says every sprint is `pending`; the per-sprint
YAML files have their own `status:` field that's mutated in place; Kiro's
session log says Sprint 1 is approved and Sprint 2 is in progress. Three
disagreeing views. Pick one source — see §3.

### 2.5 Hardcoded path

`BASE_DIR = Path("<local-projects>/GovCon/zippy-govcon-os-spec")`. Non-portable.
Read from `Path.cwd()` walking up to find `.autoclaw/`, or accept `--root`.

### 2.6 Wakeup latency

`time.sleep(30)` everywhere. Replace with `watchdog` filesystem events to
get sub-second reactivity at ~0% idle CPU. Keep a slow heartbeat tick (~5
min) for stalled-agent detection only.

## 3. What the AutoClaw default should be

Not Kiro's daemon as-is. The right component is a **role-neutral orchestrator
process** that owns the state machine. Suggested shape (this is where the
other session's "naming and additional features" work should slot in):

```
.autoclaw/orchestrator/
  daemon.py             # state machine, single instance, role = "orchestrator"
  state.json            # single source of truth: current sprint, message ledger,
                        # consensus tallies, agent heartbeats
  comms/
    inboxes/{agent}/    # incoming to that agent
    outboxes/{agent}/   # what the orchestrator dispatched (audit trail)
    processed/          # archived inbox files after handling
  agents/
    {agent}/heartbeat   # touched every N sec by the agent — daemon detects stalls
    {agent}/ready       # daemon sets this to signal "you have work"
```

State-machine rules:

- **Inbox handling**: read → move to `processed/` (atomic rename) → write
  ledger entry to `state.json`. Never re-read a processed file.
- **No duplicate fan-out**: ledger keyed by `msg.id` records `responded_at`
  per recipient. If you've already sent the `review_request` triggered by
  `msg.id=X`, you don't send it again — even if a duplicate `X` somehow
  arrives.
- **Dynamic consensus participants**: the participant set is whoever has
  written a heartbeat within the last N minutes, not a hardcoded 4. The
  consensus threshold applies to actual participants, so an absent agent
  doesn't stall the sprint forever.
- **Stall detection**: if an agent's heartbeat is older than N min, daemon
  re-fires its `ready` signal once, then excludes it from consensus until
  it returns.
- **Single source of truth**: `state.json` is canonical for *state* (sprint
  pointer, statuses, ledger). The per-sprint YAML files are *spec* (what
  the sprint is supposed to do). `plan-summary.yaml` is *plan output*,
  generated, not mutated. tasks.md (if any) is reconciled from state, not
  the reverse.

## 4. The autonomy problem the daemon doesn't solve

A passive daemon is insufficient. To actually drive agents you need a per-vendor
dispatch path. The orchestrator writes to `outboxes/{agent}/` and flips
`agents/{agent}/ready`; what happens next depends on the agent:

| Agent       | Wakeup mechanism                                                       | Status                                   |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| Claude Code | Claude Agent SDK headless subprocess spawned by daemon when ready flips| Lives in `adapters/claude-code/` already |
| Cursor      | `cursor-agent` CLI headless                                            | New adapter needed                       |
| Windsurf    | Cascade CLI if/when it lands                                           | Blocked on vendor                        |
| Kiro        | No headless mode known                                                 | Bridge required                          |
| Kilo Code   | No headless mode; chat-only VS Code extension                          | Bridge required                          |

For Kiro and Kilo, "bridge" = a tiny VS Code companion extension that watches
`agents/{agent}/ready`, reads the corresponding `outbox` message, and
auto-submits it into the chat panel. Until that exists those two stay
human-tapped — but the orchestrator should at least fire an OS toast so the
tap is one click, not a hunt across three IDE windows.

This is also where naming matters (other session's scope):

- The orchestrator itself probably wants a name that distinguishes it from
  Kiro's daemon (suggest: `autoclaw-orchestrator` / `acorn` / etc.).
- The bridge extensions need names per IDE (`autoclaw-bridge-kilo`, etc.).
- The headless adapter contract should have a single name across vendors
  (suggest: `agent-runner` interface, with `claude-code-runner`,
  `cursor-runner`, …).

## 5. Why "make it default like KDream" is the wrong framing

KDream is a *real agent* with the ability to take actions; it consolidates
memory and runs continuously *as* an agent. The proposed daemon is a passive
file-watcher with one agent's identity hardcoded. Promoting the latter as a
default normalizes the wrong shape — it makes "polling without ability to
act" the default coordination layer.

The correct comparison is: KDream is to a single agent as the orchestrator
sketched in §3 is to the multi-agent fleet. They're peers in spirit, not
substitutes.

## 6. Suggested follow-ups for the other session

1. **Don't** lift `agent-daemon.py` verbatim into AutoClaw defaults.
2. **Do** build the orchestrator described in §3 inside
   [adapters/](../adapters/) (or wherever the cross-agent contract already lives).
   Start with the state machine + ledger; the wakeup adapters can land
   incrementally per-vendor.
3. **Do** fix bugs §2.1–§2.6 in the GovCon file regardless of what AutoClaw
   ships, since that one is actively being relied on by Kiro right now.
4. **Naming**: see §4. The orchestrator/bridge/runner trio is the surface
   to name.
5. **Open question for the user**: should AutoClaw's default ship with a
   minimum-viable Kilo/Kiro bridge extension, or punt that to consumer
   projects? It's a real lift but it's the linchpin of true autonomy.
