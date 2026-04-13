import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GammaApi } from './gamma-api.js';

test('GammaApi.getMarketByConditionId: endDate field extracted from raw response', async () => {
  // Minimal stub via global.fetch mock
  const raw = [{
    id: '1',
    question: 'Will X?',
    slug: 'will-x',
    conditionId: '0xCOND',
    tokens: [],
    orderPriceMinTickSize: 0.01,
    negRisk: false,
    active: true,
    closed: false,
    volume: 1000,
    liquidity: 500,
    endDate: '2026-05-01T00:00:00Z',
  }];

  const originalFetch = global.fetch;
  // @ts-ignore — minimal mock just for this test
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => raw,
    text: async () => JSON.stringify(raw),
  });

  try {
    const api = new GammaApi('http://stub.test');
    const market = await api.getMarketByConditionId('0xCOND');
    assert.ok(market);
    assert.equal(market!.endDate, '2026-05-01T00:00:00Z');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GammaApi.getMarket: endDate field extracted from raw response', async () => {
  const raw = [{
    id: '2',
    question: 'Will Y?',
    slug: 'will-y',
    conditionId: '0xCOND2',
    tokens: [],
    orderPriceMinTickSize: 0.01,
    negRisk: false,
    active: true,
    closed: false,
    volume: 2000,
    liquidity: 1000,
    endDate: '2026-06-15T12:30:00Z',
  }];

  const originalFetch = global.fetch;
  // @ts-ignore — minimal mock just for this test
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => raw,
    text: async () => JSON.stringify(raw),
  });

  try {
    const api = new GammaApi('http://stub.test');
    const market = await api.getMarket('will-y');
    assert.ok(market);
    assert.equal(market!.endDate, '2026-06-15T12:30:00Z');
  } finally {
    global.fetch = originalFetch;
  }
});
