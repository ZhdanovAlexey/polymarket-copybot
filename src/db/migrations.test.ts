import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb, closeDb } from './database.js';

afterEach(() => closeDb());

function tables(): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexes(table: string): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

test('migration creates bt_universe', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_universe'));
});

test('migration creates bt_trader_activity with required indexes', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_trader_activity'));
  const idx = indexes('bt_trader_activity');
  assert.ok(idx.some((n) => n.includes('addr_ts')), 'expected addr_ts index');
  assert.ok(idx.some((n) => n.includes('token_ts')), 'expected token_ts index');
  assert.ok(idx.some((n) => n.includes('cond_ts')), 'expected cond_ts index');
});

test('migration creates bt_markets', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_markets'));
});

test('migration creates bt_market_resolutions', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_market_resolutions'));
});

test('running initDb twice is idempotent (no exception)', () => {
  initDb(':memory:');
  closeDb();
  initDb(':memory:');
  assert.ok(tables().includes('bt_universe'));
});
