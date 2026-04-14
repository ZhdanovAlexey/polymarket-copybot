import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  bulkInsertActivity,
  getMarket,
  getResolution,
  conditionIdsMissingFromMarkets,
} from '../../db/bt-queries.js';
import { collectMarkets } from './markets.js';
import type { ClobMarketRaw } from './markets.js';

beforeEach(() => {
  initDb(':memory:');
  bulkInsertActivity([
    { id: 't1', address: '0xA', timestamp: 100, tokenId: 'tA', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: 'm1' },
    { id: 't2', address: '0xA', timestamp: 200, tokenId: 'tB', conditionId: 'c2',
      action: 'sell', price: 0.5, size: 1, usdValue: 0.5, marketSlug: 'm2' },
  ]);
});
afterEach(() => closeDb());

function fakeClobMarket(conditionId: string, overrides: Partial<ClobMarketRaw> = {}): ClobMarketRaw {
  return {
    condition_id: conditionId,
    question: 'Question for ' + conditionId,
    market_slug: 'slug-' + conditionId,
    end_date_iso: '2026-05-01T00:00:00Z',
    closed: false,
    neg_risk: false,
    tokens: [
      { token_id: 'tA', outcome: 'Yes', winner: false },
      { token_id: 'tB', outcome: 'No', winner: false },
    ],
    ...overrides,
  };
}

test('collectMarkets: fetches only missing conditionIds', async () => {
  const fetched: string[] = [];
  const stubFetch = async (cid: string): Promise<ClobMarketRaw | null> => {
    fetched.push(cid);
    return fakeClobMarket(cid);
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
  const stubFetch = async (cid: string): Promise<ClobMarketRaw | null> => {
    return fakeClobMarket(cid, { closed: true, end_date_iso: '2026-04-01T00:00:00Z' });
  };
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  const m = getMarket('c1');
  assert.ok(m);
  assert.equal(m!.closed, 1);
  assert.equal(m!.endDate, '2026-04-01T00:00:00Z');
});

test('collectMarkets: writes resolution for closed market with winner', async () => {
  const stubFetch = async (cid: string): Promise<ClobMarketRaw | null> => {
    return fakeClobMarket(cid, {
      closed: true,
      tokens: [
        { token_id: 'tA', outcome: 'Yes', winner: true },
        { token_id: 'tB', outcome: 'No', winner: false },
      ],
    });
  };
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  const r = getResolution('c1');
  assert.ok(r);
  assert.equal(r!.winnerTokenId, 'tA');
});

test('collectMarkets: does NOT write resolution for open market', async () => {
  const stubFetch = async (cid: string): Promise<ClobMarketRaw | null> => {
    return fakeClobMarket(cid, { closed: false });
  };
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  assert.equal(getResolution('c1'), null);
});

test('collectMarkets: skips null response (market not found)', async () => {
  const stubFetch = async (): Promise<ClobMarketRaw | null> => null;
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  assert.equal(getMarket('c1'), null);
  assert.equal(getMarket('c2'), null);
});
