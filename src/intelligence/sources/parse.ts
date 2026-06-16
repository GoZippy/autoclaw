/**
 * sources/parse.ts — shared, host-free parsing helpers for the built-in Source
 * Adapters. Internal to `sources/` (not re-exported from the barrel).
 *
 * No `vscode` import, no native modules, no work at import time.
 */

import { redactSecrets } from '../redact';
import {
  MessageRole,
  SessionCodeBlock,
  SessionMessage,
  SessionProvenance,
} from '../types';

const FENCE_RE = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;

/** Extract fenced ```code``` blocks from markdown/chat text (secrets redacted). */
export function extractCodeBlocks(text: string): SessionCodeBlock[] {
  if (!text) {
    return [];
  }
  const blocks: SessionCodeBlock[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = (m[1] || '').trim();
    const code = m[2] ?? '';
    if (code.trim() === '') {
      continue;
    }
    blocks.push({ lang, code: redactSecrets(code) });
  }
  return blocks;
}

/** Coerce an arbitrary role-ish token into a {@link MessageRole}. */
export function mapRole(raw: unknown, fallback: MessageRole = 'system'): MessageRole {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'user' || s === 'human') {
    return 'user';
  }
  if (s === 'assistant' || s === 'ai' || s === 'model' || s === 'agent' || s === 'bot') {
    return 'assistant';
  }
  if (s === 'tool' || s === 'function') {
    return 'tool';
  }
  if (s === 'system') {
    return 'system';
  }
  return fallback;
}

/** Best-effort epoch-ms timestamp from a variety of field shapes. */
export function coerceTs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: treat 10-digit values as seconds.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** First defined, non-empty string among the candidate fields of `obj`. */
export function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') {
      return v;
    }
  }
  return undefined;
}

/** Build a {@link SessionMessage}, redacting secrets and extracting code blocks. */
export function makeMessage(role: MessageRole, text: string, ts?: number): SessionMessage {
  const safe = redactSecrets(text ?? '');
  const codeBlocks = extractCodeBlocks(text ?? '');
  const msg: SessionMessage = { role, text: safe };
  if (typeof ts === 'number') {
    msg.ts = ts;
  }
  if (codeBlocks.length) {
    msg.codeBlocks = codeBlocks;
  }
  return msg;
}

/** Standard provenance stamp for an extracted session. */
export function makeProvenance(adapterId: string, rawRef: string): SessionProvenance {
  return { adapterId, rawRef, extractedAt: Date.now() };
}

/** Parse a JSONL string into an array of objects, skipping malformed lines. */
export function parseJsonl(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // skip malformed line — best effort
    }
  }
  return out;
}
