import { DataApi } from '../api/data-api.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import * as queries from '../db/queries.js';
import type { TrackedTrader, LeaderboardEntry, TradeEntry } from '../types.js';

const log = createLogger('leaderboard');

/** Small delay between per-trader API calls to avoid rate-limiting. */
const RATE_LIMIT_DELAY_MS = 250;

export class Leaderboard {
  private dataApi: DataApi;

  constructor(dataApi?: DataApi) {
    this.dataApi = dataApi ?? new DataApi();
  }

  /**
   * Main method: fetch leaderboard, score, filter, save
   */
  async fetchAndScore(): Promise<TrackedTrader[]> {
    log.info('Fetching leaderboard...');

    // 1. Get raw leaderboard from Data API (already sorted by PnL DESC).
    //    Use a generous buffer so enrichment failures + activity filter still
    //    leave us with at least `topTradersCount` valid entries.
    const fetchLimit = Math.max(30, config.topTradersCount * 3);
    const entries = await this.dataApi.getLeaderboard(
      config.leaderboardPeriod,
      'pnl',
      fetchLimit,
    );

    log.info({ requested: fetchLimit, fetched: entries.length }, 'Leaderboard entries fetched');

    // 2. Enrich each trader with trade history (up to 500 trades for frequency metrics)
    const scored: TrackedTrader[] = [];
    for (const entry of entries) {
      try {
        const trades = await this.dataApi.getTrades(entry.address, 500);
        const winRate = this.calculateWinRate(trades);
        const { tradesPerDay, avgTradeUsd, consistency } = this.calculateFrequencyMetrics(trades);
        const roi = entry.volume > 0 ? entry.pnl / entry.volume : 0;
        const score = this.calculateScore(roi, tradesPerDay, winRate, consistency, avgTradeUsd);

        scored.push({
          address: entry.address,
          name: entry.name || 'Unknown',
          pnl: entry.pnl,
          volume: entry.volume,
          winRate,
          score,
          tradesCount: trades.length,
          lastSeenTimestamp: Math.floor(Date.now() / 1000),
          addedAt: new Date().toISOString(),
          active: true,
          exitOnly: false,
          probation: false,
          probationTradesLeft: 0,
        });

        log.debug({
          address: entry.address, name: entry.name, score: score.toFixed(1),
          tradesPerDay: tradesPerDay.toFixed(1), roi: (roi * 100).toFixed(2) + '%',
          avgTradeUsd: avgTradeUsd.toFixed(0), consistency: (consistency * 100).toFixed(0) + '%',
        }, 'Trader scored');
      } catch (err) {
        log.warn({ address: entry.address, err }, 'Failed to enrich trader, skipping');
      }

      // Rate-limit between per-trader API calls
      await sleep(RATE_LIMIT_DELAY_MS);
    }

    // 3. Filter by hard gates
    const filtered = this.filterByActivity(scored);

    // 4. Rank by composite score DESC and take top N.
    filtered.sort((a, b) => b.score - a.score);
    const topN = filtered.slice(0, config.topTradersCount);

    log.info(
      { requested: config.topTradersCount, scored: scored.length, afterFilter: filtered.length, topN: topN.length },
      'Scoring complete',
    );

    return topN;
  }

  /**
   * NEW composite score: optimized for copy-trading on small deposits.
   * ROI 30% + Frequency 25% + WinRate 20% + Consistency 15% + SizeProximity 10%.
   */
  calculateScore(
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
   * Frequency metrics from trade history.
   */
  calculateFrequencyMetrics(trades: TradeEntry[]): {
    tradesPerDay: number;
    avgTradeUsd: number;
    consistency: number;
  } {
    if (trades.length === 0) return { tradesPerDay: 0, avgTradeUsd: 0, consistency: 0 };

    const timestamps = trades.map((t) => {
      const ts = typeof t.timestamp === 'string' ? new Date(t.timestamp).getTime() / 1000 : t.timestamp;
      return ts;
    });
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const spanDays = Math.max(1, (maxTs - minTs) / 86400);

    const tradesPerDay = trades.length / spanDays;
    const totalUsd = trades.reduce((s, t) => s + t.size * t.price, 0);
    const avgTradeUsd = totalUsd / trades.length;

    const uniqueDays = new Set(timestamps.map((ts) => Math.floor(ts / 86400))).size;
    const consistency = uniqueDays / Math.max(1, spanDays);

    return { tradesPerDay, avgTradeUsd, consistency };
  }

  /**
   * Calculate win rate from trade history.
   * Heuristic: BUY at price > 0.5 = bet on likely outcome (proxy for win).
   * In live we don't have resolved markets, so this approximation is kept
   * but with reduced weight (20% vs 25% in legacy).
   */
  calculateWinRate(trades: TradeEntry[]): number {
    if (trades.length === 0) return 0;
    const profitable = trades.filter((t) => t.price > 0.5).length;
    return profitable / trades.length;
  }

  /**
   * Hard gates: filter out traders unsuitable for copy-trading.
   */
  filterByActivity(traders: TrackedTrader[]): TrackedTrader[] {
    return traders.filter((t) => {
      // Min volume filter (from config)
      if (config.minTraderVolume > 0 && t.volume < config.minTraderVolume) return false;
      // Hard gates
      if (t.tradesCount < 10) return false;          // not enough data
      if (t.pnl < 0) return false;                   // losing trader
      return true;
    });
  }

  /**
   * Save scored traders to database
   */
  saveToDb(traders: TrackedTrader[]): void {
    log.info({ count: traders.length }, 'Saving traders to DB');
    for (const trader of traders) {
      queries.upsertTrader(trader);
    }
  }

  /**
   * Load active traders from database
   */
  loadFromDb(): TrackedTrader[] {
    return queries.getActiveTraders();
  }

  /**
   * Full pipeline: fetch, score, filter, save, return
   */
  async refresh(): Promise<TrackedTrader[]> {
    const traders = await this.fetchAndScore();
    this.saveToDb(traders);
    return traders;
  }
}
