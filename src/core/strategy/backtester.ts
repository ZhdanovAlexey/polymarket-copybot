import { pickTopN } from './historical-leaderboard.js';
import { computeConviction } from './conviction.js';
import { calmar, sharpe, winRate } from './metrics.js';
import type {
  BtDataset, BtTradeActivity, BacktestSimConfig, BacktestSimResult,
  DailyEquityPoint, SimPosition,
} from '../../types.js';

const DAY_SECONDS = 86400;

/**
 * Run a time-indexed backtest over [startTs, endTs).
 * Pure function — all data comes from BtDataset (pre-loaded in memory).
 */
export function runBacktest(
  ds: BtDataset,
  config: BacktestSimConfig,
  startTs: number,
  endTs: number,
): BacktestSimResult {
  // Align to day boundaries so tradesByDay index keys always match loop iterations.
  const alignedStart = Math.floor(startTs / DAY_SECONDS) * DAY_SECONDS;
  const alignedEnd = Math.ceil(endTs / DAY_SECONDS) * DAY_SECONDS;

  let equity = config.initialCapital;
  let maxEquity = equity;
  let maxDrawdown = 0;
  const equityCurve: DailyEquityPoint[] = [{ dayTs: alignedStart, equity }];
  const positions = new Map<string, SimPosition>();
  let tradeCount = 0;
  let closedWins = 0;
  let closedTotal = 0;
  let totalTtrDays = 0;

  // Pre-index trades by day for fast lookup
  const tradesByDay = new Map<number, BtTradeActivity[]>();
  for (const t of ds.trades) {
    if (t.timestamp < alignedStart || t.timestamp >= alignedEnd) continue;
    const dayStart = Math.floor(t.timestamp / DAY_SECONDS) * DAY_SECONDS;
    const arr = tradesByDay.get(dayStart);
    if (arr) arr.push(t);
    else tradesByDay.set(dayStart, [t]);
  }

  // Pre-build per-trader recent USD values for F2 z-score
  // Map address → array of usdValues (most recent 50 before current trade)
  const traderUsdHistory = new Map<string, number[]>();

  // Pre-build consensus index: for each (tokenId, day) → set of addresses
  const consensusIndex = new Map<string, Set<string>>();
  for (const t of ds.trades) {
    if (t.action !== 'buy' || t.timestamp < alignedStart || t.timestamp >= alignedEnd) continue;
    const dayStart = Math.floor(t.timestamp / DAY_SECONDS) * DAY_SECONDS;
    const key = `${t.tokenId}_${dayStart}`;
    const set = consensusIndex.get(key);
    if (set) set.add(t.address);
    else consensusIndex.set(key, new Set([t.address]));
  }

  // Day-by-day simulation
  for (let dayTs = alignedStart; dayTs < alignedEnd; dayTs += DAY_SECONDS) {
    // 1. Rebuild leaderboard for this day.
    // Use end-of-day (dayTs + DAY_SECONDS) as T so today's trades count for today's leaderboard.
    const topTraders = pickTopN(ds, dayTs + DAY_SECONDS, config.leaderboardWindowDays, config.topN, 1);
    const activeSet = new Set(topTraders.map((t) => t.address));
    const traderScoreMap = new Map(topTraders.map((t) => [t.address, t.score]));

    // 2. Process today's trades
    const todayTrades = tradesByDay.get(dayTs) ?? [];
    for (const trade of todayTrades) {
      if (!activeSet.has(trade.address)) continue;

      if (trade.action === 'buy') {
        // H7 gate: check time-to-resolution
        if (config.maxTtrDays !== Infinity) {
          const market = ds.markets.get(trade.conditionId);
          if (!market?.endDate) continue; // skip unknown endDate
          const endDateTs = new Date(market.endDate).getTime() / 1000;
          const ttrDays = (endDateTs - trade.timestamp) / DAY_SECONDS;
          if (ttrDays > config.maxTtrDays) continue;
        }

        // Max positions gate
        if (positions.size >= config.maxPositions) continue;

        // Conviction sizing
        const recentUsd = traderUsdHistory.get(trade.address) ?? [];
        const traderScore = traderScoreMap.get(trade.address) ?? 0;
        const consensusKey = `${trade.tokenId}_${dayTs}`;
        const consensusCount = (consensusIndex.get(consensusKey)?.size ?? 1) - 1; // exclude self
        const betUsd = computeConviction(trade, config.conviction, recentUsd, traderScore, consensusCount);

        // Cost modeling
        const cost = Math.min(betUsd, equity);
        if (cost <= 0) continue;
        const slippageAdj = 1 + config.slippagePct / 100;
        const effectivePrice = trade.price * slippageAdj;
        const shares = cost / effectivePrice;
        const commission = cost * config.commissionPct / 100;
        equity -= cost + commission;

        // Track position
        const key = trade.tokenId;
        const existing = positions.get(key);
        if (existing) {
          existing.invested += cost;
          existing.shares += shares;
          existing.avgPrice = existing.invested / existing.shares;
        } else {
          positions.set(key, {
            tokenId: trade.tokenId, conditionId: trade.conditionId,
            shares, avgPrice: effectivePrice, invested: cost, openedAtTs: trade.timestamp,
          });
        }
        tradeCount++;

        // Update trader USD history for F2
        const hist = traderUsdHistory.get(trade.address) ?? [];
        hist.push(trade.usdValue);
        if (hist.length > 50) hist.shift();
        traderUsdHistory.set(trade.address, hist);

      } else if (trade.action === 'sell') {
        // Close position if we hold it
        const pos = positions.get(trade.tokenId);
        if (!pos) continue;
        const slippageAdj = 1 - config.slippagePct / 100;
        const revenue = pos.shares * trade.price * slippageAdj;
        const commission = revenue * config.commissionPct / 100;
        equity += revenue - commission;
        const pnl = revenue - commission - pos.invested;
        if (pnl > 0) closedWins++;
        closedTotal++;
        const ttr = (trade.timestamp - pos.openedAtTs) / DAY_SECONDS;
        totalTtrDays += ttr;
        positions.delete(trade.tokenId);
        tradeCount++;
      }
    }

    // 3. Mark-to-market: close resolved positions
    for (const [tokenId, pos] of positions) {
      const winner = ds.resolutions.get(pos.conditionId);
      if (winner === undefined) continue; // not resolved yet
      // Market resolved — settle
      const isWinner = tokenId === winner;
      const settlement = isWinner ? pos.shares * 1.0 : 0;
      equity += settlement;
      const pnl = settlement - pos.invested;
      if (pnl > 0) closedWins++;
      closedTotal++;
      const ttr = (dayTs - pos.openedAtTs) / DAY_SECONDS;
      totalTtrDays += ttr;
      positions.delete(tokenId);
    }

    // 4. Track equity + drawdown
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity > 0 ? ((maxEquity - equity) / maxEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ dayTs, equity });
  }

  // Close remaining open positions at last known price (assume 0.5 as neutral)
  for (const [, pos] of positions) {
    equity += pos.shares * 0.5;
    closedTotal++;
  }

  const totalPnl = equity - config.initialCapital;
  const equityValues = equityCurve.map((p) => p.equity);

  return {
    config,
    calmar: calmar(totalPnl, maxDrawdown),
    totalPnl,
    maxDrawdown,
    sharpe: sharpe(equityValues),
    winRate: winRate(closedWins, closedTotal),
    tradeCount,
    avgTtrDays: closedTotal > 0 ? totalTtrDays / closedTotal : 0,
    equityCurve,
  };
}
