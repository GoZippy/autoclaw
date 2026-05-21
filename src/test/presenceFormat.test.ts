/**
 * presenceFormat.test.ts — Unit tests for the status-bar presence formatters
 * (`src/statusbar/presenceFormat.ts`).
 *
 * No `vscode` import — plain Node/Mocha. The `FleetStatusBar` class itself
 * imports `vscode` and is exercised by the VS Code integration suite; only the
 * pure formatters are unit-tested here.
 *
 * Sprint 4 — C5_statusbar (C.11, WA-1).
 */

import * as assert from 'assert';
import {
  formatPresenceText,
  presenceTooltip,
  presenceColorKey,
} from '../statusbar/presenceFormat';
import type { PresenceSummary } from '../views/fleetViewModel';

function summary(p: Partial<PresenceSummary>): PresenceSummary {
  return {
    working: 0,
    needsReview: 0,
    down: 0,
    total: 0,
    text: '',
    ...p,
  };
}

suite('Status-bar Presence — formatPresenceText', () => {
  test('shows an idle label when no agents are tracked', () => {
    assert.strictEqual(formatPresenceText(summary({ total: 0 })), '$(rocket) AutoClaw: idle');
  });

  test('prepends the AutoClaw glyph to the presence text', () => {
    const text = formatPresenceText(
      summary({ total: 4, working: 3, needsReview: 1, text: '3 agents working, 1 needs review' }),
    );
    assert.strictEqual(text, '$(rocket) 3 agents working, 1 needs review');
  });
});

suite('Status-bar Presence — presenceTooltip', () => {
  test('includes the working / review / down / total breakdown', () => {
    const tip = presenceTooltip(summary({ total: 3, working: 2, needsReview: 1, down: 0 }));
    assert.ok(tip.includes('2 working'));
    assert.ok(tip.includes('1 need review'));
    assert.ok(tip.includes('0 down'));
    assert.ok(tip.includes('3 agents total'));
    assert.ok(tip.includes('Click to open the Fleet panel.'));
  });

  test('uses the singular "agent" for a one-agent fleet', () => {
    const tip = presenceTooltip(summary({ total: 1 }));
    assert.ok(tip.includes('1 agent total'));
    assert.ok(!tip.includes('1 agents total'));
  });
});

suite('Status-bar Presence — presenceColorKey', () => {
  test('returns the error background when agents are down', () => {
    assert.strictEqual(
      presenceColorKey(summary({ down: 1 })),
      'statusBarItem.errorBackground',
    );
  });

  test('returns the warning background when reviews are pending (and none down)', () => {
    assert.strictEqual(
      presenceColorKey(summary({ needsReview: 2 })),
      'statusBarItem.warningBackground',
    );
  });

  test('down takes precedence over needs-review', () => {
    assert.strictEqual(
      presenceColorKey(summary({ down: 1, needsReview: 3 })),
      'statusBarItem.errorBackground',
    );
  });

  test('returns undefined when nothing needs attention', () => {
    assert.strictEqual(presenceColorKey(summary({ working: 5 })), undefined);
  });
});
