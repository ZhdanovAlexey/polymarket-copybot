import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import { listUniverse } from '../../db/bt-queries.js';
import { collectUniverse } from './universe.js';
import type { LeaderboardEntry } from '../../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('collectUniverse: writes top-N by volume into bt_universe', async () => {
  const stubLeaderboard = async (
    _period?: string,
    _orderBy?: string,
    _limit?: number,
  ): Promise<LeaderboardEntry[]> => [
    { address: '0xA', name: 'alice', profileImage: undefined, pnl: 100, volume: 10000, markets_traded: 5, positions_value: 0, rank: 1 },
    { address: '0xB', name: 'bob',   profileImage: undefined, pnl: 200, volume: 5000,  markets_traded: 3, positions_value: 0, rank: 2 },
    { address: '0xC', name: '',      profileImage: undefined, pnl: 50,  volume: 0,     markets_traded: 1, positions_value: 0, rank: 3 },
  ];

  await collectUniverse({ fetchLeaderboard: stubLeaderboard, size: 3 });

  const loaded = listUniverse();
  assert.equal(loaded.length, 3);
  // sorted DESC by volume
  assert.equal(loaded[0]!.address, '0xA');
  assert.equal(loaded[1]!.address, '0xB');
  assert.equal(loaded[2]!.address, '0xC');
});

test('collectUniverse: requests correct leaderboard params', async () => {
  let capturedArgs: unknown[] = [];
  const stubLeaderboard = async (...args: unknown[]): Promise<LeaderboardEntry[]> => {
    capturedArgs = args;
    return [];
  };
  await collectUniverse({ fetchLeaderboard: stubLeaderboard, size: 300 });
  assert.deepEqual(capturedArgs, ['ALL_TIME', 'volume', 300]);
});
