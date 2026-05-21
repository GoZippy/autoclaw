/**
 * fleet-templates.ts — Quick-config fleet templates + VS Code "Start Fleet"
 * command (H2).
 *
 * Two responsibilities:
 *
 *   1. Quick-config templates — three ready-made fleet configurations,
 *      materialised on demand into `.autoclaw/templates/`:
 *        • solo-sprint.yaml   — one runner, no remote agents (fast local loop)
 *        • full-fleet.yaml    — every known runner + LMD monitoring
 *        • voidspec-sync.yaml — full fleet with a `.voidspec/` watcher enabled
 *
 *   2. {@link startFleetCommand} — the function the VS Code command
 *      `AutoClaw: Start Fleet` invokes. It picks (or asks for) a template,
 *      writes the registry, and boots the fleet via {@link fleetStart}. It is
 *      exported here but *not* wired into `src/extension.ts` — a separate
 *      session owns that file. See the TODO(extension) note below.
 *
 * Pure file-I/O + orchestration. *** NO LLM CALLS. ***
 *
 * H2 — Sprint-3 / WA-4 (Fleet VS Code command + templates).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fleetStart, FleetStartResult } from './fleet-start';

// ---------------------------------------------------------------------------
// Template model
// ---------------------------------------------------------------------------

/** The identifier of a built-in quick-config template. */
export type FleetTemplateId = 'solo-sprint' | 'full-fleet' | 'voidspec-sync';

/** A quick-config fleet template. */
export interface FleetTemplate {
  /** Template id — also the basename of its `.yaml` file. */
  id: FleetTemplateId;
  /** Short human-readable label for the picker UI. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Runner ids this template starts. */
  runners: string[];
  /** Whether the LMD health monitor is started. */
  lmd: boolean;
  /** Whether a `.voidspec/` directory watcher is started. */
  voidspecWatch: boolean;
}

/** Every built-in template, in picker display order. */
export const FLEET_TEMPLATES: Readonly<Record<FleetTemplateId, FleetTemplate>> = {
  'solo-sprint': {
    id: 'solo-sprint',
    label: 'Solo Sprint',
    description: 'One runner, no remote agents — fastest local edit loop.',
    runners: ['claude-code'],
    lmd: false,
    voidspecWatch: false,
  },
  'full-fleet': {
    id: 'full-fleet',
    label: 'Full Fleet',
    description: 'Every known runner plus LMD health monitoring.',
    runners: ['codex', 'hermes', 'openclaw'],
    lmd: true,
    voidspecWatch: false,
  },
  'voidspec-sync': {
    id: 'voidspec-sync',
    label: 'VoidSpec Sync',
    description: 'Full fleet with a .voidspec/ watcher for spec-driven work.',
    runners: ['codex', 'hermes', 'openclaw'],
    lmd: true,
    voidspecWatch: true,
  },
};

/** Ordered list of template ids, for picker UIs. */
export const FLEET_TEMPLATE_ORDER: FleetTemplateId[] = [
  'solo-sprint',
  'full-fleet',
  'voidspec-sync',
];

// ---------------------------------------------------------------------------
// Template YAML serialisation
// ---------------------------------------------------------------------------

/** Serialise a {@link FleetTemplate} to a small YAML document. */
export function templateToYaml(t: FleetTemplate): string {
  const lines: string[] = [];
  lines.push(`# AutoClaw fleet quick-config template: ${t.label}`);
  lines.push(`# ${t.description}`);
  lines.push(`id: ${t.id}`);
  lines.push(`label: "${t.label}"`);
  lines.push(`description: "${t.description}"`);
  lines.push(`runners: [${t.runners.join(', ')}]`);
  lines.push(`lmd: ${t.lmd}`);
  lines.push(`voidspec_watch: ${t.voidspecWatch}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse a fleet template YAML document back into a {@link FleetTemplate}.
 * Best-effort, no external YAML library — same approach as the orchestrator.
 */
export function parseTemplateYaml(content: string): FleetTemplate | null {
  const text = content.replace(/^﻿/, '');
  const scalar = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    if (!m) { return undefined; }
    return m[1].trim().replace(/^["']|["']$/g, '');
  };
  const bool = (key: string): boolean =>
    (scalar(key) ?? 'false').toLowerCase() === 'true';
  const list = (key: string): string[] => {
    const raw = scalar(key);
    if (!raw) { return []; }
    const inner = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1)
      : raw;
    return inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  };

  const id = scalar('id') as FleetTemplateId | undefined;
  if (!id) { return null; }
  return {
    id,
    label: scalar('label') ?? id,
    description: scalar('description') ?? '',
    runners: list('runners'),
    lmd: bool('lmd'),
    voidspecWatch: bool('voidspec_watch'),
  };
}

// ---------------------------------------------------------------------------
// Template materialisation
// ---------------------------------------------------------------------------

/** Resolve the absolute path to a workspace's `.autoclaw/templates/` dir. */
export function templatesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'templates');
}

/**
 * Write all built-in templates into `.autoclaw/templates/`.
 *
 * Idempotent: a template file whose content is byte-for-byte identical is not
 * rewritten. Returns the absolute paths of files that were created or updated.
 */
export function writeFleetTemplates(workspaceRoot: string): string[] {
  const dir = templatesDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });

  const changed: string[] = [];
  for (const id of FLEET_TEMPLATE_ORDER) {
    const filePath = path.join(dir, `${id}.yaml`);
    const yaml = templateToYaml(FLEET_TEMPLATES[id]);
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* none */ }
    if (existing !== yaml) {
      fs.writeFileSync(filePath, yaml, 'utf8');
      changed.push(filePath);
    }
  }
  return changed;
}

/**
 * Load a fleet template by id from `.autoclaw/templates/`. Falls back to the
 * built-in definition when the file is absent or unparseable.
 */
export function loadFleetTemplate(
  workspaceRoot: string,
  id: FleetTemplateId,
): FleetTemplate {
  const filePath = path.join(templatesDir(workspaceRoot), `${id}.yaml`);
  try {
    const parsed = parseTemplateYaml(fs.readFileSync(filePath, 'utf8'));
    if (parsed) { return parsed; }
  } catch { /* fall through to built-in */ }
  return FLEET_TEMPLATES[id];
}

// ---------------------------------------------------------------------------
// Template picker helper
// ---------------------------------------------------------------------------

/** A single pick option, shaped for a VS Code `showQuickPick`. */
export interface TemplatePickItem {
  /** Template id — use as the pick value. */
  id: FleetTemplateId;
  /** `label` for the quick-pick row. */
  label: string;
  /** `detail` for the quick-pick row. */
  detail: string;
}

/**
 * Build the quick-pick item list for the template picker UI.
 *
 * This is host-agnostic: it returns plain data the extension feeds straight
 * into `vscode.window.showQuickPick`. Keeping it here makes it unit-testable
 * without a VS Code host.
 */
export function buildTemplatePickItems(): TemplatePickItem[] {
  return FLEET_TEMPLATE_ORDER.map((id) => {
    const t = FLEET_TEMPLATES[id];
    return { id, label: t.label, detail: t.description };
  });
}

/**
 * Decide whether the template picker should be shown on this run.
 *
 * The picker is "first-run" UX: it shows when no fleet registry exists yet.
 * Once `.autoclaw/program/registry.json` has been written the picker is
 * skipped and the existing registry is reused.
 */
export function shouldShowTemplatePicker(workspaceRoot: string): boolean {
  const registry = path.join(
    workspaceRoot, '.autoclaw', 'program', 'registry.json',
  );
  return !fs.existsSync(registry);
}

// ---------------------------------------------------------------------------
// Registry materialisation
// ---------------------------------------------------------------------------

/**
 * Write `.autoclaw/program/registry.json` from a template's runner list so a
 * subsequent {@link fleetStart} boots exactly the template's runners.
 * Returns the absolute path of the registry file.
 */
export function applyTemplateToRegistry(
  workspaceRoot: string,
  template: FleetTemplate,
): string {
  const dir = path.join(workspaceRoot, '.autoclaw', 'program');
  fs.mkdirSync(dir, { recursive: true });
  const registryPath = path.join(dir, 'registry.json');
  const payload = JSON.stringify(
    {
      runners: template.runners,
      // Provenance — which template produced this registry.
      _source_template: template.id,
    },
    null,
    2,
  );
  fs.writeFileSync(registryPath, payload + '\n', 'utf8');
  return registryPath;
}

// ---------------------------------------------------------------------------
// VS Code command — AutoClaw: Start Fleet
// ---------------------------------------------------------------------------

/** Options for {@link startFleetCommand}. */
export interface StartFleetCommandOptions {
  /** Workspace root. */
  workspaceRoot: string;
  /**
   * The template to start. When omitted and a picker is needed, the
   * {@link StartFleetCommandOptions.pickTemplate} callback is invoked.
   */
  templateId?: FleetTemplateId;
  /**
   * Picker callback — invoked on first run when no `templateId` is given and
   * no registry exists. The extension host wires this to
   * `vscode.window.showQuickPick(buildTemplatePickItems())`. When it returns
   * `null` the command is cancelled. Defaults to picking `'full-fleet'`.
   */
  pickTemplate?: (items: TemplatePickItem[]) => Promise<FleetTemplateId | null>;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /** When true, skip the actual fleet boot (used by tests). */
  dryRun?: boolean;
}

/** Result surfaced by {@link startFleetCommand} to the VS Code UI. */
export interface StartFleetCommandResult {
  /** True when the fleet was started (false when the user cancelled). */
  started: boolean;
  /** The template that was used, if any. */
  template?: FleetTemplate;
  /** The fleet-start result, when {@link started} is true and not a dry run. */
  fleet?: FleetStartResult;
  /** Human-readable summary for an information message. */
  summary: string;
}

/**
 * Implementation of the `AutoClaw: Start Fleet` VS Code command.
 *
 * Flow:
 *   1. Ensure the three built-in templates exist under `.autoclaw/templates/`.
 *   2. Resolve the template: explicit `templateId`, else (first run) show the
 *      picker, else default to `full-fleet`.
 *   3. Write `.autoclaw/program/registry.json` from the template.
 *   4. Boot the fleet via {@link fleetStart} (skipped when `dryRun`).
 *
 * No `vscode` import — fully unit-testable. The extension host wraps it.
 *
 * TODO(extension): a separate session owns `src/extension.ts`. To wire this
 * command, that session should add to `package.json#contributes.commands`:
 *
 *   { "command": "autoclaw.fleet.start",
 *     "title": "AutoClaw: Start Fleet" }
 *
 * optionally a status-bar button, and in `activate()`:
 *
 *   context.subscriptions.push(
 *     vscode.commands.registerCommand('autoclaw.fleet.start', async () => {
 *       const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
 *       if (!root) { return; }
 *       const r = await startFleetCommand({
 *         workspaceRoot: root,
 *         pickTemplate: async (items) => {
 *           const pick = await vscode.window.showQuickPick(
 *             items.map(i => ({ label: i.label, detail: i.detail, id: i.id })),
 *             { placeHolder: 'Choose a fleet configuration' },
 *           );
 *           return pick ? pick.id : null;
 *         },
 *       });
 *       vscode.window.showInformationMessage(r.summary);
 *     }),
 *   );
 */
export async function startFleetCommand(
  opts: StartFleetCommandOptions,
): Promise<StartFleetCommandResult> {
  const logger = opts.logger ?? console;

  // 1. Materialise built-in templates.
  const written = writeFleetTemplates(opts.workspaceRoot);
  if (written.length > 0) {
    logger.info(`fleet: wrote ${written.length} template file(s).`);
  }

  // 2. Resolve which template to use.
  let templateId: FleetTemplateId | null = opts.templateId ?? null;
  if (templateId === null) {
    if (shouldShowTemplatePicker(opts.workspaceRoot) && opts.pickTemplate) {
      templateId = await opts.pickTemplate(buildTemplatePickItems());
      if (templateId === null) {
        return { started: false, summary: 'Start Fleet cancelled.' };
      }
    } else {
      // Not first run, or no picker supplied — default to the full fleet.
      templateId = 'full-fleet';
    }
  }

  const template = loadFleetTemplate(opts.workspaceRoot, templateId);

  // 3. Write the registry so fleetStart boots exactly this template.
  const registryPath = applyTemplateToRegistry(opts.workspaceRoot, template);
  logger.info(`fleet: registry written → ${registryPath}`);

  // 4. Boot the fleet (unless dry-run).
  if (opts.dryRun) {
    return {
      started: true,
      template,
      summary:
        `Fleet template "${template.label}" prepared (dry run) — ` +
        `runners [${template.runners.join(', ')}].`,
    };
  }

  let fleet: FleetStartResult;
  try {
    fleet = await fleetStart({
      workspaceRoot: opts.workspaceRoot,
      skipLmd: !template.lmd,
      logger,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`fleet: start failed — ${msg}`);
    return {
      started: false,
      template,
      summary: `Start Fleet failed: ${msg}`,
    };
  }

  const summary =
    `Fleet "${template.label}" started — ` +
    `${fleet.started.length} runner(s) up` +
    (fleet.failed.length > 0 ? `, ${fleet.failed.length} unavailable` : '') +
    `; LMD ${fleet.lmd.running ? fleet.lmd.mode : 'off'}` +
    (template.voidspecWatch ? '; VoidSpec watch enabled' : '') +
    '.';

  return { started: true, template, fleet, summary };
}
