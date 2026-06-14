/**
 * intelligence-learn.test.ts — unit tests for the `/learn` orchestrator
 * (Phase-1 intelligence-core-loop, Group 6 / tasks 6.1-6.4).
 *
 * Verifies, against real fixtures in OS temp dirs and fully offline (provider
 * 'none' embeddings + injected fake adapters):
 *  - a run writes a timestamped insight-*.md, merges preferences.json WITHOUT
 *    losing prior entries, regenerates agent-style.md, and APPENDS (never
 *    overwrites) MEMORY.md (R5.2, R5.7, R5.8)
 *  - empty / no-signal input still produces non-empty default patterns (R5.3)
 *  - duplicate sessions across sources are deduped/merged (R5.5)
 *  - `--last N` caps the analyzed sessions (R5.4)
 *  - generateAgentStyle is a pure, deterministic markdown renderer
 *
 * Pure-logic tests — no vscode, no extension host. All temp dirs live inside a
 * SINGLE enclosing suite (suiteSetup/suiteTeardown) so teardown never races
 * sibling suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { learnFromSessions } from '../intelligence/learn';
import { generateAgentStyle } from '../intelligence/agentStyle';
import { SourceRegistry } from '../intelligence/sources/registry';
import { defaultConfig } from '../intelligence/config';
import {
  AdapterEnv,
  ExtractOptions,
  IntelligenceConfig,
  SourceAdapter,
  UnifiedSession,
} from '../intelligence/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function readFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A config that keeps every run offline + deterministic (provider 'none'). */
function offlineConfig(): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding.provider = 'none';
  return cfg;
}

function envFor(workspaceRoot: string): AdapterEnv {
  return {
    homeDir: tmpRoot,
    workspaceRoot,
    platform: process.platform,
    env: {},
  };
}

/** Minimal in-memory adapter for the learn pipeline. */
function fakeAdapter(id: string, sessions: UnifiedSession[]): SourceAdapter {
  return {
    id,
    displayName: id,
    tier: 3,
    capabilities: {
      fullTranscripts: true,
      codeBlocks: true,
      timestamps: true,
      workspaceAttribution: true,
      incremental: false,
    },
    async discover(): Promise<any> {
      return { available: true, locations: [] };
    },
    async *extract(_opts: ExtractOptions): AsyncIterable<UnifiedSession> {
      for (const s of sessions) {
        yield s;
      }
    },
  };
}

function session(over: Partial<UnifiedSession> & { id: string; source: string }): UnifiedSession {
  return {
    tool: over.source,
    startedAt: 1000,
    messages: [],
    signals: { keptCode: [] },
    provenance: { adapterId: over.source, rawRef: over.id, extractedAt: Date.now() },
    ...over,
  } as UnifiedSession;
}

function registryWith(adapters: SourceAdapter[]): SourceRegistry {
  const reg = new SourceRegistry();
  for (const a of adapters) {
    reg.registerAdapter(a);
  }
  return reg;
}

// .autoclaw contract paths under a workspace root.
function paths(ws: string) {
  const root = path.join(ws, '.autoclaw');
  return {
    root,
    learningsDir: path.join(root, 'learnings'),
    preferences: path.join(root, 'vector', 'preferences.json'),
    agentStyle: path.join(root, 'agent-style.md'),
    memory: path.join(root, 'kdream', 'memory', 'MEMORY.md'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('intelligence-learn', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-learn-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  suite('generateAgentStyle (pure)', function () {
    test('renders all sections and is deterministic', function () {
      const md = generateAgentStyle('parsers', {
        successfulPatterns: ['Do X'],
        avoidedPatterns: ['Avoid Y'],
        preferredTools: ['Tool Z'],
      });
      assert.ok(md.includes('# Agent Style Guide'));
      assert.ok(md.includes('**Focus:** parsers'));
      assert.ok(md.includes('## Successful Patterns'));
      assert.ok(md.includes('- Do X'));
      assert.ok(md.includes('## Patterns to Avoid'));
      assert.ok(md.includes('- Avoid Y'));
      assert.ok(md.includes('## Preferred Tools'));
      assert.ok(md.includes('- Tool Z'));
      assert.strictEqual(md, generateAgentStyle('parsers', {
        successfulPatterns: ['Do X'],
        avoidedPatterns: ['Avoid Y'],
        preferredTools: ['Tool Z'],
      }));
    });

    test('empty aggregates render placeholders, no focus line', function () {
      const md = generateAgentStyle();
      assert.ok(!md.includes('**Focus:**'));
      assert.ok(md.includes('_None recorded yet._'));
    });
  });

  // -------------------------------------------------------------------------
  suite('learnFromSessions full run', function () {
    test('writes insight, merges preferences (no data loss), regenerates style, appends MEMORY', async function () {
      const ws = freshDir('ws-full');
      const p = paths(ws);

      // Pre-seed preferences.json with prior entries that must survive a merge.
      writeFile(
        p.preferences,
        JSON.stringify(
          {
            preferredPatterns: ['PRIOR-PATTERN'],
            avoided: ['PRIOR-AVOID'],
            tools: ['PRIOR-TOOL'],
            updatedAt: '2000-01-01T00:00:00.000Z',
          },
          null,
          2,
        ),
      );
      // Pre-seed MEMORY.md to prove append-only behavior.
      const priorMemory = '# MEMORY\n\nExisting durable note that must survive.\n';
      writeFile(p.memory, priorMemory);

      const s = session({
        id: 'native:1',
        source: 'autoclaw-native',
        tool: 'AutoClaw',
        title: 'Parser fix',
        summary: 'Refactored the tokenizer for clarity',
        messages: [{ role: 'assistant', text: 'apply this fix' }],
        signals: {
          keptCode: [{ code: 'const parsed = parse(input);', reason: 'user_approval', confidence: 0.8 }],
          outcome: 'shipped',
        },
      });

      const summary = await learnFromSessions({
        workspaceRoot: ws,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('autoclaw-native', [s])]),
        enabledIds: ['autoclaw-native'],
        env: envFor(ws),
        focus: 'parsers',
      });

      // Summary shape.
      assert.strictEqual(summary.sessionsAnalyzed, 1);
      assert.strictEqual(summary.kept, 1, 'one kept-code signal');
      assert.ok(summary.patterns >= 2, 'derived patterns present');
      assert.deepStrictEqual(summary.sources, ['autoclaw-native']);

      // insight-*.md written.
      const insights = listDir(p.learningsDir).filter((f) => /^insight-.*\.md$/.test(f));
      assert.strictEqual(insights.length, 1, 'exactly one insight file');
      const insightBody = readFile(path.join(p.learningsDir, insights[0]));
      assert.ok(insightBody.includes('Refactored the tokenizer'), 'insight reflects shipped summary');

      // preferences.json merged WITHOUT losing prior entries.
      const prefs = JSON.parse(readFile(p.preferences));
      assert.ok(prefs.preferredPatterns.includes('PRIOR-PATTERN'), 'prior pattern survives');
      assert.ok(prefs.avoided.includes('PRIOR-AVOID'), 'prior avoided survives');
      assert.ok(prefs.tools.includes('PRIOR-TOOL'), 'prior tool survives');
      assert.ok(prefs.preferredPatterns.length > 1, 'new patterns merged in');
      assert.notStrictEqual(prefs.updatedAt, '2000-01-01T00:00:00.000Z', 'updatedAt advanced');

      // agent-style.md regenerated.
      assert.ok(fs.existsSync(p.agentStyle), 'agent-style.md exists');
      const style = readFile(p.agentStyle);
      assert.ok(style.includes('# Agent Style Guide'));
      assert.ok(style.includes('**Focus:** parsers'));

      // MEMORY.md appended, never overwritten.
      const memory = readFile(p.memory);
      assert.ok(memory.startsWith(priorMemory), 'prior MEMORY content preserved at the top');
      assert.ok(memory.length > priorMemory.length, 'new content appended');
      assert.ok(memory.includes('/learn'), 'dated learn entry appended');
    });
  });

  // -------------------------------------------------------------------------
  suite('empty / no-signal fallback (R5.3)', function () {
    test('no sessions still produces non-empty default patterns', async function () {
      const ws = freshDir('ws-empty');
      const p = paths(ws);

      const summary = await learnFromSessions({
        workspaceRoot: ws,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('autoclaw-native', [])]),
        enabledIds: ['autoclaw-native'],
        env: envFor(ws),
      });

      assert.strictEqual(summary.sessionsAnalyzed, 0);
      assert.strictEqual(summary.kept, 0);
      assert.ok(summary.patterns > 0, 'default patterns fill an empty run');

      const style = readFile(p.agentStyle);
      assert.ok(!style.includes('_None recorded yet._'), 'sections are non-empty via defaults');

      const prefs = JSON.parse(readFile(p.preferences));
      assert.ok(prefs.preferredPatterns.length > 0, 'preferences seeded with defaults');
      assert.ok(prefs.avoided.length > 0);
      assert.ok(prefs.tools.length > 0);
    });
  });

  // -------------------------------------------------------------------------
  suite('dedup + --last N', function () {
    test('duplicate sessions across sources are merged', async function () {
      const ws = freshDir('ws-dedup');
      const messages = [{ role: 'assistant' as const, text: 'apply this fix to the parser' }];
      const a = session({ id: 'a:1', source: 'srcA', startedAt: 1000, messages });
      const b = session({ id: 'b:1', source: 'srcB', startedAt: 1500, messages });

      const summary = await learnFromSessions({
        workspaceRoot: ws,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('srcA', [a]), fakeAdapter('srcB', [b])]),
        enabledIds: ['srcA', 'srcB'],
        env: envFor(ws),
      });

      assert.strictEqual(summary.sessionsAnalyzed, 1, 'identical sessions deduped to one');
    });

    test('--last N caps analyzed sessions', async function () {
      const ws = freshDir('ws-last');
      const many: UnifiedSession[] = [];
      for (let i = 0; i < 5; i++) {
        many.push(
          session({
            id: `native:${i}`,
            source: 'autoclaw-native',
            startedAt: 1000 + i * 10_000,
            messages: [{ role: 'user', text: `distinct message ${i}` }],
          }),
        );
      }

      const summary = await learnFromSessions({
        workspaceRoot: ws,
        last: 2,
        config: offlineConfig(),
        registry: registryWith([fakeAdapter('autoclaw-native', many)]),
        enabledIds: ['autoclaw-native'],
        env: envFor(ws),
      });

      assert.strictEqual(summary.sessionsAnalyzed, 2, '--last 2 caps the run');
    });
  });
});
