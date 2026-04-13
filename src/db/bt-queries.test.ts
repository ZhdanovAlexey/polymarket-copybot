import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from './database.js';
import {
  upsertUniverseEntries,
  listUniverse,
  bulkInsertActivity,
  maxActivityTimestamp,
  countActivityForAddress,
  upsertMarket,
  getMarket,
  conditionIdsMissingFromMarkets,
  closedConditionIdsMissingResolution,
  upsertResolution,
  getResolution,
} from './bt-queries.js';
import type { BtUniverseEntry, BtTradeActivity, BtMarket, BtMarketResolution } from '../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('upsertUniverseEntries + listUniverse: roundtrip 2 entries', () => {
  const entries: BtUniverseEntry[] = [
    { address: '0xA', name: 'alice', volume12m: 10000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 5000, addedAt: '' },
  ];
  upsertUniverseEntries(entries);
  const loaded = listUniverse();
  assert.equal(loaded.length, 2);
  assert.ok(loaded.find((e) => e.address === '0xA' && e.volume12m === 10000));
});

test('upsertUniverseEntries: upsert updates volume on conflict', () => {
  upsertUniverseEntries([{ address: '0xA', name: 'alice', volume12m: 100, addedAt: '' }]);
  upsertUniverseEntries([{ address: '0xA', name: 'alice-new', volume12m: 200, addedAt: '' }]);
  const loaded = listUniverse();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.volume12m, 200);
  assert.equal(loaded[0]!.name, 'alice-new');
});

test('bulkInsertActivity + countActivityForAddress + maxActivityTimestamp', () => {
  const rows: BtTradeActivity[] = [
    {
      id: 't1', address: '0xA', timestamp: 1000, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
    },
    {
      id: 't2', address: '0xA', timestamp: 2000, tokenId: 'tok2', conditionId: 'c2',
      action: 'sell', price: 0.6, size: 8, usdValue: 4.8, marketSlug: 's',
    },
    {
      id: 't3', address: '0xB', timestamp: 1500, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.55, size: 20, usdValue: 11, marketSlug: 's',
    },
  ];
  bulkInsertActivity(rows);
  assert.equal(countActivityForAddress('0xA'), 2);
  assert.equal(countActivityForAddress('0xB'), 1);
  assert.equal(maxActivityTimestamp('0xA'), 2000);
  assert.equal(maxActivityTimestamp('0xB'), 1500);
  assert.equal(maxActivityTimestamp('0xC'), null);
});

test('bulkInsertActivity: duplicate id ignored (INSERT OR IGNORE)', () => {
  const row: BtTradeActivity = {
    id: 't1', address: '0xA', timestamp: 1000, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: '',
  };
  bulkInsertActivity([row]);
  bulkInsertActivity([row]);  // should not throw
  assert.equal(countActivityForAddress('0xA'), 1);
});

test('upsertMarket + getMarket + conditionIdsMissingFromMarkets', () => {
  const m: BtMarket = {
    conditionId: 'c1', question: 'Will X?', slug: 'will-x',
    endDate: '2026-05-01', volume: 1000, liquidity: 500,
    negRisk: 0, closed: 1, tokenIds: '["tokA","tokB"]',
  };
  upsertMarket(m);
  const loaded = getMarket('c1');
  assert.ok(loaded);
  assert.equal(loaded!.question, 'Will X?');
  assert.equal(loaded!.closed, 1);

  // c2 is referenced in activity but not in bt_markets
  bulkInsertActivity([{
    id: 'tX', address: '0xA', timestamp: 100, tokenId: 'tokC', conditionId: 'c2',
    action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: '',
  }]);
  const missing = conditionIdsMissingFromMarkets();
  assert.ok(missing.includes('c2'));
  assert.ok(!missing.includes('c1'), 'c1 already in bt_markets');
});

test('closedConditionIdsMissingResolution: closed=1 AND no resolution row', () => {
  upsertMarket({
    conditionId: 'cClosed', question: '', slug: '',
    endDate: null, volume: 0, liquidity: 0,
    negRisk: 0, closed: 1, tokenIds: '[]',
  });
  upsertMarket({
    conditionId: 'cOpen', question: '', slug: '',
    endDate: null, volume: 0, liquidity: 0,
    negRisk: 0, closed: 0, tokenIds: '[]',
  });
  const missing = closedConditionIdsMissingResolution();
  assert.ok(missing.includes('cClosed'));
  assert.ok(!missing.includes('cOpen'));

  upsertResolution({ conditionId: 'cClosed', winnerTokenId: 'tokA', resolvedAt: '' });
  const afterUpsert = closedConditionIdsMissingResolution();
  assert.ok(!afterUpsert.includes('cClosed'));

  const res = getResolution('cClosed');
  assert.ok(res);
  assert.equal(res!.winnerTokenId, 'tokA');
});
