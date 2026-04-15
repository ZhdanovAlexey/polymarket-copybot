import type { ScoringWeights } from '../../types.js';
import * as queries from '../../db/queries.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('adaptive-weights');

export const DEFAULT_WEIGHTS: ScoringWeights = {
  roi: 0.30,
  frequency: 0.25,
  winRate: 0.20,
  consistency: 0.15,
  sizeProximity: 0.10,
};

export class AdaptiveWeights {
  getCurrentWeights(): ScoringWeights {
    if (!config.adaptiveWeights) return DEFAULT_WEIGHTS;
    const latest = queries.getLatestScoringWeights();
    if (!latest) return DEFAULT_WEIGHTS;
    return {
      roi: latest.roi,
      frequency: latest.frequency,
      winRate: latest.winRate,
      consistency: latest.consistency,
      sizeProximity: latest.sizeProximity,
    };
  }

  /**
   * Recalculate weights based on Pearson correlation between each scoring
   * component value and the actual realized P&L per trader.
   *
   * Returns null if there is insufficient data (< 20 copied trades total,
   * < 3 traders, or NaN in Pearson computation).
   */
  recalculate(): ScoringWeights | null {
    // 1. Collect all trader performance rows
    const allPerf = queries.getAllPerformance();

    // Filter to traders with >= 5 copied trades
    const qualified = allPerf.filter((p) => p.copiedTrades >= 5);

    // Guard: need at least 3 traders
    if (qualified.length < 3) {
      log.warn({ qualifiedTraders: qualified.length }, 'Weights recalc skipped: < 3 qualified traders');
      return null;
    }

    // Guard: need at least 20 total copied trades
    const totalCopied = qualified.reduce((s, p) => s + p.copiedTrades, 0);
    if (totalCopied < 20) {
      log.warn({ totalCopied }, 'Weights recalc skipped: < 20 total copied trades');
      return null;
    }

    // 2. Build component vectors from tracked_traders DB data joined to performance
    const componentVectors: Record<keyof ScoringWeights, number[]> = {
      roi: [],
      frequency: [],
      winRate: [],
      consistency: [],
      sizeProximity: [],
    };
    const pnlVector: number[] = [];

    for (const perf of qualified) {
      const trader = queries.getTraderByAddress(perf.traderId);
      if (!trader) continue;

      // roi → PnL normalized (same sign-log used in calculateScore)
      const pnlSign = trader.pnl >= 0 ? 1 : -1;
      const roiVal = pnlSign * (Math.log10(Math.max(1, Math.abs(trader.pnl))) / 7) * 100;

      // frequency → trades count (capped at 100)
      const freqVal = Math.min(100, trader.tradesCount);

      // winRate → direct percentage
      const winRateVal = (trader.winRate ?? 0) * 100;

      // consistency → winRate * min(tradesCount, 50)/50
      const consistencyVal = Math.min(100, (trader.winRate ?? 0) * 100 * (Math.min(trader.tradesCount, 50) / 50));

      // sizeProximity → volume log-scaled
      const sizePVal = Math.min(100, Math.max(0, (Math.log10(Math.max(1, trader.volume)) / 8) * 100));

      componentVectors.roi.push(roiVal);
      componentVectors.frequency.push(freqVal);
      componentVectors.winRate.push(winRateVal);
      componentVectors.consistency.push(consistencyVal);
      componentVectors.sizeProximity.push(sizePVal);
      pnlVector.push(perf.totalPnl);
    }

    if (pnlVector.length < 3) {
      log.warn({ dataPoints: pnlVector.length }, 'Weights recalc skipped: < 3 data points after trader lookup');
      return null;
    }

    // 3. Compute Pearson correlation for each component with realized P&L
    const current = this.getCurrentWeights();
    const componentKeys = Object.keys(componentVectors) as Array<keyof ScoringWeights>;

    const rawWeights: Partial<Record<keyof ScoringWeights, number>> = {};
    for (const key of componentKeys) {
      const corr = pearsonCorrelation(componentVectors[key], pnlVector);
      if (Number.isNaN(corr)) {
        log.warn({ key }, 'Weights recalc: NaN Pearson correlation — aborting');
        return null;
      }
      // Negative correlation → 0 (penalise, don't invert)
      rawWeights[key] = Math.max(0, corr);
    }

    // 4. Normalize raw weights to sum → 1
    const rawSum = componentKeys.reduce((s, k) => s + (rawWeights[k] ?? 0), 0);
    if (rawSum === 0) {
      log.warn('Weights recalc: all raw weights are zero — returning defaults');
      return DEFAULT_WEIGHTS;
    }

    const normalized: Partial<Record<keyof ScoringWeights, number>> = {};
    for (const key of componentKeys) {
      normalized[key] = (rawWeights[key] ?? 0) / rawSum;
    }

    // 5. Bayesian smoothing: 0.7 * raw + 0.3 * current
    const smoothed: Partial<Record<keyof ScoringWeights, number>> = {};
    for (const key of componentKeys) {
      smoothed[key] = 0.7 * (normalized[key] ?? 0) + 0.3 * current[key];
    }

    // 6. Clamp [0.05, 0.50]
    for (const key of componentKeys) {
      smoothed[key] = Math.max(0.05, Math.min(0.50, smoothed[key] ?? 0));
    }

    // 7. Renormalize after clamp
    const clampedSum = componentKeys.reduce((s, k) => s + (smoothed[k] ?? 0), 0);
    for (const key of componentKeys) {
      smoothed[key] = (smoothed[key] ?? 0) / clampedSum;
    }

    const newWeights: ScoringWeights = {
      roi: smoothed.roi!,
      frequency: smoothed.frequency!,
      winRate: smoothed.winRate!,
      consistency: smoothed.consistency!,
      sizeProximity: smoothed.sizeProximity!,
    };

    // 8. Persist
    queries.insertScoringWeights({ ...newWeights, source: 'auto' });

    log.info(
      { weights: newWeights, traders: pnlVector.length, totalCopied },
      'Scoring weights recalculated',
    );

    return newWeights;
  }
}

// ---------------------------------------------------------------------------
// Pearson correlation helper
// ---------------------------------------------------------------------------

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;
  return num / denom;
}
