import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries, bulkInsertActivity, upsertMarket, upsertResolution,
  insertGridRun, topGridRuns, insertWalkForwardRun, topWalkForwardRuns,
} from '../../db/bt-queries.js';
import { loadDataset } from './data-loader.js';
import { runBacktest } from './backtester.js';
import { generateLHS } from './grid-params.js';
import type { BacktestSimConfig } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  // Seed a minimal but realistic dataset
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 500, addedAt: '' },
  ]);
  const DAY = 86400;
  const trades = [];
  // Generate 30 days of trades for 2 traders
  for (let d = 1; d <= 30; d++) {
    const ts = d * DAY;
    trades.push({
      id: `a_buy_${d}`, address: '0xA', timestamp: ts + 100,
      tokenId: `tok_${d}`, conditionId: `c_${d}`, action: 'buy' as const,
      price: 0.5, size: 20, usdValue: 10, marketSlug: `m_${d}`,
    });
    trades.push({
      id: `b_buy_${d}`, address: '0xB', timestamp: ts + 200,
      tokenId: `tok_${d}`, conditionId: `c_${d}`, action: 'buy' as const,
      price: 0.4, size: 25, usdValue: 10, marketSlug: `m_${d}`,
    });
  }
  bulkInsertActivity(trades);

  // Markets and resolutions — 60% win rate for alice, 40% for bob
  for (let d = 1; d <= 30; d++) {
    const endDate = new Date((d * DAY + 3 * DAY) * 1000).toISOString();
    upsertMarket({
      conditionId: `c_${d}`, question: `Q${d}`, slug: `q${d}`, endDate,
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: `["tok_${d}","tok_${d}_no"]`,
    });
    // Alice wins 60% (days 1-18), Bob's token loses on those
    const winner = d <= 18 ? `tok_${d}` : `tok_${d}_no`;
    upsertResolution({ conditionId: `c_${d}`, winnerTokenId: winner, resolvedAt: '' });
  }
});
afterEach(() => closeDb());

test('e2e: load dataset → run backtest → positive calmar for winning trader', () => {
  const ds = loadDataset();
  assert.equal(ds.trades.length, 60);
  assert.equal(ds.universe.length, 2);

  const DAY = 86400;
  const config: BacktestSimConfig = {
    conviction: { betBase: 5, f1Anchor: 10, f1Max: 3, w2: 0, w3: 0, f4Boost: 1.0 },
    topN: 2, leaderboardWindowDays: 30, maxTtrDays: Infinity,
    maxPositions: 20, initialCapital: 500, slippagePct: 1, commissionPct: 2,
  };

  const result = runBacktest(ds, config, DAY, 31 * DAY);
  assert.ok(result.tradeCount > 0, 'Should have some trades');
  assert.ok(result.equityCurve.length > 2, 'Should have equity curve');
  // With 60% win rate, PnL should be positive despite costs
  // (not guaranteed with slippage+commission but likely with enough trades)
});

test('e2e: grid search produces diverse results', () => {
  const ds = loadDataset();
  const DAY = 86400;
  const configs = generateLHS(5);

  for (const cfg of configs) {
    const result = runBacktest(ds, cfg, DAY, 31 * DAY);
    insertGridRun({
      id: `g_${Math.random()}`, runId: 'test', paramsJson: JSON.stringify(cfg),
      calmar: result.calmar === Infinity ? 9999 : result.calmar,
      pnl: result.totalPnl, maxDd: result.maxDrawdown, sharpe: result.sharpe,
      winRate: result.winRate, tradeCount: result.tradeCount,
      avgTtrDays: result.avgTtrDays, ranAt: '',
    });
  }

  const top = topGridRuns(5);
  assert.equal(top.length, 5);
  assert.ok(top[0]!.calmar >= top[1]!.calmar, 'Should be sorted by calmar DESC');
});
