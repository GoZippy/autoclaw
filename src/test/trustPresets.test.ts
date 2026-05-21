/**
 * trustPresets.test.ts — Sprint 3 B5 (WA-3).
 *
 * Covers the `agents/<agent>/scope.json` trust-preset model: validation,
 * deny-by-default I/O, and effective-trust resolution (allow/deny list
 * interaction with the preset baseline).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AUTO_BASELINE_TOOLS,
  STRICTEST_PRESET,
  defaultScopeFile,
  isToolAutoApproved,
  isTrustPreset,
  readScopeFile,
  resolveAutoApproved,
  resolveEffectiveTrust,
  validateScopeFile,
  writeScopeFile,
  type AgentScopeFile,
} from '../runners/trustPresets';

suite('trustPresets — validation', () => {
  test('isTrustPreset accepts only the three presets', () => {
    assert.ok(isTrustPreset('off'));
    assert.ok(isTrustPreset('auto'));
    assert.ok(isTrustPreset('turbo'));
    assert.ok(!isTrustPreset('yolo'));
    assert.ok(!isTrustPreset(undefined));
  });

  test('validateScopeFile rejects a non-object', () => {
    const r = validateScopeFile('nope');
    assert.ok(!r.ok);
  });

  test('validateScopeFile rejects an unknown trust value', () => {
    const r = validateScopeFile({ agent: 'claude-code', trust: 'maximum' });
    assert.ok(!r.ok);
    assert.ok((r as { errors: string[] }).errors.some(e => e.includes('trust')));
  });

  test('validateScopeFile rejects a negative budget', () => {
    const r = validateScopeFile({ agent: 'a', trust: 'auto', maxTokensPerDispatch: -1 });
    assert.ok(!r.ok);
  });

  test('validateScopeFile normalises a valid document and drops a bad list', () => {
    const r = validateScopeFile({
      agent: 'claude-code',
      trust: 'auto',
      trustAllowList: ['read', 'write', 42],
      trustDenyList: 'not-an-array',
    });
    assert.ok(r.ok);
    const v = (r as { value: AgentScopeFile }).value;
    assert.deepStrictEqual(v.trustAllowList, ['read', 'write']);
    assert.strictEqual(v.trustDenyList, undefined);
  });

  test('defaultScopeFile is the strictest preset', () => {
    assert.strictEqual(defaultScopeFile('x').trust, STRICTEST_PRESET);
    assert.strictEqual(STRICTEST_PRESET, 'off');
  });
});

suite('trustPresets — resolveAutoApproved', () => {
  test('off auto-approves nothing', () => {
    const { autoApproved } = resolveAutoApproved({ trust: 'off' });
    assert.strictEqual(autoApproved.length, 0);
  });

  test('auto = baseline ∪ allow, minus deny', () => {
    const { autoApproved } = resolveAutoApproved({
      trust: 'auto',
      trustAllowList: ['build'],
      trustDenyList: ['grep'],
    });
    assert.ok(autoApproved.includes('build'));
    assert.ok(autoApproved.includes('read'));
    assert.ok(!autoApproved.includes('grep')); // deny wins over baseline
  });

  test('deny list wins over allow list', () => {
    const { autoApproved, denied } = resolveAutoApproved({
      trust: 'auto',
      trustAllowList: ['delete'],
      trustDenyList: ['delete'],
    });
    assert.ok(!autoApproved.includes('delete'));
    assert.ok(denied.includes('delete'));
  });

  test('turbo leaves autoApproved empty (allow-all-except-deny model)', () => {
    const { autoApproved, denied } = resolveAutoApproved({
      trust: 'turbo',
      trustDenyList: ['force_push'],
    });
    assert.strictEqual(autoApproved.length, 0);
    assert.deepStrictEqual(denied, ['force_push']);
  });
});

suite('trustPresets — isToolAutoApproved', () => {
  test('turbo auto-approves anything not denied', () => {
    assert.ok(isToolAutoApproved({ trust: 'turbo' }, 'anything'));
    assert.ok(!isToolAutoApproved({ trust: 'turbo', trustDenyList: ['rm'] }, 'rm'));
  });

  test('off auto-approves nothing', () => {
    assert.ok(!isToolAutoApproved({ trust: 'off' }, 'read'));
  });

  test('auto auto-approves baseline read tools', () => {
    for (const t of AUTO_BASELINE_TOOLS) {
      assert.ok(isToolAutoApproved({ trust: 'auto' }, t), `${t} should be auto-approved`);
    }
    assert.ok(!isToolAutoApproved({ trust: 'auto' }, 'delete_branch'));
  });
});

suite('trustPresets — resolveEffectiveTrust', () => {
  test('combines registry translation with materialised lists', () => {
    const eff = resolveEffectiveTrust('claude-code', {
      trust: 'auto',
      trustDenyList: ['grep'],
    });
    assert.strictEqual(eff.preset, 'auto');
    assert.ok(eff.translation.flags.length > 0);
    assert.ok(!eff.autoApproved.includes('grep'));
    assert.strictEqual(eff.downgraded, false);
  });

  test('flags a downgrade for an unknown runner', () => {
    const eff = resolveEffectiveTrust('mystery-runner', { trust: 'turbo' });
    assert.strictEqual(eff.downgraded, true);
  });
});

suite('trustPresets — filesystem I/O', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-trust-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readScopeFile returns the strict default when no file exists', async () => {
    const r = await readScopeFile(dir, 'claude-code');
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.scope.trust, 'off');
  });

  test('write then read round-trips a scope file', async () => {
    const w = await writeScopeFile(dir, { agent: 'kilocode', trust: 'turbo', trustDenyList: ['rm'] });
    assert.ok(w.ok);
    const r = await readScopeFile(dir, 'kilocode');
    assert.strictEqual(r.source, 'file');
    assert.strictEqual(r.scope.trust, 'turbo');
    assert.deepStrictEqual(r.scope.trustDenyList, ['rm']);
  });

  test('readScopeFile falls back to default on corrupt JSON', async () => {
    const file = path.join(dir, 'agents', 'cursor', 'scope.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    const r = await readScopeFile(dir, 'cursor');
    assert.strictEqual(r.source, 'default');
    assert.ok(r.errors && r.errors.length > 0);
  });

  test('writeScopeFile rejects an invalid document', async () => {
    const w = await writeScopeFile(dir, { agent: 'x', trust: 'nope' as never });
    assert.ok(!w.ok);
  });
});
