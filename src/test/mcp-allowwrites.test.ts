import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readMcpConfig,
  isWritesAllowed,
  setAllowWrites,
  mcpConfigPath,
  ALLOW_WRITES_ENV,
} from '../mcp/allowWritesConfig';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-allowwrites-test-'));
}

/** Hand-write a config.json (raw, so tests can plant BOM/malformed bytes). */
function writeRawConfig(wr: string, raw: string): void {
  const file = mcpConfigPath(wr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw, 'utf8');
}

suite('MCP allowWrites config (join follow-up #1)', () => {

  test('readMcpConfig tolerates a missing file → {}', () => {
    const wr = makeTmp();
    assert.deepStrictEqual(readMcpConfig(wr), {});
  });

  test('readMcpConfig tolerates malformed JSON → {} (never throws)', () => {
    const wr = makeTmp();
    writeRawConfig(wr, '{ this is : not json,,,');
    assert.deepStrictEqual(readMcpConfig(wr), {});
  });

  test('readMcpConfig tolerates a non-object (array) → {}', () => {
    const wr = makeTmp();
    writeRawConfig(wr, '[1,2,3]');
    assert.deepStrictEqual(readMcpConfig(wr), {});
  });

  test('readMcpConfig strips a leading BOM before parsing', () => {
    const wr = makeTmp();
    writeRawConfig(wr, '﻿{"allowWrites": true}');
    assert.strictEqual(readMcpConfig(wr).allowWrites, true);
  });

  test('setAllowWrites → readMcpConfig roundtrip (create then read back true)', async () => {
    const wr = makeTmp();
    const result = await setAllowWrites(wr, true);
    assert.strictEqual(result.allowWrites, true);
    assert.ok(fs.existsSync(mcpConfigPath(wr)));
    assert.strictEqual(readMcpConfig(wr).allowWrites, true);
    assert.strictEqual(isWritesAllowed(wr, {}), true);
  });

  test('setAllowWrites(false) writes a flag the gate reads as denied', async () => {
    const wr = makeTmp();
    await setAllowWrites(wr, true);
    await setAllowWrites(wr, false);
    assert.strictEqual(readMcpConfig(wr).allowWrites, false);
    assert.strictEqual(isWritesAllowed(wr, {}), false);
  });

  test('setAllowWrites creates the .autoclaw/mcp dir when absent', async () => {
    const wr = makeTmp();
    assert.ok(!fs.existsSync(path.join(wr, '.autoclaw', 'mcp')));
    await setAllowWrites(wr, true);
    assert.ok(fs.existsSync(path.join(wr, '.autoclaw', 'mcp')));
  });

  test('setAllowWrites preserves an existing tools map (and other keys) when flipping', async () => {
    const wr = makeTmp();
    // Operator has a hand-tuned per-tool policy + an extra key.
    writeRawConfig(
      wr,
      JSON.stringify(
        {
          allowWrites: false,
          tools: {
            'dream.run': { allow: false, reason: 'daemon owns dream scheduling' },
            'consensus.vote': { allow: true },
          },
          customKey: 'keep-me',
        },
        null,
        2,
      ),
    );

    const next = await setAllowWrites(wr, true);
    assert.strictEqual(next.allowWrites, true, 'flag flipped');
    // The tools map survives verbatim — this is the footgun guard.
    assert.deepStrictEqual(next.tools, {
      'dream.run': { allow: false, reason: 'daemon owns dream scheduling' },
      'consensus.vote': { allow: true },
    });
    assert.strictEqual(next.customKey, 'keep-me', 'unrelated keys preserved');

    // And it is durable on disk, not just in the return value.
    const back = readMcpConfig(wr);
    assert.deepStrictEqual(back.tools, next.tools);
    assert.strictEqual(back.customKey, 'keep-me');
  });

  test('setAllowWrites is idempotent — re-setting true yields the same file', async () => {
    const wr = makeTmp();
    await setAllowWrites(wr, true);
    const first = fs.readFileSync(mcpConfigPath(wr), 'utf8');
    await setAllowWrites(wr, true);
    const second = fs.readFileSync(mcpConfigPath(wr), 'utf8');
    assert.strictEqual(first, second, 'idempotent re-set is byte-identical');
  });

  test('isWritesAllowed: env override TRUE wins over a false file flag', async () => {
    const wr = makeTmp();
    await setAllowWrites(wr, false);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'true' }), true);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: '1' }), true);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'yes' }), true);
  });

  test('isWritesAllowed: env override FALSE wins over a true file flag', async () => {
    const wr = makeTmp();
    await setAllowWrites(wr, true);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'false' }), false);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: '0' }), false);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'no' }), false);
  });

  test('isWritesAllowed: an unrecognized env value falls through to the file', async () => {
    const wr = makeTmp();
    await setAllowWrites(wr, true);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'maybe' }), true);
    await setAllowWrites(wr, false);
    assert.strictEqual(isWritesAllowed(wr, { [ALLOW_WRITES_ENV]: 'maybe' }), false);
  });

  test('isWritesAllowed: missing file with no env → false (deny by default)', () => {
    const wr = makeTmp();
    assert.strictEqual(isWritesAllowed(wr, {}), false);
  });
});
