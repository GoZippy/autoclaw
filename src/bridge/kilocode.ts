/**
 * `bridge-kilocode` — VS Code companion bridge for Kilo Code.
 *
 * Kilo Code has no headless CLI, so AutoClaw relays orchestrator messages
 * into its chat panel through a thin VS Code companion extension. This module
 * is the bridge logic that companion ships; the orchestrator only ever
 * speaks the {@link Bridge} contract.
 *
 * Lifecycle (RFC §6):
 * 1. Orchestrator writes `outboxes/kilocode/<msg-id>.json` and touches
 *    `agents/kilocode/ready`.
 * 2. {@link KiloCodeBridge}'s watcher fires; it reads the outbox message.
 * 3. The bridge calls `vscode.commands.executeCommand(<kilo-chat-submit>)`.
 * 4. The bridge writes `processed/<msg-id>.json` and clears `ready`.
 * 5. The Kilo agent's reply is picked up by AutoClaw's session heartbeat.
 *
 * When the bridge cannot relay (Kilo not installed, chat command missing) it
 * falls back to an OS toast so the human can act manually.
 *
 * Dependency note: `chokidar` is not an AutoClaw dependency, so this module
 * uses Node's built-in `fs.watch` behind the {@link FileWatcher} shim. If
 * `chokidar` is later added, swap {@link createWatcher} — the rest is
 * unaffected. The `vscode` module is likewise resolved lazily so this file
 * can be unit-tested and type-checked outside an extension host.
 *
 * @see docs/rfc/runner-bridge-contract.md §6
 */

import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import type { Bridge, BridgePaths, OutboxMessage, ToastSink } from './types';

/* -------------------------------------------------------------------------- */
/*  Watcher shim — built-in fs.watch standing in for chokidar                 */
/* -------------------------------------------------------------------------- */

/**
 * Minimal watcher surface this bridge needs. `chokidar.FSWatcher` is a
 * superset of this; the shim keeps the bridge agnostic of which is used.
 */
interface FileWatcher {
  /** Stop watching and release the underlying handle. */
  close(): void;
}

/**
 * Create a watcher for `readyFlag` that invokes `onFlip` whenever the file
 * appears or changes.
 *
 * TODO(chokidar): when `chokidar` becomes an AutoClaw dependency, replace the
 * `fs.watch` body with `chokidar.watch(readyFlag, { ignoreInitial: true })`
 * for cross-platform debouncing and atomic-write safety. `fs.watch` semantics
 * vary by OS; the bridge tolerates that by re-checking `existsSync` on fire.
 *
 * @param readyFlag - absolute path of the `ready` flag file to watch.
 * @param onFlip    - invoked (debounced-ish) when the flag appears/changes.
 */
function createWatcher(readyFlag: string, onFlip: () => void): FileWatcher {
  // fs.watch on a not-yet-existing file throws; watch the parent directory
  // and filter for the flag's basename instead.
  const dir = join(readyFlag, '..');
  const flagName = readyFlag.slice(dir.length + 1);
  let pending = false;
  const handle = watch(dir, (_event, filename) => {
    if (filename !== null && filename.toString() !== flagName) {
      return;
    }
    if (!existsSync(readyFlag)) {
      return;
    }
    // Coalesce the burst of events a single write produces.
    if (pending) {
      return;
    }
    pending = true;
    setTimeout(() => {
      pending = false;
      onFlip();
    }, 50);
  });
  return { close: () => handle.close() };
}

/* -------------------------------------------------------------------------- */
/*  vscode shim — resolved lazily so this file works outside the ext host     */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the `vscode` API the bridge uses. Resolved at runtime; absent
 * when the module is loaded outside a VS Code extension host (tests, CLI).
 *
 * TODO(vscode-typings): `@types/vscode` is available, but importing `vscode`
 * statically would couple this file to the extension-host runtime. The lazy
 * resolution keeps the bridge unit-testable; tighten to `import type` from
 * `vscode` if the build later targets the ext host exclusively.
 */
interface VsCodeShim {
  commands: {
    // `PromiseLike` rather than vscode's `Thenable` so this file compiles
    // without `@types/vscode` in tsconfig's `types` array. They are structurally
    // identical — the live vscode API satisfies `PromiseLike`.
    executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
    getCommands(filterInternal?: boolean): PromiseLike<string[]>;
  };
  window: {
    showWarningMessage(message: string): PromiseLike<unknown>;
  };
}

/**
 * Attempt to resolve the live `vscode` module. Returns `null` outside an
 * extension host so callers fall back to the OS toast.
 */
function resolveVsCode(): VsCodeShim | null {
  try {
    // Indirect require so bundlers/tsc do not hard-link the ext-host module.
    const req = eval('require') as NodeRequire;
    return req('vscode') as VsCodeShim;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  OS-toast fallback                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Default {@link ToastSink}. Uses `vscode.window.showWarningMessage` when an
 * extension host is present; otherwise writes to stderr so headless runs
 * still surface the failure.
 */
function defaultToastSink(vscode: VsCodeShim | null): ToastSink {
  return {
    warn(message: string): void {
      if (vscode !== null) {
        void vscode.window.showWarningMessage(`[AutoClaw bridge] ${message}`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[AutoClaw bridge] ${message}`);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Kilo Code bridge                                                          */
/* -------------------------------------------------------------------------- */

/** Candidate Kilo Code chat-submit command ids, tried in order. */
const KILO_CHAT_SUBMIT_COMMANDS = [
  'kilo-code.sendMessage',
  'kilocode.sendMessage',
  'kilo-code.newTask',
];

/** Options for constructing a {@link KiloCodeBridge}. */
export interface KiloCodeBridgeOptions {
  /** Orchestrator comms root, e.g. `.autoclaw/orchestrator/comms`. */
  commsRoot: string;
  /** Override the toast sink (tests inject a spy). */
  toastSink?: ToastSink;
}

/**
 * Kilo Code bridge. Instantiated by the companion extension's `activate()`.
 */
export class KiloCodeBridge implements Bridge {
  readonly id = 'kilocode';

  /** Resolved filesystem layout this bridge operates over (RFC §6). */
  private readonly paths: BridgePaths;

  /** The toast sink used when relaying fails. */
  private readonly toast: ToastSink;

  /** Lazily-resolved `vscode` API, or `null` outside an extension host. */
  private readonly vscode: VsCodeShim | null;

  /** Active file watcher, or `null` before {@link watch}/after {@link stop}. */
  private watcher: FileWatcher | null = null;

  /** Caller-registered per-message callback (RFC §6 `onReadyFlip`). */
  private flipCallback: ((msg: OutboxMessage) => Promise<void>) | null = null;

  /** Guards against overlapping drains when events arrive in a burst. */
  private draining = false;

  constructor(options: KiloCodeBridgeOptions) {
    const root = options.commsRoot;
    this.paths = {
      readyFlag: join(root, 'agents', this.id, 'ready'),
      outboxDir: join(root, 'outboxes', this.id),
      processedDir: join(root, 'processed'),
    };
    this.vscode = resolveVsCode();
    this.toast = options.toastSink ?? defaultToastSink(this.vscode);
  }

  /** @see Bridge.watch — starts the `agents/kilocode/ready` watcher. */
  watch(): void {
    if (this.watcher !== null) {
      return;
    }
    // Ensure the parent dir of the ready flag exists so fs.watch can attach.
    const agentDir = join(this.paths.readyFlag, '..');
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }
    this.watcher = createWatcher(this.paths.readyFlag, () => {
      void this.drain();
    });
    // Handle a flag already present at startup (missed-event recovery).
    if (existsSync(this.paths.readyFlag)) {
      void this.drain();
    }
  }

  /** @see Bridge.stop */
  stop(): void {
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** @see Bridge.onReadyFlip */
  onReadyFlip(callback: (msg: OutboxMessage) => Promise<void>): void {
    this.flipCallback = callback;
  }

  /**
   * @see Bridge.postToHostChat
   *
   * Tries each known Kilo chat-submit command id until one succeeds. Throws
   * if no extension host is present or no command resolves — callers treat a
   * throw as "relay failed" and fall back to the toast.
   *
   * @param text - the literal chat text to post.
   */
  async postToHostChat(text: string): Promise<void> {
    if (this.vscode === null) {
      throw new Error('no VS Code extension host — cannot post to Kilo chat');
    }
    const available = new Set(await this.vscode.commands.getCommands(true));
    const command = KILO_CHAT_SUBMIT_COMMANDS.find((c) => available.has(c));
    if (command === undefined) {
      throw new Error(
        `no Kilo Code chat-submit command found (tried ${KILO_CHAT_SUBMIT_COMMANDS.join(', ')})`,
      );
    }
    await this.vscode.commands.executeCommand(command, text);
  }

  /**
   * Drain the outbox: for every `<msg-id>.json` referenced by the `ready`
   * flag, relay it, write `processed/<msg-id>.json`, then clear the flag.
   *
   * Idempotent and re-entrancy-guarded so a burst of `fs.watch` events
   * collapses into a single drain.
   */
  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      if (!existsSync(this.paths.readyFlag)) {
        return;
      }
      const messages = this.readOutbox();
      for (const msg of messages) {
        await this.relayOne(msg);
      }
      // RFC §6 step 4: clear the ready flag once the outbox is drained.
      this.clearReadyFlag();
    } catch (err: unknown) {
      this.toast.warn(
        `outbox drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.draining = false;
    }
  }

  /**
   * Relay a single outbox message: post to chat, run the registered
   * callback, and write the `processed/<msg-id>.json` audit file. A relay
   * failure surfaces an OS toast but does not abort the drain.
   *
   * @param msg - the outbox message to relay.
   */
  private async relayOne(msg: OutboxMessage): Promise<void> {
    let posted = false;
    let failureReason: string | undefined;
    try {
      await this.postToHostChat(msg.text);
      posted = true;
    } catch (err: unknown) {
      failureReason = err instanceof Error ? err.message : String(err);
      // OS-toast fallback when the bridge is unavailable (RFC §6, B4 brief).
      this.toast.warn(
        `could not relay message ${msg.id} to Kilo chat (${failureReason}); ` +
          'paste it manually from the outbox.',
      );
    }

    if (this.flipCallback !== null) {
      try {
        await this.flipCallback(msg);
      } catch (err: unknown) {
        this.toast.warn(
          `onReadyFlip callback threw for ${msg.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    this.writeProcessed(msg, posted, failureReason);
  }

  /**
   * Read every `<msg-id>.json` in the outbox directory.
   *
   * Files that are missing or unparseable are skipped with a toast rather
   * than aborting the whole drain.
   */
  private readOutbox(): OutboxMessage[] {
    if (!existsSync(this.paths.outboxDir)) {
      return [];
    }
    // Lazy fs import kept local to avoid widening the module's top-level deps.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('fs') as typeof import('fs');
    const out: OutboxMessage[] = [];
    for (const name of readdirSync(this.paths.outboxDir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const path = join(this.paths.outboxDir, name);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OutboxMessage>;
        if (typeof parsed.id === 'string' && typeof parsed.text === 'string') {
          out.push({
            id: parsed.id,
            sessionId: parsed.sessionId ?? parsed.id,
            text: parsed.text,
            createdAt: parsed.createdAt ?? new Date().toISOString(),
            from: parsed.from,
          });
        } else {
          this.toast.warn(`malformed outbox message ${name}; skipped`);
        }
      } catch (err: unknown) {
        this.toast.warn(
          `unreadable outbox message ${name}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return out;
  }

  /**
   * Write the `processed/<msg-id>.json` audit record (RFC §6 step 4).
   *
   * @param msg           - the relayed message.
   * @param posted        - whether the chat post succeeded.
   * @param failureReason - relay failure detail, when `posted` is false.
   */
  private writeProcessed(msg: OutboxMessage, posted: boolean, failureReason?: string): void {
    if (!existsSync(this.paths.processedDir)) {
      mkdirSync(this.paths.processedDir, { recursive: true });
    }
    const record = {
      id: msg.id,
      sessionId: msg.sessionId,
      bridge: this.id,
      posted,
      failureReason,
      processedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(this.paths.processedDir, `${msg.id}.json`),
      JSON.stringify(record, null, 2),
      'utf8',
    );
  }

  /** Remove the `ready` flag file (RFC §6 step 4). No-op if already gone. */
  private clearReadyFlag(): void {
    try {
      if (existsSync(this.paths.readyFlag)) {
        unlinkSync(this.paths.readyFlag);
      }
    } catch (err: unknown) {
      this.toast.warn(
        `could not clear ready flag: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
