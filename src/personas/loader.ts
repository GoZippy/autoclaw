/**
 * Persona loader — implementation of `docs/specs/persona-loader/spec.md`.
 *
 * Reads `skills/<id>/SKILL.md` frontmatter, builds a {@link PersonaProfile},
 * and dispatches a prompt against the persona's preferred provider with
 * a fallback chain. Until Phase B lands the real `src/llm/`, dispatch
 * routes through `provider-stub.ts`.
 *
 * No new dependencies. Frontmatter parsing is the shallow one in
 * `frontmatter.ts`. VS Code wiring is `command.ts`; this file is the
 * vscode-free core.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ErrorClass } from '../runners/types';
import { parseFrontmatter } from './frontmatter';
import { resolveProvider } from './provider-stub';
import {
  DEFAULT_PROVIDER_CHAIN,
  type PersonaId,
  type PersonaProfile,
  type ProviderRef,
} from './types';

export interface LoaderOptions {
  /** Absolute path of the workspace root. */
  workspaceRoot: string;
  /** Where skill packages live; defaults to `<workspaceRoot>/skills`. */
  skillsRoot?: string;
}

export interface DispatchOptions {
  prompt: string;
  /** Override the persona's preferred provider for this call. */
  providerOverride?: ProviderRef;
  /** Whether to fall back through providerFallback on failure (default true). */
  allowFallback?: boolean;
  /** Carried into the cost ledger and any finding_report. */
  sessionId: string;
}

export interface DispatchResult {
  ok: boolean;
  response?: string;
  /** Which provider actually answered (or was last tried on failure). */
  provider: ProviderRef;
  fallbackTaken: boolean;
  tokens?: { input: number; output: number };
  durationMs: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
}

export class PersonaLoader {
  private readonly skillsRoot: string;
  private readonly cache = new Map<PersonaId, PersonaProfile>();

  constructor(private readonly opts: LoaderOptions) {
    this.skillsRoot = opts.skillsRoot ?? path.join(opts.workspaceRoot, 'skills');
  }

  /** List persona ids whose SKILL.md is present and has parseable frontmatter. */
  async list(): Promise<PersonaId[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.skillsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: PersonaId[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      const skillPath = path.join(this.skillsRoot, e.name, 'SKILL.md');
      try {
        const content = await fs.promises.readFile(skillPath, 'utf8');
        if (parseFrontmatter(content)) {
          result.push(e.name);
        }
      } catch {
        // Missing or unreadable SKILL.md → not a persona; skip silently.
      }
    }
    return result.sort();
  }

  /** Load + cache a persona profile from its SKILL.md frontmatter. */
  async load(id: PersonaId): Promise<PersonaProfile> {
    const cached = this.cache.get(id);
    if (cached) {
      return cached;
    }
    const skillPath = path.join(this.skillsRoot, id, 'SKILL.md');
    const content = await fs.promises.readFile(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) {
      throw new Error(`No frontmatter found in ${skillPath}`);
    }
    const profile = buildProfile(id, fm);
    this.cache.set(id, profile);
    return profile;
  }

  /** Run a persona against a prompt; returns the dispatch result. */
  async dispatch(id: PersonaId, opts: DispatchOptions): Promise<DispatchResult> {
    const start = Date.now();
    let profile: PersonaProfile;
    try {
      profile = await this.load(id);
    } catch {
      const available = await this.list();
      return {
        ok: false,
        provider: 'none',
        fallbackTaken: false,
        durationMs: Date.now() - start,
        errorClass: 'internal',
        errorMessage: `unknown persona '${id}'; available: ${available.join(', ') || '(none)'}`,
      };
    }

    const allowFallback = opts.allowFallback ?? true;
    const preferred = opts.providerOverride ?? profile.preferredProvider;
    const chain: ProviderRef[] = [preferred];
    if (
      allowFallback &&
      profile.providerFallback &&
      profile.providerFallback !== preferred
    ) {
      chain.push(profile.providerFallback);
    }

    let lastError: { errorClass: ErrorClass; errorMessage: string } | undefined;
    for (let i = 0; i < chain.length; i++) {
      const ref = chain[i];
      const provider = resolveProvider(ref, profile, this.opts.workspaceRoot);
      const result = await provider.chat({
        prompt: opts.prompt,
        toolAllowList: profile.toolAllowList,
        toolDenyList: profile.toolDenyList,
      });
      if (result.ok) {
        await this.appendLedger({
          persona: id,
          provider: ref,
          fallback_taken: i > 0,
          session_id: opts.sessionId,
          tokens: result.tokens,
          duration_ms: Date.now() - start,
        });
        return {
          ok: true,
          response: result.response,
          provider: ref,
          fallbackTaken: i > 0,
          tokens: result.tokens,
          durationMs: Date.now() - start,
        };
      }
      lastError = {
        errorClass: result.errorClass ?? 'internal',
        errorMessage: result.errorMessage ?? 'unknown error',
      };
      // tool_denied → write a finding_report and stop (don't fall back).
      if (result.errorClass === 'tool_denied') {
        await this.writeFindingReport(profile, opts, lastError);
        return {
          ok: false,
          provider: ref,
          fallbackTaken: i > 0,
          durationMs: Date.now() - start,
          errorClass: 'tool_denied',
          errorMessage: lastError.errorMessage,
        };
      }
      // Otherwise continue to the next provider in the chain.
    }

    return {
      ok: false,
      provider: chain[chain.length - 1],
      fallbackTaken: chain.length > 1,
      durationMs: Date.now() - start,
      errorClass: lastError?.errorClass ?? 'internal',
      errorMessage: lastError?.errorMessage ?? 'all providers failed',
    };
  }

  private async appendLedger(row: Record<string, unknown>): Promise<void> {
    const logPath = path.join(
      this.opts.workspaceRoot,
      '.autoclaw',
      'orchestrator',
      'comms',
      'comms-log.jsonl',
    );
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({
      type: 'persona_dispatch',
      ...row,
      timestamp: new Date().toISOString(),
    });
    await fs.promises.appendFile(logPath, line + '\n', 'utf8');
  }

  private async writeFindingReport(
    profile: PersonaProfile,
    opts: DispatchOptions,
    err: { errorClass: ErrorClass; errorMessage: string },
  ): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionFrag = opts.sessionId.slice(0, 8);
    const dir = path.join(
      this.opts.workspaceRoot,
      '.autoclaw',
      'orchestrator',
      'comms',
      'inboxes',
      'shared',
    );
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ts}-finding_report-persona-${sessionFrag}.json`);
    const body = {
      id: `msg-persona-${err.errorClass}-${profile.id}-${Date.now()}`,
      from: 'persona-loader',
      session_id: opts.sessionId,
      to: 'shared',
      type: 'finding_report',
      timestamp: new Date().toISOString(),
      requires_response: false,
      payload: {
        severity: err.errorClass === 'tool_denied' ? 'medium' : 'low',
        title: `Persona ${profile.id} dispatch blocked: ${err.errorClass}`,
        detail: err.errorMessage,
        persona: profile.id,
        trust: profile.trust,
      },
    };
    await fs.promises.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
  }
}

/** Build a {@link PersonaProfile} from parsed SKILL.md frontmatter. */
export function buildProfile(id: PersonaId, fm: Record<string, unknown>): PersonaProfile {
  const name = typeof fm.name === 'string' && fm.name.length > 0 ? fm.name : id;
  const description = typeof fm.description === 'string' ? fm.description : '';

  const triggers: string[] = Array.isArray(fm.trigger)
    ? (fm.trigger as string[])
    : typeof fm.trigger === 'string'
    ? fm.trigger.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  const trustRaw = typeof fm.trust === 'string' ? fm.trust : 'auto';
  const trust: PersonaProfile['trust'] =
    trustRaw === 'off' || trustRaw === 'auto' || trustRaw === 'turbo' ? trustRaw : 'auto';

  const home = os.homedir().replace(/\\/g, '/');

  return {
    id: name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    mission: description,
    triggers,
    toolAllowList: Array.isArray(fm.tools) ? (fm.tools as string[]) : undefined,
    toolDenyList: Array.isArray(fm.toolDenyList) ? (fm.toolDenyList as string[]) : undefined,
    trust,
    preferredProvider:
      typeof fm.preferred_provider === 'string'
        ? (fm.preferred_provider as string)
        : DEFAULT_PROVIDER_CHAIN.preferred,
    providerFallback:
      typeof fm.provider_fallback === 'string'
        ? (fm.provider_fallback as string)
        : DEFAULT_PROVIDER_CHAIN.fallback,
    requiredInputs: Array.isArray(fm.required_inputs) ? (fm.required_inputs as string[]) : [],
    outputArtifacts: Array.isArray(fm.output_artifacts) ? (fm.output_artifacts as string[]) : [],
    successCriteria: [],
    exemplars: Array.isArray(fm.exemplars) ? (fm.exemplars as string[]) : [],
    memoryRoot: `.autoclaw/memory/personas/${name}/`,
    globalMemoryRoot: `${home}/.autoclaw/personas/${name}/`,
  };
}
