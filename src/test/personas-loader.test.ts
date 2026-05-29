/**
 * personas-loader.test.ts — Unit tests for the persona loader.
 *
 * Implements the acceptance cases from
 * `docs/specs/persona-loader/spec.md`:
 *   1. Happy path (inline provider)
 *   2. Unknown persona
 *   3. Tool-denial path → finding_report written
 *   4. Fallback chain (ollama:* unavailable → providerFallback succeeds)
 *   5. (Slash-command surface — vscode integration; covered separately)
 *
 * Plus frontmatter parser + buildProfile sanity checks.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseFrontmatter,
  PersonaLoader,
  buildProfile,
  setInlineOverride,
  clearInlineOverride,
  DEFAULT_PROVIDER_CHAIN,
} from '../personas';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-personas-'));
}

function writeSkill(workspace: string, id: string, frontmatter: string): string {
  const dir = path.join(workspace, 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n# ${id}\n\nBody.\n`, 'utf8');
  return file;
}

function readLedger(workspace: string): Array<Record<string, unknown>> {
  const logPath = path.join(workspace, '.autoclaw', 'orchestrator', 'comms', 'comms-log.jsonl');
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function listFindings(workspace: string): string[] {
  const dir = path.join(
    workspace,
    '.autoclaw',
    'orchestrator',
    'comms',
    'inboxes',
    'shared',
  );
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.includes('finding_report') && f.endsWith('.json'));
}

suite('frontmatter parser', () => {
  test('parses simple key/value frontmatter', () => {
    const content = `---\nname: architect\ntrust: auto\n---\n\nBody.`;
    const fm = parseFrontmatter(content);
    assert.deepStrictEqual(fm, { name: 'architect', trust: 'auto' });
  });

  test('parses quoted strings, list blocks, and inline arrays', () => {
    const content = [
      '---',
      'name: persona',
      'description: "A quoted description"',
      'tools:',
      '  - read',
      '  - grep',
      'triggers: [foo, "bar", baz]',
      '---',
      '',
      'Body.',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.deepStrictEqual(fm, {
      name: 'persona',
      description: 'A quoted description',
      tools: ['read', 'grep'],
      triggers: ['foo', 'bar', 'baz'],
    });
  });

  test('returns null when frontmatter is absent', () => {
    assert.strictEqual(parseFrontmatter('# no frontmatter here\n'), null);
  });
});

suite('buildProfile', () => {
  test('applies defaults when frontmatter is sparse', () => {
    const profile = buildProfile('architect', { name: 'architect' });
    assert.strictEqual(profile.id, 'architect');
    assert.strictEqual(profile.displayName, 'Architect');
    assert.strictEqual(profile.trust, 'auto');
    assert.strictEqual(profile.preferredProvider, DEFAULT_PROVIDER_CHAIN.preferred);
    assert.strictEqual(profile.providerFallback, DEFAULT_PROVIDER_CHAIN.fallback);
    assert.deepStrictEqual(profile.triggers, []);
    assert.strictEqual(profile.toolAllowList, undefined);
  });

  test('honors frontmatter overrides', () => {
    const profile = buildProfile('sec', {
      name: 'security-auditor',
      trust: 'off',
      preferred_provider: 'ollama:llama3.1:70b',
      provider_fallback: 'claude-code-runner',
      tools: ['read', 'grep'],
      trigger: '/persona security-auditor, audit',
    });
    assert.strictEqual(profile.trust, 'off');
    assert.strictEqual(profile.preferredProvider, 'ollama:llama3.1:70b');
    assert.deepStrictEqual(profile.toolAllowList, ['read', 'grep']);
    assert.deepStrictEqual(profile.triggers, ['/persona security-auditor', 'audit']);
  });
});

suite('PersonaLoader — list + load', () => {
  let workspace: string;

  setup(() => {
    workspace = mkWorkspace();
  });

  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('list() returns persona ids with valid SKILL.md frontmatter', async () => {
    writeSkill(workspace, 'architect', 'name: architect\ntrust: auto');
    writeSkill(workspace, 'doc-writer', 'name: doc-writer\ntrust: auto');
    // A directory without frontmatter should be skipped.
    fs.mkdirSync(path.join(workspace, 'skills', 'no-frontmatter'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'skills', 'no-frontmatter', 'SKILL.md'),
      '# no frontmatter\n',
      'utf8',
    );
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const ids = await loader.list();
    assert.deepStrictEqual(ids, ['architect', 'doc-writer']);
  });

  test('load() parses frontmatter and caches the profile', async () => {
    writeSkill(workspace, 'architect', 'name: architect\ntrust: auto\npreferred_provider: inline');
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const a = await loader.load('architect');
    assert.strictEqual(a.id, 'architect');
    assert.strictEqual(a.preferredProvider, 'inline');
    // Mutating the file should not change the cached result.
    fs.writeFileSync(
      path.join(workspace, 'skills', 'architect', 'SKILL.md'),
      '---\nname: changed\n---\n',
      'utf8',
    );
    const b = await loader.load('architect');
    assert.strictEqual(b.id, 'architect');
  });
});

suite('PersonaLoader.dispatch — acceptance cases', () => {
  let workspace: string;

  setup(() => {
    workspace = mkWorkspace();
  });

  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    clearInlineOverride();
  });

  test('1. happy path — inline provider returns response + ledger row', async () => {
    writeSkill(workspace, 'architect', 'name: architect\ntrust: auto\npreferred_provider: inline');
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const result = await loader.dispatch('architect', {
      prompt: 'hi',
      sessionId: 'test-session-1',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.provider, 'inline');
    assert.strictEqual(result.fallbackTaken, false);
    assert.ok(result.response && result.response.includes('Architect'));
    const ledger = readLedger(workspace);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].type, 'persona_dispatch');
    assert.strictEqual(ledger[0].persona, 'architect');
    assert.strictEqual(ledger[0].provider, 'inline');
    assert.strictEqual(ledger[0].fallback_taken, false);
    assert.strictEqual(ledger[0].session_id, 'test-session-1');
  });

  test('2. unknown persona — clean error with available list, no ledger row', async () => {
    writeSkill(workspace, 'architect', 'name: architect\ntrust: auto');
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const result = await loader.dispatch('does-not-exist', {
      prompt: 'hi',
      sessionId: 'test-session-2',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'internal');
    assert.ok(
      result.errorMessage && result.errorMessage.includes('unknown persona'),
      `errorMessage was: ${result.errorMessage}`,
    );
    assert.ok(
      result.errorMessage && result.errorMessage.includes('architect'),
      'available list should include the existing architect persona',
    );
    const ledger = readLedger(workspace);
    assert.strictEqual(ledger.length, 0);
  });

  test('3. tool denial — finding_report written, no fallback', async () => {
    writeSkill(
      workspace,
      'architect',
      'name: architect\ntrust: auto\npreferred_provider: inline\nprovider_fallback: claude-code-runner',
    );
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const result = await loader.dispatch('architect', {
      prompt: '[deny-test] write to a denied tool',
      sessionId: 'test-session-3',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'tool_denied');
    assert.strictEqual(result.fallbackTaken, false, 'tool_denied should NOT fall back');
    const findings = listFindings(workspace);
    assert.strictEqual(findings.length, 1);
    const finding = JSON.parse(
      fs.readFileSync(
        path.join(
          workspace,
          '.autoclaw',
          'orchestrator',
          'comms',
          'inboxes',
          'shared',
          findings[0],
        ),
        'utf8',
      ),
    );
    assert.strictEqual(finding.type, 'finding_report');
    assert.strictEqual(finding.payload.persona, 'architect');
    assert.strictEqual(finding.payload.severity, 'medium');
  });

  test('4. fallback chain — ollama unavailable → claude-code-runner answers', async () => {
    writeSkill(
      workspace,
      'architect',
      'name: architect\ntrust: auto\npreferred_provider: ollama:llama3.1:70b\nprovider_fallback: claude-code-runner',
    );
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const result = await loader.dispatch('architect', {
      prompt: 'hi',
      sessionId: 'test-session-4',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.fallbackTaken, true);
    assert.strictEqual(result.provider, 'claude-code-runner');
    assert.ok(
      result.response && result.response.includes('claude-code-runner fallback'),
      `response was: ${result.response}`,
    );
    const ledger = readLedger(workspace);
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].fallback_taken, true);
  });

  test('inline override hook lets a test simulate provider behavior', async () => {
    writeSkill(workspace, 'architect', 'name: architect\ntrust: auto\npreferred_provider: inline');
    setInlineOverride((opts, profile) => ({
      ok: true,
      response: `[override] ${profile.id}: ${opts.prompt}`,
      tokens: { input: 1, output: 1 },
    }));
    const loader = new PersonaLoader({ workspaceRoot: workspace });
    const result = await loader.dispatch('architect', {
      prompt: 'X',
      sessionId: 'override-test',
    });
    assert.strictEqual(result.response, '[override] architect: X');
  });
});
