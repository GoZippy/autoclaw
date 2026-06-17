/**
 * coordinationSignals.ts — Feed multi-agent COORDINATION outcomes into the
 * learnings store (yocooLab learnings #8).
 *
 * The `/learn` aggregator historically distilled only per-session code-diff
 * signals (kept code, git commits, shipped/discarded). It ignored the richest,
 * most reusable team events: a cross-agent review that confirmed a security
 * finding, caught a scope gap, or gated a merge. Those live in the orchestrator
 * comms tree, not in any single agent's session log.
 *
 * This module harvests them from durable comms artifacts:
 *   - `consensus/resolved/<task>.json` — the verdict records the consensus
 *     auto-tally (consensusTally.ts) now writes: approved / changes_requested /
 *     rejected, with rule + panel.
 *   - `finding_report` messages in `inboxes/shared/` (+ `processed/`) — severity
 *     + description of issues a reviewer raised.
 *
 * It returns ready-to-fold `successful` / `avoided` pattern strings plus the raw
 * outcomes, so learn.ts can treat coordination as first-class learning signal.
 * Free-text (finding descriptions) is redacted here so the collector is safe by
 * construction. Pure reads — no `vscode`, no network.
 */

import * as fs from 'fs';
import * as path from 'path';

import { redactSecrets } from './redact';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type CoordinationVerdict = 'approved' | 'changes_requested' | 'rejected';
export type CoordinationRule = 'majority' | 'unanimous';

export interface ConsensusOutcome {
  taskId: string;
  verdict: CoordinationVerdict;
  rule: CoordinationRule;
  approvals: number;
  panelSize: number;
  reviewers: string[];
  resolvedAt?: string;
}

export interface ReviewFinding {
  from: string;
  severity: string;
  description: string;
}

export interface CoordinationSignals {
  outcomes: ConsensusOutcome[];
  findings: ReviewFinding[];
  /** Pattern strings to fold into the learn aggregate's successful set. */
  successful: string[];
  /** Pattern strings to fold into the learn aggregate's avoided set. */
  avoided: string[];
  counts: { approved: number; changesRequested: number; rejected: number; findings: number };
}

export interface CollectCoordinationOptions {
  /** Cap per pattern list (recency-first). Default 25. */
  max?: number;
}

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}
function resolvedDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'consensus', 'resolved');
}
function sharedInbox(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
}

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '')) as T; }
  catch { return null; }
}
function listJson(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')); }
  catch { return []; }
}

/* -------------------------------------------------------------------------- */
/*  Collectors                                                                */
/* -------------------------------------------------------------------------- */

/** Normalise a verdict string from a resolved record; default to rejected so an
 *  unrecognised value never masquerades as an approval. */
function normalizeVerdict(raw: unknown): CoordinationVerdict {
  return raw === 'approved' || raw === 'changes_requested' || raw === 'rejected' ? raw : 'rejected';
}

function readConsensusOutcomes(workspaceRoot: string): ConsensusOutcome[] {
  const dir = resolvedDir(workspaceRoot);
  const out: ConsensusOutcome[] = [];
  for (const name of listJson(dir)) {
    const rec = readJson<Record<string, unknown>>(path.join(dir, name));
    if (!rec || typeof rec.task_id !== 'string') { continue; }
    out.push({
      taskId: rec.task_id,
      verdict: normalizeVerdict(rec.verdict),
      rule: rec.rule === 'unanimous' ? 'unanimous' : 'majority',
      approvals: typeof rec.approvals === 'number' ? rec.approvals : 0,
      panelSize: typeof rec.panel_size === 'number' ? rec.panel_size : 0,
      reviewers: Array.isArray(rec.reviewers) ? rec.reviewers.filter((r): r is string => typeof r === 'string') : [],
      resolvedAt: typeof rec.resolved_at === 'string' ? rec.resolved_at : undefined,
    });
  }
  // Recency-first so the cap keeps the freshest outcomes.
  out.sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  return out;
}

function readReviewFindings(workspaceRoot: string): ReviewFinding[] {
  const root = sharedInbox(workspaceRoot);
  const out: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const sub of ['', 'processed']) {
    const dir = sub ? path.join(root, sub) : root;
    for (const name of listJson(dir)) {
      const msg = readJson<{ id?: string; type?: string; from?: string; payload?: Record<string, unknown> }>(path.join(dir, name));
      if (!msg || msg.type !== 'finding_report') { continue; }
      const key = msg.id ?? name;
      if (seen.has(key)) { continue; }
      seen.add(key);
      const sev = typeof msg.payload?.severity === 'string' ? msg.payload.severity : 'info';
      const descRaw = typeof msg.payload?.description === 'string' ? msg.payload.description : '';
      out.push({
        from: typeof msg.from === 'string' ? msg.from : 'unknown',
        severity: sev,
        description: redactSecrets(descRaw).replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Pattern derivation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Harvest coordination outcomes from the comms tree and derive learning
 * patterns. Approvals become reusable "what passed review" signal; rejections,
 * changes-requested, and findings become "what review catches" signal.
 */
export function collectCoordinationSignals(
  workspaceRoot: string,
  opts: CollectCoordinationOptions = {},
): CoordinationSignals {
  const max = opts.max ?? 25;
  const outcomes = readConsensusOutcomes(workspaceRoot);
  const findings = readReviewFindings(workspaceRoot);

  const successful: string[] = [];
  const avoided: string[] = [];
  let approved = 0, changesRequested = 0, rejected = 0;

  for (const o of outcomes) {
    const panel = o.reviewers.length > 0 ? o.reviewers.join('+') : `${o.panelSize} reviewers`;
    if (o.verdict === 'approved') {
      approved++;
      successful.push(
        `Coordination: ${o.rule} consensus approved ${o.taskId} (${o.approvals}/${o.panelSize}, ${panel}).`,
      );
    } else {
      if (o.verdict === 'rejected') { rejected++; } else { changesRequested++; }
      avoided.push(
        `Coordination: ${o.taskId} ${o.verdict.replace(/_/g, ' ')} by ${o.rule} review — reworked before merge.`,
      );
    }
  }

  for (const f of findings) {
    if (!f.description) { continue; }
    avoided.push(`Review finding [${f.severity}] from ${f.from}: ${f.description}`);
  }

  return {
    outcomes,
    findings,
    successful: successful.slice(0, max),
    avoided: avoided.slice(0, max),
    counts: { approved, changesRequested, rejected, findings: findings.length },
  };
}
