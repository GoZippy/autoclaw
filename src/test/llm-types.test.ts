/**
 * llm-types.test.ts — Unit tests for src/llm/types.ts.
 *
 * Covers: ProviderRef parsing, ChatOptions normalization, capability
 * merging. Implements acceptance criterion #7 of
 * docs/specs/llm-provider-s1/spec.md (compile + ≥18 cases across S1).
 */

import * as assert from 'assert';

import {
  parseProviderRef,
  normalizeMessages,
  mergeCapabilities,
  type ProviderCapabilities,
} from '../llm/types';

const BASE_CAPS: ProviderCapabilities = {
  streaming: true,
  toolUse: false,
  jsonMode: true,
  embeddings: false,
  locality: 'local',
  reportsCost: false,
  modelFamilies: ['llama'],
};

suite('parseProviderRef', () => {
  test('no colon returns provider id only', () => {
    const r = parseProviderRef('ollama');
    assert.strictEqual(r.providerId, 'ollama');
    assert.strictEqual(r.model, undefined);
  });

  test('splits on first colon (preserves model id with colons)', () => {
    const r = parseProviderRef('ollama:llama3.1:70b');
    assert.strictEqual(r.providerId, 'ollama');
    assert.strictEqual(r.model, 'llama3.1:70b');
  });

  test('zippymesh:auto parses cleanly', () => {
    const r = parseProviderRef('zippymesh:auto');
    assert.strictEqual(r.providerId, 'zippymesh');
    assert.strictEqual(r.model, 'auto');
  });

  test('empty string yields empty provider id', () => {
    const r = parseProviderRef('');
    assert.strictEqual(r.providerId, '');
    assert.strictEqual(r.model, undefined);
  });
});

suite('normalizeMessages', () => {
  test('prompt sugar becomes a single user message', () => {
    const msgs = normalizeMessages({ prompt: 'hello' });
    assert.deepStrictEqual(msgs, [{ role: 'user', content: 'hello' }]);
  });

  test('messages array passes through untouched', () => {
    const input = [
      { role: 'system' as const, content: 's' },
      { role: 'user' as const, content: 'u' },
    ];
    const msgs = normalizeMessages({ messages: input });
    assert.strictEqual(msgs, input); // same reference — no copy needed
  });

  test('messages takes precedence when both prompt and messages are set', () => {
    const input = [{ role: 'user' as const, content: 'msg' }];
    const msgs = normalizeMessages({ prompt: 'ignored', messages: input });
    assert.strictEqual(msgs[0].content, 'msg');
  });

  test('empty options yields empty array', () => {
    const msgs = normalizeMessages({});
    assert.deepStrictEqual(msgs, []);
  });
});

suite('mergeCapabilities', () => {
  test('no override returns base unchanged', () => {
    const out = mergeCapabilities(BASE_CAPS);
    assert.strictEqual(out, BASE_CAPS);
  });

  test('override replaces scalar fields', () => {
    const out = mergeCapabilities(BASE_CAPS, { toolUse: true, contextWindow: 8192 });
    assert.strictEqual(out.toolUse, true);
    assert.strictEqual(out.contextWindow, 8192);
    assert.strictEqual(out.streaming, true); // base preserved
  });

  test('override modelFamilies replaces (not merges)', () => {
    const out = mergeCapabilities(BASE_CAPS, { modelFamilies: ['qwen', 'claude'] });
    assert.deepStrictEqual(out.modelFamilies, ['qwen', 'claude']);
  });

  test('omitted modelFamilies preserves base', () => {
    const out = mergeCapabilities(BASE_CAPS, { toolUse: true });
    assert.deepStrictEqual(out.modelFamilies, ['llama']);
  });
});
