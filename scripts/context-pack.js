#!/usr/bin/env node
/**
 * context-pack.js — generate an AutoClaw "context pack" for an assigned agent,
 * decoupled from VS Code (Channel A delivery).
 *
 * The orchestrate `assign` flow calls this once per agent. It builds a grounded
 * pack (real code via RAG + proven patterns/learnings + learned style + recent
 * memory + durable Knowledge-Graph facts), writes it to
 * `.autoclaw/orchestrator/sprints/sprint-<N>-<agent>.context.md`, and prints a
 * compact JSON summary to stdout so the caller can embed it under a task_assign
 * `payload.intelligence`. Works for EVERY runner because delivery is a file any
 * agent can read — no MCP required.
 *
 * Degrade-safe: with no embeddings backend reachable the pack is still produced
 * from preferences.json + style + memory (and the KG falls back to full-text).
 *
 * Usage:
 *   node scripts/context-pack.js --task "Add pagination to /users" \
 *        --agent claude-code --sprint 2 --tasks B1,B2 --role coder
 *   node scripts/context-pack.js --task "..." --out path/to/file.md --json
 *
 * Flags:
 *   --task   <text>     (required) what the agent will work on
 *   --agent  <id>       agent id (header + default filename)
 *   --sprint <n>        sprint number (header + default filename)
 *   --tasks  <a,b,c>    comma-separated task ids
 *   --role   <label>    work-lane / role label
 *   --ws     <dir>      workspace root (default: cwd)
 *   --out    <file>     output path (default: derived under .autoclaw/orchestrator/sprints)
 *   --json              also print the full summary JSON to stdout
 *
 * Requires `npm run compile` first (reads from ./out).
 * Exit code 0 = pack written; non-zero = failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'json') {
      out.json = true;
      continue;
    }
    out[key] = argv[++i];
  }
  return out;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('context-pack: --task is required');
    process.exit(2);
  }

  const ws = path.resolve(args.ws || process.cwd());

  let mod;
  try {
    mod = require(path.join(__dirname, '..', 'out', 'intelligence', 'contextPack'));
  } catch (err) {
    console.error('context-pack: cannot load compiled module — run `npm run compile` first.');
    console.error('  ' + err.message);
    process.exit(1);
  }

  const scope = {
    task: args.task,
    agentId: args.agent,
    role: args.role,
    sprint: args.sprint != null ? Number(args.sprint) : undefined,
    taskIds: args.tasks ? args.tasks.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };

  const log = (m) => process.stderr.write(`[context-pack] ${m}\n`);

  let pack;
  try {
    pack = await mod.buildContextPack(scope, { workspaceRoot: ws, log });
  } catch (err) {
    console.error('context-pack: build failed — ' + err.message);
    process.exit(1);
  }

  // Resolve output path.
  let outPath = args.out;
  if (!outPath) {
    const sprintPart = scope.sprint != null ? `sprint-${scope.sprint}` : 'pack';
    const agentPart = scope.agentId ? `-${slug(scope.agentId)}` : '';
    outPath = path.join(ws, '.autoclaw', 'orchestrator', 'sprints', `${sprintPart}${agentPart}.context.md`);
  }
  outPath = path.resolve(ws, outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pack.markdown, 'utf8');

  const rel = path.relative(ws, outPath).split(path.sep).join('/');
  const payload = { context_file: rel, ...pack.summary };

  log(
    `wrote ${rel} — ${pack.usedCode ? `${pack.codeHits} code chunk(s)` : 'no code (degraded/empty)'}, ` +
      `${pack.learningHits} learning(s), ${pack.kgHits} KG fact(s)${pack.degraded ? ' [degraded]' : ''}`,
  );
  for (const note of pack.notes) {
    log(`note — ${note}`);
  }

  // stdout: the payload fragment for Message.payload.intelligence (machine-readable).
  process.stdout.write(JSON.stringify(args.json ? { payload, pack: { markdown: pack.markdown } } : payload, null, 2) + '\n');
}

main().catch((err) => {
  console.error('context-pack: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
