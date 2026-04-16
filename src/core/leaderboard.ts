import { DataApi } from '../api/data-api.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import * as queries from '../db/queries.js';
import type { TrackedTrader, LeaderboardEntry, TradeEntry } from '../types.js';
import { broadcastEvent } from '../dashboard/routes/sse.js';
import { AdaptiveWeights } from './strategy/adaptive-weights.js';
import { TraderCorrelation } from './strategy/correlation.js';

const log = createLogger('leaderboard');

/** Small delay between per-trader API calls to avoid rate-limiting. */
const RATE_LIMIT_DELAY_MS = 250;

export class Leaderboard {
  private dataApi: DataApi;
  readonly adaptiveWeights: AdaptiveWeights;
  private correlation: TraderCorrelation;

  constructor(dataApi?: DataApi) {
    this.dataApi = dataApi ?? new DataApi();
    this.adaptiveWeights = new AdaptiveWeights();
    this.correlation = new TraderCorrelation(this.dataApi);
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

    // 2. Enrich each trader with win rate from their trade history
    const scored: TrackedTrader[] = [];
    for (const entry of entries) {
      try {
        const trades = await this.dataApi.getTrades(entry.address, 100);
        const lastTradeTs = trades.length > 0
          ? Math.max(...trades.map((t) => t.timestamp))
          : 0;
        const heuristicWinRate = this.calculateWinRate(trades);

        // Check DB for real win rate from resolved markets (written by backfill)
        const dbTrader = queries.getTraderByAddress(entry.address);
        const hasRealWinRate =
          dbTrader != null &&
          dbTrader.resolvedTradesCount != null &&
          dbTrader.resolvedTradesCount >= config.minResolvedTradesForRealWinRate &&
          dbTrader.realizedWinRate != null;

        const winRate = hasRealWinRate ? (dbTrader!.realizedWinRate as number) : heuristicWinRate;
        const confidence = hasRealWinRate ? (dbTrader!.confidence ?? 1) : 1;
        const score = this.calculateScore(entry, winRate, trades.length, confidence);

        log.debug(
          {
            address: entry.address,
            name: entry.name,
            score,
            winRateSource: hasRealWinRate ? 'realized' : 'heuristic',
            winRate,
            confidence,
          },
          'Trader scored',
        );

        scored.push({
          address: entry.address,
          name: entry.name || 'Unknown',
          pnl: entry.pnl,
          volume: entry.volume,
          winRate,
          score,
          tradesCount: trades.length,
          lastSeenTimestamp: lastTradeTs || Math.floor(Date.now() / 1000),
          addedAt: new Date().toISOString(),
          active: true,
          exitOnly: false,
          probation: false,
          probationTradesLeft: 0,
          realizedWinRate: hasRealWinRate ? winRate : undefined,
          resolvedTradesCount: dbTrader?.resolvedTradesCount,
          confidence: hasRealWinRate ? confidence : undefined,
        });
      } catch (err) {
        log.warn({ address: entry.address, err }, 'Failed to enrich trader, skipping');
      }

      // Rate-limit between per-trader API calls
      await sleep(RATE_LIMIT_DELAY_MS);
    }

    // 3. Filter
    const filtered = this.filterByActivity(scored);

    // 4. Rank by composite score DESC.
    filtered.sort((a, b) => b.score - a.score);

    // 5. Correlation-based diversification (when threshold < 1.0 and we have extras).
    let topN: TrackedTrader[];
    if (
      config.maxPairwiseCorrelation < 1.0 &&
      filtered.length > config.topTradersCount
    ) {
      try {
        const matrix = await this.correlation.computeCorrelationMatrix(
          filtered.map((f) => f.address),
        );
        topN = this.correlation.selectDiversified(
          filtered,
          config.topTradersCount,
          matrix,
          config.maxPairwiseCorrelation,
        );
        log.info(
          { beforeCorr: filtered.length, afterCorr: topN.length },
          'Correlation diversification applied',
        );
      } catch (err) {
        log.warn({ err }, 'Correlation computation failed — falling back to score-only selection');
        topN = filtered.slice(0, config.topTradersCount);
      }
    } else {
      topN = filtered.slice(0, config.topTradersCount);
    }

    log.info(
      { requested: config.topTradersCount, scored: scored.length, filtered: topN.length },
      'Scoring complete',
    );

    return topN;
  }

  /**
   * Composite score calculation from spec:
   * P&L (40%) + Win Rate (25%) + Volume (15%) + Trade Count (10%) + Consistency (10%)
   *
   * Optional `confidence` (0–1) is applied as a multiplier to the final score.
   * This allows traders with fewer resolved markets to be penalised proportionally.
   */
  calculateScore(entry: LeaderboardEntry, winRate: number, tradesCount: number, confidence = 1): number {
    // Normalize each component to 0-100 scale
    // PnL: signed log scale so traders with negative PnL are penalised
    // (previously floored to 0, letting losers rank high via volume/winrate).
    const pnlSign = entry.pnl >= 0 ? 1 : -1;
    const pnlMagnitude = Math.min(100, (Math.log10(Math.max(1, Math.abs(entry.pnl))) / 7) * 100);
    const pnlScore = pnlSign * pnlMagnitude;

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

    const weights = this.adaptiveWeights.getCurrentWeights();

    const rawScore =
      pnlScore * weights.roi +
      winRateScore * weights.winRate +
      volumeScore * weights.sizeProximity +
      tradesScore * weights.frequency +
      consistencyScore * weights.consistency;

    return rawScore * Math.max(0, Math.min(1, confidence));
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
    const MAX_AGE_SECONDS = 7 * 24 * 3600; // 7 days
    const now = Math.floor(Date.now() / 1000);
    return traders.filter((t) => {
      // Min volume filter (from config)
      if (config.minTraderVolume > 0 && t.volume < config.minTraderVolume) return false;
      // Min trades
      if (t.tradesCount < 3) return false;
      // Recency: drop traders whose last trade is older than 7 days.
      // Polymarket v1 leaderboard returns stale/cumulative PnL for inactive
      // traders — this filter ensures we only copy people actually trading.
      if (t.lastSeenTimestamp > 0 && now - t.lastSeenTimestamp > MAX_AGE_SECONDS) {
        log.info(
          { address: t.address, name: t.name, lastTradeSec: now - t.lastSeenTimestamp },
          'Trader filtered out: no recent trades',
        );
        return false;
      }
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

  /**
   * Re-score all active traders in DB using realized_win_rate where available.
   * Called after backfill completes so that the latest win-rate data is reflected
   * in each trader's stored score without a full API leaderboard refresh.
   */
  rescoreWithRealWinRates(): void {
    log.info('rescoreWithRealWinRates: updating scores for active traders');

    const active = queries.getActiveTraders();
    let updated = 0;

    for (const trader of active) {
      const hasRealWinRate =
        trader.resolvedTradesCount != null &&
        trader.resolvedTradesCount >= config.minResolvedTradesForRealWinRate &&
        trader.realizedWinRate != null;

      if (!hasRealWinRate) continue;

      const winRate = trader.realizedWinRate as number;
      const confidence = trader.confidence ?? 1;

      // Build a minimal LeaderboardEntry from the stored trader data
      const entry = {
        address: trader.address,
        name: trader.name,
        pnl: trader.pnl,
        volume: trader.volume,
        markets_traded: 0,
        positions_value: 0,
        rank: 0,
      };

      const newScore = this.calculateScore(entry, winRate, trader.tradesCount, confidence);

      queries.updateTraderScore(trader.address, newScore);
      updated++;

      log.debug(
        { address: trader.address, name: trader.name, newScore, winRate, confidence },
        'rescoreWithRealWinRates: trader score updated',
      );
    }

    log.info({ updated, total: active.length }, 'rescoreWithRealWinRates complete');

    broadcastEvent('leaderboard_rescored', { updated, total: active.length });
  }
}
