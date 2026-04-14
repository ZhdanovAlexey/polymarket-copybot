import type { ConvictionParams, BtTradeActivity } from '../../types.js';

/**
 * Compute conviction-sized bet in USD.
 *
 * @param trade         The trade signal being evaluated
 * @param params        Conviction parameters (from grid search)
 * @param recentUsd     Recent USD values for this trader (for F2 z-score, last 50)
 * @param traderScore   Composite leaderboard score at time T (0-100)
 * @param consensusCount Number of distinct tracked traders who bought same token in last 24h
 * @returns USD bet size (always >= betBase)
 */
export function computeConviction(
  trade: BtTradeActivity,
  params: ConvictionParams,
  recentUsd: number[],
  traderScore: number,
  consensusCount: number,
): number {
  // F1: absolute USD signal, clamped
  const f1Raw = params.f1Anchor > 0 ? trade.usdValue / params.f1Anchor : 1;
  const f1 = Math.max(1, Math.min(f1Raw, params.f1Max));

  // F2: z-score relative to trader's recent history
  let f2 = 1;
  if (params.w2 > 0 && recentUsd.length >= 3) {
    const mean = recentUsd.reduce((a, b) => a + b, 0) / recentUsd.length;
    const variance = recentUsd.reduce((a, b) => a + (b - mean) ** 2, 0) / recentUsd.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      const zscore = (trade.usdValue - mean) / std;
      const clampedZ = Math.max(-2, Math.min(zscore, 3));
      f2 = 1 + params.w2 * clampedZ;
    }
  }

  // F3: trader quality multiplier
  const f3 = 1 + params.w3 * (traderScore / 100);

  // F4: consensus boost (only if >= 2 other traders on same token)
  const f4 = consensusCount >= 2 ? params.f4Boost : 1.0;

  const bet = params.betBase * f1 * f2 * f3 * f4;

  // Floor at betBase (never bet less than base, even with negative z-score)
  return Math.max(params.betBase, bet);
}
