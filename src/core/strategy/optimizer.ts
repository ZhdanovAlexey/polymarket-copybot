import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import * as queries from '../../db/queries.js';
import type { StrategyRecommendation } from '../../types.js';

const log = createLogger('optimizer');

export class ParameterOptimizer {

  /**
   * Kelly Criterion: optimal bet size
   * f* = (p * b - q) / b
   * where p = win probability, q = 1-p, b = avg win / avg loss ratio
   */
  optimalBetSize(): { kellyCriterion: number; recommendedBetSize: number; reason: string } {
    const allTrades = queries.getTrades({ limit: 200 });
    const completed = allTrades.filter(t =>
      (t.status === 'filled' || t.status === 'simulated') && t.side === 'SELL'
    );

    if (completed.length < 10) {
      return {
        kellyCriterion: 0,
        recommendedBetSize: config.betSizeUsd,
        reason: 'Not enough trade data (need at least 10 completed sells)'
      };
    }

    const wins = completed.filter(t => t.totalUsd > t.originalTraderPrice * t.size);
    const losses = completed.filter(t => t.totalUsd <= t.originalTraderPrice * t.size);

    const p = wins.length / completed.length;
    const q = 1 - p;

    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + (t.totalUsd - t.originalTraderPrice * t.size), 0) / wins.length
      : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + (t.totalUsd - t.originalTraderPrice * t.size), 0) / losses.length)
      : 1;

    const b = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly = b > 0 ? (p * b - q) / b : 0;

    // Apply fractional Kelly (half Kelly is more conservative)
    const halfKelly = Math.max(0, kelly * 0.5);

    // Translate to dollar amount (assume $1000 bankroll as reference)
    const bankroll = 1000;
    const recommended = Math.max(1, Math.min(100, Math.round(halfKelly * bankroll)));

    log.info({ kelly, halfKelly, recommended, winRate: p, avgWin, avgLoss }, 'Kelly calculation');

    return {
      kellyCriterion: kelly,
      recommendedBetSize: recommended,
      reason: `Win rate: ${(p * 100).toFixed(1)}%, Avg W/L ratio: ${b.toFixed(2)}, Kelly: ${(kelly * 100).toFixed(1)}%`,
    };
  }

  /**
   * Adaptive slippage based on recent execution data
   */
  adaptiveSlippage(): { recommended: number; reason: string } {
    const trades = queries.getTrades({ limit: 50 });
    const executed = trades.filter(t => t.status === 'filled' || t.status === 'simulated');

    if (executed.length < 5) {
      return { recommended: config.maxSlippagePct, reason: 'Not enough data' };
    }

    const slippages = executed.map(t =>
      Math.abs(t.price - t.originalTraderPrice) / Math.max(t.originalTraderPrice, 0.01) * 100
    );

    const avgSlippage = slippages.reduce((a, b) => a + b, 0) / slippages.length;
    const maxObserved = Math.max(...slippages);

    // Recommend: avg + 2 standard deviations
    const std = Math.sqrt(slippages.reduce((a, b) => a + (b - avgSlippage) ** 2, 0) / slippages.length);
    const recommended = Math.max(1, Math.min(20, Math.round((avgSlippage + 2 * std) * 10) / 10));

    return {
      recommended,
      reason: `Avg slippage: ${avgSlippage.toFixed(2)}%, Max: ${maxObserved.toFixed(2)}%, Recommended: ${recommended.toFixed(1)}%`,
    };
  }

  /**
   * Progressive de-risking: reduce position size during losing streaks
   */
  drawdownScaling(): { scaleFactor: number; reason: string } {
    const todayTrades = queries.getTodayTrades();
    const completed = todayTrades.filter(t => t.status === 'filled' || t.status === 'simulated');

    // Count recent consecutive losses
    let streak = 0;
    for (const t of completed.reverse()) {
      if (t.side === 'SELL' && t.totalUsd < t.originalTraderPrice * t.size) {
        streak++;
      } else if (t.side === 'SELL') {
        break;
      }
    }

    // Scale down: each loss reduces by 20%, min 20% of normal
    const scale = Math.max(0.2, 1 - streak * 0.2);

    return {
      scaleFactor: scale,
      reason: streak > 0
        ? `${streak} consecutive losses today, scaling to ${(scale * 100).toFixed(0)}%`
        : 'No losing streak',
    };
  }

  /**
   * Get all recommendations
   */
  getRecommendations(): StrategyRecommendation[] {
    const recommendations: StrategyRecommendation[] = [];

    // Bet size
    const kelly = this.optimalBetSize();
    if (kelly.recommendedBetSize !== config.betSizeUsd) {
      recommendations.push({
        param: 'betSizeUsd',
        currentValue: config.betSizeUsd,
        recommendedValue: kelly.recommendedBetSize,
        confidence: Math.min(1, kelly.kellyCriterion > 0 ? 0.7 : 0.3),
        reason: kelly.reason,
      });
    }

    // Slippage
    const slip = this.adaptiveSlippage();
    if (Math.abs(slip.recommended - config.maxSlippagePct) > 0.5) {
      recommendations.push({
        param: 'maxSlippagePct',
        currentValue: config.maxSlippagePct,
        recommendedValue: slip.recommended,
        confidence: 0.6,
        reason: slip.reason,
      });
    }

    // Position scaling
    const drawdown = this.drawdownScaling();
    if (drawdown.scaleFactor < 1) {
      recommendations.push({
        param: 'betSizeScale',
        currentValue: 1,
        recommendedValue: drawdown.scaleFactor,
        confidence: 0.8,
        reason: drawdown.reason,
      });
    }

    return recommendations;
  }

  /**
   * Auto-apply recommendations (if enabled)
   */
  autoApply(): void {
    if (!config.optimizerAutoApply) return;

    const recs = this.getRecommendations();
    for (const rec of recs) {
      if (rec.confidence >= 0.6) {
        queries.setSetting(`optimizer_${rec.param}`, String(rec.recommendedValue));
        log.info({ param: rec.param, value: rec.recommendedValue }, 'Auto-applied recommendation');
      }
    }
  }
}
