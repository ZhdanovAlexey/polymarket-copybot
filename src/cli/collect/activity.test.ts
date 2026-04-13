import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries,
  bulkInsertActivity,
  countActivityForAddress,
  maxActivityTimestamp,
} from '../../db/bt-queries.js';
import { collectActivity } from './activity.js';
import type { ActivityEntry } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 500, addedAt: '' },
  ]);
});
afterEach(() => closeDb());

function makeActivity(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'x', timestamp: 1000, address: '0xA', type: 'TRADE', action: 'buy',
    market_slug: 's', title: '', description: '', token_id: 'tok', condition_id: 'c',
    outcome: 'Yes', size: 10, price: 0.5, usd_value: 5, transaction_hash: '',
    ...overrides,
  };
}

test('collectActivity: single page, inserts rows', async () => {
  const calls: Array<{ address: string; start?: number }> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    calls.push({ address, start: opts?.start });
    if (address === '0xA') {
      return [
        makeActivity({ id: 'a1', timestamp: 100, action: 'buy' }),
        makeActivity({ id: 'a2', timestamp: 200, action: 'sell' }),
      ];
    }
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 2);
  assert.equal(countActivityForAddress('0xB'), 0);
});

test('collectActivity: paginates via seek when page is full', async () => {
  const starts: Array<number | undefined> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    starts.push(opts?.start);
    if (address !== '0xA') return [];
    const lim = opts?.limit ?? 500;
    // First call: full page (timestamps 100..104). Second call: one remaining (999). Third: empty.
    if (starts.length === 1) {
      return Array.from({ length: lim }, (_, i) =>
        makeActivity({ id: `a${i}`, timestamp: 100 + i }),
      );
    }
    if (starts.length === 2) {
      return [makeActivity({ id: 'alast', timestamp: 999 })];
    }
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 5,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 6);
  // second call's `start` should be 1 greater than the last ts of the first page
  assert.equal(starts[0], 0);
  assert.equal(starts[1], 105);  // 100 + 5 (page) - 1 + 1 = 105
});

test('collectActivity: resume uses maxActivityTimestamp when row exists', async () => {
  // Pre-seed DB with a row for 0xA at ts=500
  bulkInsertActivity([{
    id: 'old', address: '0xA', timestamp: 500, tokenId: 'tok', conditionId: 'c',
    action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: '',
  }]);
  assert.equal(maxActivityTimestamp('0xA'), 500);

  const seenStarts: Array<number | undefined> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    if (address === '0xA') seenStarts.push(opts?.start);
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(seenStarts[0], 501);  // resume from 500 + 1
});

test('collectActivity: skips non-TRADE or non-buy/sell actions', async () => {
  const stub = async (address: string): Promise<ActivityEntry[]> => {
    if (address !== '0xA') return [];
    return [
      makeActivity({ id: 'r1', type: 'REDEEM', action: 'redeem', timestamp: 100 }),
      makeActivity({ id: 't1', type: 'TRADE', action: 'buy', timestamp: 200 }),
      makeActivity({ id: 't2', type: 'TRADE', action: 'sell', timestamp: 300 }),
    ];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 2);
});
