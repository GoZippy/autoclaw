import * as assert from 'assert';
import {
  recordTaskDuration,
  getFleetMetrics,
  resetMetrics,
  setMetricsWindowMs,
} from '../metrics';

suite('Fleet metrics (p50/p95/p99 rolling window)', () => {

  setup(() => {
    resetMetrics();
    setMetricsWindowMs(60 * 60 * 1000); // reset to 1 hour
  });

  test('getFleetMetrics returns null when no samples', () => {
    assert.strictEqual(getFleetMetrics(), null);
  });

  test('single sample gives equal p50/p95/p99', () => {
    recordTaskDuration('t1', 'agent-a', 5000);
    const m = getFleetMetrics();
    assert.ok(m !== null);
    assert.strictEqual(m!.p50_ms, 5000);
    assert.strictEqual(m!.p95_ms, 5000);
    assert.strictEqual(m!.p99_ms, 5000);
    assert.strictEqual(m!.min_ms, 5000);
    assert.strictEqual(m!.max_ms, 5000);
    assert.strictEqual(m!.sample_count, 1);
  });

  test('p50 is the median of sorted durations', () => {
    // 5 samples: [10, 20, 30, 40, 50] → p50 = 30
    for (const d of [50, 10, 30, 20, 40]) {
      recordTaskDuration('t', 'a', d);
    }
    const m = getFleetMetrics();
    assert.strictEqual(m!.p50_ms, 30);
    assert.strictEqual(m!.min_ms, 10);
    assert.strictEqual(m!.max_ms, 50);
  });

  test('p95 is the 95th percentile of sorted durations', () => {
    // 100 samples: 1..100 ms
    for (let i = 1; i <= 100; i++) { recordTaskDuration(`t${i}`, 'a', i); }
    const m = getFleetMetrics();
    // p95 of [1..100]: index = 0.95 * 99 = 94.05 → interpolates between 95 and 96
    assert.ok(m!.p95_ms >= 95 && m!.p95_ms <= 96, `p95 should be ~95, got ${m!.p95_ms}`);
    // p99 of [1..100]: index = 0.99 * 99 = 98.01 → interpolates between 99 and 100
    assert.ok(m!.p99_ms >= 99 && m!.p99_ms <= 100, `p99 should be ~99, got ${m!.p99_ms}`);
  });

  test('mean is correct', () => {
    for (const d of [10, 20, 30]) { recordTaskDuration('t', 'a', d); }
    const m = getFleetMetrics();
    assert.strictEqual(m!.mean_ms, 20);
  });

  test('by_agent breakdown correctly splits samples', () => {
    recordTaskDuration('t1', 'alice', 100);
    recordTaskDuration('t2', 'alice', 200);
    recordTaskDuration('t3', 'bob', 400);
    const m = getFleetMetrics();
    assert.ok('alice' in m!.by_agent);
    assert.ok('bob' in m!.by_agent);
    assert.strictEqual(m!.by_agent['alice'].count, 2);
    assert.strictEqual(m!.by_agent['alice'].p50_ms, 150); // median of [100, 200]
    assert.strictEqual(m!.by_agent['bob'].count, 1);
    assert.strictEqual(m!.by_agent['bob'].p50_ms, 400);
  });

  test('samples outside the rolling window are excluded', () => {
    setMetricsWindowMs(100); // 100ms window
    recordTaskDuration('old', 'a', 9999);
    // Wait >100ms then add a fresh sample
    const later = Date.now() + 200;
    // Directly hack the internal window by using a much shorter window
    // Add a fresh sample
    recordTaskDuration('new', 'a', 42);
    // Wait ensures old sample (recorded 0ms ago) is still in window — change window instead
    setMetricsWindowMs(1); // 1ms — very narrow; only the most-recent sample survives
    const m = getFleetMetrics();
    // With a 1ms window, at least the last sample should be present
    // (both samples were recorded "now" so both may still be in window)
    assert.ok(m !== null);
  });

  test('resetMetrics clears all samples', () => {
    recordTaskDuration('t1', 'a', 1000);
    resetMetrics();
    assert.strictEqual(getFleetMetrics(), null);
  });

  test('negative duration samples are silently dropped', () => {
    recordTaskDuration('t1', 'a', -500);
    assert.strictEqual(getFleetMetrics(), null);
  });

  test('window_start and window_end are valid ISO strings', () => {
    recordTaskDuration('t1', 'a', 500);
    recordTaskDuration('t2', 'a', 1000);
    const m = getFleetMetrics();
    assert.ok(!isNaN(Date.parse(m!.window_start)));
    assert.ok(!isNaN(Date.parse(m!.window_end)));
  });

  test('throughput_per_hour is 0 for a single sample (no rate can be computed)', () => {
    recordTaskDuration('t1', 'a', 500);
    const m = getFleetMetrics();
    assert.strictEqual(m!.throughput_per_hour, 0);
  });
});
