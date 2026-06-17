/**
 * AutoClaw Doctor — Health Check
 *
 * Read-only health report producer. No `vscode.window.*` calls live in this
 * module so it can be unit-tested against a temp workspace. The extension
 * activates `runDoctor` and renders the structured `DoctorReport` into a
 * dedicated OutputChannel.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import {
  checkZippyMeshHealth,
  getKdreamDirPath,
  getMemoryPath,
  getStatePath,
  getTodayLogPath,
  getTodayDate,
  isAutoclawInGitignore
} from './kdream-helpers';
import type { AdapterHealth } from './kdream-helpers';
import {
  discoverWorkflows,
  getWorkflowsDir,
  getRegistryPath,
  readRegistry,
  parseCron
} from './autobuild';
import { detectIde } from './ide-ports';
import { vectorBackendPreflight, VectorBackendPreflight } from './intelligence/vector';
import { openKnowledgeGraph } from './intelligence/kg';
import { intelligencePaths } from './intelligence/paths';

// Vscode is optional at runtime — passed in via dependency injection so the
// module can run under plain Mocha without `vscode` being on the import path.
export interface DoctorVscodeShim {
  workspaceRoot?: string;
  isExtensionInstalled?: (id: string) => boolean;
  /** Back-compat flag; prefer `hostAppName` which covers all VS Code forks. */
  isAntigravityHost?: boolean;
  /** `vscode.env.appName` — used to detect host IDE forks (Kiro/Cursor/…). */
  hostAppName?: string;
  zippymeshUrl?: string;
  /** Knowledge Graph settings. Optional — tests can omit. */
  kg?: {
    /** `autoclaw.kg.enabled` — the in-process store master switch. */
    enabled?: boolean;
    /** `autoclaw.kg.port` — only applies to the optional standalone daemon. */
    port?: number;
    /** `autoclaw.kg.dbPath` override — empty string ⇒ `.autoclaw/kg/kg.db` default. */
    dbPath?: string;
  };
}

export interface WorkspaceSection {
  workspaceRoot: string | null;
  autoclawDirExists: boolean;
  autoclawInGitignore: boolean | null; // null when no .gitignore present
  gitignorePresent: boolean;
}

export interface KdreamStateSection {
  initialised: boolean;
  status?: string;
  tick?: number;
  lastDream?: string;
  started?: string;
  raw?: unknown;
  error?: string;
}

export interface MemorySection {
  present: boolean;
  lineCount: number;
  openFollowups: number;
  doneFollowups: number;
  hasFollowupsSection: boolean;
  hasFactsSection: boolean;
  hasObservationsSection: boolean;
}

export interface LogsSection {
  todayLogPresent: boolean;
  todayLogSizeBytes: number;
  todayLogLastEntryTimestamp: string | null;
  totalLogFiles: number;
}

export type AdapterDriftStatus = 'ok' | 'drift' | 'skipped' | 'error';

export interface AdapterDriftSection {
  status: AdapterDriftStatus;
  exitCode: number | null;
  driftedFiles: number;
  message: string;
  output: string;
}

export interface AdapterHostStatus {
  host: string;
  extensionId: string | null;
  extensionInstalled: boolean;
  destination: string;
  destinationExists: boolean;
  expectedFiles: { file: string; present: boolean }[];
  notes?: string;
}

export interface AdapterInstallationSection {
  hosts: AdapterHostStatus[];
}

export interface SkillsSourceSection {
  skillsRoot: string;
  skills: { name: string; skillMdPath: string; present: boolean }[];
  allPresent: boolean;
}

export interface AutobuildWorkflowStatus {
  name: string;
  cron: string;
  workflowPresent: boolean;
  cronValid: boolean;
  cronError?: string;
  lastRun: string | null;
  status: string;
  lastLog?: string;
}

export interface AutobuildSection {
  workflowsDir: string;
  workflowCount: number;
  registryPresent: boolean;
  workflows: AutobuildWorkflowStatus[];
}

/**
 * Knowledge Graph doctor section. The KG is an IN-PROCESS store on the
 * Intelligence Layer's ABI-proof node:sqlite driver (no child process, no
 * native deps). We report the realized backend, not a daemon's deps/entry.
 */
export interface KgDaemonSection {
  /** `autoclaw.kg.enabled` — the in-process store master switch. */
  enabled: boolean;
  /** `true` when no SQLite driver loaded (writes no-op, reads []). */
  degraded: boolean;
  /** Which SQLite driver is live, or null when degraded / disabled. */
  driverKind: string | null;
  /** Realized backend capabilities. */
  caps: { sqlite: boolean; vec: boolean; fts: boolean };
  /** Active embedding provider + model + dimension. */
  embedding: { provider: string; model: string; dimension: number };
  /** Absolute SQLite db path in use (empty string when degraded). */
  dbPath: string;
  /** `autoclaw.kg.port` — only applies to the optional standalone daemon. */
  port: number;
}

export interface CompilationSection {
  outDirPresent: boolean;
  extensionJsPresent: boolean;
  newestSrcMs: number | null;
  newestOutMs: number | null;
  stale: boolean;
  staleFiles: string[];
  message: string;
}

export interface AdapterSchemaIssue {
  adapter: string;
  missingSkills: string[];
}

export interface AdapterSchemaSection {
  adapters: { name: string; skillsFound: string[] }[];
  issues: AdapterSchemaIssue[];
  ok: boolean;
}

export interface GitHealthSection {
  isGitRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  uncommittedFiles: number;
  untrackedFiles: number;
  lastCommitAgoHours: number | null;
  remoteName: string | null;
  notes: string[];
}

/**
 * Health of the intelligence vector backend (the SQLite + sqlite-vec store that
 * powers RAG). Surfaces which driver is live and whether it is the ABI-fragile
 * native one, so an IDE/Electron update that breaks the fallback is visible and
 * actionable instead of a silent degrade to no-RAG.
 */
export interface VectorBackendSection {
  /** `node-sqlite` (ABI-proof) | `better-sqlite3` (fallback) | `none`. */
  active: VectorBackendPreflight['active'];
  healthy: boolean;
  abiProof: boolean;
  runtime: VectorBackendPreflight['runtime'];
  drivers: VectorBackendPreflight['drivers'];
  remediation: string | null;
}

export interface DoctorReport {
  generatedAt: string;
  extensionPath: string;
  workspace: WorkspaceSection;
  kdreamState: KdreamStateSection;
  memory: MemorySection;
  logs: LogsSection;
  adapterDrift: AdapterDriftSection;
  adapterInstallation: AdapterInstallationSection;
  adapterSchema: AdapterSchemaSection;
  compilation: CompilationSection;
  gitHealth: GitHealthSection;
  zmlr: AdapterHealth;
  skillsSource: SkillsSourceSection;
  autobuild: AutobuildSection;
  kgDaemon: KgDaemonSection;
  vectorBackend: VectorBackendSection;
}

/**
 * Probe the intelligence vector backend's drivers and summarise their health.
 * Read-only; never throws (a probe failure becomes an unhealthy section).
 */
export function buildVectorBackendSection(): VectorBackendSection {
  try {
    const pf = vectorBackendPreflight();
    return {
      active: pf.active,
      healthy: pf.healthy,
      abiProof: pf.abiProof,
      runtime: pf.runtime,
      drivers: pf.drivers,
      remediation: pf.remediation
    };
  } catch (e) {
    return {
      active: 'none',
      healthy: false,
      abiProof: false,
      runtime: {
        node: process.version,
        modules: process.versions.modules,
        electron: process.versions.electron ?? null
      },
      drivers: [],
      remediation: `vector preflight failed: ${(e as Error).message}`
    };
  }
}

const SKILL_NAMES = ['kdream', 'autobuild', 'mateam'] as const;

interface HostSpec {
  host: string;
  extensionId: string | null; // null = not a vscode extension (e.g. Antigravity host)
  destinationFor: (ctx: {
    workspaceRoot: string | null;
    home: string;
    isAntigravityHost: boolean;
  }) => string | null;
  expectedFiles: string[];
  // Whether this host is "active" given the shim — used to colour notes only.
  isActive?: (ctx: { extInstalled: boolean; isAntigravityHost: boolean }) => boolean;
}

const HOST_SPECS: HostSpec[] = [
  {
    host: 'claude-code',
    extensionId: 'Anthropic.claude-code',
    destinationFor: ({ home }) => path.join(home, '.claude', 'skills').replace(/\\/g, '/'),
    expectedFiles: SKILL_NAMES.map(s => `${s}/SKILL.md`)
  },
  {
    host: 'kilocode',
    extensionId: 'kilocode.kilo-code',
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.kilocodemodes').replace(/\\/g, '/') : null,
    expectedFiles: [] // single merged file, presence checked via destinationExists
  },
  {
    host: 'cline',
    extensionId: 'saoudrizwan.claude-dev',
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.clinerules').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.md`)
  },
  {
    host: 'cursor',
    extensionId: null,
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.cursor', 'rules').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.mdc`)
  },
  {
    host: 'antigravity',
    extensionId: null,
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.agent', 'rules').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.md`)
  },
  {
    host: 'windsurf',
    extensionId: 'codeium.windsurf',
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.windsurf', 'rules').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.md`)
  },
  {
    host: 'kiro',
    extensionId: 'amazon.kiro',
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.kiro', 'steering').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.md`)
  },
  {
    host: 'continue',
    extensionId: 'Continue.continue',
    destinationFor: ({ workspaceRoot }) =>
      workspaceRoot ? path.join(workspaceRoot, '.continue', 'prompts').replace(/\\/g, '/') : null,
    expectedFiles: SKILL_NAMES.map(s => `${s}.prompt`)
  }
];

function safeReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function buildWorkspaceSection(workspaceRoot: string | null): WorkspaceSection {
  if (!workspaceRoot) {
    return {
      workspaceRoot: null,
      autoclawDirExists: false,
      autoclawInGitignore: null,
      gitignorePresent: false
    };
  }
  const autoclawDir = path.join(workspaceRoot, '.autoclaw');
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const gitignoreContent = safeReadFile(gitignorePath);
  return {
    workspaceRoot,
    autoclawDirExists: fs.existsSync(autoclawDir),
    autoclawInGitignore:
      gitignoreContent === null ? null : isAutoclawInGitignore(gitignoreContent),
    gitignorePresent: gitignoreContent !== null
  };
}

export function buildKdreamStateSection(workspaceRoot: string | null): KdreamStateSection {
  if (!workspaceRoot) {
    return { initialised: false };
  }
  const statePath = getStatePath(workspaceRoot);
  const raw = safeReadFile(statePath);
  if (raw === null) {
    return { initialised: false };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      initialised: true,
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      tick: typeof parsed.tick === 'number' ? parsed.tick : undefined,
      lastDream: typeof parsed.lastDream === 'string' ? parsed.lastDream : undefined,
      started: typeof parsed.started === 'string' ? parsed.started : undefined,
      raw: parsed
    };
  } catch (e) {
    return {
      initialised: true,
      error: `state.json present but unparseable: ${(e as Error).message}`
    };
  }
}

export function buildMemorySection(workspaceRoot: string | null): MemorySection {
  if (!workspaceRoot) {
    return {
      present: false,
      lineCount: 0,
      openFollowups: 0,
      doneFollowups: 0,
      hasFollowupsSection: false,
      hasFactsSection: false,
      hasObservationsSection: false
    };
  }
  const memoryPath = getMemoryPath(workspaceRoot);
  const content = safeReadFile(memoryPath);
  if (content === null) {
    return {
      present: false,
      lineCount: 0,
      openFollowups: 0,
      doneFollowups: 0,
      hasFollowupsSection: false,
      hasFactsSection: false,
      hasObservationsSection: false
    };
  }
  const lines = content.split(/\r?\n/);
  // Use multiline-aware regexes that anchor to the start of a line.
  const openMatches = content.match(/^\s*-\s*\[\s\]/gm) ?? [];
  const doneMatches = content.match(/^\s*-\s*\[[xX]\]/gm) ?? [];
  return {
    present: true,
    lineCount: lines.length,
    openFollowups: openMatches.length,
    doneFollowups: doneMatches.length,
    hasFollowupsSection: /^##\s+Follow-?ups\s*$/im.test(content),
    hasFactsSection: /^##\s+Facts\s*$/im.test(content),
    hasObservationsSection: /^##\s+Observations\s*$/im.test(content)
  };
}

export function buildLogsSection(workspaceRoot: string | null): LogsSection {
  if (!workspaceRoot) {
    return {
      todayLogPresent: false,
      todayLogSizeBytes: 0,
      todayLogLastEntryTimestamp: null,
      totalLogFiles: 0
    };
  }
  const logsDir = path.join(getKdreamDirPath(workspaceRoot), 'logs');
  let totalLogFiles = 0;
  try {
    if (fs.existsSync(logsDir)) {
      totalLogFiles = fs
        .readdirSync(logsDir)
        .filter(f => f.endsWith('.md'))
        .length;
    }
  } catch {
    /* ignore */
  }

  const todayLog = getTodayLogPath(workspaceRoot);
  const stats = safeStat(todayLog);
  if (!stats) {
    return {
      todayLogPresent: false,
      todayLogSizeBytes: 0,
      todayLogLastEntryTimestamp: null,
      totalLogFiles
    };
  }
  const content = safeReadFile(todayLog) ?? '';
  // Heuristic: lines starting with `- ` plus an ISO-ish timestamp at the head,
  // OR `## YYYY-MM-DD HH:MM` markdown subheadings.
  const tsMatches = content.match(
    /\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/g
  );
  return {
    todayLogPresent: true,
    todayLogSizeBytes: stats.size,
    todayLogLastEntryTimestamp: tsMatches && tsMatches.length > 0 ? tsMatches[tsMatches.length - 1] : null,
    totalLogFiles
  };
}

export function buildAdapterDriftSection(extensionPath: string): AdapterDriftSection {
  const checkScript = path.join(extensionPath, 'out', 'scripts', 'check-adapters.js');
  if (!fs.existsSync(checkScript)) {
    return {
      status: 'skipped',
      exitCode: null,
      driftedFiles: 0,
      message: 'adapter drift check skipped — run `npm run adapters:compile` first',
      output: ''
    };
  }
  try {
    const result = spawnSync(process.execPath, [checkScript], {
      cwd: extensionPath,
      encoding: 'utf8',
      timeout: 30000
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = [stdout, stderr].filter(s => s.length > 0).join('\n');
    if (result.status === 0) {
      return {
        status: 'ok',
        exitCode: 0,
        driftedFiles: 0,
        message: 'Adapters in sync with skills/.',
        output: combined.trim()
      };
    }
    const driftMatch = stderr.match(/Adapter drift detected in (\d+) file/);
    return {
      status: 'drift',
      exitCode: result.status ?? -1,
      driftedFiles: driftMatch ? parseInt(driftMatch[1], 10) : 0,
      message: 'Adapter drift detected — run `npm run adapters:build`',
      output: combined.trim()
    };
  } catch (e) {
    return {
      status: 'error',
      exitCode: null,
      driftedFiles: 0,
      message: `failed to invoke check-adapters: ${(e as Error).message}`,
      output: ''
    };
  }
}

export function buildAdapterInstallationSection(
  shim: DoctorVscodeShim
): AdapterInstallationSection {
  const home = os.homedir();
  const isAntigravityHost = !!shim.isAntigravityHost;
  const isInstalled = shim.isExtensionInstalled ?? (() => false);
  // Host IDE forks (Cursor/Kiro/Windsurf/Antigravity) carry no extension to
  // resolve in their own extension host — recognise them via the running app
  // name instead. `spec.host` ids match `detectIde()`'s lowercase output.
  const hostId = detectIde(shim.hostAppName ?? '');

  const hosts: AdapterHostStatus[] = HOST_SPECS.map(spec => {
    const dest = spec.destinationFor({
      workspaceRoot: shim.workspaceRoot ?? null,
      home,
      isAntigravityHost
    });
    const extInstalled = spec.extensionId ? isInstalled(spec.extensionId) : false;
    const isCurrentHostFork =
      spec.host === hostId ||
      (spec.host === 'antigravity' && isAntigravityHost);
    // A running host fork is "present" even though it exposes no extension.
    const present = extInstalled || isCurrentHostFork;
    const hostNote = isCurrentHostFork
      ? 'host detected via vscode.env.appName'
      : undefined;
    if (!dest) {
      return {
        host: spec.host,
        extensionId: spec.extensionId,
        extensionInstalled: present,
        destination: '(no workspace open)',
        destinationExists: false,
        expectedFiles: spec.expectedFiles.map(f => ({ file: f, present: false })),
        notes: hostNote ?? 'workspace not open'
      };
    }
    const destinationExists = fs.existsSync(dest);
    const expectedFiles = spec.expectedFiles.map(f => ({
      file: f,
      present: fs.existsSync(path.join(dest, f))
    }));
    return {
      host: spec.host,
      extensionId: spec.extensionId,
      extensionInstalled: present,
      destination: dest,
      destinationExists,
      expectedFiles,
      notes: hostNote
    };
  });

  return { hosts };
}

export function buildAutobuildSection(workspaceRoot: string | null): AutobuildSection {
  if (!workspaceRoot) {
    return {
      workflowsDir: '(no workspace)',
      workflowCount: 0,
      registryPresent: false,
      workflows: []
    };
  }
  const workflowsDir = getWorkflowsDir(workspaceRoot).replace(/\\/g, '/');
  const registryPath = getRegistryPath(workspaceRoot);
  const registryPresent = fs.existsSync(registryPath);
  const registry = readRegistry(workspaceRoot);
  const registryByName = new Map<string, typeof registry.workflows[number]>();
  for (const r of registry.workflows) {
    registryByName.set(r.name, r);
  }

  const discovered = discoverWorkflows(workspaceRoot);
  const seen = new Set<string>();
  const workflows: AutobuildWorkflowStatus[] = [];
  for (const d of discovered) {
    seen.add(d.workflow.name);
    let cronValid = true;
    let cronError: string | undefined;
    try {
      parseCron(d.workflow.cron);
    } catch (e) {
      cronValid = false;
      cronError = (e as Error).message;
    }
    const reg = registryByName.get(d.workflow.name);
    workflows.push({
      name: d.workflow.name,
      cron: d.workflow.cron,
      workflowPresent: true,
      cronValid,
      cronError,
      lastRun: reg?.lastRun ?? null,
      status: reg?.status ?? 'scheduled',
      lastLog: reg?.lastLog
    });
  }
  // Surface registry-only entries (workflow file removed but registry not pruned).
  for (const r of registry.workflows) {
    if (seen.has(r.name)) { continue; }
    workflows.push({
      name: r.name,
      cron: r.cron,
      workflowPresent: false,
      cronValid: false,
      cronError: 'workflow YAML missing',
      lastRun: r.lastRun,
      status: r.status,
      lastLog: r.lastLog
    });
  }

  return {
    workflowsDir,
    workflowCount: discovered.length,
    registryPresent,
    workflows
  };
}

/**
 * Walks `dir` recursively and returns the newest mtime (ms) among files
 * matching the predicate, plus the path of the newest file. Returns
 * `{ newest: null }` if no matching files exist.
 */
function newestMtime(
  dir: string,
  predicate: (filename: string) => boolean
): { newestMs: number | null; newestPath: string | null } {
  let newestMs: number | null = null;
  let newestPath: string | null = null;
  if (!fs.existsSync(dir)) { return { newestMs, newestPath }; }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') { continue; }
        stack.push(full);
        continue;
      }
      if (!predicate(ent.name)) { continue; }
      const stats = safeStat(full);
      if (!stats) { continue; }
      if (newestMs === null || stats.mtimeMs > newestMs) {
        newestMs = stats.mtimeMs;
        newestPath = full;
      }
    }
  }
  return { newestMs, newestPath };
}

export function buildCompilationSection(extensionPath: string): CompilationSection {
  const srcDir = path.join(extensionPath, 'src');
  const outDir = path.join(extensionPath, 'out');
  const extensionJs = path.join(outDir, 'extension.js');
  const outDirPresent = fs.existsSync(outDir);
  const extensionJsPresent = fs.existsSync(extensionJs);

  if (!outDirPresent) {
    return {
      outDirPresent: false,
      extensionJsPresent: false,
      newestSrcMs: null,
      newestOutMs: null,
      stale: true,
      staleFiles: [],
      message: 'out/ directory missing — run `npm run compile`'
    };
  }
  if (!extensionJsPresent) {
    return {
      outDirPresent: true,
      extensionJsPresent: false,
      newestSrcMs: null,
      newestOutMs: null,
      stale: true,
      staleFiles: [],
      message: 'out/extension.js missing — run `npm run compile`'
    };
  }

  const src = newestMtime(srcDir, f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const out = newestMtime(outDir, f => f.endsWith('.js'));
  const newestSrcMs = src.newestMs;
  const newestOutMs = out.newestMs;

  // 2 second slop for filesystems with low mtime resolution.
  const slopMs = 2000;
  if (newestSrcMs === null || newestOutMs === null) {
    return {
      outDirPresent,
      extensionJsPresent,
      newestSrcMs,
      newestOutMs,
      stale: false,
      staleFiles: [],
      message: 'no source files to compare'
    };
  }
  const stale = newestSrcMs > newestOutMs + slopMs;
  const staleFiles: string[] = [];
  if (stale && src.newestPath) {
    staleFiles.push(path.relative(extensionPath, src.newestPath).replace(/\\/g, '/'));
  }
  return {
    outDirPresent,
    extensionJsPresent,
    newestSrcMs,
    newestOutMs,
    stale,
    staleFiles,
    message: stale
      ? 'src/ has files newer than out/ — run `npm run compile`'
      : 'compilation up to date'
  };
}

/**
 * Validates that every `adapters/<host>/` directory contains at least one
 * file referencing each declared skill (kdream/autobuild/mateam). Catches
 * the common bug where a new skill is added but the per-host adapter file
 * is forgotten. Tolerates whatever filename convention each host uses.
 */
export function buildAdapterSchemaSection(extensionPath: string): AdapterSchemaSection {
  const adaptersDir = path.join(extensionPath, 'adapters');
  const result: AdapterSchemaSection = { adapters: [], issues: [], ok: true };
  if (!fs.existsSync(adaptersDir)) {
    result.ok = false;
    result.issues.push({ adapter: '(none)', missingSkills: [...SKILL_NAMES] });
    return result;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(adaptersDir, { withFileTypes: true });
  } catch {
    result.ok = false;
    return result;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) { continue; }
    const adapterDir = path.join(adaptersDir, ent.name);
    let names: string[] = [];
    try {
      names = fs.readdirSync(adapterDir);
    } catch {
      continue;
    }
    // ZippyMesh and KiloCode use their own conventions (playbooks / single
    // YAML), not per-skill files. Skip schema enforcement for them.
    if (ent.name === 'zippymesh' || ent.name === 'kilocode') {
      result.adapters.push({ name: ent.name, skillsFound: ['(custom layout)'] });
      continue;
    }
    const flat = names.join('\n');
    const subdirSkills: string[] = [];
    for (const skill of SKILL_NAMES) {
      // Matches either `kdream.md` / `kdream.mdc` / `kdream.prompt`, or a
      // `kdream/SKILL.md` subdirectory layout (claude-code).
      const subdirPath = path.join(adapterDir, skill, 'SKILL.md');
      if (fs.existsSync(subdirPath) || new RegExp(`(^|\\n)${skill}\\.[a-z]+`, 'i').test(flat)) {
        subdirSkills.push(skill);
      }
    }
    result.adapters.push({ name: ent.name, skillsFound: subdirSkills });
    const missing = SKILL_NAMES.filter(s => !subdirSkills.includes(s));
    if (missing.length > 0) {
      result.ok = false;
      result.issues.push({ adapter: ent.name, missingSkills: missing });
    }
  }
  return result;
}

/**
 * Run a git subcommand synchronously and return trimmed stdout, or null on
 * error. Doctor is invoked on demand so a synchronous spawn is acceptable;
 * the timeout cap keeps a hung git from freezing the OutputChannel.
 */
function gitOut(cwd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
    if (r.status !== 0) { return null; }
    return (r.stdout ?? '').trim();
  } catch {
    return null;
  }
}

export function buildGitHealthSection(workspaceRoot: string | null): GitHealthSection {
  const empty: GitHealthSection = {
    isGitRepo: false,
    branch: null,
    ahead: 0,
    behind: 0,
    uncommittedFiles: 0,
    untrackedFiles: 0,
    lastCommitAgoHours: null,
    remoteName: null,
    notes: []
  };
  if (!workspaceRoot) { return empty; }
  if (!fs.existsSync(path.join(workspaceRoot, '.git'))) { return empty; }

  const out: GitHealthSection = { ...empty, isGitRepo: true };

  out.branch = gitOut(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = gitOut(workspaceRoot, ['status', '--porcelain']);
  if (status !== null) {
    const lines = status.split('\n').filter(l => l.length > 0);
    out.uncommittedFiles = lines.filter(l => !l.startsWith('??')).length;
    out.untrackedFiles = lines.filter(l => l.startsWith('??')).length;
  }

  const lastCommitTs = gitOut(workspaceRoot, ['log', '-1', '--format=%ct']);
  if (lastCommitTs) {
    const seconds = parseInt(lastCommitTs, 10);
    if (Number.isFinite(seconds)) {
      out.lastCommitAgoHours = Math.round((Date.now() / 1000 - seconds) / 3600);
    }
  }

  // Determine the upstream remote, then ahead/behind. Missing upstream is
  // common (new branch never pushed) — surface it as a note, not an error.
  const upstream = gitOut(workspaceRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  if (upstream) {
    out.remoteName = upstream;
    const counts = gitOut(workspaceRoot, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    if (counts) {
      const parts = counts.split(/\s+/);
      out.behind = parseInt(parts[0], 10) || 0;
      out.ahead = parseInt(parts[1], 10) || 0;
    }
  } else {
    out.notes.push('no upstream tracking branch (push with --set-upstream to enable ahead/behind)');
  }

  return out;
}

export function buildSkillsSourceSection(extensionPath: string): SkillsSourceSection {
  const skillsRoot = path.join(extensionPath, 'skills').replace(/\\/g, '/');
  const skills = SKILL_NAMES.map(name => {
    const skillMdPath = path.join(skillsRoot, name, 'SKILL.md').replace(/\\/g, '/');
    return {
      name,
      skillMdPath,
      present: fs.existsSync(skillMdPath)
    };
  });
  return {
    skillsRoot,
    skills,
    allPresent: skills.every(s => s.present)
  };
}

/**
 * Build the Knowledge Graph doctor section. The KG is an IN-PROCESS store on
 * the Intelligence Layer's ABI-proof node:sqlite driver — there is no daemon,
 * no `packages/kg-daemon` deps, and no `dist/server.js` entry to check. We open
 * the lazily-cached handle (never throws) and report the realized backend:
 * driver kind, capabilities, embedding provider, and db path.
 */
export function buildKgDaemonSection(
  extensionPath: string,
  shimKg: DoctorVscodeShim['kg'],
  workspaceRoot?: string | null
): KgDaemonSection {
  const enabled = shimKg?.enabled !== false; // default-on (in-process store)
  const port = typeof shimKg?.port === 'number' ? shimKg.port : 9877;
  const dbPath = typeof shimKg?.dbPath === 'string' ? shimKg.dbPath : '';

  // The configured (on-disk) db path — reported but NOT created here.
  const configuredDbPath = dbPath && dbPath.trim()
    ? dbPath
    : (workspaceRoot ? intelligencePaths(workspaceRoot).kgDbPath : '');

  // Probe capabilities against an IN-MEMORY db (`:memory:`) — the doctor is a
  // read-only diagnostic and must never create the `.autoclaw/kg/` directory or
  // the db file as a side effect (see snapshot read-only invariant). caps,
  // driverKind and the embedding signature are runtime properties, identical
  // for a :memory: probe and the real file, so this reports accurately without
  // touching disk. openKnowledgeGraph never throws.
  const h = openKnowledgeGraph({
    workspaceRoot: workspaceRoot ?? undefined,
    dbPath: ':memory:',
  });
  try {
    return {
      enabled,
      degraded: h.degraded,
      driverKind: h.driverKind,
      caps: { sqlite: h.caps.sqlite, vec: h.caps.vec, fts: h.caps.fts },
      embedding: {
        provider: h.embedding.provider,
        model: h.embedding.model,
        dimension: h.embedding.dimension,
      },
      dbPath: configuredDbPath,
      port,
    };
  } finally {
    h.close();
  }
}

/**
 * Run all doctor checks and return a structured report.
 *
 * `shim` lets the extension inject its `vscode` view of the world (workspace,
 * installed extensions, host name, ZMLR config) without this module importing
 * the `vscode` namespace. Tests can pass a synthetic shim.
 */
export async function runDoctor(
  extensionPath: string,
  shim: DoctorVscodeShim = {}
): Promise<DoctorReport> {
  const workspaceRoot = shim.workspaceRoot ?? null;
  const zippymeshUrl = shim.zippymeshUrl ?? 'http://localhost:20128';

  const workspace = buildWorkspaceSection(workspaceRoot);
  const kdreamState = buildKdreamStateSection(workspaceRoot);
  const memory = buildMemorySection(workspaceRoot);
  const logs = buildLogsSection(workspaceRoot);
  const adapterDrift = buildAdapterDriftSection(extensionPath);
  const adapterInstallation = buildAdapterInstallationSection(shim);
  const adapterSchema = buildAdapterSchemaSection(extensionPath);
  const compilation = buildCompilationSection(extensionPath);
  const gitHealth = buildGitHealthSection(workspaceRoot);
  const skillsSource = buildSkillsSourceSection(extensionPath);
  const autobuild = buildAutobuildSection(workspaceRoot);
  const kgDaemon = buildKgDaemonSection(extensionPath, shim.kg, workspaceRoot);
  const vectorBackend = buildVectorBackendSection();
  const zmlr = await checkZippyMeshHealth(zippymeshUrl);

  return {
    generatedAt: new Date().toISOString(),
    extensionPath,
    workspace,
    kdreamState,
    memory,
    logs,
    adapterDrift,
    adapterInstallation,
    adapterSchema,
    compilation,
    gitHealth,
    zmlr,
    skillsSource,
    autobuild,
    kgDaemon,
    vectorBackend
  };
}

/**
 * Render a `DoctorReport` as canonical JSON. Useful for tooling that wants
 * to filter/grep the report or feed it to another agent.
 */
export function renderReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Render a `DoctorReport` to a single multi-line string suitable for an
 * OutputChannel. Plain text for most sections; a markdown-style table for
 * adapter installation.
 */
export function renderReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('AutoClaw Doctor — Health Report');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Extension: ${report.extensionPath.replace(/\\/g, '/')}`);
  lines.push(`Today: ${getTodayDate()}`);
  lines.push('');

  // Workspace
  lines.push('## Workspace');
  if (!report.workspace.workspaceRoot) {
    lines.push('  workspace: (none open)');
  } else {
    lines.push(`  workspace: ${report.workspace.workspaceRoot.replace(/\\/g, '/')}`);
    lines.push(`  .autoclaw/ exists: ${report.workspace.autoclawDirExists ? 'yes' : 'no'}`);
    lines.push(
      `  .gitignore: ${
        report.workspace.gitignorePresent
          ? report.workspace.autoclawInGitignore
            ? '.autoclaw/ ignored'
            : '.autoclaw/ NOT ignored'
          : '(no .gitignore)'
      }`
    );
  }
  lines.push('');

  // KDream state
  lines.push('## KDream State');
  if (!report.kdreamState.initialised) {
    lines.push('  not initialised (no state.json)');
  } else if (report.kdreamState.error) {
    lines.push(`  error: ${report.kdreamState.error}`);
  } else {
    lines.push(`  status:    ${report.kdreamState.status ?? '(unset)'}`);
    lines.push(`  tick:      ${report.kdreamState.tick ?? '(unset)'}`);
    lines.push(`  started:   ${report.kdreamState.started ?? '(unset)'}`);
    lines.push(`  lastDream: ${report.kdreamState.lastDream ?? '(unset)'}`);
  }
  lines.push('');

  // MEMORY.md
  lines.push('## MEMORY.md');
  if (!report.memory.present) {
    lines.push('  not present');
  } else {
    lines.push(`  lines:               ${report.memory.lineCount}`);
    lines.push(`  open follow-ups:     ${report.memory.openFollowups}`);
    lines.push(`  done follow-ups:     ${report.memory.doneFollowups}`);
    lines.push(`  ## Follow-ups:       ${report.memory.hasFollowupsSection ? 'present' : 'missing'}`);
    lines.push(`  ## Facts:            ${report.memory.hasFactsSection ? 'present' : 'missing'}`);
    lines.push(`  ## Observations:     ${report.memory.hasObservationsSection ? 'present' : 'missing'}`);
  }
  lines.push('');

  // Logs
  lines.push('## Logs');
  lines.push(`  total log files:        ${report.logs.totalLogFiles}`);
  if (!report.logs.todayLogPresent) {
    lines.push("  today's log:            not present");
  } else {
    lines.push(`  today's log size:       ${report.logs.todayLogSizeBytes} bytes`);
    lines.push(
      `  today's last timestamp: ${report.logs.todayLogLastEntryTimestamp ?? '(none parsed)'}`
    );
  }
  lines.push('');

  // Compilation freshness
  lines.push('## Compilation');
  lines.push(`  out/ present:        ${report.compilation.outDirPresent ? 'yes' : 'no'}`);
  lines.push(`  out/extension.js:    ${report.compilation.extensionJsPresent ? 'present' : 'MISSING'}`);
  lines.push(`  stale:               ${report.compilation.stale ? 'YES — recompile needed' : 'no'}`);
  if (report.compilation.staleFiles.length > 0) {
    lines.push(`  newer src files:     ${report.compilation.staleFiles.join(', ')}`);
  }
  lines.push(`  message: ${report.compilation.message}`);
  lines.push('');

  // Adapter schema
  lines.push('## Adapter Schema');
  lines.push(`  status: ${report.adapterSchema.ok ? 'ok' : 'ISSUES'}`);
  for (const a of report.adapterSchema.adapters) {
    lines.push(`  - ${a.name}: skills=[${a.skillsFound.join(', ')}]`);
  }
  for (const issue of report.adapterSchema.issues) {
    lines.push(`  ! ${issue.adapter} missing: ${issue.missingSkills.join(', ')}`);
  }
  lines.push('');

  // Adapter drift
  lines.push('## Adapter Drift');
  lines.push(`  status:  ${report.adapterDrift.status}`);
  lines.push(`  message: ${report.adapterDrift.message}`);
  if (report.adapterDrift.exitCode !== null) {
    lines.push(`  exit:    ${report.adapterDrift.exitCode}`);
  }
  if (report.adapterDrift.driftedFiles > 0) {
    lines.push(`  drifted files: ${report.adapterDrift.driftedFiles}`);
  }
  lines.push('');

  // Adapter installation table
  lines.push('## Adapter Installation');
  lines.push('');
  lines.push('| Host | Extension Installed | Destination Exists | Expected Files | Destination |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const h of report.adapterInstallation.hosts) {
    const filesSummary =
      h.expectedFiles.length === 0
        ? h.destinationExists
          ? '(file)'
          : '(missing)'
        : `${h.expectedFiles.filter(f => f.present).length}/${h.expectedFiles.length}`;
    lines.push(
      `| ${h.host} | ${h.extensionInstalled ? 'yes' : 'no'} | ${
        h.destinationExists ? 'yes' : 'no'
      } | ${filesSummary} | ${h.destination} |`
    );
  }
  lines.push('');

  // Git health
  lines.push('## Git Health');
  if (!report.gitHealth.isGitRepo) {
    lines.push('  not a git repository');
  } else {
    lines.push(`  branch:               ${report.gitHealth.branch ?? '(detached)'}`);
    lines.push(`  upstream:             ${report.gitHealth.remoteName ?? '(none)'}`);
    lines.push(`  ahead/behind:         ${report.gitHealth.ahead}/${report.gitHealth.behind}`);
    lines.push(`  uncommitted files:    ${report.gitHealth.uncommittedFiles}`);
    lines.push(`  untracked files:      ${report.gitHealth.untrackedFiles}`);
    if (report.gitHealth.lastCommitAgoHours !== null) {
      lines.push(`  last commit:          ${report.gitHealth.lastCommitAgoHours}h ago`);
    }
    for (const note of report.gitHealth.notes) {
      lines.push(`  note: ${note}`);
    }
  }
  lines.push('');

  // ZMLR
  lines.push('## ZippyMesh LLM Router');
  lines.push(`  status:  ${report.zmlr.status}`);
  lines.push(`  details: ${report.zmlr.details}`);
  lines.push('');

  // Skills source
  lines.push('## Skills Source (VSIX sanity)');
  for (const s of report.skillsSource.skills) {
    lines.push(`  ${s.name}/SKILL.md: ${s.present ? 'present' : 'MISSING'}`);
  }
  lines.push('');

  // Knowledge Graph (in-process store — no daemon, no native deps)
  const kg = report.kgDaemon;
  lines.push('## KG Daemon');
  lines.push('  (in-process store on the Intelligence Layer SQLite driver — no child process)');
  lines.push(`  enabled:        ${kg.enabled ? 'yes' : 'no (autoclaw.kg.enabled = false)'}`);
  if (kg.degraded) {
    lines.push('  state:          DEGRADED — no SQLite driver loaded (writes no-op, reads return [])');
  } else {
    lines.push('  state:          ready');
  }
  lines.push(`  driver:         ${kg.driverKind ?? '(none)'}`);
  lines.push(`  capabilities:   sqlite=${kg.caps.sqlite} vec=${kg.caps.vec} fts=${kg.caps.fts}`);
  lines.push(`  embedding:      ${kg.embedding.provider} / ${kg.embedding.model} (dim ${kg.embedding.dimension})`);
  lines.push(`  db path:        ${kg.dbPath ? kg.dbPath.replace(/\\/g, '/') : '(none — degraded)'}`);
  lines.push(`  daemon port:    ${kg.port} (only used by the optional standalone daemon)`);
  lines.push('');

  // AutoBuild
  lines.push('## AutoBuild');
  lines.push(`  workflows dir:    ${report.autobuild.workflowsDir}`);
  lines.push(`  workflow files:   ${report.autobuild.workflowCount}`);
  lines.push(`  registry.json:    ${report.autobuild.registryPresent ? 'present' : 'absent'}`);
  if (report.autobuild.workflows.length === 0) {
    lines.push('  (no workflows scheduled)');
  } else {
    for (const w of report.autobuild.workflows) {
      const cronStatus = w.cronValid ? w.cron : `${w.cron}  [INVALID: ${w.cronError}]`;
      const fileStatus = w.workflowPresent ? '' : '  [WORKFLOW MISSING]';
      lines.push(
        `  - ${w.name}: cron="${cronStatus}" status=${w.status} lastRun=${w.lastRun ?? '(never)'}${fileStatus}`
      );
    }
  }
  lines.push('');

  // Vector backend (intelligence RAG store)
  lines.push('## Vector Backend (Intelligence RAG)');
  const vb = report.vectorBackend;
  const health = !vb.healthy ? 'UNAVAILABLE (no-RAG)' : vb.abiProof ? 'ok (ABI-proof)' : 'ok (native fallback — fragile)';
  lines.push(`  status:         ${health}`);
  lines.push(`  active driver:  ${vb.active}`);
  lines.push(`  runtime:        node ${vb.runtime.node} / ABI ${vb.runtime.modules}${vb.runtime.electron ? ` / electron ${vb.runtime.electron}` : ''}`);
  for (const d of vb.drivers) {
    lines.push(`  - ${d.kind}: ${d.available ? 'available' : `unavailable${d.error ? ` (${d.error})` : ''}`}`);
  }
  if (vb.remediation) {
    lines.push(`  remediation:    ${vb.remediation}`);
  }
  lines.push('');

  return lines.join('\n');
}
