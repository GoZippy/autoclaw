/**
 * subcontract.ts — Work-subcontracting protocol over the comms bus (B5).
 *
 * AGENT_SESSION_PROTOCOL §3.1 lists a parent↔child subcontract message
 * family: `subcontract_request → subcontract_accept → subcontract_deliver →
 * subcontract_ack | subcontract_reject_with_fixes`. This module is the
 * orchestrator-side state machine that drives that exchange: it builds the
 * messages, writes them into the recipient inboxes as protocol-conformant
 * JSON files (§3 message contract), and validates that each transition is
 * legal for the current contract state.
 *
 * The contract is identified by a `subcontract_id` (a UUID minted by the
 * parent at request time) and carried in every message's `payload`. State is
 * derived from the message stream, not stored separately — the comms bus is
 * the source of truth, so a contract can be reconstructed by replaying the
 * messages that carry its id.
 *
 * `subcontract_reject_with_fixes` is intentionally NOT in the `MessageType`
 * union in `src/comms.ts` (a Sprint-2 file this module must not modify), so
 * the rejection message rides on the bus as a `finding_report`-typed file
 * whose `payload.subcontract_phase` carries the real phase. Every message
 * this module emits stamps `payload.subcontract_phase` so a reader keys off
 * the payload rather than the constrained top-level `type`.
 *
 * Sprint 3 — B5 (WA-3)
 *
 * @see docs/AGENT_SESSION_PROTOCOL.md §3.1
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Protocol phases & state machine                                           */
/* -------------------------------------------------------------------------- */

/**
 * The five subcontract phases. `request → accept → deliver` is the happy
 * path; `deliver` terminates in either `ack` (accepted) or
 * `reject_with_fixes` (bounced back for rework).
 */
export type SubcontractPhase =
  | 'request'
  | 'accept'
  | 'deliver'
  | 'ack'
  | 'reject_with_fixes';

/**
 * Coarse contract state, derived from the most recent phase observed:
 *
 * - `proposed`   — request sent, not yet accepted.
 * - `accepted`   — child accepted; work in progress.
 * - `delivered`  — child delivered; awaiting parent verdict.
 * - `completed`  — parent acked the delivery. Terminal.
 * - `rework`     — parent rejected with fixes; child must re-deliver.
 */
export type SubcontractState =
  | 'proposed'
  | 'accepted'
  | 'delivered'
  | 'completed'
  | 'rework';

/** Phase → resulting contract state. */
const PHASE_TO_STATE: Readonly<Record<SubcontractPhase, SubcontractState>> = {
  request: 'proposed',
  accept: 'accepted',
  deliver: 'delivered',
  ack: 'completed',
  reject_with_fixes: 'rework',
};

/**
 * Legal next phases from each phase. A `reject_with_fixes` returns the
 * contract to a deliver-able state, so the child may `deliver` again.
 */
const LEGAL_TRANSITIONS: Readonly<Record<SubcontractPhase, readonly SubcontractPhase[]>> = {
  request: ['accept', 'reject_with_fixes'],
  accept: ['deliver'],
  deliver: ['ack', 'reject_with_fixes'],
  ack: [],
  reject_with_fixes: ['deliver'],
};

/** A phase from which no further transition is possible. */
export function isTerminalPhase(phase: SubcontractPhase): boolean {
  return LEGAL_TRANSITIONS[phase].length === 0;
}

/**
 * Validate that `next` is a legal transition from `current`. `current` is
 * `null` when no message has been seen yet — only `request` is legal then.
 */
export function isLegalTransition(
  current: SubcontractPhase | null,
  next: SubcontractPhase,
): boolean {
  if (current === null) {
    return next === 'request';
  }
  return LEGAL_TRANSITIONS[current].includes(next);
}

/* -------------------------------------------------------------------------- */
/*  Message shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The payload AutoClaw stamps on every subcontract message. Carried inside
 * the protocol message `payload` (AGENT_SESSION_PROTOCOL §3).
 */
export interface SubcontractPayload {
  /** UUID identifying the contract; stable across all five phases. */
  subcontract_id: string;
  /** The real phase — read this, not the top-level `type` (see file header). */
  subcontract_phase: SubcontractPhase;
  /** The task being subcontracted. */
  task_id: string;
  /** The parent agent that originated the contract. */
  parent: string;
  /** The child agent the work is delegated to. */
  child: string;
  /** Free-form brief / deliverable description / verdict notes. */
  brief?: string;
  /**
   * PA-4: route the subcontract to a named specialized persona (e.g.
   * `security-auditor`, `doc-writer`). When set, the child runs the work
   * under that persona's profile + memory rather than its generic role.
   * Absent ⇒ the child's default behaviour (back-compatible).
   */
  persona_id?: string;
  /** On `reject_with_fixes`: the structured list of required fixes. */
  fixes?: Array<{ detail: string; severity?: 'blocker' | 'major' | 'minor' }>;
  /** On `deliver`: a reference to the produced artifact (branch, diff, …). */
  deliverable?: { kind: string; ref: string; description?: string };
}

/**
 * A full subcontract message as written to an inbox. Mirrors the
 * `InboxMessage` shape from `src/comms/types.ts` but is declared locally so
 * this module stays decoupled from that Sprint-2 file.
 */
export interface SubcontractMessage {
  id: string;
  from: string;
  to: string;
  /**
   * Top-level message type. `subcontract_request`/`_accept`/`_deliver`/`_ack`
   * map to the real `MessageType` union; `reject_with_fixes` has no union
   * member and rides as `finding_report` (see file header).
   */
  type:
    | 'subcontract_request'
    | 'subcontract_accept'
    | 'subcontract_deliver'
    | 'subcontract_ack'
    | 'finding_report';
  timestamp: string;
  task_id: string;
  requires_response: boolean;
  payload: SubcontractPayload;
  /** Carried through so the orchestrator can attribute the message. */
  session_id?: string;
}

/** Map a phase to the top-level message `type` it rides on. */
function typeForPhase(phase: SubcontractPhase): SubcontractMessage['type'] {
  switch (phase) {
    case 'request':
      return 'subcontract_request';
    case 'accept':
      return 'subcontract_accept';
    case 'deliver':
      return 'subcontract_deliver';
    case 'ack':
      return 'subcontract_ack';
    case 'reject_with_fixes':
      // No MessageType member — ride as finding_report (see file header).
      return 'finding_report';
  }
}

/** A phase requires a response unless it is terminal. */
function phaseRequiresResponse(phase: SubcontractPhase): boolean {
  return !isTerminalPhase(phase);
}

/* -------------------------------------------------------------------------- */
/*  Message construction                                                      */
/* -------------------------------------------------------------------------- */

/** Mint a fresh subcontract id. */
export function newSubcontractId(): string {
  return crypto.randomUUID();
}

/** ISO-8601 timestamp with `:`/`.` stripped — safe as a filename component. */
function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Build a subcontract message for `phase`. The `from`/`to` routing is derived
 * from the phase: `request`/`reject_with_fixes`/`ack` flow parent→child or
 * child→parent depending on direction; the helper sets it correctly.
 */
export function buildSubcontractMessage(
  phase: SubcontractPhase,
  payload: Omit<SubcontractPayload, 'subcontract_phase'>,
  opts: { sessionId?: string; now?: Date } = {},
): SubcontractMessage {
  const now = opts.now ?? new Date();
  // request, ack, reject_with_fixes are parent-driven; accept, deliver are child-driven.
  const parentDriven = phase === 'request' || phase === 'ack' || phase === 'reject_with_fixes';
  const from = parentDriven ? payload.parent : payload.child;
  const to = parentDriven ? payload.child : payload.parent;
  return {
    id: `msg-${crypto.randomUUID()}`,
    from,
    to,
    type: typeForPhase(phase),
    timestamp: now.toISOString(),
    task_id: payload.task_id,
    requires_response: phaseRequiresResponse(phase),
    payload: { ...payload, subcontract_phase: phase },
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Bus I/O                                                                   */
/* -------------------------------------------------------------------------- */

/** Inbox directory for a recipient under a comms dir. */
function inboxDir(commsDir: string, agent: string): string {
  return path.join(commsDir, 'inboxes', path.basename(agent));
}

/**
 * Write a subcontract message into its recipient's inbox as a protocol-
 * conformant JSON file (filename per AGENT_SESSION_PROTOCOL §3:
 * `<sortable-ts>-<type>-<from>-<short-session>.json`).
 */
export async function sendSubcontractMessage(
  commsDir: string,
  msg: SubcontractMessage,
): Promise<{ path: string }> {
  const dir = inboxDir(commsDir, msg.to);
  await fsPromises.mkdir(dir, { recursive: true });
  const sessionFrag = (msg.session_id ?? msg.id).slice(0, 8);
  const fileName = `${fileTimestamp(new Date(msg.timestamp))}-${msg.type}-${msg.from}-${sessionFrag}.json`;
  const file = path.join(dir, fileName);
  await fsPromises.writeFile(file, JSON.stringify(msg, null, 2) + '\n', 'utf8');
  return { path: file };
}

/* -------------------------------------------------------------------------- */
/*  Contract driver — the state machine                                       */
/* -------------------------------------------------------------------------- */

/** A subcontract whose state was reconstructed from observed messages. */
export interface SubcontractView {
  subcontract_id: string;
  task_id: string;
  parent: string;
  child: string;
  /** The latest phase observed. */
  phase: SubcontractPhase;
  /** Derived coarse state. */
  state: SubcontractState;
  /** Every phase observed, oldest first. */
  history: SubcontractPhase[];
}

/**
 * Drives one subcontract contract through the protocol. Construct it with the
 * `request` already minted (via {@link SubcontractDriver.open}) or rebuild it
 * from observed messages with {@link SubcontractDriver.fromMessages}.
 *
 * Each transition method:
 *   1. Validates the transition is legal ({@link isLegalTransition}).
 *   2. Builds the next message.
 *   3. Returns it for the caller to send via {@link sendSubcontractMessage}.
 *
 * The driver never writes to disk itself — keeping I/O at the call site makes
 * it trivial to unit-test the state machine in isolation.
 */
export class SubcontractDriver {
  private constructor(
    private readonly id: string,
    private readonly taskId: string,
    private readonly parent: string,
    private readonly child: string,
    private current: SubcontractPhase | null,
    private readonly _history: SubcontractPhase[],
  ) {}

  /**
   * Open a new contract: mints the `subcontract_id` and produces the
   * `request` message. The driver's state advances to `request`.
   */
  static open(
    args: { taskId: string; parent: string; child: string; brief?: string; persona_id?: string },
    opts: { sessionId?: string; now?: Date } = {},
  ): { driver: SubcontractDriver; message: SubcontractMessage } {
    const id = newSubcontractId();
    const driver = new SubcontractDriver(id, args.taskId, args.parent, args.child, null, []);
    const message = driver.advance('request', { brief: args.brief, persona_id: args.persona_id }, opts);
    return { driver, message };
  }

  /**
   * Reconstruct a contract's current state by replaying its messages. The
   * messages need not be sorted — they are ordered by `timestamp` here.
   * Returns `null` if no message carries `subId` or the stream is malformed.
   */
  static fromMessages(subId: string, messages: SubcontractMessage[]): SubcontractDriver | null {
    const relevant = messages
      .filter(m => m.payload?.subcontract_id === subId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (relevant.length === 0) {
      return null;
    }
    const first = relevant[0].payload;
    let current: SubcontractPhase | null = null;
    const history: SubcontractPhase[] = [];
    for (const m of relevant) {
      const next = m.payload?.subcontract_phase;
      if (!next || !isLegalTransition(current, next)) {
        // Malformed stream — stop replaying at the last consistent point.
        break;
      }
      current = next;
      history.push(next);
    }
    if (current === null) {
      return null;
    }
    return new SubcontractDriver(
      subId,
      first.task_id,
      first.parent,
      first.child,
      current,
      history,
    );
  }

  /** Build the next-phase message, validating the transition first. */
  advance(
    phase: SubcontractPhase,
    extra: Partial<Omit<SubcontractPayload, 'subcontract_id' | 'subcontract_phase' | 'task_id' | 'parent' | 'child'>> = {},
    opts: { sessionId?: string; now?: Date } = {},
  ): SubcontractMessage {
    if (!isLegalTransition(this.current, phase)) {
      throw new Error(
        `subcontract ${this.id}: illegal transition ${this.current ?? '(none)'} → ${phase}`,
      );
    }
    const message = buildSubcontractMessage(
      phase,
      {
        subcontract_id: this.id,
        task_id: this.taskId,
        parent: this.parent,
        child: this.child,
        ...extra,
      },
      opts,
    );
    this.current = phase;
    this._history.push(phase);
    return message;
  }

  /** Child accepts the request. */
  accept(brief?: string, opts?: { sessionId?: string; now?: Date }): SubcontractMessage {
    return this.advance('accept', brief !== undefined ? { brief } : {}, opts);
  }

  /** Child delivers completed work. */
  deliver(
    deliverable: SubcontractPayload['deliverable'],
    brief?: string,
    opts?: { sessionId?: string; now?: Date },
  ): SubcontractMessage {
    return this.advance(
      'deliver',
      { ...(deliverable ? { deliverable } : {}), ...(brief !== undefined ? { brief } : {}) },
      opts,
    );
  }

  /** Parent acks the delivery — terminal, the contract is complete. */
  ack(brief?: string, opts?: { sessionId?: string; now?: Date }): SubcontractMessage {
    return this.advance('ack', brief !== undefined ? { brief } : {}, opts);
  }

  /** Parent rejects the delivery (or the request) with required fixes. */
  rejectWithFixes(
    fixes: NonNullable<SubcontractPayload['fixes']>,
    brief?: string,
    opts?: { sessionId?: string; now?: Date },
  ): SubcontractMessage {
    return this.advance(
      'reject_with_fixes',
      { fixes, ...(brief !== undefined ? { brief } : {}) },
      opts,
    );
  }

  /** A read-only snapshot of the contract. */
  view(): SubcontractView {
    if (this.current === null) {
      throw new Error(`subcontract ${this.id}: not yet opened`);
    }
    return {
      subcontract_id: this.id,
      task_id: this.taskId,
      parent: this.parent,
      child: this.child,
      phase: this.current,
      state: PHASE_TO_STATE[this.current],
      history: [...this._history],
    };
  }
}
