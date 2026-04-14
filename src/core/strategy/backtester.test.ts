import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './backtester.js';
import type { BtDataset, BtTradeActivity, BtMarket, BacktestSimConfig, ConvictionParams } from '../../types.js';

function indexByAddr(trades: BtTradeActivity[]): Map<string, BtTradeActivity[]> {
  const m = new Map<string, BtTradeActivity[]>();
  for (const t of trades) { const a = m.get(t.address); if (a) a.push(t); else m.set(t.address, [t]); }
  return m;
}

function makeTrade(overrides: Partial<BtTradeActivity>): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 50, marketSlug: 's',
    ...overrides,
  };
}

const defaultConfig: BacktestSimConfig = {
  conviction: { betBase: 10, f1Anchor: 100, f1Max: 5, w2: 0, w3: 0, f4Boost: 1.0 },
  topN: 10, leaderboardWindowDays: 30, maxTtrDays: Infinity,
  maxPositions: 20, initialCapital: 500, slippagePct: 0, commissionPct: 0,
};

test('backtester: single winning trade → positive PnL', () => {
  // Day 1 (ts 86400): 0xA buys tok1 on c1 at price=0.5
  // Market c1 resolves with winner=tok1 → $1/share, bought at $0.5 → profit
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades, tradesByAddress: indexByAddr(trades),
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.ok(result.totalPnl > 0, `Expected positive PnL, got ${result.totalPnl}`);
  assert.ok(result.tradeCount >= 1);
});

test('backtester: losing trade → negative PnL', () => {
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades, tradesByAddress: indexByAddr(trades),
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1","tok2"]',
    }]]),
    resolutions: new Map([['c1', 'tok2']]),  // tok2 wins, not tok1
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.ok(result.totalPnl < 0, `Expected negative PnL, got ${result.totalPnl}`);
});

test('backtester: H7 filter skips trades on long-horizon markets', () => {
  const DAY = 86400;
  const dayTs = DAY;
  // Market endDate is 100 days from now — exceeds maxTtrDays=7
  const farEndDate = new Date((dayTs + 100 * DAY) * 1000).toISOString();
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades, tradesByAddress: indexByAddr(trades),
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: farEndDate,
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, maxTtrDays: 7, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.equal(result.tradeCount, 0);  // filtered out by H7
});

test('backtester: slippage + commission reduce PnL', () => {
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades, tradesByAddress: indexByAddr(trades),
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const noCosts = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  const withCosts = runBacktest(ds, {
    ...defaultConfig, topN: 1, leaderboardWindowDays: 1,
    slippagePct: 1, commissionPct: 2,
  }, DAY, DAY * 3);

  assert.ok(withCosts.totalPnl < noCosts.totalPnl,
    `Costs should reduce PnL: ${withCosts.totalPnl} vs ${noCosts.totalPnl}`);
});

test('backtester: returns equity curve with daily points', () => {
  const DAY = 86400;
  const result = runBacktest(
    { trades: [], tradesByAddress: new Map(), markets: new Map(), resolutions: new Map(), universe: ['0xA'] },
    defaultConfig, DAY, DAY * 5,
  );
  assert.ok(result.equityCurve.length >= 2); // at least start + end
  assert.equal(result.equityCurve[0]!.equity, 500); // initialCapital
});
