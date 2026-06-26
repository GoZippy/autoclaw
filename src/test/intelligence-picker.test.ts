/**
 * intelligence-picker.test.ts — the PURE provider-picker decision logic
 * (buildProviderOptions). No vscode: a {@link ProviderProbe} in, the annotated,
 * self-explaining option rows out, with exactly ONE rung recommended.
 */

import * as assert from 'assert';

import {
  buildProviderOptions,
  ProviderProbe,
  ProviderOption,
} from '../intelligence/providerChoice';

/** All rungs down, nothing installed — the "empty" baseline. */
function emptyProbe(): ProviderProbe {
  return {
    router: { reachable: false },
    ollama: { reachable: false },
    transformers: { installed: false },
  };
}

const byId = (opts: ProviderOption[], id: ProviderOption['id']): ProviderOption =>
  opts.find((o) => o.id === id) as ProviderOption;

const recommended = (opts: ProviderOption[]): ProviderOption[] => opts.filter((o) => o.recommended);

suite('intelligence — provider picker (buildProviderOptions)', () => {
  test('(a) router reachable → router recommended (even when ollama is also up)', () => {
    const probe: ProviderProbe = {
      router: { reachable: true },
      ollama: { reachable: true, embedModel: 'nomic-embed-text' },
      transformers: { installed: true },
    };
    const opts = buildProviderOptions(probe, 'auto');
    const router = byId(opts, 'router');
    assert.strictEqual(router.recommended, true, 'router should be recommended');
    assert.ok(router.label.startsWith('★ '), 'recommended label carries the ★ badge');
    assert.strictEqual(byId(opts, 'ollama').recommended, false, 'ollama yields to a reachable router');
  });

  test('(b) only ollama with an embed model → ollama recommended', () => {
    const probe: ProviderProbe = {
      router: { reachable: false },
      ollama: { reachable: true, embedModel: 'nomic-embed-text:latest' },
      transformers: { installed: false },
    };
    const opts = buildProviderOptions(probe, 'auto');
    const ollama = byId(opts, 'ollama');
    assert.strictEqual(ollama.recommended, true, 'ollama should be recommended');
    assert.ok(ollama.label.startsWith('★ '), 'recommended label carries the ★ badge');
    assert.ok(
      ollama.description.includes('nomic-embed-text:latest'),
      'description names the ready embed model',
    );
    assert.ok(ollama.description.includes('✓'), 'description shows a ready glyph');
  });

  test('(c) ollama running but no embed model → NOT recommended, nudges `ollama pull`', () => {
    const probe: ProviderProbe = {
      router: { reachable: false },
      ollama: { reachable: true, embedModel: undefined },
      transformers: { installed: false },
    };
    const opts = buildProviderOptions(probe, 'auto');
    const ollama = byId(opts, 'ollama');
    assert.strictEqual(ollama.recommended, false, 'no embed model ⇒ ollama is not recommended');
    assert.ok(
      ollama.description.includes('ollama pull'),
      'description nudges the user to pull an embed model',
    );
    assert.ok(ollama.description.includes('⚠'), 'description shows the running-but-incomplete glyph');
    // With no other rung up, "none" carries the recommendation.
    assert.strictEqual(byId(opts, 'none').recommended, true, 'none is the last-resort recommendation');
  });

  test('(c2) transformers installed and no network provider → transformers recommended', () => {
    const probe: ProviderProbe = {
      router: { reachable: false },
      ollama: { reachable: true, embedModel: undefined }, // up but no embed model
      transformers: { installed: true },
    };
    const opts = buildProviderOptions(probe, 'auto');
    assert.strictEqual(byId(opts, 'transformers').recommended, true, 'installed offline peer wins');
    assert.ok(byId(opts, 'transformers').description.includes('✓ installed'));
  });

  test('(d) nothing available → none recommended, auto stays an explicit non-recommended option', () => {
    const opts = buildProviderOptions(emptyProbe(), 'auto');
    assert.strictEqual(byId(opts, 'none').recommended, true, 'none is the fallback recommendation');
    assert.strictEqual(byId(opts, 'auto').recommended, false, 'auto is never the auto-recommendation');
    // Live status glyphs are present on the down rungs.
    assert.ok(byId(opts, 'router').description.includes('✗'), 'router shows a down glyph');
    assert.ok(byId(opts, 'ollama').description.includes('✗'), 'ollama shows a down glyph');
    assert.ok(
      byId(opts, 'transformers').description.includes('not installed'),
      'transformers shows the install size',
    );
  });

  test('(e) exactly one option is recommended across a range of probes', () => {
    const probes: ProviderProbe[] = [
      emptyProbe(),
      { router: { reachable: true }, ollama: { reachable: true, embedModel: 'nomic-embed-text' }, transformers: { installed: true } },
      { router: { reachable: false }, ollama: { reachable: true, embedModel: 'nomic-embed-text' }, transformers: { installed: false } },
      { router: { reachable: false }, ollama: { reachable: true, embedModel: undefined }, transformers: { installed: true } },
      { router: { reachable: false }, ollama: { reachable: false }, transformers: { installed: true } },
    ];
    for (const probe of probes) {
      const opts = buildProviderOptions(probe, 'auto');
      assert.strictEqual(recommended(opts).length, 1, `exactly one recommended for ${JSON.stringify(probe)}`);
      // Exactly one ★-prefixed label, matching the recommended row.
      const starred = opts.filter((o) => o.label.startsWith('★ '));
      assert.strictEqual(starred.length, 1, 'exactly one ★ badge');
      assert.strictEqual(starred[0].id, recommended(opts)[0].id, '★ badge sits on the recommended row');
    }
  });

  test('current provider is annotated with a "(current)" hint', () => {
    const opts = buildProviderOptions(emptyProbe(), 'ollama (nomic-embed-text, 768-dim)');
    assert.ok(byId(opts, 'ollama').label.includes('(current)'), 'current rung is marked');
    assert.ok(!byId(opts, 'router').label.includes('(current)'), 'non-current rungs are not marked');
  });
});
