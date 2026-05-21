import type { MessageType } from '../comms';

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  timestamp: string;
  sprint?: number;
  task_id?: string;
  payload: Record<string, unknown>;
  requires_response: boolean;
  response_deadline?: string;
}

export interface ClaimedMessage {
  message: InboxMessage;
  originalPath: string;
  processedPath: string;
  claimedAt: string;
  claimToken: string;
}

/**
 * Per-message state record persisted at <inboxPath>/_state/<msg_id>.json.
 * Absence of the state file implies the message is unread (backwards-compatible).
 *
 * Owned by WA-3 (inbox state machine — A4).
 */
export interface InboxStateEntry {
  /** Matches the message filename stem (without .json). */
  msg_id: string;
  /** ISO timestamp when the message was first received/detected.
   *  Set to the file mtime on first write if not provided. */
  received_at: string;
  /** ISO timestamp when the agent marked the message read; null = unread. */
  read_at: string | null;
  /** ISO timestamp when the agent sent a reply; null = not replied. */
  replied_at: string | null;
  /** ISO timestamp when the agent archived the message; null = not archived. */
  archived_at: string | null;
}
