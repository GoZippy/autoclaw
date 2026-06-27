import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createClaudeCodeAdapter } from '../intelligence/sources/claudeCode';
import type { AdapterEnv, SourceAdapter } from '../intelligence/types';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provenance-'));
}

/**
 * Encode a cwd the way Claude Code does: replace path separators and colons
 * with hyphens. This mirrors the directory naming under ~/.claude/projects/.
 */
function encodeCwd(p: string): string {
  return p.replace(/[:/\\]/g, '-');
}

function writeSession(projectsDir: string, cwd: string, sessionId: string): void {
  const dir = path.join(projectsDir, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ sessionId, cwd, type: 'summary', summary: 'test session' }),
    JSON.stringify({ type: 'human', message: { role: 'user', content: 'hello' } }),
  ].join('\n') + '\n';
  fs.writeFileSync(file, lines, 'utf8');
}

async function getCounts(adapter: SourceAdapter): Promise<{ matched: number; ignored: number }> {
  if (!adapter.countWorkspaceSessions) { return { matched: 0, ignored: 0 }; }
  return adapter.countWorkspaceSessions();
}

suite('ClaudeCodeAdapter — countWorkspaceSessions', () => {
  test('counts matched vs ignored sessions by workspace', async () => {
    const home = makeTmp();
    const projectsDir = path.join(home, '.claude', 'projects');
    const wsRoot = 'K:\\Projects\\MyProject';

    // Two sessions matching the workspace.
    writeSession(projectsDir, wsRoot, 'sess-1');
    writeSession(projectsDir, wsRoot, 'sess-2');
    // One session from a different project.
    writeSession(projectsDir, 'K:\\Projects\\OtherProject', 'sess-3');

    const adapter = createClaudeCodeAdapter({ projectsDir });
    const env: AdapterEnv = {
      homeDir: home,
      workspaceRoot: wsRoot,
      platform: 'win32',
      env: {},
    };
    await adapter.discover(env);

    const counts = await getCounts(adapter);
    assert.strictEqual(counts.matched, 2);
    assert.strictEqual(counts.ignored, 1);
  });

  test('no workspace root → zeros', async () => {
    const home = makeTmp();
    const adapter = createClaudeCodeAdapter();
    const env: AdapterEnv = {
      homeDir: home,
      workspaceRoot: '',
      platform: 'win32',
      env: {},
    };
    await adapter.discover(env);

    const counts = await getCounts(adapter);
    assert.deepStrictEqual(counts, { matched: 0, ignored: 0 });
  });

  test('subdirectory of workspace counts as matched', async () => {
    const home = makeTmp();
    const projectsDir = path.join(home, '.claude', 'projects');
    const wsRoot = 'K:\\Projects\\MyProject';

    writeSession(projectsDir, `${wsRoot}\\src\\components`, 'sess-sub');

    const adapter = createClaudeCodeAdapter({ projectsDir });
    const env: AdapterEnv = {
      homeDir: home,
      workspaceRoot: wsRoot,
      platform: 'win32',
      env: {},
    };
    await adapter.discover(env);

    const counts = await getCounts(adapter);
    assert.strictEqual(counts.matched, 1);
    assert.strictEqual(counts.ignored, 0);
  });
});
