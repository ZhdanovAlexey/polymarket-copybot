import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb, closeDb } from './database.js';

afterEach(() => closeDb());

test('initDb with :memory: path creates isolated db', () => {
  initDb(':memory:');
  const db = getDb();
  // memory db should have the settings table after migrations run
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
    .get();
  assert.ok(row, 'settings table not created');
});

test('initDb() without arg still opens default path', () => {
  // This just proves the default-path branch compiles + runs; we immediately close.
  initDb();
  const db = getDb();
  assert.ok(db, 'getDb returned nothing');
});
