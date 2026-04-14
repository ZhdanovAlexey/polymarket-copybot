import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../db/database.js';
import { collectUniverse } from './collect/universe.js';
import { collectActivity } from './collect/activity.js';
import { collectMarkets } from './collect/markets.js';
import { collectResolutions } from './collect/resolutions.js';
import type { ActivityEntry, GammaMarket, LeaderboardEntry } from '../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('end-to-end: 2 traders → 3 trades → 2 markets → 1 resolution', async () => {
  const stubLb = async (): Promise<LeaderboardEntry[]> => [
    { address: '0xA', name: 'alice', profileImage: undefined, pnl: 0, volume: 1000, markets_traded: 2, positions_value: 0, rank: 1 },
    { address: '0xB', name: 'bob', profileImage: undefined, pnl: 0, volume: 500, markets_traded: 1, positions_value: 0, rank: 2 },
  ];

  const activityMap: Record<string, ActivityEntry[]> = {
    '0xA': [
      { id: 'a1', timestamp: 100, address: '0xA', type: 'TRADE', action: 'buy',
        market_slug: 'm1', title: '', description: '', token_id: 'tA1', condition_id: 'c1',
        outcome: 'Yes', size: 10, price: 0.5, usd_value: 5, transaction_hash: '' },
      { id: 'a2', timestamp: 200, address: '0xA', type: 'TRADE', action: 'sell',
        market_slug: 'm1', title: '', description: '', token_id: 'tA1', condition_id: 'c1',
        outcome: 'Yes', size: 8, price: 0.7, usd_value: 5.6, transaction_hash: '' },
    ],
    '0xB': [
      { id: 'b1', timestamp: 150, address: '0xB', type: 'TRADE', action: 'buy',
        market_slug: 'm2', title: '', description: '', token_id: 'tB1', condition_id: 'c2',
        outcome: 'Yes', size: 5, price: 0.4, usd_value: 2, transaction_hash: '' },
    ],
  };
  const stubActivity = async (addr: string): Promise<ActivityEntry[]> =>
    activityMap[addr] ?? [];

  const marketsMap: Record<string, GammaMarket> = {
    c1: {
      id: 'id1', question: 'Q1', slug: 'q1', conditionId: 'c1',
      tokens: [{ token_id: 'tA1', outcome: 'Yes', price: 0.5 }],
      orderPriceMinTickSize: 0.01, negRisk: false, active: false, closed: true,
      volume: 100, liquidity: 50, endDate: '2026-03-01',
    },
    c2: {
      id: 'id2', question: 'Q2', slug: 'q2', conditionId: 'c2',
      tokens: [{ token_id: 'tB1', outcome: 'Yes', price: 0.5 }],
      orderPriceMinTickSize: 0.01, negRisk: false, active: true, closed: false,
      volume: 200, liquidity: 75, endDate: '2027-01-01',
    },
  };
  const stubGamma = async (cid: string): Promise<GammaMarket | null> =>
    marketsMap[cid] ?? null;

  const stubClob = async (cid: string) => ({
    closed: true,
    winnerTokenId: cid === 'c1' ? 'tA1' : null,
  });

  await collectUniverse({ fetchLeaderboard: stubLb, size: 2 });
  await collectActivity({ fetchActivity: stubActivity, historyStartTs: 0, pageLimit: 500, ratePauseMs: 0, maxTradesPerTrader: 0 });
  await collectMarkets({ fetchMarket: stubGamma, ratePauseMs: 0 });
  await collectResolutions({ fetchResolution: stubClob, ratePauseMs: 0 });

  // Sanity: counts
  const counts = (table: string) =>
    (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  assert.equal(counts('bt_universe'), 2);
  assert.equal(counts('bt_trader_activity'), 3);
  assert.equal(counts('bt_markets'), 2);
  assert.equal(counts('bt_market_resolutions'), 1);

  // Sanity: end_date persisted and queryable
  const m1 = getDb().prepare('SELECT end_date, closed FROM bt_markets WHERE condition_id = ?').get('c1') as { end_date: string; closed: number };
  assert.equal(m1.end_date, '2026-03-01');
  assert.equal(m1.closed, 1);

  // Sanity: the open market did not get a resolution row
  const r2 = getDb().prepare('SELECT * FROM bt_market_resolutions WHERE condition_id = ?').get('c2');
  assert.equal(r2, undefined);
});
