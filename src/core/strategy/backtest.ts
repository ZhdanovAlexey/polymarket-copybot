import { DataApi } from '../../api/data-api.js';
import { createLogger } from '../../utils/logger.js';
import { generateId } from '../../utils/helpers.js';
import * as queries from '../../db/queries.js';
import type { BacktestConfig, BacktestResult, ActivityEntry } from '../../types.js';

const log = createLogger('backtest');

export class Backtester {
  private dataApi: DataApi;

  constructor(dataApi?: DataApi) {
    this.dataApi = dataApi ?? new DataApi();
  }

  /**
   * Run a backtest simulation
   */
  async run(cfg: BacktestConfig, onProgress?: (pct: number) => void): Promise<BacktestResult> {
    log.info({ config: cfg }, 'Starting backtest');

    const startDate = Date.now() - cfg.periodDays * 24 * 60 * 60 * 1000;
    const startTs = Math.floor(startDate / 1000);

    // Track state
    let equity = 1000; // Start with $1000 virtual capital
    const equityCurve: Array<{ timestamp: number; equity: number }> = [
      { timestamp: startTs, equity },
    ];
    const traderPnl: Map<string, { pnl: number; trades: number; name: string }> = new Map();
    let totalTrades = 0;
    let wins = 0;
    let maxEquity = equity;
    let maxDrawdown = 0;
    const positions: Map<string, { shares: number; avgPrice: number; invested: number }> =
      new Map();

    // Fetch historical activity for each trader
    for (let i = 0; i < cfg.traders.length; i++) {
      const addr = cfg.traders[i]!;

      try {
        const activities: ActivityEntry[] = await this.dataApi.getActivity(addr, {
          type: 'TRADE',
          start: startTs,
          sortBy: 'TIMESTAMP',
          sortDirection: 'ASC',
        });

        log.debug({ trader: addr, activities: activities.length }, 'Fetched trader history');

        for (const activity of activities) {
          // Simulate BUY
          if (activity.action === 'buy' || !activity.action?.includes('sell')) {
            const cost = Math.min(cfg.betSize, equity);
            if (cost <= 0) continue;

            const price = activity.price || 0.5;
            const shares = cost / price;

            // Check slippage
            if (cfg.maxSlippage > 0) {
              // In backtest, assume some slippage
              const slippage = Math.random() * cfg.maxSlippage;
              if (slippage > cfg.maxSlippage) continue;
            }

            // Check max positions
            if (positions.size >= cfg.maxPositions) continue;

            equity -= cost;

            const key = activity.token_id || activity.condition_id;
            const existing = positions.get(key);
            if (existing) {
              existing.shares += shares;
              existing.invested += cost;
              existing.avgPrice = existing.invested / existing.shares;
            } else {
              positions.set(key, { shares, avgPrice: price, invested: cost });
            }

            totalTrades++;
          }

          // Simulate SELL
          if (activity.action === 'sell') {
            const key = activity.token_id || activity.condition_id;
            const pos = positions.get(key);
            if (!pos) continue;

            const sellPrice = activity.price || 0.5;
            const revenue = pos.shares * sellPrice;
            const pnl = revenue - pos.invested;

            equity += revenue;
            positions.delete(key);

            if (pnl > 0) wins++;
            totalTrades++;

            // Track per-trader P&L
            const tp = traderPnl.get(addr) ?? { pnl: 0, trades: 0, name: '' };
            tp.pnl += pnl;
            tp.trades++;
            traderPnl.set(addr, tp);
          }

          // Record equity curve point
          equityCurve.push({ timestamp: activity.timestamp, equity });

          // Track drawdown
          if (equity > maxEquity) maxEquity = equity;
          const dd = ((maxEquity - equity) / maxEquity) * 100;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      } catch (err) {
        log.warn({ trader: addr, err }, 'Failed to fetch trader history for backtest');
      }

      if (onProgress) {
        onProgress(((i + 1) / cfg.traders.length) * 100);
      }
    }

    // Close remaining open positions at last known price (assume 0.5)
    for (const [, pos] of positions) {
      equity += pos.shares * 0.5;
    }

    // Calculate Sharpe (simplified)
    const returns = equityCurve
      .slice(1)
      .map((p, i) => (p.equity - equityCurve[i]!.equity) / equityCurve[i]!.equity);
    const avgReturn =
      returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn =
      returns.length > 1
        ? Math.sqrt(returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / (returns.length - 1))
        : 0;
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    const result: BacktestResult = {
      id: generateId(),
      config: cfg,
      totalPnl: equity - 1000,
      winRate: totalTrades > 0 ? wins / totalTrades : 0,
      maxDrawdown,
      sharpe,
      tradeCount: totalTrades,
      equityCurve,
      traderBreakdown: Array.from(traderPnl.entries()).map(([addr, data]) => ({
        address: addr,
        name: data.name || addr.substring(0, 10),
        pnl: data.pnl,
        trades: data.trades,
      })),
      ranAt: new Date().toISOString(),
    };

    // Save to DB
    queries.insertBacktest(result);

    log.info(
      {
        pnl: result.totalPnl.toFixed(2),
        winRate: (result.winRate * 100).toFixed(1),
        trades: result.tradeCount,
        sharpe: result.sharpe.toFixed(2),
      },
      'Backtest complete',
    );

    return result;
  }

  /**
   * Compare multiple strategy configurations
   */
  async compareStrategies(configs: BacktestConfig[]): Promise<BacktestResult[]> {
    const results: BacktestResult[] = [];
    for (const cfg of configs) {
      const result = await this.run(cfg);
      results.push(result);
    }
    return results;
  }

  /**
   * List previous backtest results
   */
  listResults(limit = 20): BacktestResult[] {
    return queries.listBacktests(limit);
  }

  /**
   * Get a specific backtest result
   */
  getResult(id: string): BacktestResult | undefined {
    return queries.getBacktest(id);
  }
}
