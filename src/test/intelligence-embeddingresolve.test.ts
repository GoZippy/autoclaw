/**
 * intelligence-embeddingresolve.test.ts — unit tests for the auto-detect ladder
 * + sidecar pin (`embeddingResolve.ts`).
 *
 * Hermetic: explicit providers short-circuit (no network); `auto` is forced to
 * the `none` rung by pointing router/ollama at a dead loopback port; the pin is
 * exercised by writing/reading the sidecar directly.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveEmbeddingConfig,
  setEmbeddingProvider,
  clearEmbeddingPin,
  readEmbeddingPin,
  pickOllamaEmbedModel,
  loadConfig,
  defaultConfig,
} from '../intelligence';
import { IntelligenceConfig } from '../intelligence/types';

const DEAD = 'http://127.0.0.1:1';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-embres-'));
}

function autoConfig(overrides: Partial<IntelligenceConfig['embedding']> = {}): IntelligenceConfig {
  const cfg = defaultConfig();
  cfg.embedding = { provider: 'auto', model: 'Xenova/nomic-embed-text-v1.5', dimension: 768, ...overrides };
  return cfg;
}

suite('embeddingResolve: pickOllamaEmbedModel', function () {
  test('prefers an exact nomic-embed-text tag', function () {
    assert.strictEqual(
      pickOllamaEmbedModel(['llama3.1:8b', 'nomic-embed-text:latest', 'qwen3:4b']),
      'nomic-embed-text:latest',
    );
  });

  test('falls back to any embedding-looking model', function () {
    assert.strictEqual(pickOllamaEmbedModel(['llama3.1:8b', 'mxbai-embed-large']), 'mxbai-embed-large');
  });

  test('returns undefined when only chat models are present', function () {
    assert.strictEqual(pickOllamaEmbedModel(['llama3.1:8b', 'qwen3:4b']), undefined);
  });
});

suite('embeddingResolve: explicit provider passthrough', function () {
  test('an explicit provider is returned unchanged with source=explicit (no network)', async function () {
    const ws = tmpWorkspace();
    const cfg = defaultConfig();
    cfg.embedding = { provider: 'none', model: 'none-hashed-bow', dimension: 768 };
    const res = await resolveEmbeddingConfig(cfg, ws);
    assert.strictEqual(res.source, 'explicit');
    assert.strictEqual(res.provider, 'none');
    assert.strictEqual(res.freshlyResolved, false);
    assert.strictEqual(res.config.embedding.provider, 'none');
  });
});

suite('embeddingResolve: auto → none when nothing is reachable', function () {
  test('dead router+ollama hosts resolve to none and do NOT pin', async function () {
    const ws = tmpWorkspace();
    const cfg = autoConfig({ routerHost: DEAD, ollamaHost: DEAD });
    const res = await resolveEmbeddingConfig(cfg, ws);
    assert.strictEqual(res.provider, 'none');
    assert.strictEqual(res.freshlyResolved, true);
    assert.strictEqual(res.config.embedding.provider, 'none');
    // `none` is deliberately NOT pinned, so a later router/ollama is still found.
    assert.strictEqual(readEmbeddingPin(ws), undefined, 'none must not be pinned');
  });
});

suite('embeddingResolve: sidecar pin', function () {
  test('a present pin short-circuits resolution (source=pinned, no probe)', async function () {
    const ws = tmpWorkspace();
    const vectorDir = path.join(ws, '.autoclaw', 'vector');
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vectorDir, 'embedding-resolved.json'),
      JSON.stringify({ provider: 'ollama', model: 'nomic-embed-text', dimension: 768, resolvedAt: '2026-01-01T00:00:00Z' }),
    );
    // Point hosts at a dead port to PROVE no probe runs (a probe would fail).
    const cfg = autoConfig({ routerHost: DEAD, ollamaHost: DEAD });
    const res = await resolveEmbeddingConfig(cfg, ws);
    assert.strictEqual(res.source, 'pinned');
    assert.strictEqual(res.provider, 'ollama');
    assert.strictEqual(res.config.embedding.model, 'nomic-embed-text');
    assert.strictEqual(res.config.embedding.dimension, 768);
  });

  test('readEmbeddingPin rejects an invalid pin', function () {
    const ws = tmpWorkspace();
    const vectorDir = path.join(ws, '.autoclaw', 'vector');
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.writeFileSync(path.join(vectorDir, 'embedding-resolved.json'), JSON.stringify({ provider: 'auto' }));
    assert.strictEqual(readEmbeddingPin(ws), undefined);
  });

  test('a pinned provider that is no longer reachable is dropped, cleared, and re-detected', async function () {
    const ws = tmpWorkspace();
    const vectorDir = path.join(ws, '.autoclaw', 'vector');
    fs.mkdirSync(vectorDir, { recursive: true });
    // Pin a router that is now dead.
    fs.writeFileSync(
      path.join(vectorDir, 'embedding-resolved.json'),
      JSON.stringify({ provider: 'router', model: 'nomic-embed-text', dimension: 768, routerHost: DEAD, resolvedAt: '' }),
    );
    const cfg = autoConfig({ routerHost: DEAD, ollamaHost: DEAD });
    const res = await resolveEmbeddingConfig(cfg, ws);
    assert.strictEqual(res.source, 'probed', 'a dead pin must not be trusted');
    assert.strictEqual(res.provider, 'none', 'with no reachable provider it falls to none');
    assert.strictEqual(readEmbeddingPin(ws), undefined, 'the dead pin must be cleared');
  });
});

suite('embeddingResolve: setEmbeddingProvider', function () {
  test('writes an explicit provider to config.json and clears any pin', async function () {
    const ws = tmpWorkspace();
    const vectorDir = path.join(ws, '.autoclaw', 'vector');
    fs.mkdirSync(vectorDir, { recursive: true });
    // Seed a pin that should be cleared.
    fs.writeFileSync(
      path.join(vectorDir, 'embedding-resolved.json'),
      JSON.stringify({ provider: 'ollama', model: 'm', dimension: 768, resolvedAt: '' }),
    );

    setEmbeddingProvider(ws, { provider: 'router', model: 'nomic-embed-text', dimension: 768, routerHost: 'http://x:1' });

    const reloaded = loadConfig(ws);
    assert.strictEqual(reloaded.embedding.provider, 'router');
    assert.strictEqual(reloaded.embedding.model, 'nomic-embed-text');
    assert.strictEqual(reloaded.embedding.routerHost, 'http://x:1');
    assert.strictEqual(readEmbeddingPin(ws), undefined, 'pin must be cleared on explicit set');
  });

  test('clearEmbeddingPin removes the sidecar', function () {
    const ws = tmpWorkspace();
    const vectorDir = path.join(ws, '.autoclaw', 'vector');
    fs.mkdirSync(vectorDir, { recursive: true });
    const pinFile = path.join(vectorDir, 'embedding-resolved.json');
    fs.writeFileSync(pinFile, JSON.stringify({ provider: 'router', model: 'm', dimension: 768, resolvedAt: '' }));
    assert.ok(fs.existsSync(pinFile));
    clearEmbeddingPin(ws);
    assert.strictEqual(fs.existsSync(pinFile), false);
  });
});
