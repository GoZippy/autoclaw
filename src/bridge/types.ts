/**
 * Bridge contract types.
 *
 * Implements the type surface of `docs/rfc/runner-bridge-contract.md` §6.
 *
 * A **Bridge** is a VS Code companion extension for hosts that have *no*
 * headless mode (currently only Kilo Code). Where a {@link import('../runners/types').Runner}
 * drives a CLI directly, a Bridge relays an orchestrator message into the
 * host's chat panel via `vscode.commands.executeCommand`.
 *
 * The bridge is a thin shim — it does not interpret the message body, just
 * relays. All policy lives in the orchestrator + `scope.json`.
 *
 * @see docs/rfc/runner-bridge-contract.md §6
 */

/**
 * A message the orchestrator drops into `outboxes/<bridge-id>/<msg-id>.json`
 * for a bridge to relay into its host's chat panel (RFC §6 step 1).
 *
 * The bridge reads this verbatim and posts {@link text} — it never inspects
 * the semantics of the payload.
 */
export interface OutboxMessage {
  /** Stable, unique message id. Used for the `processed/<msg-id>.json` audit file. */
  id: string;
  /** AutoClaw session id, carried through so the reply heartbeat can correlate (RFC §6 step 5). */
  sessionId: string;
  /** The literal text to post into the host's chat panel. */
  text: string;
  /** ISO timestamp the orchestrator wrote the message. */
  createdAt: string;
  /** Optional originating agent id, for the audit trail. */
  from?: string;
}

/**
 * The common contract every host bridge implements (RFC §6).
 *
 * Lifecycle:
 * 1. Orchestrator writes `outboxes/<id>/<msg-id>.json` and touches
 *    `agents/<id>/ready`.
 * 2. The bridge's file watcher fires; it reads the outbox message.
 * 3. The bridge calls {@link postToHostChat} to post the text.
 * 4. The bridge writes `processed/<msg-id>.json` and clears `ready`.
 * 5. The host agent's reply is picked up by AutoClaw's session heartbeat.
 */
export interface Bridge {
  /** Stable bridge id, e.g. `"kilocode"`. */
  readonly id: string;
  /** Begin watching `agents/<id>/ready` for outbox flips. */
  watch(): void;
  /** Stop watching and release file-system handles. */
  stop(): void;
  /**
   * Register the callback invoked once per outbox message when `ready` flips.
   * The callback resolves after the message has been relayed and audited.
   */
  onReadyFlip(callback: (msg: OutboxMessage) => Promise<void>): void;
  /** Post text into the host's chat panel (host-specific submit command). */
  postToHostChat(text: string): Promise<void>;
}

/**
 * Filesystem layout a bridge operates over, rooted at the orchestrator's
 * comms directory (RFC §6). Paths are absolute once resolved by the bridge.
 */
export interface BridgePaths {
  /** `agents/<id>/ready` — the flag file the orchestrator touches. */
  readyFlag: string;
  /** `outboxes/<id>/` — directory the orchestrator writes `<msg-id>.json` into. */
  outboxDir: string;
  /** `processed/` — directory the bridge writes `<msg-id>.json` audit files into. */
  processedDir: string;
}

/**
 * A minimal toast surface used as the fallback when the bridge cannot relay
 * a message (host not running, chat command unavailable). In a real VS Code
 * host this is `vscode.window.showWarningMessage`; in headless contexts the
 * bridge falls back to an OS toast / stderr.
 */
export interface ToastSink {
  /** Show a warning-level notification to the user. */
  warn(message: string): void;
}
