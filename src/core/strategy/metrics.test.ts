import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calmar, sharpe, winRate } from './metrics.js';

test('calmar: positive pnl / drawdown', () => {
  assert.equal(calmar(100, 40), 2.5);
});

test('calmar: zero drawdown returns Infinity', () => {
  assert.equal(calmar(100, 0), Infinity);
});

test('calmar: negative pnl', () => {
  assert.ok(calmar(-50, 60) < 0);
});

test('sharpe: flat returns = 0', () => {
  const eq = [100, 100, 100, 100, 100];
  assert.equal(sharpe(eq), 0);
});

test('sharpe: steadily increasing = high', () => {
  const eq = [100, 101, 102, 103, 104, 105];
  assert.ok(sharpe(eq) > 5);
});

test('sharpe: volatile = lower than steady', () => {
  const steady = [100, 101, 102, 103, 104, 105];
  const volatile = [100, 110, 95, 115, 90, 105];
  assert.ok(sharpe(steady) > sharpe(volatile));
});

test('winRate: 3 wins out of 5', () => {
  assert.equal(winRate(3, 5), 0.6);
});

test('winRate: 0 trades = 0', () => {
  assert.equal(winRate(0, 0), 0);
});
