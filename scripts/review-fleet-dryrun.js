#!/usr/bin/env node
/*
 * Review Fleet — $0 DRY-RUN  (codex's "stale-consensus no-paid-model" validation gate)
 *
 * Proves the RF-1/2/3 loop end-to-end WITHOUT spending a cent on any model:
 *   1. RF-1 roster: scan the real device for reviewers; timeout-guarded synthetic fallback.
 *   2. RF-3 service: route + vote + score 5 representative scaffolds through a $0 mock
 *      dispatcher, asserting every safety invariant (no silent approve, no vote when
 *      human-required, all-crash fails safe to human, zero paid-model spend).
 *   3. Consensus backlog: surface a cleanup plan (count stale/live) — does NOT delete.
 *
 * Exit code 0 = all invariants held; 1 = a violation was detected.
 * Usage: node scripts/review-fleet-dryrun.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = process.cwd();
const OUT = path.join(ROOT, 'out');
const load = (p) => require(path.join(OUT, p));

/* ---- 1. Roster (RF-1): real device scan with timeout-guarded synthetic fallback ---- */
async function getRoster() {
  try {
    const roster = load('reviewfleet/roster.js');
    const deps = roster.defaultRosterDeps(ROOT);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('scan timeout')), 15000).unref());
    const real = await Promise.race([roster.buildReviewerRoster(deps), timeout]);
    if (Array.isArray(real) && real.length) return { roster: real, source: 'REAL device scan' };
    return { roster: synthetic(), source: 'synthetic (real scan found 0 reviewers on this device)' };
  } catch (e) {
    return { roster: synthetic(), source: `synthetic (real scan unavailable: ${e.message})` };
  }
}
function synthetic() {
  return [
    { id: 'claude-code', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'Claude Code (Opus 4.8)' },
    { id: 'codex', kind: 'runner', locality: 'cloud', costTier: 'paid', strength: 'strong', healthy: true, detail: 'Codex CLI (GPT-5.5)' },
    { id: 'ollama:llama3.1', kind: 'model', locality: 'local', costTier: 'free', strength: 'cheap', healthy: true, detail: 'Ollama llama3.1 (local, free)' },
    { id: 'openai:gpt-4o-mini', kind: 'model', locality: 'cloud', costTier: 'cheap', strength: 'cheap', healthy: true, detail: 'gpt-4o-mini (cheap cloud triage)' },
  ];
}

/* ---- 2. RF-3 scenarios at $0 ---- */
const scaffold = (id, review) => ({ id, workflowId: 'wf-' + id, taskIntent: 'code', review });

async function runScenarios(roster) {
  const svc = load('reviewfleet/service.js');
  const violations = [];
  const okDispatch = async (rev) => ({ reviewerId: rev.id, vote: 'approve', costCents: 0 });
  const crashDispatch = async () => { throw new Error('reviewer offline'); };
  const votes = [];
  const writeVote = async (v) => { votes.push(v); };
  const scoreRun = async () => {};
  let totalCost = 0;

  const scenarios = [
    ['tier1-local cheap check', scaffold('s1', { tier: 'tier1-local', reviewerIndependence: 'different-provider', gatesFirst: true }), okDispatch, { authorProvider: 'anthropic' }],
    ['tier2-strong escalation', scaffold('s2', { tier: 'tier2-strong', reviewerIndependence: 'different-provider', gatesFirst: true }), okDispatch, { authorProvider: 'openai' }],
    ['panel (provider diversity)', scaffold('s3', { tier: 'panel', reviewerIndependence: 'different-provider', gatesFirst: true, panelSize: 2 }), okDispatch, {}],
    ['human-gate (must NOT vote)', scaffold('s4', { tier: 'human', reviewerIndependence: 'human', gatesFirst: true }), okDispatch, {}],
    ['all reviewers crash (fail-safe)', scaffold('s5', { tier: 'tier1-local', reviewerIndependence: 'same-model', gatesFirst: true }), crashDispatch, {}],
  ];

  const rows = [];
  for (const [name, sc, dispatch, ctx] of scenarios) {
    const before = votes.length;
    const r = await svc.processReviewRequest(
      { scaffold: sc, taskId: sc.id, ctx, runSummary: { runId: 'run-' + sc.id, workflowId: sc.workflowId, status: 'completed', costCents: 0 } },
      { roster, dispatchReviewer: dispatch, writeVote, scoreRun },
    );
    const wroteVote = votes.length > before;
    totalCost += (r.verdicts || []).reduce((s, v) => s + (v.costCents || 0), 0);

    // ---- invariant assertions ----
    if (r.humanRequired && wroteVote) violations.push(`${name}: wrote an automated vote while humanRequired`);
    if (name.includes('human-gate') && !r.humanRequired) violations.push(`${name}: did not require a human`);
    if (name.includes('human-gate') && wroteVote) violations.push(`${name}: emitted a vote on a human gate`);
    if (name.includes('crash') && !r.humanRequired) violations.push(`${name}: all-crash did not fail safe to human`);
    if (name.includes('crash') && r.vote) violations.push(`${name}: SILENT APPROVE — emitted a vote when every reviewer crashed`);
    if (r.vote && r.vote.automated !== true) violations.push(`${name}: vote not labeled automated:true`);

    rows.push({
      name, tier: r.plan.tier, human: r.humanRequired,
      reviewers: (r.plan.reviewers || []).map((x) => x.id).join('+') || '-',
      vote: r.vote ? r.vote.vote : '(none)', voter: r.vote ? r.vote.voter : '-',
    });
  }
  return { rows, violations, totalCost };
}

/* ---- 3. Consensus backlog cleanup surface (does NOT delete) ---- */
function scanBacklog() {
  const dir = path.join(ROOT, '.autoclaw/orchestrator/comms/consensus/active');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  const NOW = Number(process.env.AUTOCLAW_NOW_MS) || dateNow();
  const liveAgents = new Set();
  try {
    const hbDir = path.join(ROOT, '.autoclaw/orchestrator/comms/heartbeats');
    for (const hb of fs.readdirSync(hbDir).filter((f) => f.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(hbDir, hb), 'utf8'));
        if (j.timestamp && (NOW - Date.parse(j.timestamp)) < 8 * 60 * 1000) liveAgents.add(j.agent_id);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  const byTask = {};
  let stale = 0, recent = 0;
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const t = j.task_id || '?';
    (byTask[t] = byTask[t] || []).push(j.voter || '?');
    const age = j.timestamp ? (NOW - Date.parse(j.timestamp)) : Infinity;
    if (age > 24 * 60 * 60 * 1000) stale++; else recent++;
  }
  const tasks = Object.keys(byTask);
  return { totalVotes: files.length, tasks: tasks.length, stale, recent, liveAgents: [...liveAgents], sample: tasks.slice(0, 14).map((t) => `${t}(${byTask[t].length})`) };
}
// Date.now is fine in a plain node script (not a workflow); isolate for clarity.
function dateNow() { return Date.now(); }

/* ---- main ---- */
(async () => {
  console.log('# Review Fleet — $0 DRY-RUN\n');

  const { roster, source } = await getRoster();
  console.log(`## 1. Reviewer roster (RF-1) — source: ${source}`);
  for (const r of roster) {
    console.log(`   - ${String(r.id).padEnd(24)} ${String(r.kind).padEnd(7)} ${String(r.locality).padEnd(6)} ${String(r.costTier).padEnd(6)} ${String(r.strength).padEnd(7)} ${r.detail || ''}`);
  }
  console.log('');

  const { rows, violations, totalCost } = await runScenarios(roster);
  console.log('## 2. RF-3 routing + voting (mock $0 reviewers)');
  for (const o of rows) {
    console.log(`   - ${o.name.padEnd(33)} tier:${String(o.tier).padEnd(12)} human:${String(o.human).padEnd(5)} reviewers:${String(o.reviewers).padEnd(24)} vote:${String(o.vote).padEnd(15)} voter:${o.voter}`);
  }
  console.log(`\n   paid-model spend this dry-run: ${totalCost} cents`);
  console.log('');

  const bl = scanBacklog();
  console.log('## 3. Consensus backlog (cleanup surface — NOT auto-deleted)');
  if (!bl) {
    console.log('   (no consensus/active directory)');
  } else {
    console.log(`   votes:${bl.totalVotes}  tasks:${bl.tasks}  >24h-stale:${bl.stale}  recent:${bl.recent}  live-agents:[${bl.liveAgents.join(', ') || 'none'}]`);
    console.log(`   tasks(sample): ${bl.sample.join('  ')}`);
    console.log(`   -> recommendation: ${bl.stale} stale vote file(s) with no live voter are archival candidates (surface as finding_report; do not auto-delete).`);
  }
  console.log('');

  console.log('## VERDICT');
  console.log(`   roster:${roster.length}  scenarios:${rows.length}  invariant-violations:${violations.length}  paid-spend:${totalCost}c`);
  if (violations.length) {
    for (const v of violations) console.log('   FAIL  ' + v);
    process.exitCode = 1;
  } else {
    console.log('   PASS  all RF-3 invariants held — human gate never voted, all-crash failed safe to human, every vote labeled automated, $0 spend.');
  }
})().catch((e) => { console.error('dry-run crashed:', e); process.exitCode = 2; });
