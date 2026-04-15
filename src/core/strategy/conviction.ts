import { config } from '../../config.js';
import { convictionStore } from './conviction-store.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('conviction');

/**
 * Compute the conviction-adjusted bet size in USD.
 *
 * Factors:
 *  F1 = size factor   — clamp(traderUsd / f1Anchor, 1.0, f1Max)
 *  F2 = win-rate      — 1.0 + w2 * (winRate - 0.5) * 2  (neutral at 50%)
 *  F3 = score         — 1.0 + w3 * normalizedScore      (score in [0,1])
 *  F4 = boost         — f4Boost when trader is top-performer (score >= 0.8), else 1.0
 *  F5 = market age    — <24h=1.2, <72h=1.0, <168h=0.9, >168h=0.7 (optional)
 *
 * Final: bet = betBase * betSizeUsd * F1 * F2 * F3 * F4 * F5
 */
export function computeConviction(opts: {
  traderUsd: number;
  winRate: number;
  score: number;
  marketAgeHours?: number;
}): number {
  const params = convictionStore.getParams();
  const { traderUsd, winRate, score, marketAgeHours } = opts;

  // F1: trade size factor
  const rawF1 = traderUsd > 0 ? traderUsd / params.f1Anchor : 1.0;
  const f1 = Math.min(params.f1Max, Math.max(1.0, rawF1));

  // F2: win rate factor (neutral at 50%)
  const clampedWr = Math.max(0, Math.min(1, winRate));
  const f2 = 1.0 + params.w2 * (clampedWr - 0.5) * 2;

  // F3: score factor (score assumed in [0,1])
  const clampedScore = Math.max(0, Math.min(1, score));
  const f3 = 1.0 + params.w3 * clampedScore;

  // F4: top-performer boost
  const f4 = clampedScore >= 0.8 ? params.f4Boost : 1.0;

  // F5: market age factor
  let f5 = 1.0;
  if (marketAgeHours !== undefined && config.marketAgeFactorEnabled) {
    if (marketAgeHours < 24) f5 = 1.2;
    else if (marketAgeHours < 72) f5 = 1.0;
    else if (marketAgeHours < 168) f5 = 0.9;
    else f5 = 0.7;
  }

  const bet = params.betBase * config.betSizeUsd * f1 * f2 * f3 * f4 * f5;

  log.debug(
    { traderUsd, winRate, score, marketAgeHours, f1, f2, f3, f4, f5, bet: bet.toFixed(2) },
    'Conviction computed',
  );

  return bet;
}
