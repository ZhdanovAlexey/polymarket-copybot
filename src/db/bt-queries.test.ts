import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from './database.js';
import {
  upsertUniverseEntries,
  listUniverse,
  bulkInsertActivity,
  maxActivityTimestamp,
  countActivityForAddress,
} from './bt-queries.js';
import type { BtUniverseEntry, BtTradeActivity } from '../types.js';

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
