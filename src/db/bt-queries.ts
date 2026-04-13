import { getDb } from './database.js';
import type {
  BtUniverseEntry,
  BtTradeActivity,
  BtMarket,
  BtMarketResolution,
} from '../types.js';

// ============================================================
// bt_universe
// ============================================================

export function upsertUniverseEntries(entries: BtUniverseEntry[]): void {
  if (entries.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT INTO bt_universe (address, name, volume_12m)
     VALUES (@address, @name, @volume12m)
     ON CONFLICT(address) DO UPDATE SET
       name = excluded.name,
       volume_12m = excluded.volume_12m`,
  );
  const tx = getDb().transaction((rows: BtUniverseEntry[]) => {
    for (const r of rows) {
      stmt.run({ address: r.address, name: r.name, volume12m: r.volume12m });
    }
  });
  tx(entries);
}

export function listUniverse(): BtUniverseEntry[] {
  const rows = getDb()
    .prepare('SELECT address, name, volume_12m, added_at FROM bt_universe ORDER BY volume_12m DESC')
    .all() as Array<{ address: string; name: string; volume_12m: number; added_at: string }>;
  return rows.map((r) => ({
    address: r.address,
    name: r.name,
    volume12m: r.volume_12m,
    addedAt: r.added_at,
  }));
}

// ============================================================
// bt_trader_activity
// ============================================================

export function bulkInsertActivity(rows: BtTradeActivity[]): void {
  if (rows.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO bt_trader_activity
     (id, address, timestamp, token_id, condition_id, action, price, size, usd_value, market_slug)
     VALUES (@id, @address, @timestamp, @tokenId, @conditionId, @action, @price, @size, @usdValue, @marketSlug)`,
  );
  const tx = getDb().transaction((items: BtTradeActivity[]) => {
    for (const r of items) stmt.run(r);
  });
  tx(rows);
}

export function maxActivityTimestamp(address: string): number | null {
  const row = getDb()
    .prepare('SELECT MAX(timestamp) AS m FROM bt_trader_activity WHERE address = ?')
    .get(address) as { m: number | null };
  return row.m;
}

export function countActivityForAddress(address: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM bt_trader_activity WHERE address = ?')
    .get(address) as { c: number };
  return row.c;
}

export function distinctConditionIds(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT condition_id FROM bt_trader_activity')
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}
