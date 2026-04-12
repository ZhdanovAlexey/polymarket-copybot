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

    // 1. Get raw leaderboard from Data API
    const entries = await this.dataApi.getLeaderboard(
      config.leaderboardPeriod,
      'pnl',
      config.topTradersCount * 2, // fetch extra to have buffer after filtering
    );

    log.info({ count: entries.length }, 'Leaderboard entries fetched');

    // 2. Enrich each trader with win rate from their trade history
    const scored: TrackedTrader[] = [];
    for (const entry of entries) {
      try {
        const trades = await this.dataApi.getTrades(entry.address, 100);
        const winRate = this.calculateWinRate(trades);
        const score = this.calculateScore(entry, winRate, trades.length);

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
          probation: false,
          probationTradesLeft: 0,
        });

        log.debug({ address: entry.address, name: entry.name, score }, 'Trader scored');
      } catch (err) {
        log.warn({ address: entry.address, err }, 'Failed to enrich trader, skipping');
      }

      // Rate-limit between per-trader API calls
      await sleep(RATE_LIMIT_DELAY_MS);
    }

    // 3. Filter
    const filtered = this.filterByActivity(scored);

    // 4. Sort by score and take top N
    filtered.sort((a, b) => b.score - a.score);
    const topN = filtered.slice(0, config.topTradersCount);

    log.info({ total: scored.length, filtered: topN.length }, 'Scoring complete');

    return topN;
  }

  /**
   * Composite score calculation from spec:
   * P&L (40%) + Win Rate (25%) + Volume (15%) + Trade Count (10%) + Consistency (10%)
   */
  calculateScore(entry: LeaderboardEntry, winRate: number, tradesCount: number): number {
    // Normalize each component to 0-100 scale
    // PnL: use log scale, cap at reasonable max
    const pnlScore = Math.min(100, Math.max(0, (Math.log10(Math.max(1, entry.pnl)) / 7) * 100));

    // Win rate: direct percentage
    const winRateScore = winRate * 100;

    // Volume: log scale
    const volumeScore = Math.min(
      100,
      Math.max(0, (Math.log10(Math.max(1, entry.volume)) / 8) * 100),
    );

    // Trade count: more trades = better, cap at 100+ trades
    const tradesScore = Math.min(100, (tradesCount / 100) * 100);

    // Consistency: simple heuristic -- high win rate + many trades = consistent
    const consistencyScore = Math.min(
      100,
      winRate * 100 * (Math.min(tradesCount, 50) / 50),
    );

    return (
      pnlScore * 0.4 +
      winRateScore * 0.25 +
      volumeScore * 0.15 +
      tradesScore * 0.1 +
      consistencyScore * 0.1
    );
  }

  /**
   * Calculate win rate from trade history.
   *
   * A "win" is hard to determine from trade data alone.
   * Heuristic: trades bought at price > 0.5 are bets on the likely outcome,
   * which correlates with successful prediction. This is a rough proxy that
   * can be refined later with resolved-market data.
   */
  calculateWinRate(trades: TradeEntry[]): number {
    if (trades.length === 0) return 0;

    const profitable = trades.filter((t) => t.price > 0.5).length;
    return profitable / trades.length;
  }

  /**
   * Filter traders by minimum activity thresholds
   */
  filterByActivity(traders: TrackedTrader[]): TrackedTrader[] {
    return traders.filter((t) => {
      // Min volume filter (from config)
      if (config.minTraderVolume > 0 && t.volume < config.minTraderVolume) return false;
      // Min trades
      if (t.tradesCount < 3) return false;
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
