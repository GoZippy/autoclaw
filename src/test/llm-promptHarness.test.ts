/**
 * llm-promptHarness.test.ts — OSL-4.1 Prompt Harness Registry tests
 */

import * as assert from 'assert';

import {
  OPENAI_TOOLS_HARNESS,
  CLAUDE_TOOLS_HARNESS,
  QWEN_XML_TOOLS_HARNESS,
  DEEPSEEK_R1_HARNESS,
  BUILT_IN_HARNESSES,
  checkHarnessCompatibility,
  PromptHarnessRegistry,
  defaultPromptHarnessRegistry,
  type PromptHarnessContract,
} from '../llm/promptHarness';

suite('PromptHarnessContract — built-ins', () => {
  test('all built-in harnesses have stable ids', () => {
    const ids = BUILT_IN_HARNESSES.map(h => h.id);
    assert.deepStrictEqual(ids, ['openai-tools', 'claude-tools', 'qwen-xml-tools', 'deepseek-r1']);
  });

  test('each built-in has at least one model family', () => {
    for (const h of BUILT_IN_HARNESSES) {
      assert.ok(h.modelFamilies.length > 0, `${h.id} has no modelFamilies`);
    }
  });

  test('OpenAI harness uses JSON tools and system message', () => {
    assert.strictEqual(OPENAI_TOOLS_HARNESS.toolCall, 'openai-json-tools');
    assert.strictEqual(OPENAI_TOOLS_HARNESS.role, 'openai-system-message');
    assert.strictEqual(OPENAI_TOOLS_HARNESS.parallelToolCalls, true);
  });

  test('Claude harness uses Anthropic tools and thinking block', () => {
    assert.strictEqual(CLAUDE_TOOLS_HARNESS.toolCall, 'anthropic-json-tools');
    assert.strictEqual(CLAUDE_TOOLS_HARNESS.reasoning, 'anthropic-thinking-block');
    assert.strictEqual(CLAUDE_TOOLS_HARNESS.parallelToolCalls, true);
  });

  test('Qwen harness uses XML tools and no parallel calls', () => {
    assert.strictEqual(QWEN_XML_TOOLS_HARNESS.toolCall, 'qwen-xml-tools');
    assert.strictEqual(QWEN_XML_TOOLS_HARNESS.parallelToolCalls, false);
  });

  test('DeepSeek R1 harness uses think tag reasoning', () => {
    assert.strictEqual(DEEPSEEK_R1_HARNESS.reasoning, 'deepseek-r1-think-tag');
  });
});

suite('checkHarnessCompatibility', () => {
  test('OpenAI harness is compatible with gpt-4o', () => {
    const issues = checkHarnessCompatibility(OPENAI_TOOLS_HARNESS, 'gpt');
    assert.strictEqual(issues.length, 0);
  });

  test('Qwen harness with GPT family flags XML mismatch', () => {
    const issues = checkHarnessCompatibility(QWEN_XML_TOOLS_HARNESS, 'gpt-4o');
    assert.ok(issues.length > 0);
    const tc = issues.find(i => i.field === 'toolCall');
    assert.ok(tc);
    assert.ok(tc!.reason.includes('require JSON tool calls'));
  });

  test('OpenAI harness with Qwen family flags JSON mismatch', () => {
    const issues = checkHarnessCompatibility(OPENAI_TOOLS_HARNESS, 'qwen2.5');
    assert.ok(issues.length > 0);
    const tc = issues.find(i => i.field === 'toolCall');
    assert.ok(tc);
    assert.ok(tc!.reason.includes('XML tool calls'));
  });

  test('Claude harness is compatible with claude-sonnet', () => {
    const issues = checkHarnessCompatibility(CLAUDE_TOOLS_HARNESS, 'claude');
    assert.strictEqual(issues.length, 0);
  });

  test('Qwen harness is compatible with qwen2.5', () => {
    const issues = checkHarnessCompatibility(QWEN_XML_TOOLS_HARNESS, 'qwen');
    assert.strictEqual(issues.length, 0);
  });
});

suite('PromptHarnessRegistry', () => {
  test('default registry contains all built-ins', () => {
    const ids = defaultPromptHarnessRegistry.listIds();
    assert.ok(ids.includes('openai-tools'));
    assert.ok(ids.includes('claude-tools'));
    assert.ok(ids.includes('qwen-xml-tools'));
    assert.ok(ids.includes('deepseek-r1'));
  });

  test('getById returns the right harness', () => {
    const h = defaultPromptHarnessRegistry.getById('openai-tools');
    assert.ok(h);
    assert.strictEqual(h!.id, 'openai-tools');
  });

  test('getById returns undefined for unknown id', () => {
    assert.strictEqual(defaultPromptHarnessRegistry.getById('no-such-harness'), undefined);
  });

  test('register adds a custom harness', () => {
    const reg = new PromptHarnessRegistry();
    const custom: PromptHarnessContract = {
      id: 'custom-harness',
      name: 'Custom',
      role: 'openai-system-message',
      toolCall: 'none',
      reasoning: 'none',
      toolResponse: 'none',
      modelFamilies: ['custom'],
      parallelToolCalls: false,
    };
    reg.register(custom);
    assert.strictEqual(reg.getById('custom-harness')?.name, 'Custom');
  });

  test('selectForModelFamily picks the right built-in', () => {
    assert.strictEqual(defaultPromptHarnessRegistry.selectForModelFamily('gpt-4o')?.id, 'openai-tools');
    assert.strictEqual(defaultPromptHarnessRegistry.selectForModelFamily('claude-sonnet')?.id, 'claude-tools');
    assert.strictEqual(defaultPromptHarnessRegistry.selectForModelFamily('qwen2.5')?.id, 'qwen-xml-tools');
    assert.strictEqual(defaultPromptHarnessRegistry.selectForModelFamily('deepseek-r1')?.id, 'deepseek-r1');
  });

  test('selectForModelFamily returns undefined for unknown family', () => {
    assert.strictEqual(defaultPromptHarnessRegistry.selectForModelFamily('unknown-model'), undefined);
  });

  test('selectAndValidate returns harness when compatible', () => {
    const result = defaultPromptHarnessRegistry.selectAndValidate('gpt-4o');
    assert.ok(result.harness);
    assert.strictEqual(result.harness!.id, 'openai-tools');
    assert.deepStrictEqual(result.issues, []);
  });

  test('selectAndValidate returns issues when incompatible', () => {
    const result = defaultPromptHarnessRegistry.selectAndValidate('qwen2.5', 'openai-tools');
    assert.strictEqual(result.harness, undefined);
    assert.ok(result.issues.length > 0);
  });

  test('selectAndValidate with unknown harness id returns issue', () => {
    const result = defaultPromptHarnessRegistry.selectAndValidate('gpt-4o', 'no-such-harness');
    assert.strictEqual(result.harness, undefined);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues[0].reason.includes('No harness found'));
  });
});
