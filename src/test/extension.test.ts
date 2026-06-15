/**
 * KDream Dashboard Helper Tests
 * 
 * Unit tests for pure logic functions in kdream-helpers.ts.
 * These tests do NOT depend on vscode APIs and can run without mocking.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  parseMemoryTasks,
  formatTask,
  addTaskToContent,
  createInitialMemoryContent,
  isAutoclawInGitignore,
  addAutoclawToGitignore,
  parseLogEntries,
  parseTodosFromContent,
  getAdapterHealthEntry,
  isAdapterDetected,
  HOST_FORK_IDS,
  DEFAULT_ADAPTERS,
  generateNonce,
  shouldShowNotification,
  getTodayDate,
  getMemoryPath,
  getStatePath,
  getTodayLogPath,
  getKdreamDirPath,
  checkZippyMeshHealth
} from '../kdream-helpers';
import type { ParsedTask, TodoItem, AdapterHealth } from '../kdream-helpers';

suite('KDream Helper Tests', function () {
  
  // Test fixtures
  const testWorkspaceRoot = path.join(os.tmpdir(), 'kdream-test-workspace');
  const testAutoclawDir = path.join(testWorkspaceRoot, '.autoclaw', 'kdream');
  const testMemoryDir = path.join(testAutoclawDir, 'memory');
  const testMemoryPath = path.join(testMemoryDir, 'MEMORY.md');
  const testStatePath = path.join(testAutoclawDir, 'state.json');
  const testLogsDir = path.join(testAutoclawDir, 'logs');
  const testGitignorePath = path.join(testWorkspaceRoot, '.gitignore');

  setup(function () {
    // Create test directory structure
    fs.mkdirSync(testMemoryDir, { recursive: true });
    fs.mkdirSync(testLogsDir, { recursive: true });
  });

  teardown(function () {
    // Clean up test directory
    if (fs.existsSync(testWorkspaceRoot)) {
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
    }
  });

  // ============================================
  // 1. parseMemoryTasks() Tests
  // ============================================
  
  suite('parseMemoryTasks()', function () {
    
    test('should parse unchecked tasks', function () {
      const content = `# KDream Memory

## Follow-ups

- [ ] Task one
- [ ] Task two
`;
      const tasks = parseMemoryTasks(content);
      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(tasks[0].description, 'Task one');
      assert.strictEqual(tasks[0].completed, false);
      assert.strictEqual(tasks[1].description, 'Task two');
      assert.strictEqual(tasks[1].completed, false);
    });

    test('should parse checked tasks', function () {
      const content = `# KDream Memory

## Follow-ups

- [x] Completed task
- [X] Also completed
`;
      const tasks = parseMemoryTasks(content);
      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(tasks[0].completed, true);
      assert.strictEqual(tasks[1].completed, true);
    });

    test('should parse mixed tasks', function () {
      const content = `# KDream Memory

## Follow-ups

- [ ] Pending task
- [x] Completed task
- [ ] Another pending
`;
      const tasks = parseMemoryTasks(content);
      assert.strictEqual(tasks.length, 3);
      assert.strictEqual(tasks[0].completed, false);
      assert.strictEqual(tasks[1].completed, true);
      assert.strictEqual(tasks[2].completed, false);
    });

    test('should return empty array for no tasks', function () {
      const content = `# KDream Memory

## Follow-ups

No tasks here yet.
`;
      const tasks = parseMemoryTasks(content);
      assert.strictEqual(tasks.length, 0);
    });

    test('should handle empty content', function () {
      const tasks = parseMemoryTasks('');
      assert.strictEqual(tasks.length, 0);
    });
  });

  // ============================================
  // 2. formatTask() Tests
  // ============================================
  
  suite('formatTask()', function () {
    
    test('should format task with unchecked checkbox', function () {
      const result = formatTask('Test task');
      assert.strictEqual(result, '- [ ] Test task');
    });

    test('should handle special characters in task', function () {
      const result = formatTask('Task with "quotes" and \'apostrophes\'');
      assert.strictEqual(result, '- [ ] Task with "quotes" and \'apostrophes\'');
    });
  });

  // ============================================
  // 3. addTaskToContent() Tests
  // ============================================
  
  suite('addTaskToContent()', function () {
    
    test('should add task to content with Follow-ups section', function () {
      const content = `# KDream Memory

## Follow-ups

- [ ] Existing task
`;
      const result = addTaskToContent(content, 'New task');
      assert.ok(result.includes('- [ ] New task'));
      assert.ok(result.includes('- [ ] Existing task'));
    });

    test('should add Follow-ups section if missing', function () {
      const content = `# KDream Memory

Some other content.
`;
      const result = addTaskToContent(content, 'New task');
      assert.ok(result.includes('## Follow-ups'));
      assert.ok(result.includes('- [ ] New task'));
    });

    test('should insert task after header, before existing tasks', function () {
      const content = `# KDream Memory

## Follow-ups

- [ ] Existing task
`;
      const result = addTaskToContent(content, 'New task');
      const followUpsIndex = result.indexOf('## Follow-ups');
      const newTaskIndex = result.indexOf('- [ ] New task');
      const existingTaskIndex = result.indexOf('- [ ] Existing task');
      
      assert.ok(newTaskIndex > followUpsIndex, 'New task should be after Follow-ups header');
      assert.ok(newTaskIndex < existingTaskIndex, 'New task should be before existing tasks');
    });
  });

  // ============================================
  // 4. createInitialMemoryContent() Tests
  // ============================================
  
  suite('createInitialMemoryContent()', function () {
    
    test('should create valid MEMORY.md content', function () {
      const result = createInitialMemoryContent('First task');
      assert.ok(result.startsWith('# KDream Memory'));
      assert.ok(result.includes('## Follow-ups'));
      assert.ok(result.includes('- [ ] First task'));
    });
  });

  // ============================================
  // 5. isAutoclawInGitignore() Tests
  // ============================================
  
  suite('isAutoclawInGitignore()', function () {
    
    test('should return true when .autoclaw/ is present', function () {
      assert.strictEqual(isAutoclawInGitignore('node_modules/\n.autoclaw/\n'), true);
    });

    test('should return false when .autoclaw/ is absent', function () {
      assert.strictEqual(isAutoclawInGitignore('node_modules/\n*.log\n'), false);
    });

    test('should handle empty content', function () {
      assert.strictEqual(isAutoclawInGitignore(''), false);
    });
  });

  // ============================================
  // 6. addAutoclawToGitignore() Tests
  // ============================================
  
  suite('addAutoclawToGitignore()', function () {
    
    test('should append .autoclaw/ entry', function () {
      const content = 'node_modules/\n';
      const result = addAutoclawToGitignore(content);
      assert.ok(result.includes('.autoclaw/'));
      assert.ok(result.includes('# AutoClaw KDream data'));
    });
  });

  // ============================================
  // 7. parseLogEntries() Tests
  // ============================================
  
  suite('parseLogEntries()', function () {
    
    test('should return last N entries', function () {
      const content = `Line 1
Line 2
Line 3
Line 4
Line 5`;
      const result = parseLogEntries(content, 3);
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result, ['Line 3', 'Line 4', 'Line 5']);
    });

    test('should filter empty lines', function () {
      const content = `Line 1

Line 2

Line 3`;
      const result = parseLogEntries(content, 10);
      assert.strictEqual(result.length, 3);
    });

    test('should handle empty content', function () {
      const result = parseLogEntries('', 10);
      assert.strictEqual(result.length, 0);
    });
  });

  // ============================================
  // 8. parseTodosFromContent() Tests
  // ============================================
  
  suite('parseTodosFromContent()', function () {
    
    test('should find TODO comments', function () {
      const content = `// TODO: Fix this later
function test() {
  // FIXME: This is broken
  return true;
}`;
      const results = parseTodosFromContent(content, 'test.ts');
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].type, 'TODO');
      assert.strictEqual(results[0].text, 'Fix this later');
      assert.strictEqual(results[1].type, 'FIXME');
      assert.strictEqual(results[1].text, 'This is broken');
    });

    test('should include line numbers', function () {
      const content = `Line 1
// TODO: On line 2
Line 3`;
      const results = parseTodosFromContent(content, 'test.ts');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].line, 2);
    });

    test('should include relative file path', function () {
      const content = '// TODO: Test';
      const results = parseTodosFromContent(content, 'src/test.ts');
      assert.strictEqual(results[0].file, 'src/test.ts');
    });

    test('should handle TODO with colon separator', function () {
      const content = '// TODO: Fix this';
      const results = parseTodosFromContent(content, 'test.ts');
      assert.strictEqual(results[0].text, 'Fix this');
    });

    test('should handle TODO with dash separator', function () {
      const content = '// TODO - Fix this';
      const results = parseTodosFromContent(content, 'test.ts');
      assert.strictEqual(results[0].text, 'Fix this');
    });

    test('should return empty array for no TODOs', function () {
      const content = `function test() {
  return true;
}`;
      const results = parseTodosFromContent(content, 'test.ts');
      assert.strictEqual(results.length, 0);
    });
  });

  // ============================================
  // 9. getAdapterHealthEntry() Tests
  // ============================================
  
  suite('getAdapterHealthEntry()', function () {
    
    test('should return healthy for installed adapter', function () {
      const result = getAdapterHealthEntry('Test Adapter', true);
      assert.strictEqual(result.name, 'Test Adapter');
      assert.strictEqual(result.status, 'healthy');
      assert.strictEqual(result.details, 'Installed');
    });

    test('should return warning for missing adapter', function () {
      const result = getAdapterHealthEntry('Missing Adapter', false);
      assert.strictEqual(result.name, 'Missing Adapter');
      assert.strictEqual(result.status, 'warning');
      assert.strictEqual(result.details, 'Not detected');
    });
  });

  // ============================================
  // 10. DEFAULT_ADAPTERS Tests
  // ============================================
  
  suite('DEFAULT_ADAPTERS', function () {
    
    test('should include expected adapters', function () {
      const names = DEFAULT_ADAPTERS.map(a => a.name);
      assert.ok(names.includes('Claude Code'));
      assert.ok(names.includes('Cline'));
      assert.ok(names.includes('KiloCode'));
    });

    test('should have id (or explicit null for standalone hosts)', function () {
      // Cursor and Antigravity are standalone IDEs (not VS Code extensions),
      // so their `id` is null and they're detected via filesystem markers.
      const standaloneHosts = new Set(['Cursor', 'Antigravity']);
      for (const adapter of DEFAULT_ADAPTERS) {
        if (standaloneHosts.has(adapter.name)) {
          assert.strictEqual(
            adapter.id, null,
            `Standalone host ${adapter.name} should have id=null`
          );
        } else {
          assert.ok(adapter.id, `Adapter ${adapter.name} should have an id`);
        }
      }
    });
  });

  // ============================================
  // 10b. isAdapterDetected() Tests
  // ============================================

  suite('isAdapterDetected()', function () {
    const never = (_id: string): boolean => false;
    const kiro = DEFAULT_ADAPTERS.find(a => a.name === 'Kiro')!;
    const windsurf = DEFAULT_ADAPTERS.find(a => a.name === 'Windsurf')!;
    const cursor = DEFAULT_ADAPTERS.find(a => a.name === 'Cursor')!;
    const antigravity = DEFAULT_ADAPTERS.find(a => a.name === 'Antigravity')!;
    const claudeCode = DEFAULT_ADAPTERS.find(a => a.name === 'Claude Code')!;

    test('detects a host fork by app name even when its extension is absent', function () {
      // Reproduces the original bug: running inside Kiro, getExtension('amazon.kiro')
      // is undefined, but the host must still report as detected.
      assert.strictEqual(isAdapterDetected(kiro, 'kiro', never, undefined), true);
      assert.strictEqual(isAdapterDetected(windsurf, 'windsurf', never, undefined), true);
      assert.strictEqual(isAdapterDetected(cursor, 'cursor', never, undefined), true);
      assert.strictEqual(isAdapterDetected(antigravity, 'antigravity', never, undefined), true);
    });

    test('a host fork is NOT detected from a different host', function () {
      // Running inside Kiro should not light up Windsurf/Cursor/etc.
      assert.strictEqual(isAdapterDetected(windsurf, 'kiro', never, undefined), false);
      assert.strictEqual(isAdapterDetected(cursor, 'kiro', never, undefined), false);
      assert.strictEqual(isAdapterDetected(kiro, 'cursor', never, undefined), false);
    });

    test('a genuine extension is detected via the extension predicate', function () {
      const has = (id: string): boolean => id === 'Anthropic.claude-code';
      assert.strictEqual(isAdapterDetected(claudeCode, 'vscode', has, undefined), true);
      assert.strictEqual(isAdapterDetected(claudeCode, 'vscode', never, undefined), false);
    });

    test('Cursor falls back to a workspace marker when not the host', function () {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-cursor-'));
      try {
        assert.strictEqual(isAdapterDetected(cursor, 'vscode', never, ws), false);
        fs.mkdirSync(path.join(ws, '.cursor'));
        assert.strictEqual(isAdapterDetected(cursor, 'vscode', never, ws), true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('Antigravity falls back to a .agent/ workspace marker', function () {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ag-'));
      try {
        assert.strictEqual(isAdapterDetected(antigravity, 'vscode', never, ws), false);
        fs.mkdirSync(path.join(ws, '.agent'));
        assert.strictEqual(isAdapterDetected(antigravity, 'vscode', never, ws), true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('HOST_FORK_IDS covers every standalone host fork', function () {
      assert.deepStrictEqual(
        new Set(Object.keys(HOST_FORK_IDS)),
        new Set(['Cursor', 'Kiro', 'Windsurf', 'Antigravity'])
      );
    });
  });

  // ============================================
  // 11. generateNonce() Tests
  // ============================================
  
  suite('generateNonce()', function () {
    
    test('should generate string', function () {
      const nonce = generateNonce();
      assert.strictEqual(typeof nonce, 'string');
    });

    test('should generate default length of 32', function () {
      const nonce = generateNonce();
      assert.strictEqual(nonce.length, 32);
    });

    test('should generate custom length', function () {
      const nonce = generateNonce(16);
      assert.strictEqual(nonce.length, 16);
    });

    test('should generate unique nonces', function () {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();
      assert.notStrictEqual(nonce1, nonce2);
    });

    test('should only contain alphanumeric characters', function () {
      const nonce = generateNonce();
      assert.ok(/^[a-zA-Z0-9]+$/.test(nonce));
    });
  });

  // ============================================
  // 12. shouldShowNotificationHelper() Tests
  // ============================================
  
  suite('shouldShowNotificationHelper()', function () {
    
    test('should show all notifications when level is "all"', function () {
      assert.strictEqual(shouldShowNotification('all', 'info'), true);
      assert.strictEqual(shouldShowNotification('all', 'warning'), true);
      assert.strictEqual(shouldShowNotification('all', 'error'), true);
    });

    test('should show no notifications when level is "none"', function () {
      assert.strictEqual(shouldShowNotification('none', 'info'), false);
      assert.strictEqual(shouldShowNotification('none', 'warning'), false);
      assert.strictEqual(shouldShowNotification('none', 'error'), false);
    });

    test('should show only errors when level is "errors"', function () {
      assert.strictEqual(shouldShowNotification('errors', 'info'), false);
      assert.strictEqual(shouldShowNotification('errors', 'warning'), false);
      assert.strictEqual(shouldShowNotification('errors', 'error'), true);
    });

    test('should show errors and warnings when level is "warnings"', function () {
      assert.strictEqual(shouldShowNotification('warnings', 'info'), false);
      assert.strictEqual(shouldShowNotification('warnings', 'warning'), true);
      assert.strictEqual(shouldShowNotification('warnings', 'error'), true);
    });
  });

  // ============================================
  // 13. getTodayDate() Tests
  // ============================================
  
  suite('getTodayDate()', function () {
    
    test('should return YYYY-MM-DD format', function () {
      const date = getTodayDate();
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(date), `Date should be in YYYY-MM-DD format, got: ${date}`);
    });

    test('should return today\'s date', function () {
      const date = getTodayDate();
      const today = new Date().toISOString().split('T')[0];
      assert.strictEqual(date, today);
    });
  });

  // ============================================
  // 14. Path Helper Tests
  // ============================================
  
  suite('Path Helpers', function () {
    
    test('getKdreamDirPath should return correct path', function () {
      const result = getKdreamDirPath('/workspace');
      assert.strictEqual(result, path.join('/workspace', '.autoclaw', 'kdream'));
    });

    test('getMemoryPath should return correct path', function () {
      const result = getMemoryPath('/workspace');
      assert.strictEqual(result, path.join('/workspace', '.autoclaw', 'kdream', 'memory', 'MEMORY.md'));
    });

    test('getStatePath should return correct path', function () {
      const result = getStatePath('/workspace');
      assert.strictEqual(result, path.join('/workspace', '.autoclaw', 'kdream', 'state.json'));
    });

    test('getTodayLogPath should return path with today\'s date', function () {
      const result = getTodayLogPath('/workspace');
      const today = getTodayDate();
      assert.strictEqual(result, path.join('/workspace', '.autoclaw', 'kdream', 'logs', `${today}.md`));
    });
  });

  // ============================================
  // 15. checkZippyMeshHealth() Mock-based Tests
  // ============================================
  
  suite('checkZippyMeshHealth()', function () {
    
    test('should return warning status when fetch fails', async function () {
      // Use a URL that will definitely fail
      const result = await checkZippyMeshHealth('http://localhost:1');
      assert.strictEqual(result.name, 'ZippyMesh LLM Router');
      assert.strictEqual(result.status, 'warning');
    });

    test('should return a valid status with default URL (healthy or warning depending on environment)', async function () {
      const result = await checkZippyMeshHealth();
      assert.strictEqual(result.name, 'ZippyMesh LLM Router');
      assert.ok(['healthy', 'warning', 'error'].includes(result.status), `unexpected status: ${result.status}`);
    });

    test('should return object with expected shape', async function () {
      const result = await checkZippyMeshHealth('http://localhost:1');
      assert.ok(typeof result === 'object');
      assert.ok('name' in result);
      assert.ok('status' in result);
      assert.ok('details' in result);
      assert.strictEqual(typeof result.name, 'string');
      assert.strictEqual(typeof result.status, 'string');
      assert.strictEqual(typeof result.details, 'string');
    });
  });

  // ============================================
  // Integration Tests
  // ============================================
  
  suite('Integration Tests', function () {
    
    test('should be able to create memory, add tasks, and parse them back', function () {
      // Create initial content
      let content = createInitialMemoryContent('First task');
      
      // Add more tasks (new tasks are inserted after header, before existing ones)
      content = addTaskToContent(content, 'Second task');
      content = addTaskToContent(content, 'Third task');
      
      // Parse back - newest tasks appear first since they're inserted after the header
      const tasks = parseMemoryTasks(content);
      
      assert.strictEqual(tasks.length, 3);
      // Third task was added last, so it appears first (inserted right after header)
      assert.strictEqual(tasks[0].description, 'Third task');
      assert.strictEqual(tasks[1].description, 'Second task');
      assert.strictEqual(tasks[2].description, 'First task');
    });

    test('should handle full gitignore workflow', function () {
      let content = 'node_modules/\n*.log\n';
      
      // Check not present
      assert.strictEqual(isAutoclawInGitignore(content), false);
      
      // Add autoclaw
      content = addAutoclawToGitignore(content);
      
      // Check now present
      assert.strictEqual(isAutoclawInGitignore(content), true);
    });
  });
});
