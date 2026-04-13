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

// ============================================================
// bt_markets
// ============================================================

export function upsertMarket(m: BtMarket): void {
  getDb()
    .prepare(
      `INSERT INTO bt_markets
         (condition_id, question, slug, end_date, volume, liquidity, neg_risk, closed, token_ids)
       VALUES (@conditionId, @question, @slug, @endDate, @volume, @liquidity, @negRisk, @closed, @tokenIds)
       ON CONFLICT(condition_id) DO UPDATE SET
         question = excluded.question,
         slug = excluded.slug,
         end_date = excluded.end_date,
         volume = excluded.volume,
         liquidity = excluded.liquidity,
         neg_risk = excluded.neg_risk,
         closed = excluded.closed,
         token_ids = excluded.token_ids,
         fetched_at = CURRENT_TIMESTAMP`,
    )
    .run(m);
}

export function getMarket(conditionId: string): BtMarket | null {
  const row = getDb()
    .prepare(
      `SELECT condition_id, question, slug, end_date, volume, liquidity, neg_risk, closed, token_ids
       FROM bt_markets WHERE condition_id = ?`,
    )
    .get(conditionId) as
    | {
        condition_id: string;
        question: string;
        slug: string;
        end_date: string | null;
        volume: number;
        liquidity: number;
        neg_risk: number;
        closed: number;
        token_ids: string;
      }
    | undefined;
  if (!row) return null;
  return {
    conditionId: row.condition_id,
    question: row.question,
    slug: row.slug,
    endDate: row.end_date,
    volume: row.volume,
    liquidity: row.liquidity,
    negRisk: row.neg_risk,
    closed: row.closed,
    tokenIds: row.token_ids,
  };
}

export function conditionIdsMissingFromMarkets(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT a.condition_id
       FROM bt_trader_activity a
       LEFT JOIN bt_markets m ON m.condition_id = a.condition_id
       WHERE m.condition_id IS NULL`,
    )
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}

// ============================================================
// bt_market_resolutions
// ============================================================

export function upsertResolution(r: BtMarketResolution): void {
  getDb()
    .prepare(
      `INSERT INTO bt_market_resolutions (condition_id, winner_token_id)
       VALUES (@conditionId, @winnerTokenId)
       ON CONFLICT(condition_id) DO UPDATE SET
         winner_token_id = excluded.winner_token_id,
         resolved_at = CURRENT_TIMESTAMP`,
    )
    .run({ conditionId: r.conditionId, winnerTokenId: r.winnerTokenId });
}

export function getResolution(conditionId: string): BtMarketResolution | null {
  const row = getDb()
    .prepare(
      `SELECT condition_id, winner_token_id, resolved_at
       FROM bt_market_resolutions WHERE condition_id = ?`,
    )
    .get(conditionId) as
    | { condition_id: string; winner_token_id: string | null; resolved_at: string }
    | undefined;
  if (!row) return null;
  return {
    conditionId: row.condition_id,
    winnerTokenId: row.winner_token_id,
    resolvedAt: row.resolved_at,
  };
}

export function closedConditionIdsMissingResolution(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT m.condition_id
       FROM bt_markets m
       LEFT JOIN bt_market_resolutions r ON r.condition_id = m.condition_id
       WHERE m.closed = 1 AND r.condition_id IS NULL`,
    )
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}
