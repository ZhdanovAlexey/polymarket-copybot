import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClobClientWrapper } from './clob-client.js';

test('getMarketResolution: closed with winner token', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: true,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 1.0, winner: true },
      { token_id: 'tokB', outcome: 'No', price: 0.0, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => raw,
    text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, true);
    assert.equal(res.winnerTokenId, 'tokA');
  } finally {
    global.fetch = orig;
  }
});

test('getMarketResolution: closed with no winner declared', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: true,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 0.5, winner: false },
      { token_id: 'tokB', outcome: 'No', price: 0.5, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => raw,
    text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, true);
    assert.equal(res.winnerTokenId, null);
  } finally {
    global.fetch = orig;
  }
});

test('getMarketResolution: still open returns closed=false', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: false,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 0.6, winner: false },
      { token_id: 'tokB', outcome: 'No', price: 0.4, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    json: async () => raw,
    text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, false);
    assert.equal(res.winnerTokenId, null);
  } finally {
    global.fetch = orig;
  }
});
