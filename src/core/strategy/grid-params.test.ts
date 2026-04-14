import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLHS, generateFineGrid } from './grid-params.js';
import type { BacktestSimConfig } from '../../types.js';

test('generateLHS: produces N distinct configs', () => {
  const configs = generateLHS(50);
  assert.equal(configs.length, 50);
  // All should have valid topN values
  for (const c of configs) {
    assert.ok([5, 10, 20].includes(c.topN));
    assert.ok(c.conviction.betBase === 1);
    assert.ok(c.initialCapital === 200);
  }
});

test('generateLHS: configs are diverse (not all identical)', () => {
  const configs = generateLHS(20);
  const topNs = new Set(configs.map((c) => c.topN));
  assert.ok(topNs.size > 1, 'Expected diverse topN values');
});

test('generateFineGrid: generates neighbors around winners', () => {
  const winner: BacktestSimConfig = {
    conviction: { betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0.3, w3: 0.5, f4Boost: 1.5 },
    topN: 10, leaderboardWindowDays: 30, maxTtrDays: 14,
    maxPositions: 20, initialCapital: 500, slippagePct: 1, commissionPct: 2,
  };
  const fineConfigs = generateFineGrid([winner]);
  assert.ok(fineConfigs.length > 0);
  assert.ok(fineConfigs.length < 500, 'Fine grid should be bounded');
});
