import * as fs from 'fs';
import * as path from 'path';

import {
  PROMPT_HARNESS_SCHEMA,
  SCAFFOLD_SCHEMA,
  SCAFFOLD_SCORE_SCHEMA,
  parsePromptHarnessContract,
  parseScaffoldScore,
  parseScaffoldVariant,
  type PromptHarnessContract,
  type ScaffoldScore,
  type ScaffoldVariant,
} from './types';

export const SCAFFOLDS_DIR = path.join('.autoclaw', 'workflows', 'scaffolds');
export const SCAFFOLD_VARIANTS_FILE = 'variants.jsonl';
export const PROMPT_HARNESSES_FILE = 'prompt-harnesses.jsonl';
export const SCAFFOLD_SCORES_FILE = 'scores.jsonl';

export interface ReadScaffoldJsonlResult<T> {
  records: T[];
  warnings: string[];
}

export function scaffoldDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, SCAFFOLDS_DIR);
}

export function scaffoldVariantsPath(workspaceRoot: string): string {
  return path.join(scaffoldDir(workspaceRoot), SCAFFOLD_VARIANTS_FILE);
}

export function promptHarnessesPath(workspaceRoot: string): string {
  return path.join(scaffoldDir(workspaceRoot), PROMPT_HARNESSES_FILE);
}

export function scaffoldScoresPath(workspaceRoot: string): string {
  return path.join(scaffoldDir(workspaceRoot), SCAFFOLD_SCORES_FILE);
}

export async function appendScaffoldVariant(workspaceRoot: string, variant: ScaffoldVariant): Promise<void> {
  await appendJsonl(scaffoldVariantsPath(workspaceRoot), parseScaffoldVariant({ ...variant, schema: SCAFFOLD_SCHEMA }));
}

export async function readScaffoldVariants(workspaceRoot: string): Promise<ReadScaffoldJsonlResult<ScaffoldVariant>> {
  return readJsonl(scaffoldVariantsPath(workspaceRoot), parseScaffoldVariant, 'scaffold variant');
}

export async function appendPromptHarnessContract(workspaceRoot: string, contract: PromptHarnessContract): Promise<void> {
  await appendJsonl(promptHarnessesPath(workspaceRoot), parsePromptHarnessContract({ ...contract, schema: PROMPT_HARNESS_SCHEMA }));
}

export async function readPromptHarnessContracts(workspaceRoot: string): Promise<ReadScaffoldJsonlResult<PromptHarnessContract>> {
  return readJsonl(promptHarnessesPath(workspaceRoot), parsePromptHarnessContract, 'prompt harness contract');
}

export async function appendScaffoldScore(workspaceRoot: string, score: ScaffoldScore): Promise<void> {
  const sanitized = scrubSensitive({ ...score, schema: SCAFFOLD_SCORE_SCHEMA });
  await appendJsonl(scaffoldScoresPath(workspaceRoot), parseScaffoldScore(sanitized));
}

export async function readScaffoldScores(workspaceRoot: string): Promise<ReadScaffoldJsonlResult<ScaffoldScore>> {
  return readJsonl(scaffoldScoresPath(workspaceRoot), parseScaffoldScore, 'scaffold score');
}

async function appendJsonl(file: string, record: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

async function readJsonl<T>(
  file: string,
  parse: (input: unknown) => T,
  label: string,
): Promise<ReadScaffoldJsonlResult<T>> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], warnings: [] };
    }
    return { records: [], warnings: [`Failed to read ${label} ledger: ${(err as Error).message}`] };
  }

  const records: T[] = [];
  const warnings: string[] = [];
  raw.replace(/^\uFEFF/, '').split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      records.push(parse(JSON.parse(trimmed)));
    } catch (err) {
      warnings.push(`Skipped invalid ${label} line ${index + 1}: ${(err as Error).message}`);
    }
  });
  return { records, warnings };
}

function scrubSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSensitive);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveLedgerKey(key)) {
      continue;
    }
    out[key] = scrubSensitive(child);
  }
  return out;
}

function isSensitiveLedgerKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return [
    'prompt',
    'prompttext',
    'rawprompt',
    'messages',
    'conversation',
    'response',
    'responsetext',
    'rawresponse',
    'completion',
    'secret',
    'apikey',
    'authorization',
    'token',
  ].includes(normalized);
}
