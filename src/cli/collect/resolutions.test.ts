import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertMarket,
  getResolution,
  closedConditionIdsMissingResolution,
} from '../../db/bt-queries.js';
import { collectResolutions } from './resolutions.js';

beforeEach(() => {
  initDb(':memory:');
  upsertMarket({
    conditionId: 'cClosed1', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tA","tB"]',
  });
  upsertMarket({
    conditionId: 'cClosed2', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tX","tY"]',
  });
  upsertMarket({
    conditionId: 'cOpen', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 0, tokenIds: '[]',
  });
});
afterEach(() => closeDb());

test('collectResolutions: fetches only closed markets without resolution', async () => {
  const requested: string[] = [];
  const stub = async (cid: string) => {
    requested.push(cid);
    return { closed: true, winnerTokenId: cid === 'cClosed1' ? 'tA' : 'tX' };
  };

  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });

  assert.deepEqual(requested.sort(), ['cClosed1', 'cClosed2']);
  assert.equal(getResolution('cClosed1')!.winnerTokenId, 'tA');
  assert.equal(getResolution('cClosed2')!.winnerTokenId, 'tX');
  assert.equal(getResolution('cOpen'), null);
});

test('collectResolutions: idempotent (second run fetches nothing)', async () => {
  const stub = async (cid: string) => ({ closed: true, winnerTokenId: 'tA' });
  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });
  assert.deepEqual(closedConditionIdsMissingResolution(), []);

  const secondRun: string[] = [];
  const stub2 = async (cid: string) => {
    secondRun.push(cid);
    return { closed: true, winnerTokenId: 'tA' };
  };
  await collectResolutions({ fetchResolution: stub2, ratePauseMs: 0 });
  assert.deepEqual(secondRun, []);
});

test('collectResolutions: stores winnerTokenId=null if no winner declared', async () => {
  const stub = async () => ({ closed: true, winnerTokenId: null });
  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });
  const r = getResolution('cClosed1');
  assert.ok(r);
  assert.equal(r!.winnerTokenId, null);
});
