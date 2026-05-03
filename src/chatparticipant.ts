/**
 * chatparticipant.ts — @autoclaw VS Code Chat Participant
 *
 * Registers the @autoclaw participant so users can invoke skills directly
 * in any VS Code-based chat (Copilot, Kiro, KiloCode, Continue, etc.)
 * without copy-pasting prompts. The participant injects the SKILL.md
 * instructions as system context and forwards the user's request to the
 * active language model.
 *
 * Degrades gracefully when vscode.chat is unavailable (older VS Code,
 * Cursor, Windsurf). The launchSkill clipboard UX remains as the fallback.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Skill source map
// ---------------------------------------------------------------------------

const SKILL_SOURCES: Record<string, string> = {
  kdream:      'skills/kdream/SKILL.md',
  autobuild:   'skills/autobuild/SKILL.md',
  mateam:      'skills/mateam/SKILL.md',
  orchestrate: 'skills/orchestrate/SKILL.md',
};

// Maps @autoclaw /command to skill name
const COMMAND_TO_SKILL: Record<string, string> = {
  kdream:      'kdream',
  autobuild:   'autobuild',
  mateam:      'mateam',
  orchestrate: 'orchestrate',
  inbox:       'orchestrate',
};

// Suggested follow-ups per skill
const FOLLOWUPS: Record<string, string[]> = {
  kdream:      ['kdream ps', 'kdream work', 'kdream add "task description"'],
  autobuild:   ['autobuild list', 'autobuild run'],
  mateam:      ['mateam launch "describe the task"'],
  orchestrate: ['orchestrate plan', 'orchestrate assign', 'orchestrate status', 'orchestrate next', 'orchestrate review'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSkillMd(extensionPath: string, skillName: string): string | null {
  const src = SKILL_SOURCES[skillName];
  if (!src) { return null; }
  try {
    return fs.readFileSync(path.join(extensionPath, src), 'utf8');
  } catch {
    return null;
  }
}

function readInboxSummary(workspaceRoot: string): string {
  const inboxDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
  if (!fs.existsSync(inboxDir)) {
    return '_No shared inbox at `.autoclaw/orchestrator/comms/inboxes/shared/`. Run `/orchestrate init` first._';
  }

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 20);
  if (files.length === 0) { return '**Inbox is empty.**'; }

  const lines = files.map(f => {
    try {
      const raw = fs.readFileSync(path.join(inboxDir, f), 'utf8');
      const msg = JSON.parse(raw) as Record<string, unknown>;
      const type = String(msg.type ?? 'message');
      const from = String(msg.from ?? 'unknown');
      const ts = String(msg.timestamp ?? '').slice(0, 19).replace('T', ' ');
      const payload = msg.payload ? JSON.stringify(msg.payload).slice(0, 120) : '';
      return `- **[${type}]** from \`${from}\` at ${ts} — ${payload}`;
    } catch {
      return `- _(unreadable: ${f})_`;
    }
  });

  return `## Shared Inbox (${files.length} message${files.length === 1 ? '' : 's'})\n\n${lines.join('\n')}`;
}

function readOrchestratorStateSummary(workspaceRoot: string): string {
  const statePath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'state.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    return `\n\n---\n**Current Orchestrator State** (from \`state.json\`):\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``;
  } catch {
    return '';
  }
}

function parseCommandFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\//, '') ?? '';
}

// ---------------------------------------------------------------------------
// Chat participant registration
// ---------------------------------------------------------------------------

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  getWorkspaceRoot: () => string | undefined
): void {
  // Gracefully degrade on IDEs that don't expose vscode.chat (Cursor, Windsurf, older VS Code)
  if (!vscode.chat?.createChatParticipant) { return; }

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    // Determine skill from the subcommand (e.g. @autoclaw /orchestrate plan)
    // or by parsing the first word of the prompt as a fallback.
    const cmd = request.command
      ? request.command.toLowerCase()
      : parseCommandFromPrompt(request.prompt);

    const skillName = COMMAND_TO_SKILL[cmd] ?? 'kdream';
    const workspaceRoot = getWorkspaceRoot();

    // ── /inbox: just display messages, no LM call ───────────────────────────
    if (cmd === 'inbox') {
      if (!workspaceRoot) {
        stream.markdown('No workspace open. Open a folder first.');
        return { metadata: { command: 'inbox' } };
      }
      stream.markdown(readInboxSummary(workspaceRoot));
      stream.button({ command: 'autoclaw.orchestrate.status', title: '📊 Show Sprint Status' });
      stream.button({ command: 'autoclaw.orchestrate.assign', title: '▶️ Assign Next Sprint' });
      return { metadata: { command: 'inbox' } };
    }

    // ── Load SKILL.md ───────────────────────────────────────────────────────
    const skillMd = readSkillMd(context.extensionPath, skillName);
    if (!skillMd) {
      stream.markdown(
        `Could not load \`${skillName}\` skill definition. ` +
        `Try running **AutoClaw: Install Adapters** then reloading the extension.`
      );
      return { metadata: { command: cmd } };
    }

    // Inject live orchestrator state for orchestrate commands
    const stateContext = (workspaceRoot && skillName === 'orchestrate')
      ? readOrchestratorStateSummary(workspaceRoot)
      : '';

    const systemContent = skillMd + stateContext;
    const userContent = request.prompt.trim() || cmd;

    // ── Select LM and send ──────────────────────────────────────────────────
    // Prefer copilot/gpt-4o but accept any model. Fall back to clipboard if none.
    let model: vscode.LanguageModelChat | undefined;
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
      model = models[0];
      if (!model) {
        // Try any available model
        const any = await vscode.lm.selectChatModels({});
        model = any[0];
      }
    } catch {
      model = undefined;
    }

    if (!model) {
      await vscode.env.clipboard.writeText(`${systemContent}\n\nUser: ${userContent}`);
      stream.markdown(
        'No language model available via VS Code LM API. ' +
        'The full skill prompt has been copied to your clipboard — paste it into any AI chat.'
      );
      return { metadata: { command: cmd } };
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(systemContent),
      vscode.LanguageModelChatMessage.User(userContent),
    ];

    try {
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        if (token.isCancellationRequested) { break; }
        stream.markdown(chunk);
      }
    } catch (err) {
      stream.markdown(`\n\n_Error calling language model: ${(err as Error).message}_`);
    }

    // Suggest next actions
    stream.button({ command: 'autoclaw.launchSkill', title: '⚡ Launch Another Skill' });
    if (skillName === 'orchestrate' && workspaceRoot) {
      stream.button({ command: 'autoclaw.orchestrate.status', title: '📊 Sprint Status' });
      stream.button({ command: 'autoclaw.orchestrate.review', title: '✅ Run Consensus Review' });
    }

    return { metadata: { command: cmd } };
  };

  const participant = vscode.chat.createChatParticipant('autoclaw.autoclaw', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _ctx: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      const cmd = String((result.metadata as Record<string, unknown>)?.command ?? '');
      const skill = COMMAND_TO_SKILL[cmd] ?? cmd;
      return (FOLLOWUPS[skill] ?? []).map(f => ({
        prompt: f,
        label: f,
        command: f.split(' ')[0],
      }));
    },
  };

  context.subscriptions.push(participant);
}
