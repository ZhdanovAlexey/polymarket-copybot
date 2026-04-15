import type { BtDataset, BtTradeActivity } from '../../types.js';

export interface TraderSnapshot {
  address: string;
  pnl: number;
  volume: number;
  tradesCount: number;
  winRate: number;
  score: number;
  // New metrics for frequency-based scoring
  tradesPerDay: number;
  avgTradeUsd: number;
  roi: number;
  consistency: number; // unique trading days / window days
}

const DAY_SECONDS = 86400;

/**
 * Score a single trader using data in window [T - windowDays*86400, T).
 * Win rate uses ground-truth resolutions (not heuristic price > 0.5).
 */
export function scoreTraderAtTime(
  address: string,
  ds: BtDataset,
  T: number,
  windowDays: number,
  legacy = false,
): TraderSnapshot {
  const windowStart = T - windowDays * DAY_SECONDS;
  const traderTrades = ds.tradesByAddress?.get(address) ?? [];
  const windowTrades = traderTrades.filter(
    (t) => t.timestamp >= windowStart && t.timestamp < T,
  );

  const empty: TraderSnapshot = {
    address, pnl: 0, volume: 0, tradesCount: 0, winRate: 0, score: 0,
    tradesPerDay: 0, avgTradeUsd: 0, roi: 0, consistency: 0,
  };
  if (windowTrades.length === 0) return empty;

  let pnl = 0;
  let volume = 0;
  let wins = 0;
  let resolvedBuys = 0;

  for (const t of windowTrades) {
    volume += t.usdValue;
    if (t.action === 'buy') {
      const winner = ds.resolutions.get(t.conditionId);
      if (winner !== undefined) {
        resolvedBuys++;
        if (t.tokenId === winner) {
          pnl += t.size * (1 - t.price);
          wins++;
        } else {
          pnl -= t.size * t.price;
        }
      }
    }
  }

  const winRateVal = resolvedBuys > 0 ? wins / resolvedBuys : 0;

  // New frequency metrics
  const uniqueDays = new Set(windowTrades.map((t) => Math.floor(t.timestamp / DAY_SECONDS))).size;
  const tradesPerDay = windowTrades.length / windowDays;
  const avgTradeUsd = volume / windowTrades.length;
  const roi = volume > 0 ? pnl / volume : 0;
  const consistency = uniqueDays / windowDays;

  const score = legacy
    ? calculateScoreLegacy(pnl, volume, windowTrades.length, winRateVal)
    : calculateScore(roi, tradesPerDay, winRateVal, consistency, avgTradeUsd);

  return {
    address, pnl, volume, tradesCount: windowTrades.length, winRate: winRateVal, score,
    tradesPerDay, avgTradeUsd, roi, consistency,
  };
}

/**
 * Pick top-N traders by score at time T.
 * When legacy=false (default), applies hard gates for frequency-based scoring.
 */
export function pickTopN(
  ds: BtDataset,
  T: number,
  windowDays: number,
  topN: number,
  minTrades = 3,
  legacy = false,
): TraderSnapshot[] {
  const snapshots = ds.universe
    .map((addr) => scoreTraderAtTime(addr, ds, T, windowDays, legacy))
    .filter((s) => {
      if (legacy) {
        return s.tradesCount >= minTrades;
      }
      // Hard gates for new scoring
      if (s.tradesCount < 10) return false;         // not enough data
      if (s.pnl < 0) return false;                  // losing trader
      if (s.tradesPerDay < 1) return false;          // too infrequent
      if (s.avgTradeUsd > 50000) return false;       // whale, irrelevant for copy-trading
      return true;
    });

  snapshots.sort((a, b) => b.score - a.score);
  return snapshots.slice(0, topN);
}

/**
 * NEW scoring: optimized for copy-trading on small deposits.
 * ROI 30% + Frequency 25% + WinRate 20% + Consistency 15% + SizeProximity 10%.
 */
function calculateScore(
  roi: number,
  tradesPerDay: number,
  winRate: number,
  consistency: number,
  avgTradeUsd: number,
): number {
  // ROI: 10% ROI = score 100
  const roiScore = Math.min(100, Math.max(0, roi * 1000));
  // Frequency: 5 trades/day = score 100
  const freqScore = Math.min(100, tradesPerDay * 20);
  // Win rate: direct 0-100
  const winRateScore = winRate * 100;
  // Consistency: trades every day = 100
  const consistencyScore = consistency * 100;
  // Size proximity: bell curve centered on $500, σ=2 (log scale)
  const logAvg = Math.log(Math.max(1, avgTradeUsd));
  const logCenter = Math.log(500);
  const sizeScore = 100 * Math.exp(-((logAvg - logCenter) ** 2) / (2 * 2 * 2));

  return (
    roiScore * 0.30 +
    freqScore * 0.25 +
    winRateScore * 0.20 +
    consistencyScore * 0.15 +
    sizeScore * 0.10
  );
}

/**
 * LEGACY scoring (PnL 40% + WinRate 25% + Volume 15% + Trades 10% + Consistency 10%).
 * Kept for A/B comparison.
 */
function calculateScoreLegacy(pnl: number, volume: number, tradesCount: number, winRate: number): number {
  const pnlSign = pnl >= 0 ? 1 : -1;
  const pnlMagnitude = Math.min(100, (Math.log10(Math.max(1, Math.abs(pnl))) / 7) * 100);
  const pnlScore = pnlSign * pnlMagnitude;
  const winRateScore = winRate * 100;
  const volumeScore = Math.min(100, Math.max(0, (Math.log10(Math.max(1, volume)) / 8) * 100));
  const tradesScore = Math.min(100, (tradesCount / 100) * 100);
  const consistencyScore = Math.min(100, winRate * 100 * (Math.min(tradesCount, 50) / 50));

  return (
    pnlScore * 0.4 +
    winRateScore * 0.25 +
    volumeScore * 0.15 +
    tradesScore * 0.1 +
    consistencyScore * 0.1
  );
}
