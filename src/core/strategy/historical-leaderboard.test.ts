import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTraderAtTime, pickTopN } from './historical-leaderboard.js';
import type { BtTradeActivity, BtDataset, BtMarket } from '../../types.js';

function makeTrade(overrides: Partial<BtTradeActivity>): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
    ...overrides,
  };
}

function makeDataset(trades: BtTradeActivity[]): BtDataset {
  return {
    trades,
    markets: new Map(),
    resolutions: new Map([['c1', 'tok1'], ['c2', null]]),
    universe: [...new Set(trades.map((t) => t.address))],
  };
}

test('scoreTraderAtTime: uses only trades before T in window', () => {
  const trades = [
    makeTrade({ address: '0xA', timestamp: 50, usdValue: 100, conditionId: 'c1', tokenId: 'tok1', action: 'buy' }),
    makeTrade({ address: '0xA', timestamp: 80, usdValue: 50, conditionId: 'c1', tokenId: 'tok1', action: 'sell' }),
    makeTrade({ address: '0xA', timestamp: 150, usdValue: 200, conditionId: 'c2', action: 'buy' }), // after T=100
  ];
  const ds = makeDataset(trades);
  const result = scoreTraderAtTime('0xA', ds, 100, 60); // T=100, window=60 → [40, 100)
  // Only trades at ts=50 and ts=80 are in window [40, 100)
  assert.equal(result.tradesCount, 2);
  assert.ok(result.pnl !== undefined);
  assert.ok(result.score > 0);
});

test('scoreTraderAtTime: returns zero score for trader with no trades in window', () => {
  const ds = makeDataset([makeTrade({ address: '0xA', timestamp: 10 })]);
  const result = scoreTraderAtTime('0xA', ds, 100, 30); // window [70, 100) — trade at 10 is outside
  assert.equal(result.tradesCount, 0);
  assert.equal(result.score, 0);
});

test('pickTopN: returns top-N by score descending', () => {
  const trades = [
    // 0xA: 2 winning buys — higher PnL
    makeTrade({ id: 'a1', address: '0xA', timestamp: 50, usdValue: 100, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a2', address: '0xA', timestamp: 60, usdValue: 50, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    // 0xB: 1 losing buy — lower PnL
    makeTrade({ id: 'b1', address: '0xB', timestamp: 55, usdValue: 30, action: 'buy', tokenId: 'tok2', conditionId: 'c2' }),
  ];
  const ds = makeDataset(trades);
  const top = pickTopN(ds, 100, 60, 1); // top 1
  assert.equal(top.length, 1);
  assert.equal(top[0]!.address, '0xA'); // higher score
});
