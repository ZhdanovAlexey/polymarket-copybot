import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  bulkInsertActivity,
  getMarket,
  conditionIdsMissingFromMarkets,
} from '../../db/bt-queries.js';
import { collectMarkets } from './markets.js';
import type { GammaMarket } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  // Seed activity so markets collector has condition_ids to chase
  bulkInsertActivity([
    {
      id: 't1',
      address: '0xA',
      timestamp: 100,
      tokenId: 'tA',
      conditionId: 'c1',
      action: 'buy',
      price: 0.5,
      size: 1,
      usdValue: 0.5,
      marketSlug: 'm1',
    },
    {
      id: 't2',
      address: '0xA',
      timestamp: 200,
      tokenId: 'tB',
      conditionId: 'c2',
      action: 'sell',
      price: 0.5,
      size: 1,
      usdValue: 0.5,
      marketSlug: 'm2',
    },
  ]);
});
afterEach(() => closeDb());

function fakeMarket(conditionId: string, overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'id-' + conditionId,
    question: 'Question for ' + conditionId,
    slug: 'slug-' + conditionId,
    conditionId,
    tokens: [
      { token_id: 'tA', outcome: 'Yes', price: 0.5 },
      { token_id: 'tB', outcome: 'No', price: 0.5 },
    ],
    orderPriceMinTickSize: 0.01,
    negRisk: false,
    active: true,
    closed: false,
    volume: 100,
    liquidity: 50,
    endDate: '2026-05-01',
    ...overrides,
  };
}

test('collectMarkets: fetches only missing conditionIds', async () => {
  const fetched: string[] = [];
  const stubFetch = async (cid: string): Promise<GammaMarket | null> => {
    fetched.push(cid);
    return fakeMarket(cid);
  };

  assert.deepEqual(conditionIdsMissingFromMarkets().sort(), ['c1', 'c2']);

  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });

  assert.deepEqual(fetched.sort(), ['c1', 'c2']);
  assert.ok(getMarket('c1'));
  assert.ok(getMarket('c2'));

  // Second run: nothing to fetch.
  fetched.length = 0;
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  assert.deepEqual(fetched, []);
});

test('collectMarkets: persists endDate and closed flag', async () => {
  const stubFetch = async (cid: string): Promise<GammaMarket | null> => {
    return fakeMarket(cid, { closed: true, endDate: '2026-04-01T00:00:00Z' });
  };
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  const m = getMarket('c1');
  assert.ok(m);
  assert.equal(m!.closed, 1);
  assert.equal(m!.endDate, '2026-04-01T00:00:00Z');
});

test('collectMarkets: skips null response (market not found in Gamma)', async () => {
  const stubFetch = async (): Promise<GammaMarket | null> => null;
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  // c1, c2 still missing since Gamma returned null
  assert.equal(getMarket('c1'), null);
  assert.equal(getMarket('c2'), null);
});
