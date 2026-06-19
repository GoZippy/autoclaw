#!/usr/bin/env node
/**
 * demo-join.mjs — DEMO-1: watch an outside agent JOIN a project end-to-end.
 *
 * Simulates the federation loop from docs/ideas/FLEET-FEDERATION-SELF-HEALING.md
 * without needing a second machine or a real OpenClaw/Hermes process:
 *
 *   1. the human issues an invite token            (FF-2 — src/fleet/invites.ts)
 *   2. an outside agent consumes it (single-use)   (FF-2)
 *   3. the admit policy is resolved                (FF-2 — admitDecision)
 *   4. the agent writes a presence beacon          (FF-1 — presence.beacon / src/fleet/beacons.ts)
 *   5. the agent reads "what the project needs"     (SA-1 — needs.json)
 *   6. it offers the best-fit role (capability_offer message)
 *   7. it heartbeats a few cycles                   (the bounded loop)
 *
 * It writes the SAME on-disk JSON shapes the real modules produce, into a throwaway
 * workspace under the OS temp dir, and narrates each step — so it doubles as a
 * filesystem-contract smoke test for FF-1 / FF-2 / SA-1.
 *
 * Usage:  node scripts/demo-join.mjs [--agent hermes-ts-01] [--tool hermes] [--keep]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ── tiny arg parse ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const AGENT_ID = opt('agent', 'hermes-ts-01');
const TOOL = opt('tool', 'hermes');
const AGENT_TYPE = opt('type', 'coder');
const KEEP = argv.includes('--keep');

const SESSION = crypto.randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();
const step = (n, msg) => console.log(`\n${'─'.repeat(2)} ${n}. ${msg}`);
const info = (msg) => console.log(`   ${msg}`);
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
};
const fileTs = (d) => d.toISOString().replace(/[:.]/g, '-');

// ── throwaway workspace ─────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-demo-join-'));
const COMMS = path.join(ROOT, '.autoclaw', 'orchestrator', 'comms');
const ORCH = path.join(ROOT, '.autoclaw', 'orchestrator');
console.log(`AutoClaw federation join demo`);
console.log(`workspace: ${ROOT}`);
console.log(`joining agent: ${AGENT_ID} (tool=${TOOL}, type=${AGENT_TYPE}, session=${SESSION})`);

let failures = 0;
const check = (cond, label) => {
  if (cond) { info(`✓ ${label}`); }
  else { failures++; console.error(`   ✗ FAIL: ${label}`); }
};

// ── 1. human issues an invite (src/fleet/invites.ts shape) ───────────────────
step(1, 'Human issues a scoped, single-use invite token');
const token = `join-${crypto.randomBytes(9).toString('hex')}`;
const now = Date.now();
const invitePath = path.join(os.tmpdir(), 'autoclaw-demo-invites', `${token}.json`);
const invite = {
  token,
  issued_by: 'claude-code',
  project: 'autoclaw',
  workspace: ROOT,
  suggested_role: 'tester',
  suggested_agent_type: AGENT_TYPE,
  scope: ['src/test/**', 'docs/**'],
  transports: ['fs', 'http'],
  trust: 'off',
  admit_policy: 'auto-preapproved',
  preapproved_types: ['coder', 'tester'],
  issued_at: new Date(now).toISOString(),
  expires: new Date(now + 24 * 3600_000).toISOString(),
  consumed_by: null,
};
writeJson(invitePath, invite);
info(`token: ${token}`);
info(`scope: ${invite.scope.join(', ')}  trust: ${invite.trust}  policy: ${invite.admit_policy}`);

// ── 2. outside agent consumes it (single-use) ────────────────────────────────
step(2, `Outside agent (${TOOL}) consumes the invite`);
const loaded = JSON.parse(fs.readFileSync(invitePath, 'utf8'));
check(!loaded.consumed_by, 'invite is unconsumed before use');
check(Date.now() <= new Date(loaded.expires).getTime(), 'invite is not expired');
loaded.consumed_by = { agent_id: AGENT_ID, session_id: SESSION, at: nowIso() };
writeJson(invitePath, loaded);
const reloaded = JSON.parse(fs.readFileSync(invitePath, 'utf8'));
check(reloaded.consumed_by && reloaded.consumed_by.agent_id === AGENT_ID, 'invite is now single-use consumed');

// ── 3. admit policy resolves (FF-2 admitDecision) ────────────────────────────
step(3, 'Admit policy resolves');
const admit =
  invite.admit_policy === 'open' ? true
  : invite.admit_policy === 'auto-preapproved' ? (invite.preapproved_types || []).includes(AGENT_TYPE)
  : false;
info(`policy=${invite.admit_policy}  agent_type=${AGENT_TYPE}  preapproved=[${(invite.preapproved_types||[]).join(', ')}]`);
check(admit === true, `agent auto-admitted (type "${AGENT_TYPE}" is pre-approved)`);

// ── 4. agent writes a presence beacon (src/fleet/beacons.ts shape) ───────────
step(4, 'Agent checks in with a presence beacon');
const beacon = {
  agent_id: AGENT_ID,
  session_id: SESSION,
  timestamp: nowIso(),
  status: 'active',
  current_task: 'arriving',
  current_llm: 'claude-opus-4-8',
  role: invite.suggested_role,
  agent_type: AGENT_TYPE,
  host: TOOL,
  workspace: ROOT,
  workspace_id: path.basename(ROOT).toLowerCase(),
  origin: 'beacon',
  transports: ['fs', 'http'],
};
const beaconPath = path.join(COMMS, 'beacons', `${AGENT_ID}-${SESSION}.json`);
writeJson(beaconPath, beacon);
check(fs.existsSync(beaconPath), 'beacon written to comms/beacons (now a fleet row)');

// ── 5. agent reads what the project needs (SA-1 needs.json) ──────────────────
step(5, 'Agent reads "what the project needs right now" (needs.json)');
// In the real system SA-1 derives this from plan-summary + board + fleet.json.
// Here we seed a representative needs vector so the demo is self-contained.
const needs = {
  generated_at: nowIso(),
  open_lanes: [
    { lane: 'SA', role: 'researcher', required_capabilities: ['typescript'], unclaimed: 1 },
    { lane: 'DOC', role: 'docs', required_capabilities: ['technical-writing'], unclaimed: 1 },
  ],
  role_coverage_gap: ['tester', 'researcher'],
  staleness_pressure: [],
};
writeJson(path.join(ORCH, 'needs.json'), needs);
info(`role coverage gap: ${needs.role_coverage_gap.join(', ')}`);

// ── 6. agent offers the best-fit role (capability_offer) ─────────────────────
step(6, 'Agent offers the best-fit role it can fill');
const agentSkills = ['typescript', 'node', 'react', 'playwright'];
// naive scorer: prefer a gap whose required capability the agent has
const pick = needs.open_lanes.find(l =>
  (l.required_capabilities || []).some(c => agentSkills.includes(c))
) || needs.open_lanes[0];
info(`agent skills: ${agentSkills.join(', ')}`);
info(`offering role: ${pick.role} (lane ${pick.lane})`);
const offer = {
  id: `msg-${crypto.randomUUID()}`,
  from: AGENT_ID,
  session_id: SESSION,
  to: 'claude-code',
  type: 'capability_offer',
  timestamp: nowIso(),
  requires_response: true,
  payload: { offered_role: pick.role, lane: pick.lane, skills: agentSkills, via_invite: token },
};
const offerPath = path.join(COMMS, 'inboxes', 'claude-code', `${fileTs(new Date())}-capability_offer-${AGENT_ID}-${SESSION}.json`);
writeJson(offerPath, offer);
check(fs.existsSync(offerPath), 'capability_offer delivered to orchestrator inbox');

// ── 7. bounded heartbeat loop ────────────────────────────────────────────────
step(7, 'Agent heartbeats a few cycles (the bounded loop)');
for (let cycle = 1; cycle <= 3; cycle++) {
  const hb = { ...beacon, timestamp: nowIso(), current_task: `working ${pick.role} lane (cycle ${cycle})`, cycle };
  writeJson(beaconPath, hb);
  info(`cycle ${cycle}: heartbeat written (task="${hb.current_task}")`);
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(failures === 0
  ? `✓ join loop completed — ${AGENT_ID} is an admitted, beaconing fleet member`
  : `✗ ${failures} check(s) failed`);
console.log('artifacts:');
console.log(`   invite : ${invitePath}`);
console.log(`   beacon : ${beaconPath}`);
console.log(`   offer  : ${offerPath}`);
console.log(`   needs  : ${path.join(ORCH, 'needs.json')}`);

if (!KEEP) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(path.dirname(invitePath), { recursive: true, force: true });
  console.log('(temp artifacts cleaned — pass --keep to inspect them)');
}

process.exit(failures === 0 ? 0 : 1);
