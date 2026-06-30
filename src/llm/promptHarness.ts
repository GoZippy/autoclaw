/**
 * promptHarness.ts — Prompt Harness Registry (OSL-4.1)
 *
 * A prompt harness is a model-specific contract that describes how to format
 * the four structural parts of an LLM prompt: role, tool calls, reasoning,
 * and tool responses. Different models expect these in different formats
 * (OpenAI-style JSON tool calls vs Qwen XML tool calls, etc.).
 *
 * The registry lets the workflow engine and the scaffold selector pick the
 * right harness for a model, and reject unsupported combinations early
 * with actionable reasons (instead of silent malformation at inference time).
 *
 * Pure module — no vscode / fs / native imports.
 */

/* -------------------------------------------------------------------------- */
/*  Core types                                                                */
/* -------------------------------------------------------------------------- */

/** How the role/system prompt is formatted. */
export type RoleFormat =
  | 'openai-system-message'
  | 'anthropic-system-block'
  | 'qwen-system-prefix';

/** How tool calls are expressed in the assistant turn. */
export type ToolCallFormat =
  | 'openai-json-tools'
  | 'anthropic-json-tools'
  | 'qwen-xml-tools'
  | 'none';

/** How chain-of-thought / reasoning is surfaced. */
export type ReasoningFormat =
  | 'openai-reasoning-summary'
  | 'anthropic-thinking-block'
  | 'deepseek-r1-think-tag'
  | 'none';

/** How tool responses are fed back to the model. */
export type ToolResponseFormat =
  | 'openai-tool-result'
  | 'anthropic-tool-result'
  | 'qwen-xml-result'
  | 'none';

/** A prompt harness contract — declarative, composable. */
export interface PromptHarnessContract {
  /** Stable harness id (e.g. 'openai-tools', 'qwen-xml'). */
  id: string;
  /** Human-readable name. */
  name: string;
  role: RoleFormat;
  toolCall: ToolCallFormat;
  reasoning: ReasoningFormat;
  toolResponse: ToolResponseFormat;
  /** Model family prefixes this harness is designed for. */
  modelFamilies: string[];
  /** If true, this harness supports parallel tool calls. */
  parallelToolCalls: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Built-in harness contracts                                                */
/* -------------------------------------------------------------------------- */

export const OPENAI_TOOLS_HARNESS: PromptHarnessContract = {
  id: 'openai-tools',
  name: 'OpenAI JSON Tool Calls',
  role: 'openai-system-message',
  toolCall: 'openai-json-tools',
  reasoning: 'none',
  toolResponse: 'openai-tool-result',
  modelFamilies: ['gpt', 'o1', 'o3', 'o4'],
  parallelToolCalls: true,
};

export const CLAUDE_TOOLS_HARNESS: PromptHarnessContract = {
  id: 'claude-tools',
  name: 'Claude JSON Tool Calls',
  role: 'anthropic-system-block',
  toolCall: 'anthropic-json-tools',
  reasoning: 'anthropic-thinking-block',
  toolResponse: 'anthropic-tool-result',
  modelFamilies: ['claude'],
  parallelToolCalls: true,
};

export const QWEN_XML_TOOLS_HARNESS: PromptHarnessContract = {
  id: 'qwen-xml-tools',
  name: 'Qwen XML Tool Calls',
  role: 'qwen-system-prefix',
  toolCall: 'qwen-xml-tools',
  reasoning: 'none',
  toolResponse: 'qwen-xml-result',
  modelFamilies: ['qwen'],
  parallelToolCalls: false,
};

export const DEEPSEEK_R1_HARNESS: PromptHarnessContract = {
  id: 'deepseek-r1',
  name: 'DeepSeek R1 Think Tag',
  role: 'openai-system-message',
  toolCall: 'openai-json-tools',
  reasoning: 'deepseek-r1-think-tag',
  toolResponse: 'openai-tool-result',
  modelFamilies: ['deepseek-r1', 'deepseek'],
  parallelToolCalls: true,
};

/** All built-in harnesses, in priority order. */
export const BUILT_IN_HARNESSES: readonly PromptHarnessContract[] = [
  OPENAI_TOOLS_HARNESS,
  CLAUDE_TOOLS_HARNESS,
  QWEN_XML_TOOLS_HARNESS,
  DEEPSEEK_R1_HARNESS,
];

/* -------------------------------------------------------------------------- */
/*  Incompatibility detection                                                 */
/* -------------------------------------------------------------------------- */

/** Reason a model-harness pair is incompatible. */
export interface Incompatibility {
  /** Which harness field mismatches. */
  field: 'role' | 'toolCall' | 'reasoning' | 'toolResponse';
  /** The harness's format. */
  harnessFormat: string;
  /** What the model expects (if known). */
  expectedFormat: string;
  /** Human-readable explanation. */
  reason: string;
}

/**
 * Check whether a given harness is compatible with a model family.
 * Returns an empty array if compatible, or a list of incompatibilities
 * with actionable reasons.
 */
export function checkHarnessCompatibility(
  harness: PromptHarnessContract,
  modelFamily: string,
): Incompatibility[] {
  const issues: Incompatibility[] = [];

  if (modelFamily.startsWith('gpt') || modelFamily.startsWith('o1') || modelFamily.startsWith('o3') || modelFamily.startsWith('o4')) {
    if (harness.toolCall !== 'openai-json-tools') {
      issues.push({
        field: 'toolCall',
        harnessFormat: harness.toolCall,
        expectedFormat: 'openai-json-tools',
        reason: `GPT/o-series models require JSON tool calls; harness '${harness.id}' uses '${harness.toolCall}'`,
      });
    }
    if (harness.role !== 'openai-system-message') {
      issues.push({
        field: 'role',
        harnessFormat: harness.role,
        expectedFormat: 'openai-system-message',
        reason: `GPT/o-series models use a system message; harness '${harness.id}' uses '${harness.role}'`,
      });
    }
  }

  if (modelFamily.startsWith('claude')) {
    if (harness.toolCall !== 'anthropic-json-tools' && harness.toolCall !== 'openai-json-tools') {
      issues.push({
        field: 'toolCall',
        harnessFormat: harness.toolCall,
        expectedFormat: 'anthropic-json-tools',
        reason: `Claude models require Anthropic or OpenAI-compatible JSON tool calls; harness '${harness.id}' uses '${harness.toolCall}'`,
      });
    }
  }

  if (modelFamily.startsWith('qwen')) {
    if (harness.toolCall === 'openai-json-tools') {
      issues.push({
        field: 'toolCall',
        harnessFormat: harness.toolCall,
        expectedFormat: 'qwen-xml-tools',
        reason: `Qwen models typically use XML tool calls; harness '${harness.id}' uses JSON tool calls which may not be supported. Use 'qwen-xml-tools' harness instead.`,
      });
    }
  }

  if (modelFamily.startsWith('deepseek-r1')) {
    if (harness.reasoning !== 'deepseek-r1-think-tag' && harness.reasoning !== 'none') {
      issues.push({
        field: 'reasoning',
        harnessFormat: harness.reasoning,
        expectedFormat: 'deepseek-r1-think-tag',
        reason: `DeepSeek R1 uses <think> tags for reasoning; harness '${harness.id}' uses '${harness.reasoning}'`,
      });
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Prompt harness registry — lookup by id, model family, or capability.
 * Extensible: custom harnesses can be registered alongside built-ins.
 */
export class PromptHarnessRegistry {
  private _byId = new Map<string, PromptHarnessContract>();

  constructor(builtins: readonly PromptHarnessContract[] = BUILT_IN_HARNESSES) {
    for (const h of builtins) {
      this._byId.set(h.id, h);
    }
  }

  /** Register a custom harness (overwrites if id already exists). */
  register(harness: PromptHarnessContract): void {
    this._byId.set(harness.id, harness);
  }

  /** Look up a harness by its stable id. */
  getById(id: string): PromptHarnessContract | undefined {
    return this._byId.get(id);
  }

  /** List all registered harness ids. */
  listIds(): string[] {
    return Array.from(this._byId.keys());
  }

  /**
   * Select the best harness for a model family.
   * Returns the first built-in whose modelFamilies include a prefix of
   * the given family, or undefined if no match.
   */
  selectForModelFamily(modelFamily: string): PromptHarnessContract | undefined {
    for (const h of this._byId.values()) {
      if (h.modelFamilies.some(f => modelFamily.startsWith(f) || f === modelFamily)) {
        return h;
      }
    }
    return undefined;
  }

  /**
   * Select a harness and validate compatibility.
   * Returns the harness if compatible, or the list of incompatibilities
   * explaining why the match fails.
   */
  selectAndValidate(
    modelFamily: string,
    harnessId?: string,
  ): { harness: PromptHarnessContract; issues: [] } | { harness: undefined; issues: Incompatibility[] } {
    const harness = harnessId
      ? this._byId.get(harnessId)
      : this.selectForModelFamily(modelFamily);

    if (!harness) {
      return {
        harness: undefined,
        issues: [{
          field: 'toolCall',
          harnessFormat: harnessId ?? '(none)',
          expectedFormat: modelFamily,
          reason: `No harness found${harnessId ? ` with id '${harnessId}'` : ` for model family '${modelFamily}'`}`,
        }],
      };
    }

    const issues = checkHarnessCompatibility(harness, modelFamily);
    if (issues.length > 0) {
      return { harness: undefined, issues };
    }
    return { harness, issues: [] };
  }
}

/** Default registry instance with all built-in harnesses. */
export const defaultPromptHarnessRegistry = new PromptHarnessRegistry();
