/**
 * intelligence-connectedtools.test.ts — cross-tool ingestion detection
 * (decideIngestion / detectConnectedTools) + the recall-surface descriptor.
 *
 * Pure logic only; no vscode, no disk. Mirrors the node-assert + mocha-tdd
 * style of intelligence-storage.test.ts.
 */

import * as assert from 'assert';

import {
  decideIngestion,
  detectConnectedTools,
  recallSurfaces,
  DetectedTool,
} from '../intelligence/connectedTools';
import { AdapterEnv, SourceAdapter, SourcePresence } from '../intelligence/types';

const env: AdapterEnv = {
  homeDir: '/home/test',
  workspaceRoot: '/home/test/proj',
  platform: 'linux',
  env: {},
};

/** Build a minimal adapter whose discover() resolves/rejects as configured. */
function stubAdapter(
  id: string,
  opts: { presence?: SourcePresence; throws?: boolean; tier?: 1 | 2 | 3 },
): Pick<SourceAdapter, 'id' | 'displayName' | 'tier' | 'discover'> {
  return {
    id,
    displayName: id.toUpperCase(),
    tier: opts.tier ?? 2,
    discover: async (): Promise<SourcePresence> => {
      if (opts.throws) {
        throw new Error(`discover blew up for ${id}`);
      }
      return opts.presence ?? { available: false, locations: [] };
    },
  };
}

function tool(over: Partial<DetectedTool>): DetectedTool {
  return {
    id: 'x',
    displayName: 'X',
    tier: 2,
    present: false,
    enabled: false,
    ...over,
  };
}

suite('intelligence — connected tools (ingestion detection + recall surfaces)', () => {
  suite('decideIngestion', () => {
    test('present + NOT enabled → a candidate to auto-enable', () => {
      const detected = [tool({ id: 'cursor', present: true, enabled: false })];
      const { toEnable, all } = decideIngestion(detected);
      assert.strictEqual(toEnable.length, 1);
      assert.strictEqual(toEnable[0].id, 'cursor');
      assert.strictEqual(all.length, 1, 'all always echoes every detected tool');
    });

    test('present + already enabled → NOT a candidate', () => {
      const detected = [tool({ id: 'claude-code', present: true, enabled: true })];
      assert.strictEqual(decideIngestion(detected).toEnable.length, 0);
    });

    test('NOT present → NOT a candidate (even when disabled)', () => {
      const detected = [tool({ id: 'kiro', present: false, enabled: false })];
      assert.strictEqual(decideIngestion(detected).toEnable.length, 0);
    });

    test('mixed set filters to only present-and-disabled', () => {
      const detected = [
        tool({ id: 'cursor', present: true, enabled: false }), // candidate
        tool({ id: 'claude-code', present: true, enabled: true }), // already on
        tool({ id: 'kiro', present: false, enabled: false }), // not on disk
        tool({ id: 'gemini', present: false, enabled: true }), // neither
      ];
      const { toEnable, all } = decideIngestion(detected);
      assert.deepStrictEqual(
        toEnable.map((t) => t.id),
        ['cursor'],
      );
      assert.strictEqual(all.length, 4);
    });

    test('empty input → empty suggestion', () => {
      const { toEnable, all } = decideIngestion([]);
      assert.strictEqual(toEnable.length, 0);
      assert.strictEqual(all.length, 0);
    });
  });

  suite('detectConnectedTools', () => {
    test('maps present/absent/throwing adapters with no throw', async () => {
      const adapters = [
        stubAdapter('cursor', {
          presence: { available: true, locations: ['/a/1', '/a/2'] },
          tier: 1,
        }),
        stubAdapter('kiro', { presence: { available: false, locations: [] } }),
        stubAdapter('boom', { throws: true }),
      ];

      const detected = await detectConnectedTools({
        adapters,
        enabledIds: ['cursor'],
        env,
      });

      assert.strictEqual(detected.length, 3);

      const byId = new Map(detected.map((d) => [d.id, d]));

      const cursor = byId.get('cursor')!;
      assert.strictEqual(cursor.present, true, 'available presence → present');
      assert.strictEqual(cursor.enabled, true, 'enabledIds drives enabled');
      assert.strictEqual(cursor.sessionHint, 2, 'sessionHint from locations.length');
      assert.strictEqual(cursor.tier, 1);
      assert.strictEqual(cursor.displayName, 'CURSOR');

      const kiro = byId.get('kiro')!;
      assert.strictEqual(kiro.present, false, 'unavailable presence → not present');
      assert.strictEqual(kiro.enabled, false, 'not in enabledIds');
      assert.strictEqual(kiro.sessionHint, undefined, 'no locations → no hint');

      const boom = byId.get('boom')!;
      assert.strictEqual(boom.present, false, 'a throwing discover() → present:false');
      assert.strictEqual(boom.enabled, false);
      assert.strictEqual(boom.sessionHint, undefined);
    });

    test('available but with zero locations → present, no sessionHint', async () => {
      const detected = await detectConnectedTools({
        adapters: [stubAdapter('continue', { presence: { available: true, locations: [] } })],
        enabledIds: [],
        env,
      });
      assert.strictEqual(detected[0].present, true);
      assert.strictEqual(detected[0].sessionHint, undefined);
    });

    test('no adapters → empty result', async () => {
      const detected = await detectConnectedTools({ adapters: [], enabledIds: [], env });
      assert.strictEqual(detected.length, 0);
    });

    test('result feeds decideIngestion end-to-end', async () => {
      const adapters = [
        stubAdapter('cursor', { presence: { available: true, locations: ['/c/1'] } }),
        stubAdapter('kiro', { presence: { available: false, locations: [] } }),
      ];
      const detected = await detectConnectedTools({ adapters, enabledIds: [], env });
      const { toEnable } = decideIngestion(detected);
      assert.deepStrictEqual(
        toEnable.map((t) => t.id),
        ['cursor'],
      );
    });
  });

  suite('recallSurfaces', () => {
    const surfaces = recallSurfaces();

    test('includes the two MCP tools by their real names', () => {
      const mcp = surfaces.filter((s) => s.kind === 'mcp').map((s) => s.name);
      assert.ok(mcp.includes('intelligence.contextPack'), 'has intelligence.contextPack');
      assert.ok(mcp.includes('intelligence.retrieve'), 'has intelligence.retrieve');
    });

    test('includes the bridge HTTP context route', () => {
      const http = surfaces.filter((s) => s.kind === 'http');
      assert.strictEqual(http.length, 1);
      assert.strictEqual(http[0].name, 'GET /api/v1/intelligence/context');
    });

    test('includes a file surface for the host-context digests', () => {
      const file = surfaces.filter((s) => s.kind === 'file');
      assert.strictEqual(file.length, 1);
      assert.ok(
        file[0].detail.includes('.kiro/steering') && file[0].detail.includes('.cursor/rules'),
        'names real host rules dirs',
      );
    });

    test('every surface carries a non-empty one-line detail', () => {
      for (const s of surfaces) {
        assert.ok(s.name.length > 0, `${s.kind} surface has a name`);
        assert.ok(s.detail.length > 0, `${s.name} has a detail`);
        assert.ok(!s.detail.includes('\n'), `${s.name} detail is one line`);
      }
    });
  });
});
