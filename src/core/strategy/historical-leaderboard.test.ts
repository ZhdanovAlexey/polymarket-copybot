import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTraderAtTime, pickTopN } from './historical-leaderboard.js';
import type { BtTradeActivity, BtDataset } from '../../types.js';

const DAY = 86400;

function makeTrade(overrides: Partial<BtTradeActivity>): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 3 * DAY, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
    ...overrides,
  };
}

function buildTradesByAddress(trades: BtTradeActivity[]): Map<string, BtTradeActivity[]> {
  const m = new Map<string, BtTradeActivity[]>();
  for (const t of trades) {
    const arr = m.get(t.address);
    if (arr) arr.push(t); else m.set(t.address, [t]);
  }
  return m;
}

function makeDataset(trades: BtTradeActivity[]): BtDataset {
  return {
    trades,
    tradesByAddress: buildTradesByAddress(trades),
    markets: new Map(),
    resolutions: new Map([['c1', 'tok1'], ['c2', null], ['c3', 'tok3']]),
    universe: [...new Set(trades.map((t) => t.address))],
  };
}

test('scoreTraderAtTime: uses only trades before T in window', () => {
  const trades = [
    makeTrade({ id: 'a1', address: '0xA', timestamp: 2 * DAY, usdValue: 100, conditionId: 'c1', tokenId: 'tok1', action: 'buy' }),
    makeTrade({ id: 'a2', address: '0xA', timestamp: 4 * DAY, usdValue: 50, conditionId: 'c1', tokenId: 'tok1', action: 'sell' }),
    makeTrade({ id: 'a3', address: '0xA', timestamp: 8 * DAY, usdValue: 200, conditionId: 'c2', action: 'buy' }), // after T
  ];
  const ds = makeDataset(trades);
  // T = day 5, windowDays = 3 → window [2*DAY, 5*DAY)
  const result = scoreTraderAtTime('0xA', ds, 5 * DAY, 3);
  // Trades at day 2 and day 4 are in window, day 8 is after T
  assert.equal(result.tradesCount, 2);
  assert.ok(result.score > 0);
});

test('scoreTraderAtTime: returns zero score for trader with no trades in window', () => {
  const ds = makeDataset([makeTrade({ address: '0xA', timestamp: 1 * DAY })]);
  // T = day 10, windowDays = 2 → window [8*DAY, 10*DAY) — trade at day 1 is outside
  const result = scoreTraderAtTime('0xA', ds, 10 * DAY, 2);
  assert.equal(result.tradesCount, 0);
  assert.equal(result.score, 0);
});

test('pickTopN: returns top-N by score descending (legacy mode, requires >= 3 trades)', () => {
  const trades = [
    // 0xA: 4 winning buys on c1 (tok1 is winner) — high PnL
    makeTrade({ id: 'a1', address: '0xA', timestamp: 2 * DAY, usdValue: 100, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a2', address: '0xA', timestamp: 3 * DAY, usdValue: 50, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a3', address: '0xA', timestamp: 4 * DAY, usdValue: 80, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a4', address: '0xA', timestamp: 4 * DAY + 100, usdValue: 60, action: 'buy', tokenId: 'tok3', conditionId: 'c3' }),
    // 0xB: 3 losing buys on c2 (winner=null → loss)
    makeTrade({ id: 'b1', address: '0xB', timestamp: 2 * DAY, usdValue: 30, action: 'buy', tokenId: 'tok2', conditionId: 'c2' }),
    makeTrade({ id: 'b2', address: '0xB', timestamp: 3 * DAY, usdValue: 20, action: 'buy', tokenId: 'tok2', conditionId: 'c2' }),
    makeTrade({ id: 'b3', address: '0xB', timestamp: 4 * DAY, usdValue: 10, action: 'buy', tokenId: 'tok2', conditionId: 'c2' }),
  ];
  const ds = makeDataset(trades);
  // T = day 5, windowDays = 4 → window [1*DAY, 5*DAY) — all trades in range
  const top = pickTopN(ds, 5 * DAY, 4, 1, 3, true);
  assert.equal(top.length, 1);
  assert.equal(top[0]!.address, '0xA'); // higher score (winning trades)
});

test('pickTopN: excludes traders with fewer than 3 trades (legacy mode)', () => {
  const trades = [
    // 0xA: only 2 trades — should be excluded
    makeTrade({ id: 'a1', address: '0xA', timestamp: 2 * DAY, usdValue: 100, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a2', address: '0xA', timestamp: 3 * DAY, usdValue: 50, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    // 0xB: 3 trades — should be included
    makeTrade({ id: 'b1', address: '0xB', timestamp: 2 * DAY, usdValue: 30, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'b2', address: '0xB', timestamp: 3 * DAY, usdValue: 20, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'b3', address: '0xB', timestamp: 4 * DAY, usdValue: 10, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
  ];
  const ds = makeDataset(trades);
  const top = pickTopN(ds, 5 * DAY, 4, 10, 3, true);
  assert.equal(top.length, 1);
  assert.equal(top[0]!.address, '0xB');
});
