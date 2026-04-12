import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import * as queries from '../../db/queries.js';
import type { DetectedTrade, AnomalyAlert } from '../../types.js';

const log = createLogger('anomaly');

export class AnomalyDetector {

  /**
   * Analyze a trade for anomalies
   * Returns anomaly alert if detected, null otherwise
   * ACTION: alerts only, does NOT stop copying
   */
  analyze(trade: DetectedTrade): AnomalyAlert | null {
    // Get trader's recent history
    const recentTrades = queries.getTradesByTrader(trade.traderAddress, 50);

    if (recentTrades.length < 5) {
      // Not enough history to detect anomalies
      return null;
    }

    // Check 1: Abnormal trade size (> 3x average)
    const avgSize = recentTrades.reduce((s, t) => s + t.totalUsd, 0) / recentTrades.length;
    if (trade.usdValue > avgSize * config.anomalySizeMultiplier) {
      const alert: AnomalyAlert = {
        id: 0,
        traderId: trade.traderAddress,
        tradeId: trade.id,
        type: 'size',
        severity: trade.usdValue > avgSize * config.anomalySizeMultiplier * 2 ? 'high' : 'medium',
        message: `Trade size $${trade.usdValue.toFixed(2)} is ${(trade.usdValue / avgSize).toFixed(1)}x the average ($${avgSize.toFixed(2)})`,
        timestamp: new Date().toISOString(),
      };

      this.recordAnomaly(alert);
      log.warn({ alert }, 'SIZE ANOMALY detected');
      return alert;
    }

    // Check 2: Unusual market (not in trader's recent history)
    const recentMarkets = new Set(recentTrades.map(t => t.conditionId));
    if (!recentMarkets.has(trade.conditionId)) {
      // Check if this is really unusual — trader could just be exploring
      const uniqueMarkets = recentMarkets.size;
      if (uniqueMarkets > 3) {
        // Trader trades in multiple markets, a new one is less suspicious
        // Only flag if they've been very consistent
        const topMarket = this.getMostFrequentMarket(recentTrades);
        const topFreq = topMarket ? topMarket.count / recentTrades.length : 0;

        if (topFreq > 0.7) {
          // Trader usually trades one market, this is unusual
          const alert: AnomalyAlert = {
            id: 0,
            traderId: trade.traderAddress,
            tradeId: trade.id,
            type: 'market',
            severity: 'low',
            message: `Trading in unfamiliar market "${trade.marketTitle}" (usually trades ${topMarket?.slug ?? 'unknown'})`,
            timestamp: new Date().toISOString(),
          };

          this.recordAnomaly(alert);
          log.warn({ alert }, 'MARKET ANOMALY detected');
          return alert;
        }
      }
    }

    // Check 3: Unusual frequency (> 3x normal rate)
    if (recentTrades.length >= 10) {
      const timestamps = recentTrades.map(t => new Date(t.timestamp).getTime()).sort();
      const intervals = timestamps.slice(1).map((t, i) => t - timestamps[i]);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      // Check last few trades
      const recentInterval = timestamps.length >= 2
        ? timestamps[timestamps.length - 1] - timestamps[timestamps.length - 2]
        : Infinity;

      if (avgInterval > 0 && recentInterval < avgInterval / config.anomalySizeMultiplier) {
        const alert: AnomalyAlert = {
          id: 0,
          traderId: trade.traderAddress,
          tradeId: trade.id,
          type: 'frequency',
          severity: 'medium',
          message: `Trading frequency spike: last trade ${(recentInterval / 60000).toFixed(1)}min ago vs avg ${(avgInterval / 60000).toFixed(1)}min`,
          timestamp: new Date().toISOString(),
        };

        this.recordAnomaly(alert);
        log.warn({ alert }, 'FREQUENCY ANOMALY detected');
        return alert;
      }
    }

    return null;
  }

  /**
   * Get recent anomaly alerts
   */
  getAlerts(opts?: { traderAddress?: string; severity?: string; limit?: number }): AnomalyAlert[] {
    return queries.getAnomalies(opts);
  }

  private recordAnomaly(alert: AnomalyAlert): void {
    queries.insertAnomaly({
      traderId: alert.traderId,
      tradeId: alert.tradeId,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
    });
  }

  private getMostFrequentMarket(trades: Array<{ conditionId: string; marketSlug: string }>): { slug: string; count: number } | null {
    const counts = new Map<string, { slug: string; count: number }>();
    for (const t of trades) {
      const entry = counts.get(t.conditionId) ?? { slug: t.marketSlug, count: 0 };
      entry.count++;
      counts.set(t.conditionId, entry);
    }

    let best: { slug: string; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    return best;
  }
}
