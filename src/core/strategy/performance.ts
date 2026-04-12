import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import * as queries from '../../db/queries.js';
import type { TraderPerformance, TradeResult } from '../../types.js';

const log = createLogger('performance');

export class PerformanceTracker {

  /**
   * Track P&L for a specific trade result
   */
  trackTrade(trade: TradeResult): void {
    const today = new Date().toISOString().split('T')[0];
    const existing = this.getTodayPerformance(trade.traderAddress, today);

    const isWin = trade.side === 'SELL' && trade.totalUsd > trade.originalTraderPrice * trade.size;

    const copiedTrades = (existing?.copiedTrades ?? 0) + 1;
    const wins = (existing?.wins ?? 0) + (isWin ? 1 : 0);
    const losses = (existing?.losses ?? 0) + (isWin ? 0 : 1);
    const totalPnl = (existing?.totalPnl ?? 0) + (trade.side === 'SELL' ? trade.totalUsd - trade.originalTraderPrice * trade.size : -trade.totalUsd);
    const slippageAvg = Math.abs(trade.price - trade.originalTraderPrice);

    queries.upsertPerformance({
      traderAddress: trade.traderAddress,
      date: today,
      copiedTrades,
      wins,
      losses,
      totalPnl,
      avgReturn: copiedTrades > 0 ? totalPnl / copiedTrades : 0,
      slippageAvg,
    });

    log.info(
      { traderAddress: trade.traderAddress, side: trade.side, isWin, totalPnl },
      'Tracked trade performance',
    );
  }

  /**
   * Get performance stats for a trader
   */
  getTraderStats(traderAddress: string): TraderPerformance | undefined {
    return queries.getPerformanceByTrader(traderAddress);
  }

  /**
   * Get all trader performance rankings
   */
  getAllStats(): TraderPerformance[] {
    return queries.getAllPerformance();
  }

  /**
   * Check if a trader should be dropped based on performance
   */
  shouldDrop(traderAddress: string): { drop: boolean; reason?: string } {
    const perf = queries.getPerformanceByTrader(traderAddress);
    if (!perf) return { drop: false };

    // Check consecutive losses (from recent trades)
    const recentTrades = queries.getTradesByTrader(traderAddress, 10);
    const recentSells = recentTrades.filter(t => t.side === 'SELL');

    let consecutiveLosses = 0;
    for (const t of recentSells) {
      if (t.totalUsd < t.originalTraderPrice * t.size) {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    if (consecutiveLosses >= 5) {
      log.warn(
        { traderAddress, consecutiveLosses },
        'Trader flagged for drop: consecutive losses',
      );
      return { drop: true, reason: `${consecutiveLosses} consecutive losing trades` };
    }

    // Check total P&L threshold
    if (perf.totalPnl < config.autoDropLossThreshold) {
      log.warn(
        { traderAddress, totalPnl: perf.totalPnl, threshold: config.autoDropLossThreshold },
        'Trader flagged for drop: P&L below threshold',
      );
      return { drop: true, reason: `Total P&L $${perf.totalPnl.toFixed(2)} below threshold $${config.autoDropLossThreshold}` };
    }

    return { drop: false };
  }

  /**
   * Get slippage report comparing our execution prices vs trader prices
   */
  getSlippageReport(): Array<{
    traderAddress: string;
    avgSlippage: number;
    tradeCount: number;
  }> {
    const allPerf = queries.getAllPerformance();
    log.info({ traderCount: allPerf.length }, 'Generated slippage report');
    return allPerf.map(p => ({
      traderAddress: p.traderId,
      avgSlippage: p.slippageAvg,
      tradeCount: p.copiedTrades,
    }));
  }

  private getTodayPerformance(traderAddress: string, _date: string): TraderPerformance | undefined {
    // This is a simplified version - in production, you'd query by specific date
    return queries.getPerformanceByTrader(traderAddress);
  }
}
