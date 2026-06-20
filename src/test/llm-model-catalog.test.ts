/**
 * llm-model-catalog.test.ts — model id → context-window lookup.
 */

import * as assert from 'assert';

import {
  contextWindowForModel,
  normalizeModelId,
  isKnownModel,
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOWS,
} from '../llm/modelCatalog';

suite('llm — model context-window catalog', () => {
  test('exact catalog ids resolve', () => {
    assert.strictEqual(contextWindowForModel('claude-opus-4-8'), 1_000_000);
    assert.strictEqual(contextWindowForModel('claude-sonnet-4-6'), 200_000);
    assert.strictEqual(contextWindowForModel('gpt-4o'), 128_000);
    assert.strictEqual(contextWindowForModel('gpt-4'), 8_192);
    assert.strictEqual(contextWindowForModel('gemini-1.5-pro'), 2_000_000);
  });

  test('an explicit size marker overrides the map', () => {
    // The real model id encodes its tier.
    assert.strictEqual(contextWindowForModel('claude-opus-4-8[1m]'), 1_000_000);
    // Marker wins even when the base entry is smaller.
    assert.strictEqual(contextWindowForModel('claude-sonnet-4-6[1m]'), 1_000_000);
    assert.strictEqual(contextWindowForModel('some-model[200k]'), 200_000);
    assert.strictEqual(contextWindowForModel('foo (32k)'), 32_000);
  });

  test('vendor prefixes and date/quant suffixes are stripped', () => {
    assert.strictEqual(normalizeModelId('anthropic/claude-opus-4-8'), 'claude-opus-4-8');
    assert.strictEqual(normalizeModelId('us.anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.strictEqual(normalizeModelId('llama3.1:70b'), 'llama3.1');
    assert.strictEqual(normalizeModelId('claude-opus-4-8-20260101'), 'claude-opus-4-8');
    assert.strictEqual(contextWindowForModel('anthropic/claude-opus-4-8'), 1_000_000);
    assert.strictEqual(contextWindowForModel('llama3.1:70b'), 128_000);
  });

  test('family prefix match catches versioned variants', () => {
    // Not an exact key, but starts with the `qwen3` family.
    assert.strictEqual(contextWindowForModel('qwen3-coder-plus'), 128_000);
    assert.strictEqual(contextWindowForModel('gemini-2.5-pro-exp'), 1_000_000);
  });

  test('unknown models fall back to the default, never throw', () => {
    assert.strictEqual(contextWindowForModel('totally-made-up-model'), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(contextWindowForModel(undefined), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(contextWindowForModel(null), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(contextWindowForModel(''), DEFAULT_CONTEXT_WINDOW);
  });

  test('isKnownModel distinguishes catalog hits from fallbacks', () => {
    assert.strictEqual(isKnownModel('claude-opus-4-8'), true);
    assert.strictEqual(isKnownModel('anthropic/claude-sonnet-4-6'), true);
    assert.strictEqual(isKnownModel('model-x[1m]'), true);
    assert.strictEqual(isKnownModel('totally-made-up-model'), false);
    assert.strictEqual(isKnownModel(undefined), false);
  });

  test('every catalog value is a positive integer', () => {
    for (const [id, win] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      assert.ok(Number.isInteger(win) && win > 0, `${id} → ${win} should be a positive integer`);
    }
  });
});
