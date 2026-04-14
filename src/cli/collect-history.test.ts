import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './collect-history.js';

test('parseArgs: defaults when no flags', () => {
  const opts = parseArgs([]);
  assert.equal(opts.universeSize, 300);
  assert.equal(opts.historyDays, 365);
  assert.equal(opts.ratePauseMs, 250);
  assert.equal(opts.maxTradesPerTrader, 10000);
  assert.deepEqual(opts.phases, ['universe', 'activity', 'markets', 'resolutions']);
});

test('parseArgs: --max-trades overrides maxTradesPerTrader', () => {
  const opts = parseArgs(['--max-trades=5000']);
  assert.equal(opts.maxTradesPerTrader, 5000);
});

test('parseArgs: --size overrides universeSize', () => {
  const opts = parseArgs(['--size=50']);
  assert.equal(opts.universeSize, 50);
});

test('parseArgs: --days overrides historyDays', () => {
  const opts = parseArgs(['--days=90']);
  assert.equal(opts.historyDays, 90);
});

test('parseArgs: --phase=activity runs only that phase', () => {
  const opts = parseArgs(['--phase=activity']);
  assert.deepEqual(opts.phases, ['activity']);
});

test('parseArgs: --phase=universe,markets runs subset', () => {
  const opts = parseArgs(['--phase=universe,markets']);
  assert.deepEqual(opts.phases, ['universe', 'markets']);
});

test('parseArgs: throws on unknown phase', () => {
  assert.throws(() => parseArgs(['--phase=bogus']), /unknown phase/);
});
