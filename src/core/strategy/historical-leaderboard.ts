import type { BtDataset, BtTradeActivity } from '../../types.js';

interface TraderSnapshot {
  address: string;
  pnl: number;
  volume: number;
  tradesCount: number;
  winRate: number;
  score: number;
}

/**
 * Score a single trader using data in window [T - windowSeconds, T).
 * Win rate uses ground-truth resolutions (not heuristic price > 0.5).
 *
 * @param windowSeconds  Duration of the lookback window in the same units as
 *                       BtTradeActivity.timestamp (Unix seconds). Pass
 *                       `days * 86400` from the caller.
 */
export function scoreTraderAtTime(
  address: string,
  ds: BtDataset,
  T: number,
  windowSeconds: number,
): TraderSnapshot {
  const windowStart = T - windowSeconds;

  const windowTrades = ds.trades.filter(
    (t) => t.address === address && t.timestamp >= windowStart && t.timestamp < T,
  );

  if (windowTrades.length === 0) {
    return { address, pnl: 0, volume: 0, tradesCount: 0, winRate: 0, score: 0 };
  }

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
  const score = calculateScore(pnl, volume, windowTrades.length, winRateVal);

  return { address, pnl, volume, tradesCount: windowTrades.length, winRate: winRateVal, score };
}

/**
 * Pick top-N traders by composite score at time T.
 * Traders with zero trades in the window are excluded.
 */
export function pickTopN(
  ds: BtDataset,
  T: number,
  windowSeconds: number,
  topN: number,
): TraderSnapshot[] {
  const snapshots = ds.universe
    .map((addr) => scoreTraderAtTime(addr, ds, T, windowSeconds))
    .filter((s) => s.tradesCount > 0);

  snapshots.sort((a, b) => b.score - a.score);
  return snapshots.slice(0, topN);
}

/**
 * Composite score formula (mirrored from leaderboard.ts:90-122).
 * PnL 40% + WinRate 25% + Volume 15% + TradeCount 10% + Consistency 10%.
 */
function calculateScore(pnl: number, volume: number, tradesCount: number, winRate: number): number {
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
