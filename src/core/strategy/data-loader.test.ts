import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries, bulkInsertActivity, upsertMarket, upsertResolution,
} from '../../db/bt-queries.js';
import { loadDataset } from './data-loader.js';

beforeEach(() => {
  initDb(':memory:');
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
  ]);
  bulkInsertActivity([
    { id: 't1', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 'm1' },
    { id: 't2', address: '0xA', timestamp: 200, tokenId: 'tok1', conditionId: 'c1',
      action: 'sell', price: 0.7, size: 8, usdValue: 5.6, marketSlug: 'm1' },
  ]);
  upsertMarket({
    conditionId: 'c1', question: 'Q1', slug: 'q1', endDate: '2026-05-01',
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1","tok2"]',
  });
  upsertResolution({ conditionId: 'c1', winnerTokenId: 'tok1', resolvedAt: '' });
});
afterEach(() => closeDb());

test('loadDataset: loads all tables into memory', () => {
  const ds = loadDataset();
  assert.equal(ds.trades.length, 2);
  assert.equal(ds.trades[0]!.timestamp, 100); // sorted ASC
  assert.equal(ds.universe.length, 1);
  assert.equal(ds.markets.size, 1);
  assert.ok(ds.markets.has('c1'));
  assert.equal(ds.resolutions.get('c1'), 'tok1');
  // tradesByAddress index
  assert.equal(ds.tradesByAddress.size, 1); // 1 trader
  assert.equal(ds.tradesByAddress.get('0xA')!.length, 2);
});

test('loadDataset: trades sorted by timestamp ASC', () => {
  const ds = loadDataset();
  for (let i = 1; i < ds.trades.length; i++) {
    assert.ok(ds.trades[i]!.timestamp >= ds.trades[i - 1]!.timestamp);
  }
});
