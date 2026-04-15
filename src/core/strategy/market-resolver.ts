import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import * as queries from '../../db/queries.js';
import type { ClobClientWrapper } from '../../api/clob-client.js';
import type { DataApi } from '../../api/data-api.js';
import type { MarketResolution, RealizedWinRateResult } from '../../types.js';

const log = createLogger('market-resolver');

/** Inter-chunk pause to be gentle on rate limits. */
const CHUNK_PAUSE_MS = 250;

export class MarketResolver {
  /** Count of consecutive 429 responses; bumps inter-request delay when >= 3. */
  private consecutive429 = 0;
  private extraDelayMs = 0;

  constructor(
    private clobClient: ClobClientWrapper,
    private dataApi: DataApi,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Cache-first lookup for a single condition_id.
   *
   * - Resolved entries are cached forever (immutable).
   * - Pending entries are re-fetched once `backfillPendingTtlMs` has elapsed.
   * - Cache miss → fetch from CLOB and upsert.
   */
  async resolveMarket(conditionId: string): Promise<MarketResolution> {
    // 1. Check cache
    const cached = queries.getMarketResolution(conditionId);
    if (cached) {
      if (cached.status === 'resolved') {
        log.debug({ conditionId }, 'Market resolution: resolved (cache hit, ∞ TTL)');
        return cached;
      }
      // Pending — check if within TTL
      const ageMs = (Date.now() / 1000 - cached.fetchedAt) * 1000;
      if (ageMs < config.backfillPendingTtlMs) {
        log.debug({ conditionId, ageMs }, 'Market resolution: pending (within TTL, return cache)');
        return cached;
      }
      log.debug({ conditionId }, 'Market resolution: pending TTL expired, re-fetching');
    }

    // 2. Fetch from CLOB
    const market = await this.fetchMarketWithRateLimitTracking(conditionId);

    const now = Math.floor(Date.now() / 1000);

    let resolution: MarketResolution;

    if (!market) {
      // 404 — treat as pending (market may not exist in CLOB yet)
      resolution = {
        conditionId,
        winnerTokenId: null,
        resolvedAt: null,
        marketTitle: '',
        fetchedAt: now,
        status: 'pending',
      };
    } else {
      const winnerToken = market.tokens.find((t) => t.winner === true);
      if (market.closed && winnerToken) {
        resolution = {
          conditionId,
          winnerTokenId: winnerToken.token_id,
          resolvedAt: now,
          marketTitle: market.question,
          fetchedAt: now,
          status: 'resolved',
        };
      } else if (market.closed && !winnerToken) {
        resolution = {
          conditionId,
          winnerTokenId: null,
          resolvedAt: null,
          marketTitle: market.question,
          fetchedAt: now,
          status: 'closed_not_resolved',
        };
      } else {
        resolution = {
          conditionId,
          winnerTokenId: null,
          resolvedAt: null,
          marketTitle: market.question,
          fetchedAt: now,
          status: 'pending',
        };
      }
    }

    queries.upsertMarketResolution(resolution);
    return resolution;
  }

  /**
   * Batch resolve with concurrency control.
   *
   * Already-resolved IDs are served from cache; the remainder are processed in
   * chunks of `backfillConcurrency` with a 250 ms pause between chunks.
   * If 3 consecutive 429 responses are received the inter-request delay is bumped
   * to 2 s.
   */
  async resolveMarketsBatch(conditionIds: string[]): Promise<Map<string, MarketResolution>> {
    if (conditionIds.length === 0) return new Map();

    const result = new Map<string, MarketResolution>();

    // Batch cache lookup for already-resolved markets (∞ TTL)
    const resolvedInCache = queries.getResolvedMarketResolutions(conditionIds);
    for (const [id, res] of resolvedInCache) {
      result.set(id, res);
    }

    const remaining = conditionIds.filter((id) => !result.has(id));
    if (remaining.length === 0) return result;

    log.debug(
      { total: conditionIds.length, fromCache: result.size, toFetch: remaining.length },
      'resolveMarketsBatch: fetching remaining',
    );

    // Split into chunks
    const concurrency = config.backfillConcurrency;
    for (let i = 0; i < remaining.length; i += concurrency) {
      const chunk = remaining.slice(i, i + concurrency);

      const settled = await Promise.allSettled(
        chunk.map((id) => this.resolveMarket(id)),
      );

      for (let j = 0; j < chunk.length; j++) {
        const outcome = settled[j];
        if (outcome.status === 'fulfilled') {
          result.set(chunk[j], outcome.value);
        } else {
          log.warn({ conditionId: chunk[j], reason: outcome.reason }, 'resolveMarket failed in batch');
        }
      }

      // Pause between chunks except after the last one
      if (i + concurrency < remaining.length) {
        const pause = CHUNK_PAUSE_MS + this.extraDelayMs;
        await sleep(pause);
      }
    }

    return result;
  }

  /**
   * Compute realized win rate for a trader based on their resolved markets.
   *
   * Fetches the last 500 TRADE activity entries, resolves the underlying
   * markets, then tallies wins/losses over the resolved BUY set.
   */
  async computeRealizedWinRate(traderAddress: string): Promise<RealizedWinRateResult> {
    log.debug({ traderAddress }, 'computeRealizedWinRate: fetching activity');

    const activities = await this.dataApi.getActivity(traderAddress, {
      type: 'TRADE',
      limit: 500,
    });

    // Filter to BUY actions only
    const buys = activities.filter(
      (a) => a.action.toLowerCase() === 'buy',
    );

    if (buys.length === 0) {
      log.debug({ traderAddress }, 'No BUY activity found');
      return {
        realizedWinRate: 0,
        realizedRoi: 0,
        resolvedTradesCount: 0,
        totalPnl: 0,
        confidence: 0,
      };
    }

    // Collect unique condition_ids
    const uniqueConditionIds = [...new Set(buys.map((b) => b.condition_id).filter(Boolean))];

    log.debug(
      { traderAddress, buysTotal: buys.length, uniqueMarkets: uniqueConditionIds.length },
      'computeRealizedWinRate: resolving markets',
    );

    const resolutions = await this.resolveMarketsBatch(uniqueConditionIds);

    // Tally wins / losses
    let wins = 0;
    let losses = 0;
    let resolvedBuys = 0;
    let totalPnl = 0;
    let invested = 0;

    for (const buy of buys) {
      const resolution = resolutions.get(buy.condition_id);
      if (!resolution || resolution.status !== 'resolved') continue;

      resolvedBuys++;

      const cost = buy.price * buy.size;
      invested += cost;

      const isWin =
        resolution.winnerTokenId !== null &&
        buy.token_id === resolution.winnerTokenId &&
        buy.price < 1.0;

      if (isWin) {
        wins++;
        totalPnl += (1.0 - buy.price) * buy.size;
      } else {
        losses++;
        totalPnl -= cost;
      }
    }

    const realizedWinRate = resolvedBuys > 0 ? wins / resolvedBuys : 0;
    const realizedRoi = invested > 0 ? totalPnl / invested : 0;
    const confidence = Math.min(1, resolvedBuys / 30);

    log.info(
      {
        traderAddress,
        resolvedBuys,
        wins,
        losses,
        realizedWinRate,
        realizedRoi,
        confidence,
      },
      'computeRealizedWinRate result',
    );

    return {
      realizedWinRate,
      realizedRoi,
      resolvedTradesCount: resolvedBuys,
      totalPnl,
      confidence,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchMarketWithRateLimitTracking(conditionId: string) {
    try {
      const market = await this.clobClient.getMarketByConditionId(conditionId);
      // Successful call — reset 429 counter
      this.consecutive429 = 0;
      this.extraDelayMs = 0;
      return market;
    } catch (err: unknown) {
      // getMarketByConditionId throws on non-OK responses; check if it looks like a 429
      const msg = String(err);
      if (msg.includes('429')) {
        this.consecutive429++;
        if (this.consecutive429 >= 3) {
          this.extraDelayMs = 2000;
          log.warn({ consecutive429: this.consecutive429 }, '3 consecutive 429s — increasing inter-request delay to 2s');
        }
      } else {
        this.consecutive429 = 0;
      }
      throw err;
    }
  }
}
