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
  MarketResolution,
  BackfillJob,
  ScoringWeights,
  ScoringWeightsRow,
  ConvictionParamsRow,
  TwapOrder,
  MarketCache,
  EquitySnapshot,
  TraderBlacklistEntry,
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
    haltedUntil: row.halted_until !== undefined ? (row.halted_until as number) : undefined,
    realizedWinRate: row.realized_win_rate !== undefined ? (row.realized_win_rate as number | null) : undefined,
    resolvedTradesCount: row.resolved_trades_count !== undefined ? (row.resolved_trades_count as number) : undefined,
    confidence: row.confidence !== undefined ? (row.confidence as number) : undefined,
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
         original_trader_size, original_trader_price, is_dry_run, commission, reason)
       VALUES (@id, @timestamp, @traderAddress, @traderName, @side, @marketSlug, @marketTitle,
         @conditionId, @tokenId, @outcome, @size, @price, @totalUsd, @orderId, @status, @error,
         @originalTraderSize, @originalTraderPrice, @isDryRun, @commission, @reason)`
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
      reason: trade.reason ?? 'copy',
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
    reason: row.reason !== undefined && row.reason !== null ? (row.reason as TradeResult['reason']) : undefined,
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
    highPrice: row.high_price !== undefined ? (row.high_price as number | null) : undefined,
    highPriceUpdatedAt: row.high_price_updated_at !== undefined ? (row.high_price_updated_at as number) : undefined,
    stopLossPrice: row.stop_loss_price !== undefined ? (row.stop_loss_price as number | null) : undefined,
    trailingStopPrice: row.trailing_stop_price !== undefined ? (row.trailing_stop_price as number | null) : undefined,
    scaledOut: row.scaled_out !== undefined ? (row.scaled_out as number) === 1 : undefined,
    currentPrice: row.current_price !== undefined ? (row.current_price as number | null) : undefined,
    currentPriceUpdatedAt: row.current_price_updated_at !== undefined ? (row.current_price_updated_at as number) : undefined,
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

// ============================================================
// Market Resolutions
// ============================================================

function mapMarketResolutionRow(row: Record<string, unknown>): MarketResolution {
  return {
    conditionId: row.condition_id as string,
    winnerTokenId: (row.winner_token_id as string | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
    marketTitle: (row.market_title as string) ?? '',
    fetchedAt: row.fetched_at as number,
    status: row.status as MarketResolution['status'],
  };
}

export function getMarketResolution(conditionId: string): MarketResolution | undefined {
  const row = getDb()
    .prepare('SELECT * FROM market_resolutions WHERE condition_id = ?')
    .get(conditionId) as Record<string, unknown> | undefined;
  return row ? mapMarketResolutionRow(row) : undefined;
}

export function upsertMarketResolution(res: MarketResolution): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO market_resolutions
         (condition_id, winner_token_id, resolved_at, market_title, fetched_at, status)
       VALUES (@conditionId, @winnerTokenId, @resolvedAt, @marketTitle, @fetchedAt, @status)`
    )
    .run({
      conditionId: res.conditionId,
      winnerTokenId: res.winnerTokenId ?? null,
      resolvedAt: res.resolvedAt ?? null,
      marketTitle: res.marketTitle,
      fetchedAt: res.fetchedAt,
      status: res.status,
    });
}

export function getPendingMarketResolutions(): MarketResolution[] {
  const rows = getDb()
    .prepare("SELECT * FROM market_resolutions WHERE status = 'pending'")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapMarketResolutionRow);
}

export function getResolvedMarketResolutions(conditionIds: string[]): Map<string, MarketResolution> {
  if (conditionIds.length === 0) return new Map();
  const placeholders = conditionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT * FROM market_resolutions WHERE condition_id IN (${placeholders}) AND status = 'resolved'`
    )
    .all(...conditionIds) as Array<Record<string, unknown>>;
  const result = new Map<string, MarketResolution>();
  for (const row of rows) {
    const mapped = mapMarketResolutionRow(row);
    result.set(mapped.conditionId, mapped);
  }
  return result;
}

// ============================================================
// Backfill Jobs
// ============================================================

function mapBackfillJobRow(row: Record<string, unknown>): BackfillJob {
  return {
    traderAddress: row.trader_address as string,
    status: row.status as BackfillJob['status'],
    marketsTotal: (row.markets_total as number) ?? 0,
    marketsResolved: (row.markets_resolved as number) ?? 0,
    startedAt: (row.started_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

export function upsertBackfillJob(
  job: Partial<BackfillJob> & { traderAddress: string; status: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO backfill_jobs (trader_address, status, markets_total, markets_resolved, started_at, completed_at, error)
       VALUES (@traderAddress, @status, @marketsTotal, @marketsResolved, @startedAt, @completedAt, @error)
       ON CONFLICT(trader_address) DO UPDATE SET
         status = excluded.status,
         markets_total = excluded.markets_total,
         markets_resolved = excluded.markets_resolved,
         started_at = COALESCE(excluded.started_at, backfill_jobs.started_at),
         completed_at = excluded.completed_at,
         error = excluded.error`
    )
    .run({
      traderAddress: job.traderAddress,
      status: job.status,
      marketsTotal: job.marketsTotal ?? 0,
      marketsResolved: job.marketsResolved ?? 0,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
      error: job.error ?? null,
    });
}

export function getBackfillJob(traderAddress: string): BackfillJob | undefined {
  const row = getDb()
    .prepare('SELECT * FROM backfill_jobs WHERE trader_address = ?')
    .get(traderAddress) as Record<string, unknown> | undefined;
  return row ? mapBackfillJobRow(row) : undefined;
}

export function getAllBackfillJobs(): BackfillJob[] {
  const rows = getDb()
    .prepare('SELECT * FROM backfill_jobs ORDER BY started_at DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapBackfillJobRow);
}

// ============================================================
// Scoring Weights
// ============================================================

export function insertScoringWeights(weights: ScoringWeights & { source: string }): void {
  getDb()
    .prepare(
      `INSERT INTO scoring_weights (roi_w, freq_w, wr_w, cons_w, size_w, source)
       VALUES (@roi, @frequency, @winRate, @consistency, @sizeProximity, @source)`
    )
    .run({
      roi: weights.roi,
      frequency: weights.frequency,
      winRate: weights.winRate,
      consistency: weights.consistency,
      sizeProximity: weights.sizeProximity,
      source: weights.source,
    });
}

function mapScoringWeightsRow(row: Record<string, unknown>): ScoringWeightsRow {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    source: row.source as ScoringWeightsRow['source'],
    roi: row.roi_w as number,
    frequency: row.freq_w as number,
    winRate: row.wr_w as number,
    consistency: row.cons_w as number,
    sizeProximity: row.size_w as number,
  };
}

export function getLatestScoringWeights(): ScoringWeightsRow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM scoring_weights ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapScoringWeightsRow(row) : undefined;
}

export function getScoringWeightsHistory(limit: number): ScoringWeightsRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM scoring_weights ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapScoringWeightsRow);
}

// ============================================================
// Trader Correlations
// ============================================================

export function upsertTraderCorrelation(
  traderA: string,
  traderB: string,
  correlation: number
): void {
  // Normalize order to avoid duplicates
  const [a, b] = traderA < traderB ? [traderA, traderB] : [traderB, traderA];
  getDb()
    .prepare(
      `INSERT INTO trader_correlations (trader_a, trader_b, correlation, computed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(trader_a, trader_b) DO UPDATE SET
         correlation = excluded.correlation,
         computed_at = excluded.computed_at`
    )
    .run(a, b, correlation, Date.now());
}

export function getTraderCorrelation(traderA: string, traderB: string): number | undefined {
  const [a, b] = traderA < traderB ? [traderA, traderB] : [traderB, traderA];
  const row = getDb()
    .prepare(
      'SELECT correlation FROM trader_correlations WHERE trader_a = ? AND trader_b = ?'
    )
    .get(a, b) as { correlation: number } | undefined;
  return row?.correlation;
}

export function getCorrelationsForTrader(
  address: string
): Array<{ address: string; correlation: number }> {
  const rows = getDb()
    .prepare(
      `SELECT
         CASE WHEN trader_a = ? THEN trader_b ELSE trader_a END AS address,
         correlation
       FROM trader_correlations
       WHERE trader_a = ? OR trader_b = ?
       ORDER BY correlation DESC`
    )
    .all(address, address, address) as Array<{ address: string; correlation: number }>;
  return rows;
}

// ============================================================
// Trader Blacklist
// ============================================================

export function addToBlacklist(address: string, reason: string, days: number): void {
  const now = Date.now();
  const expiresAt = now + days * 86400000;
  getDb()
    .prepare(
      `INSERT INTO trader_blacklist (address, reason, blacklisted_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         reason = excluded.reason,
         blacklisted_at = excluded.blacklisted_at,
         expires_at = excluded.expires_at`
    )
    .run(address, reason, now, expiresAt);
}

export function isBlacklisted(address: string): boolean {
  const now = Date.now();
  const row = getDb()
    .prepare(
      'SELECT 1 FROM trader_blacklist WHERE address = ? AND expires_at > ?'
    )
    .get(address, now) as { 1: number } | undefined;
  return row !== undefined;
}

export function removeExpiredBlacklist(): number {
  const now = Date.now();
  const result = getDb()
    .prepare('DELETE FROM trader_blacklist WHERE expires_at <= ?')
    .run(now);
  return result.changes;
}

export function getBlacklist(): TraderBlacklistEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM trader_blacklist ORDER BY blacklisted_at DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    address: row.address as string,
    reason: row.reason as string,
    blacklistedAt: row.blacklisted_at as number,
    expiresAt: row.expires_at as number,
  }));
}

// ============================================================
// Halted Traders
// ============================================================

export function haltTrader(address: string, durationHours: number): void {
  const haltedUntil = Date.now() + durationHours * 3600000;
  getDb()
    .prepare(
      'UPDATE tracked_traders SET halted_until = ? WHERE address = ?'
    )
    .run(haltedUntil, address);
}

export function isTraderHalted(address: string): boolean {
  const now = Date.now();
  const row = getDb()
    .prepare(
      'SELECT halted_until FROM tracked_traders WHERE address = ? AND halted_until > ?'
    )
    .get(address, now) as { halted_until: number } | undefined;
  return row !== undefined;
}

export function clearHalt(address: string): void {
  getDb()
    .prepare('UPDATE tracked_traders SET halted_until = 0 WHERE address = ?')
    .run(address);
}

// ============================================================
// Equity Snapshots
// ============================================================

export function insertEquitySnapshot(equity: number, source = 'auto'): void {
  getDb()
    .prepare(
      'INSERT INTO equity_snapshots (timestamp, equity_usd, source) VALUES (?, ?, ?)'
    )
    .run(Date.now(), equity, source);
}

export function getEquitySnapshotsSince(sinceTs: number): EquitySnapshot[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM equity_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC'
    )
    .all(sinceTs) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as number,
    equityUsd: row.equity_usd as number,
    source: row.source as string,
  }));
}

export function getEquityPeakSince(sinceTs: number): number {
  const row = getDb()
    .prepare(
      'SELECT MAX(equity_usd) AS peak FROM equity_snapshots WHERE timestamp >= ?'
    )
    .get(sinceTs) as { peak: number | null } | undefined;
  return row?.peak ?? 0;
}

// ============================================================
// Conviction Params
// ============================================================

const DEFAULT_CONVICTION_PARAMS: ConvictionParamsRow = {
  id: 1,
  betBase: 1.0,
  f1Anchor: 20.0,
  f1Max: 5.0,
  w2: 0.3,
  w3: 0.5,
  f4Boost: 1.0,
  source: 'default',
  updatedAt: new Date().toISOString(),
};

function mapConvictionParamsRow(row: Record<string, unknown>): ConvictionParamsRow {
  return {
    id: row.id as number,
    betBase: row.bet_base as number,
    f1Anchor: row.f1_anchor as number,
    f1Max: row.f1_max as number,
    w2: row.w2 as number,
    w3: row.w3 as number,
    f4Boost: row.f4_boost as number,
    source: row.source as ConvictionParamsRow['source'],
    updatedAt: row.updated_at as string,
  };
}

export function getConvictionParams(): ConvictionParamsRow {
  const row = getDb()
    .prepare('SELECT * FROM conviction_params WHERE id = 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapConvictionParamsRow(row) : { ...DEFAULT_CONVICTION_PARAMS };
}

export function updateConvictionParams(
  params: Omit<ConvictionParamsRow, 'id' | 'updatedAt'>
): void {
  getDb()
    .prepare(
      `INSERT INTO conviction_params (id, bet_base, f1_anchor, f1_max, w2, w3, f4_boost, source, updated_at)
       VALUES (1, @betBase, @f1Anchor, @f1Max, @w2, @w3, @f4Boost, @source, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         bet_base = excluded.bet_base,
         f1_anchor = excluded.f1_anchor,
         f1_max = excluded.f1_max,
         w2 = excluded.w2,
         w3 = excluded.w3,
         f4_boost = excluded.f4_boost,
         source = excluded.source,
         updated_at = CURRENT_TIMESTAMP`
    )
    .run({
      betBase: params.betBase,
      f1Anchor: params.f1Anchor,
      f1Max: params.f1Max,
      w2: params.w2,
      w3: params.w3,
      f4Boost: params.f4Boost,
      source: params.source,
    });
}

export function insertConvictionHistory(entry: {
  betBase: number;
  f1Anchor: number;
  f1Max: number;
  w2: number;
  w3: number;
  f4Boost: number;
  source: string;
  sharpeOld?: number;
  sharpeNew?: number;
  reason?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO conviction_params_history
         (bet_base, f1_anchor, f1_max, w2, w3, f4_boost, source, sharpe_old, sharpe_new, reason)
       VALUES (@betBase, @f1Anchor, @f1Max, @w2, @w3, @f4Boost, @source, @sharpeOld, @sharpeNew, @reason)`
    )
    .run({
      betBase: entry.betBase,
      f1Anchor: entry.f1Anchor,
      f1Max: entry.f1Max,
      w2: entry.w2,
      w3: entry.w3,
      f4Boost: entry.f4Boost,
      source: entry.source,
      sharpeOld: entry.sharpeOld ?? null,
      sharpeNew: entry.sharpeNew ?? null,
      reason: entry.reason ?? null,
    });
}

export function getConvictionHistory(limit: number): Array<{
  id: number;
  betBase: number;
  f1Anchor: number;
  f1Max: number;
  w2: number;
  w3: number;
  f4Boost: number;
  source: string;
  sharpeOld: number | null;
  sharpeNew: number | null;
  appliedAt: string;
  reason: string | null;
}> {
  const rows = getDb()
    .prepare('SELECT * FROM conviction_params_history ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    betBase: row.bet_base as number,
    f1Anchor: row.f1_anchor as number,
    f1Max: row.f1_max as number,
    w2: row.w2 as number,
    w3: row.w3 as number,
    f4Boost: row.f4_boost as number,
    source: row.source as string,
    sharpeOld: (row.sharpe_old as number | null) ?? null,
    sharpeNew: (row.sharpe_new as number | null) ?? null,
    appliedAt: row.applied_at as string,
    reason: (row.reason as string | null) ?? null,
  }));
}

// ============================================================
// TWAP Orders
// ============================================================

function mapTwapOrderRow(row: Record<string, unknown>): TwapOrder {
  return {
    id: row.id as number,
    parentTradeId: row.parent_trade_id as string,
    tokenId: row.token_id as string,
    conditionId: row.condition_id as string,
    side: row.side as TwapOrder['side'],
    totalSlices: row.total_slices as number,
    sliceNum: row.slice_num as number,
    sliceUsd: row.slice_usd as number,
    sliceSize: (row.slice_size as number | null) ?? null,
    status: row.status as TwapOrder['status'],
    orderId: (row.order_id as string | null) ?? null,
    executedPrice: (row.executed_price as number | null) ?? null,
    executedAt: (row.executed_at as string | null) ?? null,
    initialPrice: row.initial_price as number,
    createdAt: row.created_at as string,
    error: (row.error as string | null) ?? null,
  };
}

export function insertTwapSlice(slice: Omit<TwapOrder, 'id' | 'createdAt'>): number {
  const result = getDb()
    .prepare(
      `INSERT INTO twap_orders
         (parent_trade_id, token_id, condition_id, side, total_slices, slice_num,
          slice_usd, slice_size, status, order_id, executed_price, executed_at,
          initial_price, error)
       VALUES (@parentTradeId, @tokenId, @conditionId, @side, @totalSlices, @sliceNum,
          @sliceUsd, @sliceSize, @status, @orderId, @executedPrice, @executedAt,
          @initialPrice, @error)`
    )
    .run({
      parentTradeId: slice.parentTradeId,
      tokenId: slice.tokenId,
      conditionId: slice.conditionId,
      side: slice.side,
      totalSlices: slice.totalSlices,
      sliceNum: slice.sliceNum,
      sliceUsd: slice.sliceUsd,
      sliceSize: slice.sliceSize ?? null,
      status: slice.status,
      orderId: slice.orderId ?? null,
      executedPrice: slice.executedPrice ?? null,
      executedAt: slice.executedAt ?? null,
      initialPrice: slice.initialPrice,
      error: slice.error ?? null,
    });
  return result.lastInsertRowid as number;
}

export function updateTwapSlice(id: number, updates: Partial<TwapOrder>): void {
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.status !== undefined) { setClauses.push('status = @status'); params['status'] = updates.status; }
  if (updates.orderId !== undefined) { setClauses.push('order_id = @orderId'); params['orderId'] = updates.orderId; }
  if (updates.executedPrice !== undefined) { setClauses.push('executed_price = @executedPrice'); params['executedPrice'] = updates.executedPrice; }
  if (updates.executedAt !== undefined) { setClauses.push('executed_at = @executedAt'); params['executedAt'] = updates.executedAt; }
  if (updates.sliceSize !== undefined) { setClauses.push('slice_size = @sliceSize'); params['sliceSize'] = updates.sliceSize; }
  if (updates.error !== undefined) { setClauses.push('error = @error'); params['error'] = updates.error; }

  if (setClauses.length === 0) return;

  getDb()
    .prepare(`UPDATE twap_orders SET ${setClauses.join(', ')} WHERE id = @id`)
    .run(params);
}

export function getPendingTwapSlices(): TwapOrder[] {
  const rows = getDb()
    .prepare("SELECT * FROM twap_orders WHERE status IN ('pending', 'executing') ORDER BY created_at ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapTwapOrderRow);
}

export function getTwapSlicesByParent(parentTradeId: string): TwapOrder[] {
  const rows = getDb()
    .prepare('SELECT * FROM twap_orders WHERE parent_trade_id = ? ORDER BY slice_num ASC')
    .all(parentTradeId) as Array<Record<string, unknown>>;
  return rows.map(mapTwapOrderRow);
}

// ============================================================
// Markets Cache
// ============================================================

function mapMarketCacheRow(row: Record<string, unknown>): MarketCache {
  return {
    conditionId: row.condition_id as string,
    createdAt: (row.created_at as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    volume: (row.volume as number | null) ?? null,
    liquidity: (row.liquidity as number | null) ?? null,
    cachedAt: row.cached_at as string,
  };
}

export function getMarketCache(conditionId: string): MarketCache | undefined {
  const row = getDb()
    .prepare('SELECT * FROM markets_cache WHERE condition_id = ?')
    .get(conditionId) as Record<string, unknown> | undefined;
  return row ? mapMarketCacheRow(row) : undefined;
}

export function upsertMarketCache(
  entry: Partial<MarketCache> & { conditionId: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO markets_cache (condition_id, created_at, end_date, volume, liquidity, cached_at)
       VALUES (@conditionId, @createdAt, @endDate, @volume, @liquidity, CURRENT_TIMESTAMP)
       ON CONFLICT(condition_id) DO UPDATE SET
         created_at = COALESCE(excluded.created_at, markets_cache.created_at),
         end_date = COALESCE(excluded.end_date, markets_cache.end_date),
         volume = COALESCE(excluded.volume, markets_cache.volume),
         liquidity = COALESCE(excluded.liquidity, markets_cache.liquidity),
         cached_at = CURRENT_TIMESTAMP`
    )
    .run({
      conditionId: entry.conditionId,
      createdAt: entry.createdAt ?? null,
      endDate: entry.endDate ?? null,
      volume: entry.volume ?? null,
      liquidity: entry.liquidity ?? null,
    });
}

// ============================================================
// Positions — new column helpers
// ============================================================

export function setPositionHighPrice(tokenId: string, price: number, ts: number): void {
  getDb()
    .prepare(
      `UPDATE positions
       SET high_price = ?, high_price_updated_at = ?
       WHERE token_id = ? AND (high_price IS NULL OR high_price < ?)`
    )
    .run(price, ts, tokenId, price);
}

export function setPositionCurrentPrice(tokenId: string, price: number, ts: number): void {
  getDb()
    .prepare(
      `UPDATE positions
       SET current_price = ?, current_price_updated_at = ?
       WHERE token_id = ?`
    )
    .run(price, ts, tokenId);
}

export function markScaledOut(tokenId: string): void {
  getDb()
    .prepare('UPDATE positions SET scaled_out = 1 WHERE token_id = ?')
    .run(tokenId);
}

export function hasScaledOut(tokenId: string): boolean {
  const row = getDb()
    .prepare('SELECT scaled_out FROM positions WHERE token_id = ?')
    .get(tokenId) as { scaled_out: number } | undefined;
  return (row?.scaled_out ?? 0) === 1;
}

// ============================================================
// Tracked Traders — extensions
// ============================================================

export function updateTraderRealizedWinRate(
  address: string,
  realizedWinRate: number,
  resolvedTrades: number,
  confidence: number
): void {
  getDb()
    .prepare(
      `UPDATE tracked_traders
       SET realized_win_rate = ?, resolved_trades_count = ?, confidence = ?
       WHERE address = ?`
    )
    .run(realizedWinRate, resolvedTrades, confidence, address);
}

export function updateTraderScore(address: string, score: number): void {
  getDb()
    .prepare('UPDATE tracked_traders SET score = ? WHERE address = ?')
    .run(score, address);
}

export function updateTradeReason(tradeId: string, reason: string): void {
  getDb()
    .prepare('UPDATE trades SET reason = ? WHERE id = ?')
    .run(reason, tradeId);
}
