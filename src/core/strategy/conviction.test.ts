import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConviction } from './conviction.js';
import type { ConvictionParams, BtTradeActivity } from '../../types.js';

const baseParams: ConvictionParams = {
  betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0, w3: 0, f4Boost: 1.0,
};

function makeTrade(usdValue: number): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok', conditionId: 'c',
    action: 'buy', price: 0.5, size: 10, usdValue, marketSlug: 's',
  };
}

test('conviction: F1 only — scales with trader USD, clamped at f1Max', () => {
  assert.equal(computeConviction(makeTrade(100), baseParams, [], 0, 0), 2);
  assert.equal(computeConviction(makeTrade(500), baseParams, [], 0, 0), 10);
  assert.equal(computeConviction(makeTrade(1000), baseParams, [], 0, 0), 10);
  assert.equal(computeConviction(makeTrade(10), baseParams, [], 0, 0), 2);
});

test('conviction: F2 z-score boost', () => {
  const params = { ...baseParams, w2: 0.5 };
  const recentUsdValues = [50, 75, 100, 125, 150];
  const bet = computeConviction(makeTrade(250), params, recentUsdValues, 0, 0);
  assert.ok(bet > 4, `Expected > 4, got ${bet}`);
});

test('conviction: F3 trader score boost', () => {
  const params = { ...baseParams, w3: 1.0 };
  const bet = computeConviction(makeTrade(100), params, [], 50, 0);
  assert.equal(bet, 2 * 1.5);
});

test('conviction: F4 consensus boost', () => {
  const params = { ...baseParams, f4Boost: 2.0 };
  const bet = computeConviction(makeTrade(100), params, [], 0, 2);
  assert.equal(bet, 2 * 2.0);
});

test('conviction: all factors combined', () => {
  const params: ConvictionParams = {
    betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0.3, w3: 0.5, f4Boost: 1.5,
  };
  const bet = computeConviction(makeTrade(200), params, [100, 100, 100], 60, 3);
  assert.ok(bet > 7.8, `Expected > 7.8, got ${bet}`);
});

test('conviction: zero usdValue → bet = betBase (min F1=1)', () => {
  assert.equal(computeConviction(makeTrade(0), baseParams, [], 0, 0), 2);
});
