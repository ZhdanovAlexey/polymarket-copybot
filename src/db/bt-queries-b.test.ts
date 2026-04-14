import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from './database.js';
import {
  insertGridRun,
  topGridRuns,
  insertWalkForwardRun,
  topWalkForwardRuns,
} from './bt-queries.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('insertGridRun + topGridRuns: stores and retrieves by calmar DESC', () => {
  insertGridRun({
    id: 'g1', runId: 'run1', paramsJson: '{"topN":5}', calmar: 2.5,
    pnl: 100, maxDd: 40, sharpe: 1.2, winRate: 0.55, tradeCount: 50, avgTtrDays: 7, ranAt: '',
  });
  insertGridRun({
    id: 'g2', runId: 'run1', paramsJson: '{"topN":10}', calmar: 5.0,
    pnl: 200, maxDd: 40, sharpe: 1.8, winRate: 0.60, tradeCount: 80, avgTtrDays: 5, ranAt: '',
  });
  const top = topGridRuns(10);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.id, 'g2');  // higher calmar first
  assert.equal(top[0]!.calmar, 5.0);
});

test('insertWalkForwardRun + topWalkForwardRuns: by min_calmar DESC', () => {
  insertWalkForwardRun({
    id: 'w1', paramsJson: '{"topN":5}', medianCalmar: 3.0, minCalmar: 1.5,
    pctPositiveFolds: 100, foldsJson: '[]', ranAt: '',
  });
  insertWalkForwardRun({
    id: 'w2', paramsJson: '{"topN":10}', medianCalmar: 2.0, minCalmar: 2.0,
    pctPositiveFolds: 83, foldsJson: '[]', ranAt: '',
  });
  const top = topWalkForwardRuns(10);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.id, 'w2');  // higher min_calmar first
});
