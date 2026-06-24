/**
 * healthSurface.ts — the always-on, global surface for Intelligence-Layer health
 * (Theme 3: proactive guidance). It owns:
 *   - a status-bar item that shows the health rollup (green/amber/red + nudge
 *     count) and, on click, offers the actionable nudges as a QuickPick;
 *   - a one-shot activation probe that raises a SINGLE actionable toast when the
 *     layer is in a red state (deduped so it never nags in a loop);
 *   - a once-per-tool consent prompt that auto-detects other AI tools' sessions
 *     on disk and offers to learn from them (the "auto-enable detected tools"
 *     flow) — detection is presence-only (discover), so no transcript is read
 *     before the user opts in.
 *
 * This is the only file that imports both `vscode` and the (vscode-free) health
 * aggregator, keeping `extension.ts` to a single registration call.
 */

import * as vscode from 'vscode';

import { getIntelligenceHealth, IntelligenceHealth, HealthNudge } from './health';
import { pendingConsentSources, setSourceEnabled } from './sourcesCommand';

const STATUS_CLICK_CMD = 'autoclaw.intelligence.healthStatus';
const REFRESH_CMD = 'autoclaw.intelligence.refreshHealth';
const DASHBOARD_FOCUS_CMD = 'autoclawIntelligenceDashboard.focus';
/** workspaceState key holding the source ids we've already offered to ingest. */
const PROMPTED_IDS_KEY = 'autoclaw.intelligence.autoEnable.promptedIds';

const STATUS_ICON: Record<IntelligenceHealth['status'], string> = {
  green: '$(check)',
  amber: '$(warning)',
  red: '$(error)',
};

/**
 * Register the Intelligence health surface. Pure registration — the activation
 * probe + auto-enable detection are fired AFTER activation (deferred, best-effort)
 * so nothing here blocks startup or throws into the activation path.
 */
export function registerIntelligenceHealthSurface(
  context: vscode.ExtensionContext,
  getWorkspaceRoot: () => string | undefined,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -5);
  item.command = STATUS_CLICK_CMD;
  context.subscriptions.push(item);

  let latest: IntelligenceHealth | null = null;
  let redNotified = false;

  const settings = () => vscode.workspace.getConfiguration('autoclaw.intelligence');

  async function probe(): Promise<IntelligenceHealth | null> {
    const ws = getWorkspaceRoot();
    if (!ws) {
      return null;
    }
    try {
      return await getIntelligenceHealth(ws, {
        probe: true,
        backendDirOverride: settings().get<string>('backendDir') || undefined,
        systemDir: settings().get<string>('systemDir') || undefined,
        globalStorageFallback: context.globalStorageUri?.fsPath,
      });
    } catch {
      return null;
    }
  }

  function render(health: IntelligenceHealth | null): void {
    latest = health;
    if (!health) {
      item.hide();
      return;
    }
    const count = health.nudges.length;
    item.text = `${STATUS_ICON[health.status]} Intel${count ? ` ${count}` : ''}`;
    item.backgroundColor =
      health.status === 'red'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : health.status === 'amber'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Intelligence — ${health.status.toUpperCase()}**\n\n`);
    md.appendMarkdown(`Provider: ${health.provider.detail}\n\n`);
    md.appendMarkdown(indexLine(health) + '\n\n');
    if (count) {
      md.appendMarkdown(health.nudges.map((n) => `- ${severityIcon(n.severity)} ${n.title}`).join('\n'));
    } else {
      md.appendMarkdown('All good.');
    }
    item.tooltip = md;
    item.show();
  }

  async function refresh(): Promise<void> {
    const health = await probe();
    render(health);
    if (health && health.status === 'red' && !redNotified) {
      redNotified = true;
      void notifyRed(health);
    } else if (health && health.status !== 'red') {
      redNotified = false; // re-arm once the layer recovers
    }
  }

  // Status-bar click → an actionable QuickPick of the current nudges.
  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_CLICK_CMD, async () => {
      const health = latest ?? (await probe());
      render(health);
      const picks: Array<vscode.QuickPickItem & { run?: () => Thenable<unknown> }> = [];
      for (const n of health?.nudges ?? []) {
        picks.push({
          label: `${severityIcon(n.severity)} ${n.title}`,
          detail: n.action ? `${n.detail}  ·  ${n.action.label}` : n.detail,
          run: n.action ? () => runHealthCommand(n.action!.command) : undefined,
        });
      }
      picks.push({ label: '$(dashboard) Open Intelligence Dashboard', run: () => openDashboard() });
      picks.push({ label: '$(refresh) Re-check health', run: () => refresh() });
      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder:
          health && health.status !== 'green'
            ? 'Intelligence needs attention — pick a fix'
            : 'Intelligence health',
      });
      if (choice?.run) {
        await choice.run();
        await refresh();
      }
    }),
  );

  context.subscriptions.push(vscode.commands.registerCommand(REFRESH_CMD, () => refresh()));

  // Deferred, best-effort: probe health + detect ingestable tools after startup.
  const timer = setTimeout(() => {
    void refresh();
    void maybeAutoEnableSources(context, getWorkspaceRoot());
  }, 3500);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

function indexLine(h: IntelligenceHealth): string {
  const i = h.index;
  if (i.neverIndexed) {
    return 'Index: not built yet';
  }
  const parts: string[] = [];
  if (typeof i.chunkCount === 'number') {
    parts.push(`${i.chunkCount} chunks`);
  }
  if (i.storeModel) {
    parts.push(i.storeModel);
  }
  if (i.stale || i.embeddingDegraded) {
    parts.push('STALE');
  }
  if (typeof i.driftFiles === 'number' && i.driftFiles > 0) {
    parts.push(`${i.driftFiles} files changed since`);
  }
  return `Index: ${parts.join(' · ') || 'present'}`;
}

function severityIcon(s: HealthNudge['severity']): string {
  return s === 'error' ? '$(error)' : s === 'warn' ? '$(warning)' : '$(info)';
}

async function notifyRed(health: IntelligenceHealth): Promise<void> {
  const top = health.nudges.find((n) => n.severity === 'error') ?? health.nudges[0];
  if (!top) {
    return;
  }
  const buttons = top.action ? [top.action.label, 'Dismiss'] : ['Open dashboard', 'Dismiss'];
  const choice = await vscode.window.showWarningMessage(`AutoClaw Intelligence: ${top.title}. ${top.detail}`, ...buttons);
  if (choice === 'Dismiss' || choice === undefined) {
    return;
  }
  if (top.action && choice === top.action.label) {
    await runHealthCommand(top.action.command);
  } else {
    await openDashboard();
  }
}

async function runHealthCommand(commandId: string): Promise<void> {
  try {
    const all = await vscode.commands.getCommands(true);
    if (all.includes(commandId)) {
      await vscode.commands.executeCommand(commandId);
    }
  } catch {
    // best-effort — a missing command should never throw out of a nudge
  }
}

async function openDashboard(): Promise<void> {
  try {
    await vscode.commands.executeCommand(DASHBOARD_FOCUS_CMD);
  } catch {
    // view may not be available in every host
  }
}

/**
 * Auto-enable detected tools: when other AI tools' sessions are present on disk
 * but not yet consented, offer (once per tool) to learn from them. Uses the
 * existing consent-safe `pendingConsentSources` (presence-only discovery — never
 * reads a transcript before opt-in). Deduped via workspaceState so it never nags.
 */
async function maybeAutoEnableSources(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (!workspaceRoot) {
    return;
  }
  let pending: string[] = [];
  try {
    const consent = await pendingConsentSources({ workspaceRoot, log: () => undefined });
    pending = consent.toPrompt;
  } catch {
    return; // discovery failed — never block or nag
  }
  const prompted = new Set(context.workspaceState.get<string[]>(PROMPTED_IDS_KEY, []));
  const fresh = pending.filter((id) => !prompted.has(id));
  if (fresh.length === 0) {
    return;
  }

  const list = fresh.join(', ');
  const choice = await vscode.window.showInformationMessage(
    `AutoClaw found sessions from other AI tools (${list}). Learn from them too? ` +
      'They stay local and are redacted before indexing.',
    'Enable & learn',
    'Choose…',
    'Not now',
  );

  // Remember we asked for these ids regardless of the answer, so we don't nag.
  fresh.forEach((id) => prompted.add(id));
  await context.workspaceState.update(PROMPTED_IDS_KEY, [...prompted]);

  if (choice === 'Enable & learn') {
    for (const id of fresh) {
      await setSourceEnabled(workspaceRoot, id, true, () => undefined);
    }
    await runHealthCommand('autoclaw.intelligence.learn');
  } else if (choice === 'Choose…') {
    await runHealthCommand('autoclaw.intelligence.sources');
  }
}
