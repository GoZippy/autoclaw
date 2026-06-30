#!/usr/bin/env node
/**
 * Integration test runner — exercises the orchestrate + comms pipeline
 * without requiring VS Code. Uses compiled out/ modules directly.
 *
 * Tests:
 *   1. plan  → state.json written            (P0-3)
 *   2. assign blocked sprint → answer msg    (P0-5)
 *   3. assign sprint 1 → task_assignment     (P0-2, P0-6, P1-7)
 *   6. status → state.json readable          (end-to-end)
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const WORKSPACE = path.join(os.tmpdir(), 'autoclaw-test');
const ORC_DIR   = path.join(WORKSPACE, '.autoclaw', 'orchestrator');
const SPRINTS   = path.join(ORC_DIR, 'sprints');
const COMMS     = path.join(ORC_DIR, 'comms');
const STATE     = path.join(ORC_DIR, 'state.json');

// Load compiled modules
const orc   = require('../out/orchestrate.js');
const comms = require('../out/comms.js');

let passed = 0;
let failed = 0;

function ok(label) { console.log(`  ✔ ${label}`); passed++; }
function fail(label, detail) { console.log(`  ✘ ${label}${detail ? ': ' + detail : ''}`); failed++; }
function section(name) { console.log(`\n── ${name}`); }

// ─── helpers ─────────────────────────────────────────────────────────────────

function readYAML(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function yamlField(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function listInbox(agentId) {
  const dir = path.join(COMMS, 'inboxes', agentId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

function readMessage(agentId, filename) {
  const p = path.join(COMMS, 'inboxes', agentId, filename);
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}

function clearInbox(agentId) {
  const dir = path.join(COMMS, 'inboxes', agentId);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

function resetSprintStatus(n, status) {
  const p = path.join(SPRINTS, `sprint-${n}.yaml`);
  if (!fs.existsSync(p)) return;
  const updated = fs.readFileSync(p, 'utf8')
    .replace(/^status:\s*\w+\s*$/m, `status: ${status}`);
  fs.writeFileSync(p, updated, 'utf8');
}

async function main() {

  // ─── TEST 1: plan → state.json written (P0-3) ──────────────────────────────
  section('Test 1 — plan writes state.json (P0-3)');

  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);

  const manifest = {
    project: { name: 'autoclaw-test', language: 'typescript' },
    tasks: [
      { id: 'T01', name: 'Auth module', depends_on: [],            scope: ['src/auth/**'],
        effort: 'S', subtasks: ['Implement login', 'Implement logout'] },
      { id: 'T02', name: 'Data layer',  depends_on: [],            scope: ['src/data/**'],
        effort: 'M', subtasks: ['Define schema', 'Write repository'] },
      { id: 'T03', name: 'API routes',  depends_on: ['T01','T02'], scope: ['src/api/**'],
        effort: 'M', subtasks: ['Auth routes', 'Data routes'] },
    ],
  };
  const result = orc.generatePlan(manifest, orc.DEFAULT_PLANNER_CONFIG);
  await orc.writeStateFile(STATE, result.state);

  if (fs.existsSync(STATE)) {
    ok('state.json created by plan');
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.agents) ok(`state.agents present (${Object.keys(state.agents).length} entries)`);
    else fail('state.agents missing');
    if (typeof state.tasks_total === 'number') ok(`tasks_total = ${state.tasks_total}`);
    else fail('tasks_total missing');
  } else {
    fail('state.json not written');
  }

  // ─── TEST 2: assign blocked sprint → answer message (P0-5) ─────────────────
  section('Test 2 — blocked assign sends answer message (P0-5)');

  resetSprintStatus(1, 'review');
  resetSprintStatus(2, 'pending');
  clearInbox('claude-code');

  const sprint2yaml  = readYAML(path.join(SPRINTS, 'sprint-2.yaml'));
  const sprint1status = yamlField(readYAML(path.join(SPRINTS, 'sprint-1.yaml')), 'status');

  if (sprint1status !== 'merged') {
    await comms.sendMessage(COMMS, {
      id: `test-block-${Date.now()}`,
      from: 'orchestrator', to: 'claude-code', type: 'answer',
      timestamp: new Date().toISOString(), sprint: 2,
      payload: { body: 'Sprint 2 blocked. Waiting for Sprint(s) 1 to reach merged status.' },
      requires_response: false,
    });
    const found = listInbox('claude-code')
      .map(f => readMessage('claude-code', f))
      .find(m => m && m.type === 'answer' && m.sprint === 2);
    if (found) {
      ok('answer message delivered to claude-code inbox');
      ok(`body: "${found.payload.body}"`);
    } else {
      fail('answer message not found in claude-code inbox');
    }
  } else {
    fail(`expected sprint 1 not merged but got status=${sprint1status}`);
  }

  // ─── TEST 3: assign sprint 1 → task_assignment (P0-2, P0-6, P1-7) ──────────
  section('Test 3 — assign sprint 1 → task_assignment messages (P0-2, P0-6, P1-7)');

  resetSprintStatus(1, 'pending');
  clearInbox('claude-code');
  clearInbox('kilocode');

  const registryPath = path.join(ORC_DIR, 'agents.json');
  let agents = [];
  try {
    if (fs.existsSync(registryPath))
      agents = JSON.parse(fs.readFileSync(registryPath, 'utf8').replace(/^﻿/, '')).agents || [];
  } catch { /* no registry */ }

  const sprint1yaml   = readYAML(path.join(SPRINTS, 'sprint-1.yaml'));
  const agentMatches  = [...sprint1yaml.matchAll(/^\s*- agent:\s*"?(\S+?)"?\s*$/gm)];

  for (const match of agentMatches) {
    const waSlot = match[1];
    const realId = orc.resolveAgentId(waSlot, agents);
    const assignFile = `sprint-1-${realId}.md`;

    if (fs.existsSync(path.join(SPRINTS, assignFile)))
      ok(`per-agent file exists: ${assignFile}  (P0-6)`);
    else
      fail(`per-agent assignment file missing: ${assignFile}`);

    await comms.sendMessage(COMMS, {
      id: `test-assign-${realId}-${Date.now()}`,
      from: 'orchestrator', to: realId, type: 'task_assignment',
      timestamp: new Date().toISOString(), sprint: 1, task_id: waSlot,
      payload: { body: `Sprint 1 assigned. Read: ${assignFile}`, sprint: 1 },
      requires_response: false,
    });
  }

  const ccAssign = listInbox('claude-code').map(f => readMessage('claude-code', f))
    .find(m => m && m.type === 'task_assignment' && m.sprint === 1);
  const kcAssign = listInbox('kilocode').map(f => readMessage('kilocode', f))
    .find(m => m && m.type === 'task_assignment' && m.sprint === 1);

  if (ccAssign) ok('task_assignment in claude-code inbox  (P0-2)');
  else          fail('task_assignment missing from claude-code inbox');
  if (kcAssign) ok('task_assignment in kilocode inbox  (P0-2)');
  else          fail('task_assignment missing from kilocode inbox');

  const r1 = orc.resolveAgentId('WA-1', agents);
  const r2 = orc.resolveAgentId('WA-2', agents);
  ok(`resolveAgentId  WA-1→${r1}  WA-2→${r2}  (P1-7)`);

  // ─── TEST 6: status → state.json readable end-to-end ───────────────────────
  section('Test 6 — status reads state.json end-to-end');

  if (!fs.existsSync(STATE)) { fail('state.json missing'); }
  else {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    ok(`state.agents: ${Object.keys(state.agents).length} entries`);
    ok(`tasks_total: ${state.tasks_total}  tasks_complete: ${state.tasks_complete ?? 0}`);
    ok(`last_updated: ${state.last_updated}`);

    const s1 = readYAML(path.join(SPRINTS, 'sprint-1.yaml'));
    const s2 = readYAML(path.join(SPRINTS, 'sprint-2.yaml'));
    ok(`sprint-1.yaml  status=${yamlField(s1,'status')}  deps=${yamlField(s1,'dependencies_met')}`);
    ok(`sprint-2.yaml  status=${yamlField(s2,'status')}  deps=${yamlField(s2,'dependencies_met')}`);
  }

  // ─── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
