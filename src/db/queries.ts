import { getDb } from './database.js';
import type {
  TrackedTrader,
  TradeResult,
  BotPosition,
  PnlSnapshot,
  TraderPerformance,
  RotationEvent,
  BacktestResult,
  BacktestConfig,
  AnomalyAlert,
} from '../types.js';

// ============================================================
// Settings
// ============================================================

export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
    )
    .run(key, value);
}

// ============================================================
// Demo Account
// ============================================================

export function getDemoBalance(): number {
  const val = getSetting('demo_balance');
  return val !== undefined ? parseFloat(val) : 0;
}

export function setDemoBalance(amount: number): void {
  setSetting('demo_balance', String(amount));
}

export function getDemoTotalCommission(): number {
  const val = getSetting('demo_total_commission');
  return val !== undefined ? parseFloat(val) : 0;
}

export function resetDemoAccount(initialBalance: number): void {
  const db = getDb();
  db.transaction(() => {
    setSetting('demo_balance', String(initialBalance));
    setSetting('demo_initial_balance', String(initialBalance));
    setSetting('demo_total_commission', '0');
    db.prepare('DELETE FROM trades WHERE is_dry_run = 1').run();
    db.prepare("DELETE FROM positions WHERE status = 'open'").run();
    db.prepare('DELETE FROM pnl_snapshots').run();
  })();
}

// ============================================================
// Tracked Traders
// ============================================================

export function upsertTrader(trader: TrackedTrader): void {
  // Note: on upsert we reset `exit_only = 0` — if a previously-removed trader
  // re-enters top-N, treat as fresh active tracking.
  getDb()
    .prepare(
      `INSERT INTO tracked_traders (address, name, pnl, volume, win_rate, score, trades_count, last_seen_timestamp, active, exit_only, probation, probation_trades_left)
       VALUES (@address, @name, @pnl, @volume, @winRate, @score, @tradesCount, @lastSeenTimestamp, @active, 0, @probation, @probationTradesLeft)
       ON CONFLICT(address) DO UPDATE SET
         name = excluded.name,
         pnl = excluded.pnl,
         volume = excluded.volume,
         win_rate = excluded.win_rate,
         score = excluded.score,
         trades_count = excluded.trades_count,
         last_seen_timestamp = excluded.last_seen_timestamp,
         active = excluded.active,
         exit_only = 0,
         probation = excluded.probation,
         probation_trades_left = excluded.probation_trades_left`
    )
    .run({
      address: trader.address,
      name: trader.name,
      pnl: trader.pnl,
      volume: trader.volume,
      winRate: trader.winRate,
      score: trader.score,
      tradesCount: trader.tradesCount,
      lastSeenTimestamp: trader.lastSeenTimestamp,
      active: trader.active ? 1 : 0,
      probation: trader.probation ? 1 : 0,
      probationTradesLeft: trader.probationTradesLeft,
    });
}

export function getActiveTraders(): TrackedTrader[] {
  const rows = getDb()
    .prepare('SELECT * FROM tracked_traders WHERE active = 1 ORDER BY score DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapTraderRow);
}

/** Returns all traders the tracker should poll: active + exit-only. */
export function getTrackedForPolling(): TrackedTrader[] {
  const rows = getDb()
    .prepare('SELECT * FROM tracked_traders WHERE active = 1 OR exit_only = 1 ORDER BY score DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapTraderRow);
}

export function deactivateTrader(address: string): void {
  getDb().prepare('UPDATE tracked_traders SET active = 0 WHERE address = ?').run(address);
}

/** Move to exit-only: stop copying BUYs but keep polling for SELL signals. */
export function setExitOnly(address: string): void {
  getDb()
    .prepare('UPDATE tracked_traders SET active = 0, exit_only = 1 WHERE address = ?')
    .run(address);
}

/** Fully stop tracking: tracker won't poll this trader anymore. */
export function deactivateTraderFully(address: string): void {
  getDb()
    .prepare('UPDATE tracked_traders SET active = 0, exit_only = 0 WHERE address = ?')
    .run(address);
}

/** Count distinct open positions where this trader contributed a BUY trade. */
export function countOpenPositionsFromTrader(address: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT p.token_id) AS cnt
       FROM positions p
       WHERE p.status = 'open'
       AND EXISTS (
         SELECT 1 FROM trades t
         WHERE t.trader_address = ? AND t.side = 'BUY' AND t.token_id = p.token_id
       )`,
    )
    .get(address) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function getTraderByAddress(address: string): TrackedTrader | undefined {
  const row = getDb()
    .prepare('SELECT * FROM tracked_traders WHERE address = ?')
    .get(address) as Record<string, unknown> | undefined;
  return row ? mapTraderRow(row) : undefined;
}

function mapTraderRow(row: Record<string, unknown>): TrackedTrader {
  return {
    address: row.address as string,
    name: row.name as string,
    pnl: row.pnl as number,
    volume: row.volume as number,
    winRate: row.win_rate as number,
    score: row.score as number,
    tradesCount: row.trades_count as number,
    lastSeenTimestamp: row.last_seen_timestamp as number,
    addedAt: row.added_at as string,
    active: (row.active as number) === 1,
    exitOnly: (row.exit_only as number) === 1,
    probation: (row.probation as number) === 1,
    probationTradesLeft: row.probation_trades_left as number,
  };
}

// ============================================================
// Trades
// ============================================================

export function insertTrade(trade: TradeResult): void {
  getDb()
    .prepare(
      `INSERT INTO trades (id, timestamp, trader_address, trader_name, side, market_slug, market_title,
         condition_id, token_id, outcome, size, price, total_usd, order_id, status, error,
         original_trader_size, original_trader_price, is_dry_run, commission)
       VALUES (@id, @timestamp, @traderAddress, @traderName, @side, @marketSlug, @marketTitle,
         @conditionId, @tokenId, @outcome, @size, @price, @totalUsd, @orderId, @status, @error,
         @originalTraderSize, @originalTraderPrice, @isDryRun, @commission)`
    )
    .run({
      id: trade.id,
      timestamp: trade.timestamp,
      traderAddress: trade.traderAddress,
      traderName: trade.traderName,
      side: trade.side,
      marketSlug: trade.marketSlug,
      marketTitle: trade.marketTitle,
      conditionId: trade.conditionId,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      size: trade.size,
      price: trade.price,
      totalUsd: trade.totalUsd,
      orderId: trade.orderId ?? null,
      status: trade.status,
      error: trade.error ?? null,
      originalTraderSize: trade.originalTraderSize,
      originalTraderPrice: trade.originalTraderPrice,
      isDryRun: trade.isDryRun ? 1 : 0,
      commission: trade.commission ?? 0,
    });
}

export function getTrades(options?: {
  limit?: number;
  offset?: number;
  status?: string;
}): TradeResult[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM trades';
  const params: unknown[] = [];

  if (options?.status) {
    sql += ' WHERE status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapTradeRow);
}

export function getTradesByTrader(traderAddress: string, limit = 50): TradeResult[] {
  const rows = getDb()
    .prepare('SELECT * FROM trades WHERE trader_address = ? ORDER BY timestamp DESC LIMIT ?')
    .all(traderAddress, limit) as Array<Record<string, unknown>>;
  return rows.map(mapTradeRow);
}

export function getTodayTrades(): TradeResult[] {
  const rows = getDb()
    .prepare("SELECT * FROM trades WHERE date(timestamp) = date('now') ORDER BY timestamp DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapTradeRow);
}

export function getTradeCount(status?: string): number {
  if (status) {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM trades WHERE status = ?')
      .get(status) as { cnt: number };
    return row.cnt;
  }
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM trades WHERE status IN ('filled','simulated','partial')")
    .get() as { cnt: number };
  return row.cnt;
}

export function getTotalCommission(): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(commission), 0) AS total FROM trades WHERE status IN ('filled','simulated')")
    .get() as { total: number };
  return row.total;
}

export function getTodayRealizedPnl(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(
        (SELECT COALESCE(SUM(t.total_usd), 0) FROM trades t
          WHERE t.token_id = p.token_id AND t.side IN ('SELL','REDEEM')
            AND t.status IN ('filled','simulated'))
        - p.total_invested
      ), 0) AS pnl
      FROM positions p
      WHERE p.status IN ('closed','redeemed')
        AND EXISTS (
          SELECT 1 FROM trades t
          WHERE t.token_id = p.token_id
            AND t.side IN ('SELL','REDEEM')
            AND date(t.timestamp) = date('now')
        )`,
    )
    .get() as { pnl: number };
  return row.pnl;
}

function mapTradeRow(row: Record<string, unknown>): TradeResult {
  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    traderAddress: row.trader_address as string,
    traderName: row.trader_name as string,
    side: row.side as 'BUY' | 'SELL',
    marketSlug: row.market_slug as string,
    marketTitle: row.market_title as string,
    conditionId: row.condition_id as string,
    tokenId: row.token_id as string,
    outcome: row.outcome as string,
    size: row.size as number,
    price: row.price as number,
    totalUsd: row.total_usd as number,
    orderId: (row.order_id as string) ?? undefined,
    status: row.status as TradeResult['status'],
    error: (row.error as string) ?? undefined,
    originalTraderSize: row.original_trader_size as number,
    originalTraderPrice: row.original_trader_price as number,
    isDryRun: (row.is_dry_run as number) === 1,
    commission: (row.commission as number) ?? 0,
  };
}

// ============================================================
// Positions
// ============================================================

export function upsertPosition(position: Omit<BotPosition, 'id'>): void {
  getDb()
    .prepare(
      `INSERT INTO positions (token_id, condition_id, market_slug, market_title, outcome,
         total_shares, avg_price, total_invested, status)
       VALUES (@tokenId, @conditionId, @marketSlug, @marketTitle, @outcome,
         @totalShares, @avgPrice, @totalInvested, @status)
       ON CONFLICT(token_id) DO UPDATE SET
         total_shares = excluded.total_shares,
         avg_price = excluded.avg_price,
         total_invested = excluded.total_invested,
         status = excluded.status`
    )
    .run({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      marketSlug: position.marketSlug,
      marketTitle: position.marketTitle,
      outcome: position.outcome,
      totalShares: position.totalShares,
      avgPrice: position.avgPrice,
      totalInvested: position.totalInvested,
      status: position.status,
    });
}

export function getPositionByTokenId(tokenId: string): BotPosition | undefined {
  const row = getDb()
    .prepare('SELECT * FROM positions WHERE token_id = ?')
    .get(tokenId) as Record<string, unknown> | undefined;
  return row ? mapPositionRow(row) : undefined;
}

export function getAllOpenPositions(): BotPosition[] {
  const rows = getDb()
    .prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapPositionRow);
}

export interface ClosedPositionRow extends BotPosition {
  closeUsd: number;         // total USD received from SELL + REDEEM trades
  closeSize: number;        // total shares exited
  closeAvgPrice: number;    // closeUsd / closeSize (0 if no exit trades)
  realizedPnl: number;      // closeUsd − totalInvested
  closedAt: string | null;  // most recent SELL/REDEEM timestamp
  traderAddress: string;    // trader whose BUY opened this position
  traderName: string;
}

/**
 * Round-trip view for closed + redeemed positions, enriched with the aggregate
 * close price, received USD, and realized P&L. Used by Dashboard "Closed
 * Positions" section.
 */
export function getClosedPositions(limit = 200): ClosedPositionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*,
              COALESCE(SUM(CASE WHEN t.side IN ('SELL','REDEEM') THEN t.total_usd END), 0) AS close_usd,
              COALESCE(SUM(CASE WHEN t.side IN ('SELL','REDEEM') THEN t.size END), 0) AS close_size,
              MAX(CASE WHEN t.side IN ('SELL','REDEEM') THEN t.timestamp END) AS closed_at,
              (SELECT ob.trader_address FROM trades ob
                 WHERE ob.token_id = p.token_id AND ob.side = 'BUY'
                 ORDER BY ob.timestamp ASC LIMIT 1) AS trader_address,
              (SELECT ob.trader_name FROM trades ob
                 WHERE ob.token_id = p.token_id AND ob.side = 'BUY'
                 ORDER BY ob.timestamp ASC LIMIT 1) AS trader_name
         FROM positions p
         LEFT JOIN trades t ON t.token_id = p.token_id
        WHERE p.status IN ('closed','redeemed')
        GROUP BY p.id
        ORDER BY closed_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const base = mapPositionRow(row);
    const closeUsd = Number(row.close_usd ?? 0);
    const closeSize = Number(row.close_size ?? 0);
    return {
      ...base,
      closeUsd,
      closeSize,
      closeAvgPrice: closeSize > 0 ? closeUsd / closeSize : 0,
      realizedPnl: closeUsd - base.totalInvested,
      closedAt: (row.closed_at as string | null) ?? null,
      traderAddress: (row.trader_address as string) ?? '',
      traderName: (row.trader_name as string) ?? '',
    };
  });
}

/**
 * The trader whose earliest BUY opened this position. Used to attribute
 * auto-redeem trade records (trades.trader_address is FK → tracked_traders).
 */
export function getOpeningTraderForToken(
  tokenId: string,
): { address: string; name: string } | undefined {
  const row = getDb()
    .prepare(
      `SELECT trader_address AS address, trader_name AS name
         FROM trades
        WHERE token_id = ? AND side = 'BUY'
        ORDER BY timestamp ASC
        LIMIT 1`,
    )
    .get(tokenId) as { address: string; name: string } | undefined;
  return row;
}

export function markPositionRedeemed(tokenId: string): void {
  getDb().prepare("UPDATE positions SET status = 'redeemed' WHERE token_id = ?").run(tokenId);
}

export function closePosition(tokenId: string): void {
  getDb().prepare("UPDATE positions SET status = 'closed' WHERE token_id = ?").run(tokenId);
}

function mapPositionRow(row: Record<string, unknown>): BotPosition {
  return {
    id: row.id as number,
    tokenId: row.token_id as string,
    conditionId: row.condition_id as string,
    marketSlug: row.market_slug as string,
    marketTitle: row.market_title as string,
    outcome: row.outcome as string,
    totalShares: row.total_shares as number,
    avgPrice: row.avg_price as number,
    totalInvested: row.total_invested as number,
    openedAt: row.opened_at as string,
    status: row.status as BotPosition['status'],
  };
}

// ============================================================
// PnL Snapshots
// ============================================================

export function insertSnapshot(snapshot: Omit<PnlSnapshot, 'id' | 'timestamp'>): void {
  getDb()
    .prepare(
      `INSERT INTO pnl_snapshots (total_pnl, unrealized_pnl, realized_pnl, balance_usdc, open_positions_count)
       VALUES (@totalPnl, @unrealizedPnl, @realizedPnl, @balanceUsdc, @openPositionsCount)`
    )
    .run({
      totalPnl: snapshot.totalPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      realizedPnl: snapshot.realizedPnl,
      balanceUsdc: snapshot.balanceUsdc,
      openPositionsCount: snapshot.openPositionsCount,
    });
}

/**
 * Earliest snapshot from today (local "now" timezone via SQLite).
 * Used to compute Today P&L = currentTotalPnl − todayBaseline.totalPnl.
 * Returns undefined if no snapshot has been taken yet today.
 */
export function getTodayBaselineSnapshot(): PnlSnapshot | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM pnl_snapshots
       WHERE timestamp >= date('now', 'start of day')
       ORDER BY timestamp ASC
       LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? mapSnapshotRow(row) : undefined;
}

export function getSnapshots(options?: { period?: string; limit?: number }): PnlSnapshot[] {
  const limit = options?.limit ?? 500;
  let sql = 'SELECT * FROM pnl_snapshots';
  const params: unknown[] = [];

  if (options?.period) {
    const { value, unit } = parsePeriod(options.period);
    // SQLite datetime modifier: '-N hours' / '-N days'
    sql += ` WHERE timestamp >= datetime('now', '-${value} ${unit}')`;
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapSnapshotRow);
}

function parsePeriod(period: string): { value: number; unit: 'hours' | 'days' } {
  const match = period.match(/^(\d+)([dhw])$/);
  if (!match) return { value: 7, unit: 'days' };
  const [, num, u] = match;
  const n = parseInt(num!, 10);
  switch (u) {
    case 'h':
      return { value: n, unit: 'hours' };
    case 'd':
      return { value: n, unit: 'days' };
    case 'w':
      return { value: n * 7, unit: 'days' };
    default:
      return { value: 7, unit: 'days' };
  }
}

function mapSnapshotRow(row: Record<string, unknown>): PnlSnapshot {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    totalPnl: row.total_pnl as number,
    unrealizedPnl: row.unrealized_pnl as number,
    realizedPnl: row.realized_pnl as number,
    balanceUsdc: row.balance_usdc as number,
    openPositionsCount: row.open_positions_count as number,
  };
}

// ============================================================
// Activity Log
// ============================================================

export function insertActivity(type: string, message: string, details?: string): void {
  getDb()
    .prepare('INSERT INTO activity_log (type, message, details) VALUES (?, ?, ?)')
    .run(type, message, details ?? null);
}

export function getActivities(options?: {
  type?: string;
  limit?: number;
}): Array<{ id: number; timestamp: string; type: string; message: string; details?: string }> {
  const limit = options?.limit ?? 50;

  let sql = 'SELECT * FROM activity_log';
  const params: unknown[] = [];

  if (options?.type) {
    sql += ' WHERE type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    type: row.type as string,
    message: row.message as string,
    details: (row.details as string) ?? undefined,
  }));
}

// ============================================================
// Trader Performance
// ============================================================

export function upsertPerformance(perf: {
  traderAddress: string;
  date: string;
  copiedTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgReturn: number;
  slippageAvg: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO trader_performance (trader_address, date, copied_trades, wins, losses, total_pnl, avg_return, slippage_avg)
       VALUES (@traderAddress, @date, @copiedTrades, @wins, @losses, @totalPnl, @avgReturn, @slippageAvg)
       ON CONFLICT(trader_address, date) DO UPDATE SET
         copied_trades = excluded.copied_trades,
         wins = excluded.wins,
         losses = excluded.losses,
         total_pnl = excluded.total_pnl,
         avg_return = excluded.avg_return,
         slippage_avg = excluded.slippage_avg`
    )
    .run(perf);
}

export function getPerformanceByTrader(traderAddress: string): TraderPerformance | undefined {
  const row = getDb()
    .prepare(
      `SELECT trader_address,
              SUM(copied_trades) as copied_trades,
              SUM(wins) as wins,
              SUM(losses) as losses,
              SUM(total_pnl) as total_pnl,
              AVG(avg_return) as avg_return,
              AVG(slippage_avg) as slippage_avg,
              MAX(date) as last_updated
       FROM trader_performance
       WHERE trader_address = ?
       GROUP BY trader_address`
    )
    .get(traderAddress) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  return {
    traderId: row.trader_address as string,
    copiedTrades: row.copied_trades as number,
    wins: row.wins as number,
    losses: row.losses as number,
    totalPnl: row.total_pnl as number,
    avgReturn: row.avg_return as number,
    sharpe: 0, // Computed elsewhere
    slippageAvg: row.slippage_avg as number,
    lastUpdated: row.last_updated as string,
  };
}

export function getAllPerformance(): TraderPerformance[] {
  const rows = getDb()
    .prepare(
      `SELECT trader_address,
              SUM(copied_trades) as copied_trades,
              SUM(wins) as wins,
              SUM(losses) as losses,
              SUM(total_pnl) as total_pnl,
              AVG(avg_return) as avg_return,
              AVG(slippage_avg) as slippage_avg,
              MAX(date) as last_updated
       FROM trader_performance
       GROUP BY trader_address
       ORDER BY total_pnl DESC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    traderId: row.trader_address as string,
    copiedTrades: row.copied_trades as number,
    wins: row.wins as number,
    losses: row.losses as number,
    totalPnl: row.total_pnl as number,
    avgReturn: row.avg_return as number,
    sharpe: 0,
    slippageAvg: row.slippage_avg as number,
    lastUpdated: row.last_updated as string,
  }));
}

// ============================================================
// Rotation Log
// ============================================================

export function insertRotation(oldTrader: string | null, newTrader: string | null, reason: string): void {
  getDb()
    .prepare('INSERT INTO rotation_log (old_trader, new_trader, reason) VALUES (?, ?, ?)')
    .run(oldTrader, newTrader, reason);
}

export function getRotations(limit = 50): RotationEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM rotation_log ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    oldTrader: row.old_trader as string,
    newTrader: row.new_trader as string,
    reason: row.reason as string,
    timestamp: row.timestamp as string,
  }));
}

// ============================================================
// Backtest Results
// ============================================================

export function insertBacktest(result: BacktestResult): void {
  getDb()
    .prepare(
      `INSERT INTO backtest_results (id, config, total_pnl, win_rate, max_drawdown, sharpe,
         trade_count, equity_curve, trader_breakdown)
       VALUES (@id, @config, @totalPnl, @winRate, @maxDrawdown, @sharpe,
         @tradeCount, @equityCurve, @traderBreakdown)`
    )
    .run({
      id: result.id,
      config: JSON.stringify(result.config),
      totalPnl: result.totalPnl,
      winRate: result.winRate,
      maxDrawdown: result.maxDrawdown,
      sharpe: result.sharpe,
      tradeCount: result.tradeCount,
      equityCurve: JSON.stringify(result.equityCurve),
      traderBreakdown: JSON.stringify(result.traderBreakdown),
    });
}

export function getBacktest(id: string): BacktestResult | undefined {
  const row = getDb()
    .prepare('SELECT * FROM backtest_results WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return mapBacktestRow(row);
}

export function listBacktests(limit = 20): BacktestResult[] {
  const rows = getDb()
    .prepare('SELECT * FROM backtest_results ORDER BY ran_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map(mapBacktestRow);
}

function mapBacktestRow(row: Record<string, unknown>): BacktestResult {
  return {
    id: row.id as string,
    config: JSON.parse(row.config as string) as BacktestConfig,
    totalPnl: row.total_pnl as number,
    winRate: row.win_rate as number,
    maxDrawdown: row.max_drawdown as number,
    sharpe: row.sharpe as number,
    tradeCount: row.trade_count as number,
    equityCurve: JSON.parse(row.equity_curve as string) as Array<{ timestamp: number; equity: number }>,
    traderBreakdown: JSON.parse(row.trader_breakdown as string) as Array<{
      address: string;
      name: string;
      pnl: number;
      trades: number;
    }>,
    ranAt: row.ran_at as string,
  };
}

// ============================================================
// Anomaly Log
// ============================================================

export function insertAnomaly(anomaly: Omit<AnomalyAlert, 'id' | 'timestamp'>): void {
  getDb()
    .prepare(
      `INSERT INTO anomaly_log (trader_address, trade_id, type, severity, message)
       VALUES (@traderId, @tradeId, @type, @severity, @message)`
    )
    .run({
      traderId: anomaly.traderId,
      tradeId: anomaly.tradeId ?? null,
      type: anomaly.type,
      severity: anomaly.severity,
      message: anomaly.message,
    });
}

export function getAnomalies(options?: {
  traderAddress?: string;
  severity?: string;
  limit?: number;
}): AnomalyAlert[] {
  const limit = options?.limit ?? 50;
  let sql = 'SELECT * FROM anomaly_log';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.traderAddress) {
    conditions.push('trader_address = ?');
    params.push(options.traderAddress);
  }

  if (options?.severity) {
    conditions.push('severity = ?');
    params.push(options.severity);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    traderId: row.trader_address as string,
    tradeId: (row.trade_id as string) ?? undefined,
    type: row.type as AnomalyAlert['type'],
    severity: row.severity as AnomalyAlert['severity'],
    message: row.message as string,
    timestamp: row.timestamp as string,
  }));
}
