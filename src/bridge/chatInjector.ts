/**
 * chatInjector.ts — generic "deliver a prompt to a heterogeneous worker".
 *
 * `KiloCodeBridge` (kilocode.ts) is the CONSUMER side of one IDE: it watches
 * an outbox `ready` flag and injects text into Kilo's chat. What was missing
 * is the PRODUCER side, generalised across every loop mechanism the registry
 * records, so the router + stall-recovery can wake ANY agent the same way.
 *
 * Selection is by the agent's `loop_mechanism` (registry.json / DESIGN.md
 * Gap E):
 *   - `cli-headless`  → write `outboxes/<agent>/<msgId>.json` + touch
 *                       `agents/<agent>/ready` (the exact contract KiloCodeBridge
 *                       and the revive runner consume).
 *   - `plain-message` → try to post into the host chat; on failure, return the
 *                       rendered prompt for the human to paste (keepalive path).
 *   - `slash-loop`    → deliver a `/loop`-style continuation (host post, else
 *                       manual paste).
 *
 * IO is injected (file writer + host poster) so this unit-tests without an
 * extension host or a real filesystem. The default host poster resolves
 * `vscode` lazily, exactly like kilocode.ts, so it is a no-op outside the host.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

/** The loop mechanisms an agent can advertise (registry.json `loop_mechanism`). */
export type LoopMechanism = 'slash-loop' | 'plain-message' | 'cli-headless';

/** A request to deliver `text` to `agentId`. */
export interface InjectRequest {
  agentId: string;
  /** The prompt / task brief / keepalive text to deliver. */
  text: string;
  /** Optional message id; one is generated when absent. */
  msgId?: string;
}

/** How the prompt was (or should be) delivered. */
export type InjectMethod = 'host-chat' | 'outbox' | 'manual-paste';

export interface InjectResult {
  agentId: string;
  mechanism: LoopMechanism;
  /** True when the prompt was delivered programmatically (no human needed). */
  delivered: boolean;
  method: InjectMethod;
  detail: string;
  /** Present for `manual-paste`: the text a human pastes into the agent's chat. */
  prompt?: string;
  /** Present for `outbox`: the files written. */
  artifacts?: string[];
}

/** The injector contract. One implementation per {@link LoopMechanism}. */
export interface ChatInjector {
  readonly mechanism: LoopMechanism;
  inject(req: InjectRequest): Promise<InjectResult>;
}

/** Posts text into the host IDE's chat. Throws when no host/command exists. */
export interface HostChatPoster {
  post(text: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Default host poster (lazy vscode, mirrors kilocode.ts)                    */
/* -------------------------------------------------------------------------- */

interface VsCodeShim {
  commands: {
    executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
    getCommands(filterInternal?: boolean): PromiseLike<string[]>;
  };
}

function resolveVsCode(): VsCodeShim | null {
  try {
    const req = eval('require') as NodeRequire;
    return req('vscode') as VsCodeShim;
  } catch {
    return null;
  }
}

/**
 * A host poster that tries a list of candidate chat-submit command ids. Used
 * for `plain-message` / `slash-loop` agents whose IDE exposes a submit command.
 */
export function commandHostPoster(candidateCommands: string[]): HostChatPoster {
  return {
    async post(text: string): Promise<void> {
      const vscode = resolveVsCode();
      if (vscode === null) {
        throw new Error('no VS Code extension host — cannot post to chat');
      }
      const available = new Set(await vscode.commands.getCommands(true));
      const command = candidateCommands.find(c => available.has(c));
      if (command === undefined) {
        throw new Error(`no chat-submit command found (tried ${candidateCommands.join(', ')})`);
      }
      await vscode.commands.executeCommand(command, text);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  cli-headless — outbox + ready flag                                        */
/* -------------------------------------------------------------------------- */

export interface OutboxInjectorOptions {
  /** Orchestrator comms root, e.g. `.autoclaw/orchestrator/comms`. */
  commsRoot: string;
  /** Clock seam for tests. */
  now?: () => Date;
}

/**
 * `cli-headless` producer. Writes the outbox message and touches the `ready`
 * flag that a headless runner (or `KiloCodeBridge`) consumes.
 */
export class OutboxChatInjector implements ChatInjector {
  readonly mechanism = 'cli-headless' as const;
  private readonly commsRoot: string;
  private readonly now: () => Date;

  constructor(opts: OutboxInjectorOptions) {
    this.commsRoot = opts.commsRoot;
    this.now = opts.now ?? (() => new Date());
  }

  async inject(req: InjectRequest): Promise<InjectResult> {
    const msgId = req.msgId ?? `inj-${this.now().toISOString().replace(/[:.]/g, '-')}-${req.agentId}`;
    const outboxDir = path.join(this.commsRoot, 'outboxes', req.agentId);
    const agentDir = path.join(this.commsRoot, 'agents', req.agentId);
    await fsPromises.mkdir(outboxDir, { recursive: true });
    await fsPromises.mkdir(agentDir, { recursive: true });

    const outboxFile = path.join(outboxDir, `${msgId}.json`);
    const readyFlag = path.join(agentDir, 'ready');
    const message = {
      id: msgId,
      sessionId: msgId,
      text: req.text,
      createdAt: this.now().toISOString(),
      from: 'orchestrator',
    };
    await fsPromises.writeFile(outboxFile, JSON.stringify(message, null, 2), 'utf8');
    await fsPromises.writeFile(readyFlag, this.now().toISOString(), 'utf8');

    return {
      agentId: req.agentId,
      mechanism: this.mechanism,
      delivered: true,
      method: 'outbox',
      detail: `wrote outbox message + ready flag for ${req.agentId}`,
      artifacts: [outboxFile, readyFlag],
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  plain-message / slash-loop — host post with manual-paste fallback         */
/* -------------------------------------------------------------------------- */

export interface HostChatInjectorOptions {
  mechanism: 'plain-message' | 'slash-loop';
  /** Poster used to deliver into the host chat. */
  poster: HostChatPoster;
}

/**
 * Producer for agents that live in-IDE. Tries to post into the host chat;
 * if that fails (no host, no command), returns `manual-paste` with the
 * rendered prompt so the human (or the `/orchestrate revive` flow) can paste
 * it. `slash-loop` wraps the text as a `/loop` continuation.
 */
export class HostChatInjector implements ChatInjector {
  readonly mechanism: 'plain-message' | 'slash-loop';
  private readonly poster: HostChatPoster;

  constructor(opts: HostChatInjectorOptions) {
    this.mechanism = opts.mechanism;
    this.poster = opts.poster;
  }

  private render(text: string): string {
    return this.mechanism === 'slash-loop' ? `/loop ${text}` : text;
  }

  async inject(req: InjectRequest): Promise<InjectResult> {
    const rendered = this.render(req.text);
    try {
      await this.poster.post(rendered);
      return {
        agentId: req.agentId,
        mechanism: this.mechanism,
        delivered: true,
        method: 'host-chat',
        detail: `posted to ${req.agentId} host chat`,
      };
    } catch (err) {
      return {
        agentId: req.agentId,
        mechanism: this.mechanism,
        delivered: false,
        method: 'manual-paste',
        detail: `host post failed (${err instanceof Error ? err.message : String(err)}); paste manually`,
        prompt: rendered,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Factory                                                                   */
/* -------------------------------------------------------------------------- */

/** Default chat-submit command candidates per known plain-message host. */
const HOST_COMMANDS: Record<string, string[]> = {
  kilocode: ['kilo-code.sendMessage', 'kilocode.sendMessage', 'kilo-code.newTask'],
  default: [],
};

export interface SelectInjectorOptions {
  commsRoot: string;
  /** Override the host poster (tests inject a spy). */
  poster?: HostChatPoster;
  /** Agent id, used to pick default host chat commands. */
  agentId?: string;
  now?: () => Date;
}

/**
 * Select the right {@link ChatInjector} for a loop mechanism. This is the one
 * call the router and stall-recovery use — they never branch on mechanism
 * themselves.
 */
export function selectInjector(mechanism: LoopMechanism, opts: SelectInjectorOptions): ChatInjector {
  if (mechanism === 'cli-headless') {
    return new OutboxChatInjector({ commsRoot: opts.commsRoot, now: opts.now });
  }
  const poster = opts.poster
    ?? commandHostPoster(HOST_COMMANDS[opts.agentId ?? 'default'] ?? HOST_COMMANDS.default);
  return new HostChatInjector({ mechanism, poster });
}
