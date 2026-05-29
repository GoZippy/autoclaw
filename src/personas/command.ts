/**
 * VS Code command registration for `/persona <id> "<prompt>"`.
 *
 * Per the persona-loader spec, this file does NOT edit `extension.ts`.
 * It exports `registerPersonaCommand(context)` for the extension to
 * call from its `activate()` once. `vscode` is required lazily so this
 * module loads cleanly in unit tests.
 *
 * @see docs/specs/persona-loader/spec.md §Slash-command wiring
 */

import { PersonaLoader, type DispatchOptions } from './loader';

interface VsCodeSubscription {
  dispose(): void;
}

interface VsCodeLike {
  commands: {
    registerCommand(
      id: string,
      handler: (...args: unknown[]) => unknown,
    ): VsCodeSubscription;
  };
  window: {
    showInformationMessage(msg: string): Thenable<unknown> | unknown;
    showErrorMessage(msg: string): Thenable<unknown> | unknown;
  };
  workspace: {
    workspaceFolders?: ReadonlyArray<{ uri: { fsPath: string } }>;
  };
}

interface VsCodeContextLike {
  subscriptions: VsCodeSubscription[];
}

/**
 * Register the `autoclaw.persona` command. Returns the disposable so
 * the caller can manage its lifetime if it prefers (the function also
 * pushes it onto `context.subscriptions`).
 *
 * If `vscode` cannot be required (test / headless context), this is a
 * no-op that returns a dummy disposable.
 */
export function registerPersonaCommand(
  context: VsCodeContextLike,
  loader?: PersonaLoader,
): VsCodeSubscription {
  let vscode: VsCodeLike;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vscode = require('vscode') as VsCodeLike;
  } catch {
    return { dispose() {} };
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return { dispose() {} };
  }

  const effectiveLoader = loader ?? new PersonaLoader({ workspaceRoot });

  const cmd = vscode.commands.registerCommand(
    'autoclaw.persona',
    async (...args: unknown[]) => {
      const argLine = args.map((a) => String(a)).join(' ').trim();
      const m = argLine.match(/^(\S+)\s+(.*)$/);
      if (!m) {
        const available = await effectiveLoader.list();
        await vscode.window.showErrorMessage(
          `Usage: /persona <id> "<prompt>". Available: ${available.join(', ') || '(none)'}`,
        );
        return;
      }
      const [, id, promptRaw] = m;
      const prompt = promptRaw.trim().replace(/^["']|["']$/g, '');
      const sessionId = randomUuid();
      const opts: DispatchOptions = { prompt, sessionId, allowFallback: true };
      const result = await effectiveLoader.dispatch(id, opts);
      if (!result.ok) {
        await vscode.window.showErrorMessage(
          `Persona ${id} failed (${result.errorClass}): ${result.errorMessage}`,
        );
        return;
      }
      const prefix = result.fallbackTaken
        ? `(using fallback provider: ${result.provider})\n\n`
        : '';
      await vscode.window.showInformationMessage(prefix + (result.response ?? ''));
    },
  );

  context.subscriptions.push(cmd);
  return cmd;
}

function randomUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const c = require('crypto') as typeof import('crypto');
  if (typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return c.randomBytes(16).toString('hex');
}
