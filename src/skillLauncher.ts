/**
 * Host-aware skill referencing for the AutoClaw "Launch Skill" picker.
 *
 * Each integrated IDE reads its always-on rules / skills from its OWN directory
 * and file format, and Claude Code invokes skills as slash commands rather than
 * by file path. These helpers render a skill invocation for whichever host is
 * active, so the picker never hands users a path that doesn't exist for their
 * setup (the classic ".clinerules/kdream.md on a Claude-Code-only install" bug).
 *
 * Pure module — no vscode / fs imports — so the rendering is trivially testable.
 * The host-resolution + on-disk presence checks live in extension.ts because
 * they need vscode + fs.
 */

/**
 * Skills generated into adapters/ by `npm run adapters:build`. Keep in sync with
 * SKILL_NAMES in scripts/adapters/index.ts — the launcher only offers skills
 * listed here, because anything else resolves to a file that exists in no host.
 */
export const SHIPPED_SKILLS = [
  'kdream', 'autobuild', 'mateam', 'orchestrate', 'security-auditor', 'doc-writer',
] as const;

export interface HostSkillConvention {
  /** 'slash' → invoke as `/skill args` (Claude Code); 'rule-file' → point at an installed rule file. */
  style: 'slash' | 'rule-file';
  /** workspace-relative rules directory (rule-file hosts only). */
  dir?: string;
  /** file extension including the leading dot (rule-file hosts only). */
  ext?: string;
}

/**
 * How each host references an installed skill. Mirrors the per-host adapter
 * transforms in scripts/adapters/ and the rulesDir column of AGENT_DEFINITIONS
 * in extension.ts. Hosts that ship no skill adapters (e.g. Codex) are absent
 * here on purpose, and render a plain fallback instruction.
 */
export const HOST_SKILL_CONVENTIONS: Record<string, HostSkillConvention> = {
  'claude-code': { style: 'slash' },
  cline:       { style: 'rule-file', dir: '.clinerules', ext: '.md' },
  kilocode:    { style: 'rule-file', dir: '.clinerules', ext: '.md' },
  kiro:        { style: 'rule-file', dir: '.kiro/steering', ext: '.md' },
  cursor:      { style: 'rule-file', dir: '.cursor/rules', ext: '.mdc' },
  continue:    { style: 'rule-file', dir: '.continue/prompts', ext: '.prompt' },
  windsurf:    { style: 'rule-file', dir: '.windsurf/rules', ext: '.md' },
  antigravity: { style: 'rule-file', dir: '.agent/rules', ext: '.md' },
};

export interface LaunchAction {
  label: string;
  /** Shipped skill id (SHIPPED_SKILLS). Omitted for the special inbox action. */
  skill?: string;
  /** Natural phrase after "run " — begins with the skill name, e.g. "kdream start". */
  command?: string;
  /** The cross-agent "check inbox" action, rendered specially per host. */
  inbox?: boolean;
}

export interface LaunchGoal {
  label: string;
  detail: string;
  actions: LaunchAction[];
}

/**
 * Render a skill invocation for `hostId`. `command` is the natural phrase that
 * follows "run " and begins with the skill name (e.g. "kdream start"). Pure.
 */
export function renderSkillPrompt(hostId: string, skill: string, command: string): string {
  const conv = HOST_SKILL_CONVENTIONS[hostId];
  if (!conv) {
    // Host without skill adapters (e.g. Codex): a plain instruction is the best we can do.
    return `Run ${command}.`;
  }
  if (conv.style === 'slash') {
    return `/${command}`;
  }
  return `Follow the instructions in ${conv.dir}/${skill}${conv.ext} — run ${command}`;
}

/**
 * Render the cross-agent "check inbox" prompt for `hostId`. cross-agent ships as
 * a rule file to every rule-file host and as an always-on rule to Claude Code,
 * where no file pointer is needed.
 */
export function renderInboxPrompt(hostId: string): string {
  const conv = HOST_SKILL_CONVENTIONS[hostId];
  const tail = 'Check your inbox at .autoclaw/orchestrator/comms/inboxes/ for new cross-agent messages and process them';
  if (!conv || conv.style === 'slash') {
    return `${tail}, following the AutoClaw cross-agent coordination protocol.`;
  }
  return `Read ${conv.dir}/cross-agent${conv.ext} for the protocol. ${tail}.`;
}
