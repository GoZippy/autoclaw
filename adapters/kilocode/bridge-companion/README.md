# AutoClaw Kilo Code Bridge Companion

A small VS Code companion extension that lets the AutoClaw orchestrator drive
**Kilo Code** even though Kilo Code has no headless CLI.

## Why this exists

Most AutoClaw-supported hosts (Claude Code, Cursor, Kiro, Gemini CLI) expose a
headless command line, so AutoClaw drives them directly through a *Runner*
(see `docs/rfc/runner-bridge-contract.md` §2–§5).

Kilo Code does not. It only accepts work typed into its chat panel inside VS
Code. The **Bridge** contract (RFC §6) covers exactly this case: a thin VS
Code companion extension that watches for orchestrator messages and relays
them into Kilo's chat panel. The companion interprets nothing — all policy
lives in the orchestrator and `scope.json`.

## What it does

The bridge logic lives in `src/bridge/kilocode.ts` (`KiloCodeBridge`). This
companion extension is the host shell that runs it:

1. On `activate()`, it constructs a `KiloCodeBridge` pointed at the workspace's
   `.autoclaw/orchestrator/comms` directory and calls `bridge.watch()`.
2. The orchestrator writes `outboxes/kilocode/<msg-id>.json` and touches
   `agents/kilocode/ready`.
3. The bridge's file watcher fires, reads each outbox message, and posts its
   `text` into Kilo's chat panel via
   `vscode.commands.executeCommand(<kilo-chat-submit>, text)`.
4. The bridge writes `processed/<msg-id>.json` (audit trail) and clears the
   `ready` flag.
5. Kilo's reply — a normal chat message — is picked up by AutoClaw's session
   heartbeat (the `session_id` is carried through the outbox message) and
   routed back onto the inbox bus like any other agent reply.

If Kilo Code is not installed, or no chat-submit command can be resolved, the
bridge falls back to an **OS toast** (`vscode.window.showWarningMessage`)
telling the user to paste the message from the outbox manually. Nothing is
lost — the outbox file and `processed/<msg-id>.json` record remain.

## Filesystem layout

Rooted at `.autoclaw/orchestrator/comms/`:

```
agents/kilocode/ready          flag the orchestrator touches
outboxes/kilocode/<msg-id>.json  messages to relay
processed/<msg-id>.json          audit record written by the bridge
```

## How it is installed

This companion is **not** published to the VS Code Marketplace. It ships
inside the AutoClaw extension package and is installed on demand:

- Run `autoclaw doctor` (or the `AutoClaw: Install Kilo Bridge` command). If
  Kilo Code is detected but no bridge is active, AutoClaw offers to install
  the companion `.vsix` bundled under this directory.
- Manual install: `code --install-extension autoclaw-kilo-bridge-<version>.vsix`.
- The companion activates on the `workspaceContains:.autoclaw/orchestrator`
  activation event, so it only loads in workspaces AutoClaw manages.

## Dependency notes

- The bridge currently watches the `ready` flag with Node's built-in
  `fs.watch` (see the `createWatcher` shim in `src/bridge/kilocode.ts`). If
  `chokidar` is later added as an AutoClaw dependency, swap that one function
  for `chokidar.watch` — the rest of the bridge is unaffected.
- The `vscode` module is resolved lazily at runtime, so the bridge logic can
  be unit-tested and type-checked outside an extension host.

## Scope

The companion is intentionally minimal. It does not interpret message bodies,
enforce scope, or make routing decisions — those are the orchestrator's job.
It only watches, relays, audits, and clears the flag.
