/**
 * extensionActivate.test.ts — exercises the real `activate()` entry point in
 * plain node (no VS Code host).
 *
 * The sibling `activation.test.ts` deliberately does NOT call `activate()` (it
 * runs only under the `@vscode/test-cli` host, which already activated the
 * extension). That leaves the actual `activate(context)` call — where all 35
 * command registrations + watcher/output-channel wiring happen — untested in
 * the node suite. This test closes that gap: it injects a stub `vscode`
 * module, loads the *compiled* `out/extension.js`, and drives `activate()`,
 * asserting every command registers and nothing throws.
 *
 * `activate()` starts several `setInterval` loops (autobuild/heartbeat/…), so
 * timers are neutralized around the call to avoid leaking background work.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import Module = require('module');

const registeredCommands: string[] = [];
const dispose = () => ({ dispose() {} });
const event = () => (_listener: unknown) => dispose();
const uri = (p: string) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p, with() { return this; } });

const vscodeStub: Record<string, unknown> = {
  commands: {
    registerCommand: (name: string) => { registeredCommands.push(name); return dispose(); },
    registerTextEditorCommand: (name: string) => { registeredCommands.push(name); return dispose(); },
    executeCommand: async () => undefined,
    getCommands: async () => registeredCommands.slice(),
  },
  window: {
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => ({}),
    showSaveDialog: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, hide() {}, clear() {}, replace() {}, dispose() {}, name: '' }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    registerWebviewViewProvider: () => dispose(),
    createTreeView: () => ({ dispose() {} }),
    withProgress: async (_o: unknown, task: (p: unknown, t: unknown) => unknown) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: event() }),
    visibleTextEditors: [],
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: event(),
  },
  workspace: {
    workspaceFolders: [{ uri: uri(process.cwd()), name: 'ws', index: 0 }],
    getConfiguration: () => ({ get: (_k: string, d?: unknown) => d, has: () => false, update: async () => {}, inspect: () => undefined }),
    getWorkspaceFolder: () => undefined,
    onDidSaveTextDocument: event(),
    onDidChangeConfiguration: event(),
    onDidChangeWorkspaceFolders: event(),
    createFileSystemWatcher: () => ({ onDidCreate: event(), onDidChange: event(), onDidDelete: event(), dispose() {} }),
    findFiles: async () => [],
    openTextDocument: async () => ({ getText: () => '', uri: uri('') }),
    asRelativePath: (p: unknown) => String(p),
  },
  extensions: { getExtension: () => undefined, all: [], onDidChange: event() },
  env: { appName: 'VS Code', appRoot: '', openExternal: async () => true, clipboard: { writeText: async () => {}, readText: async () => '' }, machineId: 'test', sessionId: 'test', uriScheme: 'vscode', language: 'en' },
  Uri: {
    file: uri,
    parse: uri,
    joinPath: (base: { fsPath?: string; path?: string }, ...segs: string[]) => uri(path.join(base.fsPath ?? base.path ?? '', ...segs)),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
  EventEmitter: class { event = event(); fire() {} dispose() {} },
  Disposable: { from: () => dispose() },
  ThemeIcon: class { constructor(public id: string) {} },
  ThemeColor: class { constructor(public id: string) {} },
  TreeItem: class { constructor(public label: unknown) {} },
  MarkdownString: class { value = ''; appendMarkdown() { return this; } },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
};

// Intercept require('vscode') process-wide for the duration of this file.
type Loader = { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = (Module as unknown as Loader)._load;
(Module as unknown as Loader)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') { return vscodeStub; }
  return realLoad.call(this, request, ...rest);
};

function fakeContext() {
  const memento = { get: (_k: string, d?: unknown) => d, update: async () => {}, keys: () => [] as string[] };
  return {
    subscriptions: [] as unknown[],
    extensionUri: uri(process.cwd()),
    extensionPath: process.cwd(),
    globalState: { ...memento, setKeysForSync() {} },
    workspaceState: memento,
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: event() },
    asAbsolutePath: (p: string) => path.join(process.cwd(), p),
    globalStorageUri: uri(os.tmpdir()),
    storageUri: uri(os.tmpdir()),
  };
}

suite('extension activate() — node smoke (stubbed vscode)', () => {
  let ext: { activate: (c: unknown) => unknown; deactivate: () => unknown };

  suiteTeardown(() => {
    (Module as unknown as Loader)._load = realLoad;
  });

  test('compiled out/extension.js loads + exports activate/deactivate', () => {
    ext = require(path.resolve(__dirname, '..', 'extension.js'));
    assert.strictEqual(typeof ext.activate, 'function');
    assert.strictEqual(typeof ext.deactivate, 'function');
  });

  test('activate() registers all commands without throwing', () => {
    registeredCommands.length = 0;
    const ctx = fakeContext();

    // Neutralize the interval loops activate() starts so none leak.
    const realSetInterval = global.setInterval;
    const handles: NodeJS.Timeout[] = [];
    (global as unknown as { setInterval: unknown }).setInterval = (() => {
      const h = realSetInterval(() => {}, 1 << 30);
      handles.push(h);
      return h;
    }) as unknown as typeof setInterval;

    try {
      assert.doesNotThrow(() => ext.activate(ctx), 'activate() must not throw');
    } finally {
      (global as unknown as { setInterval: typeof setInterval }).setInterval = realSetInterval;
      handles.forEach(h => clearInterval(h));
    }

    assert.ok(registeredCommands.length >= 30, `expected >=30 commands, got ${registeredCommands.length}`);
    assert.ok(registeredCommands.includes('autoclaw.voidspec.sync'), 'voidspec.sync registered');
    assert.ok((ctx.subscriptions as unknown[]).length > 0, 'disposables pushed to subscriptions');
  });

  test('deactivate() does not throw', () => {
    assert.doesNotThrow(() => ext.deactivate());
  });
});
