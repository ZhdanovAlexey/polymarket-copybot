import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb, closeDb } from './database.js';
import {
  getInvestedByTrader, upsertPosition, upsertTrader, insertTrade,
  getTotalInvestedByExitOnlyTraders, getActiveTraderCount, setPositionPrice, setExitOnly,
} from './queries.js';
import type { TrackedTrader, TradeResult, BotPosition } from '../types.js';

afterEach(() => closeDb());

function mkTrader(address: string, name: string): TrackedTrader {
  return {
    address, name, pnl: 0, volume: 0, winRate: 0, score: 0, tradesCount: 0,
    lastSeenTimestamp: 0, addedAt: '2026-01-01', active: true, exitOnly: false,
    probation: false, probationTradesLeft: 0,
  };
}

function mkTrade(overrides: Partial<TradeResult>): TradeResult {
  return {
    id: overrides.id ?? 't1',
    timestamp: '2026-04-15T00:00:00Z',
    traderAddress: '0xA',
    traderName: 'A',
    side: 'BUY',
    marketSlug: 'm', marketTitle: 'M',
    conditionId: 'c1', tokenId: 'tok1',
    outcome: 'Yes',
    size: 10, price: 0.5, totalUsd: 5,
    status: 'simulated', isDryRun: true,
    originalTraderSize: 10, originalTraderPrice: 0.5,
    commission: 0,
    ...overrides,
  };
}

function mkPosition(overrides: Partial<BotPosition>): BotPosition {
  return {
    id: 0,
    tokenId: 'tok1', conditionId: 'c1',
    marketSlug: 'm', marketTitle: 'M',
    outcome: 'Yes',
    totalShares: 20, avgPrice: 0.5, totalInvested: 10,
    openedAt: '2026-04-15T00:00:00Z',
    status: 'open',
    ...overrides,
  };
}

test('getInvestedByTrader: single trader gets full position', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 20, totalUsd: 10 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  assert.equal(getInvestedByTrader('0xA'), 10);
});

test('getInvestedByTrader: two traders share position proportionally', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  upsertTrader(mkTrader('0xB', 'B'));
  // A bought 5 shares, B bought 15 shares → total 20 shares, $10 invested
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', traderName: 'A', size: 5, totalUsd: 2.5 }));
  insertTrade(mkTrade({ id: 'b1', traderAddress: '0xB', traderName: 'B', size: 15, totalUsd: 7.5 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  // A's share: 5/20 × $10 = $2.50
  // B's share: 15/20 × $10 = $7.50
  assert.equal(getInvestedByTrader('0xA'), 2.5);
  assert.equal(getInvestedByTrader('0xB'), 7.5);
  // Sum = $10 (no double-counting)
  assert.equal(getInvestedByTrader('0xA') + getInvestedByTrader('0xB'), 10);
});

test('getInvestedByTrader: equal 50/50 split', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  upsertTrader(mkTrader('0xB', 'B'));
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', traderName: 'A', size: 10, totalUsd: 5 }));
  insertTrade(mkTrade({ id: 'b1', traderAddress: '0xB', traderName: 'B', size: 10, totalUsd: 5 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  assert.equal(getInvestedByTrader('0xA'), 5);
  assert.equal(getInvestedByTrader('0xB'), 5);
});

test('getInvestedByTrader: skipped trades are not counted', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  // One simulated BUY + one skipped (shouldn't count)
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 10, totalUsd: 5, status: 'simulated' }));
  insertTrade(mkTrade({ id: 'a2', traderAddress: '0xA', size: 100, totalUsd: 50, status: 'skipped' }));
  upsertPosition(mkPosition({ totalShares: 10, totalInvested: 5 }));

  assert.equal(getInvestedByTrader('0xA'), 5);
});

test('getInvestedByTrader: closed positions are not counted', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 10, totalUsd: 5 }));
  upsertPosition(mkPosition({ totalShares: 10, totalInvested: 5, status: 'closed' }));

  assert.equal(getInvestedByTrader('0xA'), 0);
});

test('getInvestedByTrader: trader with no positions returns 0', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  assert.equal(getInvestedByTrader('0xA'), 0);
});

test('getInvestedByTrader: uses mark-to-market when price is fresh', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 20, totalUsd: 10 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  // Without price: cost basis = $10
  assert.equal(getInvestedByTrader('0xA'), 10);

  // Set current price to $0.25 (position now worth 20 × 0.25 = $5)
  const now = Math.floor(Date.now() / 1000);
  setPositionPrice('tok1', 0.25, now);
  assert.equal(getInvestedByTrader('0xA'), 5); // MTM value used
});

test('getInvestedByTrader: falls back to cost basis when price is stale', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 20, totalUsd: 10 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  // Price update 10 minutes ago (stale, threshold is 5 min)
  const stale = Math.floor(Date.now() / 1000) - 600;
  setPositionPrice('tok1', 0.25, stale);
  assert.equal(getInvestedByTrader('0xA'), 10); // fallback to cost basis
});

test('getTotalInvestedByExitOnlyTraders: sums exit-only traders proportionally', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  upsertTrader(mkTrader('0xB', 'B'));
  // Both A and B bought 10 shares each, total 20 shares, $10 invested
  insertTrade(mkTrade({ id: 'a1', traderAddress: '0xA', size: 10, totalUsd: 5 }));
  insertTrade(mkTrade({ id: 'b1', traderAddress: '0xB', traderName: 'B', size: 10, totalUsd: 5 }));
  upsertPosition(mkPosition({ totalShares: 20, totalInvested: 10 }));

  // A is active, B is exit-only
  setExitOnly('0xB');

  // Only B's proportional share should count: 10/20 × $10 = $5
  assert.equal(getTotalInvestedByExitOnlyTraders(), 5);
});

test('getActiveTraderCount: counts only active=1 traders', () => {
  initDb(':memory:');
  upsertTrader(mkTrader('0xA', 'A'));
  upsertTrader(mkTrader('0xB', 'B'));
  upsertTrader(mkTrader('0xC', 'C'));
  setExitOnly('0xC');  // C becomes active=0, exit_only=1

  assert.equal(getActiveTraderCount(), 2);
});
