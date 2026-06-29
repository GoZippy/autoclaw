#!/usr/bin/env node
/**
 * workflow-run.js — Headless CLI entry point for the AutoClaw Workflow Lab
 * runner (WL-1.4).
 *
 *   node scripts/workflow-run.js --builtin cheap-fix-loop
 *   node scripts/workflow-run.js --workflow <path> [--task "<task>"]
 *
 * Runs a workflow definition through the headless runner (src/workflows/
 * runner.ts → out/workflows/runner.js), writes a run-ledger entry under
 * .autoclaw/workflows/runs/<runId>/, prints the run id + a typed summary, and
 * exits 0 only when the run completed. Provider/command execution is mocked:
 * this CLI NEVER calls an external or paid model. The `--builtin
 * cheap-fix-loop` fixture wires a deterministic mock command runner so it runs
 * fully offline, end to end, as the WL-1 exit-gate demonstration.
 *
 * Note: the runner orchestration engine (runWorkflow/defaultDeps) is owned by
 * the WL-0/WL-1 foundation work; this script only DRIVES it. If you change the
 * runner's public surface, update the require()s below.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const OUT_RUNNER = path.join(__dirname, '..', 'out', 'workflows', 'runner.js');
const OUT_STATE = path.join(__dirname, '..', 'out', 'workflows', 'state.js');

function fail(msg, code) {
  process.stderr.write(`workflow-run: ${msg}\n`);
  process.exit(code == null ? 1 : code);
}

function parseArgs(argv) {
  const out = { builtin: null, workflow: null, task: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--builtin') { out.builtin = argv[++i]; }
    else if (a === '--workflow') { out.workflow = argv[++i]; }
    else if (a === '--task') { out.task = argv[++i]; }
    else if (a === '-h' || a === '--help') { out.help = true; }
    else { fail(`unknown argument: ${a}`, 2); }
  }
  return out;
}

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  node scripts/workflow-run.js --builtin cheap-fix-loop\n' +
    '  node scripts/workflow-run.js --workflow <path.workflow.json> [--task "<task>"]\n'
  );
}

/**
 * Built-in "cheap fix loop" fixture (linear demonstration form).
 * input(task) -> agent(patch, mock model) -> tool(apply, mock command)
 *   -> gate(test, mock command) -> artifact(report).
 * Valid against the WL-0 validator (schema/name present, node kind+config,
 * tool/agent/gate config targets present).
 */
function builtinCheapFixLoop(task) {
  return {
    schema: 'autoclaw.workflow.v1',
    id: 'cheap-fix-loop',
    name: 'Cheap Fix Loop (headless demo)',
    description: 'Local model patches a failing test; a test gate judges it.',
    nodes: [
      { id: 'task', type: 'input', kind: 'task', config: { value: { task: task || 'fix the failing test' } } },
      { id: 'patch', type: 'agent', kind: 'model', config: { intent: 'debug', model: 'mock-fast', prompt: 'patch the failing test' } },
      { id: 'apply', type: 'tool', kind: 'shell', config: { command: 'apply-patch', action: 'apply-patch' } },
      { id: 'test', type: 'gate', kind: 'test', config: { kind: 'test', command: 'run-tests', criterion: 'unit tests pass' } },
      { id: 'report', type: 'artifact', kind: 'report', config: { name: 'fix-report' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'task' }, to: { node: 'patch' } },
      { id: 'e2', from: { node: 'patch' }, to: { node: 'apply' } },
      { id: 'e3', from: { node: 'apply' }, to: { node: 'test' } },
      { id: 'e4', from: { node: 'test' }, to: { node: 'report' } },
    ],
  };
}

/** Deterministic mock command runner: every known command "passes" (exit 0). */
async function mockCommandRunner(command) {
  return { exitCode: 0, stdout: `mock(${command}) ok`, stderr: '', durationMs: 1 };
}

function loadRunner() {
  if (!fs.existsSync(OUT_RUNNER)) {
    fail(`runner not built: ${OUT_RUNNER} missing. Run \`npm run compile\` (or \`tsc -p ./\`) first.`, 3);
  }
  // eslint-disable-next-line global-require
  return require(OUT_RUNNER);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }

  let def;
  if (args.builtin) {
    if (args.builtin !== 'cheap-fix-loop') {
      fail(`unknown builtin "${args.builtin}". Available: cheap-fix-loop`, 2);
    }
    def = builtinCheapFixLoop(args.task);
  } else if (args.workflow) {
    const p = path.resolve(args.workflow);
    if (!fs.existsSync(p)) { fail(`workflow file not found: ${p}`, 2); }
    try {
      def = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      fail(`could not parse workflow JSON (${p}): ${e.message}`, 2);
    }
  } else {
    usage();
    fail('one of --builtin or --workflow is required', 2);
  }

  const runner = loadRunner();
  const workspaceRoot = process.cwd();
  const deps = runner.defaultDeps(workspaceRoot, {
    persistLedger: true,
    commandRunner: mockCommandRunner,
  });

  const result = await runner.runWorkflow(def, deps);

  // Content-free summary — no prompt/response text is printed or logged.
  const summary = {
    runId: result.runId,
    workflow: result.workflowId,
    status: result.status,
    stopReason: result.stopReason,
    failureType: result.failureType || null,
    costCents: result.costCents,
    events: result.events.length,
    nodes: Object.fromEntries(
      Object.entries(result.nodeStates).map(([id, s]) => [id, s.status])
    ),
    ledgerDir: result.ledgerDir,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  // Verify the ledger was actually written (best-effort).
  try {
    const state = fs.existsSync(OUT_STATE) ? require(OUT_STATE) : null;
    if (state && typeof state.readRunEvents === 'function') {
      const persisted = state.readRunEvents(workspaceRoot, result.runId);
      process.stdout.write(`ledger events persisted: ${persisted.length}\n`);
    }
  } catch { /* non-fatal */ }

  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e), 1));
