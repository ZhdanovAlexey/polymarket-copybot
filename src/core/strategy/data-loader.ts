import { getDb } from '../../db/database.js';
import { createLogger } from '../../utils/logger.js';
import type { BtTradeActivity, BtMarket, BtDataset } from '../../types.js';

const log = createLogger('data-loader');

/**
 * Load all Stage E data into memory for pure-function backtesting.
 * Called once before grid search; data is ~30-40 MB for 260k trades.
 */
export function loadDataset(): BtDataset {
  const db = getDb();

  // Trades — sorted by timestamp ASC (critical for day-by-day iteration)
  const rawTrades = db
    .prepare('SELECT * FROM bt_trader_activity ORDER BY timestamp ASC')
    .all() as Array<Record<string, unknown>>;
  const trades: BtTradeActivity[] = rawTrades.map((r) => ({
    id: String(r.id),
    address: String(r.address),
    timestamp: Number(r.timestamp),
    tokenId: String(r.token_id),
    conditionId: String(r.condition_id),
    action: String(r.action) as 'buy' | 'sell',
    price: Number(r.price),
    size: Number(r.size),
    usdValue: Number(r.usd_value),
    marketSlug: String(r.market_slug ?? ''),
  }));

  // Markets — keyed by conditionId
  const rawMarkets = db.prepare('SELECT * FROM bt_markets').all() as Array<Record<string, unknown>>;
  const markets = new Map<string, BtMarket>();
  for (const r of rawMarkets) {
    markets.set(String(r.condition_id), {
      conditionId: String(r.condition_id),
      question: String(r.question ?? ''),
      slug: String(r.slug ?? ''),
      endDate: r.end_date ? String(r.end_date) : null,
      volume: Number(r.volume ?? 0),
      liquidity: Number(r.liquidity ?? 0),
      negRisk: Number(r.neg_risk ?? 0),
      closed: Number(r.closed ?? 0),
      tokenIds: String(r.token_ids ?? '[]'),
    });
  }

  // Resolutions — map conditionId → winnerTokenId
  const rawRes = db.prepare('SELECT condition_id, winner_token_id FROM bt_market_resolutions').all() as Array<Record<string, unknown>>;
  const resolutions = new Map<string, string | null>();
  for (const r of rawRes) {
    resolutions.set(String(r.condition_id), r.winner_token_id ? String(r.winner_token_id) : null);
  }

  // Universe — just addresses
  const rawUni = db.prepare('SELECT address FROM bt_universe').all() as Array<{ address: string }>;
  const universe = rawUni.map((r) => r.address);

  // Pre-index trades by address for O(1) lookup in scoreTraderAtTime
  const tradesByAddress = new Map<string, BtTradeActivity[]>();
  for (const t of trades) {
    const arr = tradesByAddress.get(t.address);
    if (arr) arr.push(t);
    else tradesByAddress.set(t.address, [t]);
  }

  log.info({
    trades: trades.length, traderCount: tradesByAddress.size,
    markets: markets.size, resolutions: resolutions.size, universe: universe.length,
  }, 'Dataset loaded into memory');

  return { trades, tradesByAddress, markets, resolutions, universe };
}
