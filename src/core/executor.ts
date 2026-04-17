import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { generateId, sleep } from '../utils/helpers.js';
import { ClobClientWrapper, getClobClient } from '../api/clob-client.js';
import { GammaApi } from '../api/gamma-api.js';
import { fetchWithRetry } from '../utils/retry.js';
import { RiskManager } from './risk-manager.js';
import { Portfolio } from './portfolio.js';
import { AnomalyDetector } from './strategy/anomaly.js';
import { ExitStrategy } from './strategy/exit-strategy.js';
import { convictionStore } from './strategy/conviction-store.js';
import { computeConviction } from './strategy/conviction.js';
import { TwapExecutor } from './execution/twap.js';
import { computeLiquidityMetrics, checkLiquidity } from './execution/liquidity.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, TradeResult, TradeReason, ExitSignal } from '../types.js';
import type { HealthChecker } from './health-checker.js';

const log = createLogger('executor');

// Lazily-imported types from @polymarket/clob-client
type AuthenticatedClobClient = import('@polymarket/clob-client').ClobClient;

export class Executor {
  private riskManager: RiskManager;
  private portfolio: Portfolio;
  private clobClient: ClobClientWrapper;
  private gammaApi: GammaApi;
  private authenticatedClient: AuthenticatedClobClient | null = null;
  private authFailedAt: number | null = null;
  private healthChecker?: HealthChecker;
  private anomalyDetector: AnomalyDetector;
  private exitStrategy: ExitStrategy;
  readonly twapExecutor: TwapExecutor;

  /** Per-token BUY cooldown: tokenId → timestamp of last executed BUY */
  private lastBuyAt: Map<string, number> = new Map();
  /** Minimum ms between consecutive BUYs on the same tokenId (default 60s) */
  private static readonly BUY_COOLDOWN_MS = 60_000;

  constructor(riskManager?: RiskManager, portfolio?: Portfolio, healthChecker?: HealthChecker) {
    this.riskManager = riskManager ?? new RiskManager();
    this.portfolio = portfolio ?? new Portfolio();
    this.clobClient = getClobClient();
    this.gammaApi = new GammaApi();
    this.healthChecker = healthChecker;
    this.anomalyDetector = new AnomalyDetector();
    this.exitStrategy = new ExitStrategy();
    this.twapExecutor = new TwapExecutor();
  }

  /**
   * Lazily create an authenticated ClobClient for real order placement.
   * Returns null if credentials are missing (will fall back to dry-run with a warning).
   * Implements circuit breaker: after failed auth, cooldown 30s before retry.
   */
  private async getAuthenticatedClobClient(): Promise<AuthenticatedClobClient | null> {
    if (this.authenticatedClient) return this.authenticatedClient;

    // Circuit breaker: if auth failed recently, don't retry immediately
    if (this.authFailedAt !== null) {
      const now = Date.now();
      if (now - this.authFailedAt < 30_000) {
        throw new Error('Auth on cooldown (30s after last failure)');
      }
    }

    const { privateKey, clobApiKey, clobSecret, clobPassphrase, clobHost, funderAddress, signatureType } = config;

    if (!privateKey || !clobApiKey || !clobSecret || !clobPassphrase) {
      log.warn(
        'Missing trading credentials (PRIVATE_KEY, CLOB_API_KEY, CLOB_SECRET, or CLOB_PASSPHRASE). ' +
        'Falling back to dry-run mode for this trade.',
      );
      return null;
    }

    try {
      const { ethers } = await import('ethers');
      const { ClobClient } = await import('@polymarket/clob-client');

      const wallet = new ethers.Wallet(privateKey);
      const chainId = 137; // Polygon mainnet

      this.authenticatedClient = new ClobClient(
        clobHost,
        chainId,
        wallet,
        { key: clobApiKey, secret: clobSecret, passphrase: clobPassphrase },
        signatureType,
        funderAddress || undefined,
      );

      log.info({ address: wallet.address }, 'Authenticated ClobClient initialized for real trading');
      this.healthChecker?.recordAuthResult(true);
      return this.authenticatedClient;
    } catch (err) {
      log.error({ err }, 'Failed to create authenticated ClobClient');
      this.authFailedAt = Date.now();
      this.healthChecker?.recordAuthResult(false);
      if (this.healthChecker?.isHalted()) {
        throw new Error('Bot halted due to repeated auth failures');
      }
      return null;
    }
  }

  /**
   * Round a price to the nearest tick size.
   */
  private roundToTickSize(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick <= 0) return price;
    const rounded = Math.round(price / tick) * tick;
    // Preserve decimal precision of tick size
    const decimals = tickSize.split('.')[1]?.length ?? 2;
    return parseFloat(rounded.toFixed(decimals));
  }

  /**
   * Wait for an order to be filled, polling its status.
   * Returns 'filled', 'partial', or 'failed'.
   */
  private async waitForOrderFill(orderId: string, timeoutMs = 30000): Promise<'filled' | 'partial' | 'failed'> {
    const start = Date.now();
    log.info({ orderId, timeoutMs }, 'Polling order status until fill or timeout');

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetchWithRetry(`${config.clobHost}/order/${orderId}`);
        if (!res.ok) {
          log.warn({ orderId, status: res.status }, 'Order status check returned non-OK');
          await sleep(2000);
          continue;
        }

        const data = await res.json() as { status: string; size_matched?: string; original_size?: string };
        log.debug({ orderId, status: data.status, sizeMatched: data.size_matched }, 'Order status poll');

        if (data.status === 'MATCHED') return 'filled';
        if (data.status === 'CANCELLED' || data.status === 'CANCELED') return 'failed';

        // Check for partial fill based on size_matched vs original_size
        if (data.size_matched && data.original_size) {
          const matched = parseFloat(data.size_matched);
          const original = parseFloat(data.original_size);
          if (matched > 0 && matched >= original) return 'filled';
        }
      } catch (err) {
        log.warn({ err, orderId }, 'Error polling order status, will retry');
      }

      await sleep(2000);
    }

    log.warn({ orderId, elapsedMs: Date.now() - start }, 'Order fill polling timed out');
    return 'partial';
  }

  /**
   * Compute the USD size for a copied BUY based on the configured sizing mode.
   *
   * - `fixed`: always returns `config.betSizeUsd` (legacy behaviour).
   * - `proportional`: scales linearly with the trader's own USD spend, then
   *   clamps to a [min, max] multiplier band so we don't get whipsawed by
   *   tiny "test" trades or wiped out by mega-trades.
   *
   * Falls back to fixed if `traderUsd` is missing/zero (broken API data).
   */
  private computeBetSize(traderUsd: number): number {
    if (config.betSizingMode !== 'proportional' || !(traderUsd > 0)) {
      return config.betSizeUsd;
    }
    const rawMul = traderUsd / config.betScaleAnchorUsd;
    const mul = Math.min(
      config.betScaleMaxMul,
      Math.max(config.betScaleMinMul, rawMul),
    );
    return config.betSizeUsd * mul;
  }

  /**
   * Lookup market age from markets_cache (TTL-bounded). On miss, fetches from
   * GammaApi and populates the cache. Returns age in hours, or undefined if
   * createdAt is not available (F5 will default to 1.0).
   */
  private async lookupMarketAgeHours(conditionId: string): Promise<number | undefined> {
    try {
      let cache = queries.getMarketCache(conditionId);
      const now = Date.now();
      const ttlExpired =
        !cache || new Date(cache.cachedAt).getTime() < now - config.marketAgeCacheTtlMs;

      if (ttlExpired) {
        const market = await this.gammaApi.getMarketByConditionId(conditionId);
        queries.upsertMarketCache({
          conditionId,
          createdAt: market?.createdAt ?? null,
          endDate: market?.endDate ?? null,
          volume: market?.volume ?? null,
          liquidity: market?.liquidity ?? null,
          cachedAt: new Date().toISOString(),
        });
        cache = queries.getMarketCache(conditionId);
      }

      if (cache?.createdAt) {
        return (now - new Date(cache.createdAt).getTime()) / 3_600_000;
      }
    } catch (err) {
      log.debug({ err, conditionId }, 'Market age lookup failed, F5=1.0');
    }
    return undefined;
  }

  /**
   * Compute conviction-adjusted bet size using the conviction store + F1-F5 factors.
   * Falls back to legacy computeBetSize when conviction module yields 0 or errors.
   */
  private async computeConvictionBet(trade: DetectedTrade): Promise<number> {
    try {
      const traderRec = queries.getTraderByAddress(trade.traderAddress);
      const winRate = traderRec?.realizedWinRate ?? traderRec?.winRate ?? 0.5;
      const score = traderRec?.score ?? 0;
      const marketAgeHours = await this.lookupMarketAgeHours(trade.conditionId);

      const bet = computeConviction({
        traderUsd: trade.usdValue,
        winRate,
        score,
        marketAgeHours,
      });

      if (bet > 0) {
        const scalar = traderRec?.convictionScalar ?? 1.0;
        return bet * scalar;
      }
    } catch (err) {
      log.warn({ err }, 'computeConvictionBet failed, falling back to computeBetSize');
    }
    return this.computeBetSize(trade.usdValue);
  }

  /**
   * Execute a BUY order (or simulate in dry run)
   */
  async executeBuy(trade: DetectedTrade): Promise<TradeResult> {
    log.info({
      trader: trade.traderName,
      market: trade.marketTitle,
      outcome: trade.outcome,
      traderPrice: trade.price,
    }, 'Processing BUY signal');

    // 0. Per-token BUY cooldown — prevent rapid-fire duplicate copies
    const lastBuy = this.lastBuyAt.get(trade.tokenId);
    if (lastBuy && Date.now() - lastBuy < Executor.BUY_COOLDOWN_MS) {
      const remainSec = ((Executor.BUY_COOLDOWN_MS - (Date.now() - lastBuy)) / 1000).toFixed(0);
      log.info({ tokenId: trade.tokenId, remainSec }, 'BUY cooldown active, skipping');
      return this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, `buy_cooldown:${remainSec}s`);
    }

    // 1. Risk check
    const riskCheck = this.riskManager.canTrade(trade);
    if (!riskCheck.allowed) {
      log.warn({ reason: riskCheck.reason }, 'Risk check FAILED');
      return this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, riskCheck.reason);
    }

    // 2a. Anomaly detection
    const anomaly = this.anomalyDetector.analyze(trade);
    let anomalyReduceFactor: number | undefined;

    if (anomaly) {
      const action = this.anomalyDetector.getActionForAnomaly(anomaly);
      log.warn({ type: anomaly.type, action, trader: trade.traderName }, 'Anomaly detected');

      if (action === 'skip_trade') {
        return this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, `anomaly:${anomaly.type}`);
      }
      if (action === 'halt_trader') {
        queries.haltTrader(trade.traderAddress, config.anomalyHaltDurationHours);
        return this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, `anomaly:halt:${anomaly.type}`);
      }
      if (action === 'reduce_size') {
        anomalyReduceFactor = config.anomalyReduceFactor;
      }
      // 'alert' / 'ignore' → continue (alert already logged by analyze())
    }

    try {
      // 2b. Get current price from CLOB (attempt order book fetch for liquidity check too)
      let midpoint: number;
      let liquidityChecked = false;
      let totalUsd = await this.computeConvictionBet(trade);
      totalUsd = Math.min(totalUsd, config.maxSingleBetUsd);

      if (config.minMarketLiquidity > 0 || config.maxSpreadPct > 0) {
        try {
          const book = await this.clobClient.getOrderBook(trade.tokenId);
          const metrics = computeLiquidityMetrics(book, config.depthSlippagePct);
          midpoint = metrics.midpoint > 0 ? metrics.midpoint : await this.clobClient.getMidpoint(trade.tokenId);

          const liquidityResult = checkLiquidity(metrics, totalUsd, {
            minLiquidityUsd: config.minMarketLiquidity,
            maxSpreadPct: config.maxSpreadPct,
            depthSlippagePct: config.depthSlippagePct,
            depthAdaptivePct: config.depthAdaptivePct,
          });

          if (!liquidityResult.allowed) {
            log.warn({ reason: liquidityResult.reason, tokenId: trade.tokenId }, 'Liquidity check FAILED');
            return this.createResult(trade, 'BUY', 'skipped', midpoint, 0, 0, liquidityResult.reason);
          }

          if (liquidityResult.adjustedBetUsd !== undefined) {
            log.info(
              { original: totalUsd, adjusted: liquidityResult.adjustedBetUsd },
              'Bet size adjusted due to insufficient depth',
            );
            totalUsd = liquidityResult.adjustedBetUsd;
          }

          liquidityChecked = true;
        } catch (liquidityErr) {
          // Liquidity check failure is non-fatal — fall back to plain midpoint
          log.warn({ err: liquidityErr, tokenId: trade.tokenId }, 'Liquidity check failed, using midpoint fallback');
          midpoint = await this.clobClient.getMidpoint(trade.tokenId);
        }
      } else {
        midpoint = await this.clobClient.getMidpoint(trade.tokenId);
      }

      // suppress unused variable warning
      void liquidityChecked;

      // 3. Check slippage
      const slippageCheck = this.riskManager.checkSlippage(midpoint, trade.price);
      if (!slippageCheck.allowed) {
        log.warn({ reason: slippageCheck.reason }, 'Slippage check FAILED');
        return this.createResult(trade, 'BUY', 'skipped', midpoint, 0, 0, slippageCheck.reason);
      }

      // 4a. Probation multiplier
      const traderRec = queries.getTraderByAddress(trade.traderAddress);
      if (traderRec?.probation) {
        const originalUsd = totalUsd;
        totalUsd *= config.probationSizeMultiplier;
        log.info({
          trader: trade.traderName,
          multiplier: config.probationSizeMultiplier,
          originalUsd: originalUsd.toFixed(2),
          adjustedUsd: totalUsd.toFixed(2),
        }, 'Probation: reduced bet size');
      }

      // 4b. Anomaly reduce_size factor
      if (anomalyReduceFactor !== undefined) {
        const originalUsd = totalUsd;
        totalUsd *= anomalyReduceFactor;
        log.info({
          trader: trade.traderName,
          anomalyReduceFactor,
          originalUsd: originalUsd.toFixed(2),
          adjustedUsd: totalUsd.toFixed(2),
        }, 'Anomaly: reduced bet size');
      }

      // 4c. Concentration check
      const allPositions = this.portfolio.getAllPositions();
      const demoBalance = queries.getDemoBalance();
      const equity = demoBalance + allPositions.reduce((s, p) => {
        const mtm = p.currentPrice !== null && p.currentPrice !== undefined
          ? p.totalShares * p.currentPrice
          : p.totalInvested;
        return s + mtm;
      }, 0);
      const concCheck = this.riskManager.checkConcentration(trade, allPositions, equity, totalUsd);
      if (!concCheck.allowed) {
        log.warn({ reason: concCheck.reason }, 'Concentration check FAILED');
        return this.createResult(trade, 'BUY', 'skipped', midpoint, 0, 0, concCheck.reason);
      }

      // 5. Calculate size — proportional to trader's USD when configured.
      // Note: totalUsd may already be adjusted by liquidity check above
      const size = totalUsd / midpoint;

      // 5b. TWAP: split large orders across multiple time-sliced executions
      if (this.twapExecutor.shouldUseTwap(totalUsd)) {
        const plan = this.twapExecutor.createPlan(trade, totalUsd, midpoint);
        log.info({ plan }, 'Executing BUY via TWAP');

        const twapResult = await this.twapExecutor.execute(
          plan,
          (tokenId) => this.clobClient.getMidpoint(tokenId),
          async (sliceUsd, price, sliceNum) => {
            try {
              if (config.dryRun) {
                // Simulate slice: apply small slippage per slice position
                const slippage = 1 + sliceNum * 0.002;
                const execPrice = price * slippage;
                const sliceSize = sliceUsd / execPrice;
                const commission = sliceUsd * (config.demoCommissionPct / 100);
                const balance = queries.getDemoBalance();
                if (sliceUsd + commission > balance) {
                  return { success: false, error: 'Insufficient demo balance for TWAP slice' };
                }
                queries.setDemoBalance(balance - sliceUsd - commission);
                // Record the slice trade in DB
                const sliceTrade = { ...trade, size: sliceSize, price: execPrice, usdValue: sliceUsd };
                const sliceResult = this.createResult(sliceTrade, 'BUY', 'simulated', execPrice, sliceSize, sliceUsd);
                sliceResult.isDryRun = true;
                sliceResult.commission = commission;
                queries.insertTrade(sliceResult);
                this.portfolio.updateAfterBuy(sliceResult);
                return { success: true, executedPrice: execPrice };
              }
              // Real mode: delegate to standard order placement
              const authClient = await this.getAuthenticatedClobClient();
              if (!authClient) return { success: false, error: 'No auth client' };
              const { Side, OrderType } = await import('@polymarket/clob-client');
              const obForSlice = await authClient.getOrderBook(trade.tokenId);
              const tickSizeSlice = obForSlice.tick_size ?? '0.01';
              const alignedPrice = this.roundToTickSize(price, tickSizeSlice);
              const sliceSize = sliceUsd / alignedPrice;
              const resp = await authClient.createAndPostOrder(
                { tokenID: trade.tokenId, price: alignedPrice, side: Side.BUY, size: sliceSize },
                { tickSize: tickSizeSlice as import('@polymarket/clob-client').TickSize, negRisk: obForSlice.neg_risk ?? false },
                OrderType.GTC,
              );
              if (!resp?.success) return { success: false, error: resp?.errorMsg ?? 'Order failed' };
              const sliceResult = this.createResult(trade, 'BUY', 'filled', alignedPrice, sliceSize, sliceUsd);
              sliceResult.orderId = resp.orderID;
              queries.insertTrade(sliceResult);
              this.portfolio.updateAfterBuy(sliceResult);
              return { success: true, executedPrice: alignedPrice };
            } catch (err) {
              return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
        );

        if (twapResult.slicesExecuted === 0) {
          return this.createResult(trade, 'BUY', 'failed', midpoint, 0, 0, 'TWAP: all slices failed/drifted');
        }

        this.lastBuyAt.set(trade.tokenId, Date.now());
        const twapSize = twapResult.avgPrice > 0 ? twapResult.totalFilled / twapResult.avgPrice : 0;
        return this.createResult(trade, 'BUY', 'simulated', twapResult.avgPrice, twapSize, twapResult.totalFilled);
      }

      // 6. Execute or simulate
      if (config.dryRun) {
        const commission = totalUsd * (config.demoCommissionPct / 100);
        const demoBalance = queries.getDemoBalance();

        if (totalUsd + commission > demoBalance) {
          log.warn({ needed: totalUsd + commission, balance: demoBalance }, 'Insufficient demo balance');
          return this.createResult(trade, 'BUY', 'skipped', midpoint, 0, 0, 'Insufficient demo balance');
        }

        queries.setDemoBalance(demoBalance - totalUsd - commission);

        log.info({
          market: trade.marketTitle,
          outcome: trade.outcome,
          shares: size.toFixed(2),
          price: midpoint.toFixed(4),
          total: totalUsd.toFixed(2),
          traderUsd: (trade.usdValue || 0).toFixed(2),
          mul: config.betSizeUsd > 0 ? (totalUsd / config.betSizeUsd).toFixed(2) : 'n/a',
          commission: commission.toFixed(2),
          balanceAfter: (demoBalance - totalUsd - commission).toFixed(2),
        }, 'DRY RUN: Would BUY');

        const result = this.createResult(trade, 'BUY', 'simulated', midpoint, size, totalUsd);
        result.isDryRun = true;
        result.commission = commission;

        // Save to DB
        queries.insertTrade(result);
        this.portfolio.updateAfterBuy(result);
        this.lastBuyAt.set(trade.tokenId, Date.now());
        if (commission > 0) {
          const prev = parseFloat(queries.getSetting('demo_total_commission') ?? '0');
          queries.setSetting('demo_total_commission', String(prev + commission));
        }
        queries.insertActivity('trade', `DRY RUN BUY: ${trade.marketTitle} ${trade.outcome} - ${size.toFixed(2)} shares @ $${midpoint.toFixed(4)} (fee: $${commission.toFixed(2)})`);

        return result;
      }

      // Real trading (Stage 8)
      const authClient = await this.getAuthenticatedClobClient();
      if (!authClient) {
        log.warn('No authenticated client available, treating as dry-run');
        const fallbackResult = this.createResult(trade, 'BUY', 'simulated', midpoint, size, totalUsd);
        fallbackResult.isDryRun = true;
        fallbackResult.error = 'Missing credentials — executed as dry-run';
        queries.insertTrade(fallbackResult);
        queries.insertActivity('trade', `FALLBACK DRY RUN BUY: ${trade.marketTitle} ${trade.outcome} — missing credentials`);
        return fallbackResult;
      }

      // Fetch tick_size and neg_risk from the order book
      const orderBook = await authClient.getOrderBook(trade.tokenId);
      const tickSize = orderBook.tick_size ?? '0.01';
      const negRisk = orderBook.neg_risk ?? false;

      // Align price to tick size
      const adjustedPrice = this.roundToTickSize(midpoint, tickSize);

      log.info({
        tokenId: trade.tokenId,
        rawPrice: midpoint,
        adjustedPrice,
        tickSize,
        negRisk,
        shares: size,
        totalUsd,
      }, 'Placing real BUY order');

      const { Side, OrderType } = await import('@polymarket/clob-client');

      const orderResponse = await authClient.createAndPostOrder(
        {
          tokenID: trade.tokenId,
          price: adjustedPrice,
          side: Side.BUY,
          size,
        },
        { tickSize: tickSize as import('@polymarket/clob-client').TickSize, negRisk },
        OrderType.GTC,
      );

      log.info({ orderResponse }, 'BUY order response received');

      if (!orderResponse?.success) {
        const errMsg = orderResponse?.errorMsg ?? 'Order placement failed';
        log.error({ errMsg, orderResponse }, 'BUY order was not successful');
        return this.createResult(trade, 'BUY', 'failed', adjustedPrice, size, totalUsd, errMsg);
      }

      const orderId = orderResponse.orderID;
      let fillStatus: 'filled' | 'partial' | 'failed';

      // Check immediate status
      const immediateStatus = (orderResponse.status ?? '').toUpperCase();
      if (immediateStatus === 'MATCHED') {
        fillStatus = 'filled';
      } else if (immediateStatus === 'LIVE' || immediateStatus === 'DELAYED') {
        // Poll until filled or timeout
        fillStatus = await this.waitForOrderFill(orderId);
      } else {
        fillStatus = 'partial';
      }

      log.info({ orderId, fillStatus, market: trade.marketTitle }, 'BUY order fill result');

      const result = this.createResult(trade, 'BUY', fillStatus, adjustedPrice, size, totalUsd);
      result.orderId = orderId;

      queries.insertTrade(result);
      if (fillStatus === 'filled' || fillStatus === 'partial') {
        this.portfolio.updateAfterBuy(result);
        this.lastBuyAt.set(trade.tokenId, Date.now());
      }
      queries.insertActivity(
        'trade',
        `REAL BUY: ${trade.marketTitle} ${trade.outcome} — ${size.toFixed(2)} shares @ $${adjustedPrice.toFixed(4)} [${fillStatus}] orderId=${orderId}`,
      );

      return result;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'BUY execution failed');
      return this.createResult(trade, 'BUY', 'failed', 0, 0, 0, msg);
    }
  }

  /**
   * Execute a SELL order (or simulate in dry run)
   */
  async executeSell(trade: DetectedTrade): Promise<TradeResult> {
    log.info({
      trader: trade.traderName,
      market: trade.marketTitle,
      outcome: trade.outcome,
    }, 'Processing SELL signal');

    // 1. Check if we have a position
    const position = this.portfolio.getPosition(trade.tokenId);
    if (!position) {
      log.info({ tokenId: trade.tokenId }, 'No position to sell, skipping');
      return this.createResult(trade, 'SELL', 'skipped', 0, 0, 0, 'No position');
    }

    try {
      // 2. Get current price
      const book = await this.clobClient.getOrderBook(trade.tokenId);
      const bestBid = this.clobClient.getBestBid(book) ?? 0;

      if (bestBid <= 0) {
        return this.createResult(trade, 'SELL', 'skipped', 0, 0, 0, 'No bids in orderbook');
      }

      // 3. Determine sell size based on exit strategy
      let size: number;
      {
        const estimatedTraderPos = queries.getEstimatedTraderPosition(trade.traderAddress, trade.tokenId);
        const signal = this.exitStrategy.evaluateTraderSell(
          trade,
          position,
          estimatedTraderPos,
          trade.size,
        );
        if (!signal) {
          // sellMode = take_profit or partial_scale_out — don't mirror on trader SELL
          log.info(
            { trader: trade.traderAddress, tokenId: trade.tokenId, sellMode: config.sellMode },
            'SELL: exit strategy returned no action, skipping trader mirror',
          );
          return this.createResult(trade, 'SELL', 'skipped', bestBid, 0, 0, 'Exit strategy: no action for current sellMode');
        }
        size = Math.min(position.totalShares, position.totalShares * signal.sellPct);
        log.debug({ sellPct: signal.sellPct, size, reason: signal.reason }, 'SELL size determined by exit strategy');
      }
      const totalUsd = size * bestBid;

      // 4. Execute or simulate
      if (config.dryRun) {
        const commission = totalUsd * (config.demoCommissionPct / 100);
        const demoBalance = queries.getDemoBalance();
        queries.setDemoBalance(demoBalance + totalUsd - commission);

        const pnl = totalUsd - position.totalInvested;
        log.info({
          market: trade.marketTitle,
          shares: size.toFixed(2),
          price: bestBid.toFixed(4),
          total: totalUsd.toFixed(2),
          pnl: pnl.toFixed(2),
          commission: commission.toFixed(2),
          balanceAfter: (demoBalance + totalUsd - commission).toFixed(2),
        }, 'DRY RUN: Would SELL');

        const result = this.createResult(trade, 'SELL', 'simulated', bestBid, size, totalUsd);
        result.isDryRun = true;
        result.commission = commission;

        queries.insertTrade(result);
        this.portfolio.updateAfterSell(result);
        if (commission > 0) {
          const prev = parseFloat(queries.getSetting('demo_total_commission') ?? '0');
          queries.setSetting('demo_total_commission', String(prev + commission));
        }
        queries.insertActivity('trade', `DRY RUN SELL: ${trade.marketTitle} - ${size.toFixed(2)} shares @ $${bestBid.toFixed(4)} (P&L: $${pnl.toFixed(2)}, fee: $${commission.toFixed(2)})`);

        return result;
      }

      // Real trading (Stage 8)
      const authClient = await this.getAuthenticatedClobClient();
      if (!authClient) {
        log.warn('No authenticated client available for SELL, treating as dry-run');
        const pnl = totalUsd - position.totalInvested;
        const fallbackResult = this.createResult(trade, 'SELL', 'simulated', bestBid, size, totalUsd);
        fallbackResult.isDryRun = true;
        fallbackResult.error = 'Missing credentials — executed as dry-run';
        queries.insertTrade(fallbackResult);
        queries.insertActivity('trade', `FALLBACK DRY RUN SELL: ${trade.marketTitle} — missing credentials (P&L: $${pnl.toFixed(2)})`);
        return fallbackResult;
      }

      // Fetch tick_size and neg_risk from the order book
      const orderBookData = await authClient.getOrderBook(trade.tokenId);
      const tickSize = orderBookData.tick_size ?? '0.01';
      const negRisk = orderBookData.neg_risk ?? false;

      // Use bestBid as sell price, aligned to tick size
      const adjustedPrice = this.roundToTickSize(bestBid, tickSize);

      log.info({
        tokenId: trade.tokenId,
        rawPrice: bestBid,
        adjustedPrice,
        tickSize,
        negRisk,
        shares: size,
        totalUsd,
      }, 'Placing real SELL order');

      const { Side, OrderType } = await import('@polymarket/clob-client');

      const orderResponse = await authClient.createAndPostOrder(
        {
          tokenID: trade.tokenId,
          price: adjustedPrice,
          side: Side.SELL,
          size,
        },
        { tickSize: tickSize as import('@polymarket/clob-client').TickSize, negRisk },
        OrderType.GTC,
      );

      log.info({ orderResponse }, 'SELL order response received');

      if (!orderResponse?.success) {
        const errMsg = orderResponse?.errorMsg ?? 'Order placement failed';
        log.error({ errMsg, orderResponse }, 'SELL order was not successful');
        return this.createResult(trade, 'SELL', 'failed', adjustedPrice, size, totalUsd, errMsg);
      }

      const orderId = orderResponse.orderID;
      let fillStatus: 'filled' | 'partial' | 'failed';

      const immediateStatus = (orderResponse.status ?? '').toUpperCase();
      if (immediateStatus === 'MATCHED') {
        fillStatus = 'filled';
      } else if (immediateStatus === 'LIVE' || immediateStatus === 'DELAYED') {
        fillStatus = await this.waitForOrderFill(orderId);
      } else {
        fillStatus = 'partial';
      }

      const pnl = totalUsd - position.totalInvested;
      log.info({ orderId, fillStatus, market: trade.marketTitle, pnl: pnl.toFixed(2) }, 'SELL order fill result');

      const result = this.createResult(trade, 'SELL', fillStatus, adjustedPrice, size, totalUsd);
      result.orderId = orderId;

      queries.insertTrade(result);
      if (fillStatus === 'filled' || fillStatus === 'partial') {
        this.portfolio.updateAfterSell(result);
      }
      queries.insertActivity(
        'trade',
        `REAL SELL: ${trade.marketTitle} — ${size.toFixed(2)} shares @ $${adjustedPrice.toFixed(4)} [${fillStatus}] (P&L: $${pnl.toFixed(2)}) orderId=${orderId}`,
      );

      return result;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'SELL execution failed');
      return this.createResult(trade, 'SELL', 'failed', 0, 0, 0, msg);
    }
  }

  /**
   * Execute a stop-loss or trailing stop sell for a position.
   * Creates a synthetic DetectedTrade and delegates to the SELL path.
   * Does NOT run anomaly detection.
   */
  async executeStopLossSell(
    tokenId: string,
    reason: 'stop_loss' | 'trailing_stop',
  ): Promise<TradeResult> {
    const prefix = reason === 'stop_loss' ? '[STOP-LOSS]' : '[TRAILING-STOP]';

    // Get the position
    const position = this.portfolio.getPosition(tokenId);
    if (!position) {
      log.warn({ tokenId }, `${prefix} No open position found, skipping stop-loss sell`);
      // Return a minimal skipped result
      const dummy = this.createStopLossTrade(tokenId, '', '', '', '', 0, 0, reason);
      return this.createResult(dummy, 'SELL', 'skipped', 0, 0, 0, 'No open position');
    }

    // Find the trader who opened this position
    const opener = queries.getOpeningTraderForToken(tokenId);
    const traderAddress = opener?.address ?? '';
    const traderName = opener?.name ?? 'stop-loss-system';

    log.info(
      { tokenId, conditionId: position.conditionId, market: position.marketTitle, reason },
      `${prefix} Executing stop-loss sell`,
    );

    const syntheticTrade = this.createStopLossTrade(
      tokenId,
      traderAddress,
      traderName,
      position.conditionId,
      position.marketSlug,
      position.totalShares,
      position.avgPrice,
      reason,
      position.marketTitle,
      position.outcome,
    );

    // Execute via the standard SELL path
    const result = await this.executeSell(syntheticTrade);
    result.reason = reason as TradeReason;

    // Update the reason column in the DB record that executeSell inserted
    if (result.status !== 'skipped' && result.id) {
      try {
        queries.updateTradeReason(result.id, reason);
      } catch (err) {
        log.warn({ err, tradeId: result.id }, 'Failed to update trade reason in DB');
      }
    }

    log.info(
      { tokenId, status: result.status, price: result.price, reason },
      `${prefix} Stop-loss sell completed`,
    );

    return result;
  }

  /**
   * Execute a price-triggered exit (take_profit or scale_out).
   * Called by Bot after portfolio emits an 'exitSignal' event.
   */
  async executePriceExit(signal: ExitSignal): Promise<TradeResult> {
    const position = this.portfolio.getPosition(signal.tokenId);
    if (!position) {
      const dummy = this.createSyntheticTrade(signal.tokenId, signal.conditionId, '', '', '', 0, 0);
      return this.createResult(dummy, 'SELL', 'skipped', 0, 0, 0, `No open position for ${signal.tokenId}`);
    }

    const sellSize = position.totalShares * signal.sellPct;
    const opener = queries.getOpeningTraderForToken(signal.tokenId);
    const traderAddress = opener?.address ?? '';
    const traderName = 'exit-strategy';

    log.info(
      { tokenId: signal.tokenId, triggerSource: signal.triggerSource, sellPct: signal.sellPct, sellSize, reason: signal.reason },
      'Executing price exit',
    );

    const syntheticTrade = this.createSyntheticTrade(
      signal.tokenId,
      signal.conditionId,
      traderAddress,
      traderName,
      position.marketSlug,
      sellSize,
      position.currentPrice ?? position.avgPrice,
      position.marketTitle,
      position.outcome,
    );

    // Use existing SELL path; override size via trade.size
    const result = await this.executeSellWithSize(syntheticTrade, sellSize);

    // Tag the reason
    const reason = signal.triggerSource === 'take_profit' ? 'take_profit'
      : signal.triggerSource === 'scale_out' ? 'scale_out'
      : 'copy';
    result.reason = reason as TradeReason;
    if (result.status !== 'skipped' && result.id) {
      try { queries.updateTradeReason(result.id, reason); } catch { /* ignore */ }
    }

    return result;
  }

  /**
   * Internal SELL that uses a specific size override instead of full position.
   * Bypasses exit strategy evaluation (already resolved by the caller).
   */
  private async executeSellWithSize(trade: DetectedTrade, overrideSize: number): Promise<TradeResult> {
    const position = this.portfolio.getPosition(trade.tokenId);
    if (!position) {
      return this.createResult(trade, 'SELL', 'skipped', 0, 0, 0, 'No position');
    }

    try {
      const book = await this.clobClient.getOrderBook(trade.tokenId);
      const bestBid = this.clobClient.getBestBid(book) ?? 0;
      if (bestBid <= 0) {
        return this.createResult(trade, 'SELL', 'skipped', 0, 0, 0, 'No bids in orderbook');
      }

      const size = Math.min(overrideSize, position.totalShares);
      const totalUsd = size * bestBid;

      if (config.dryRun) {
        const commission = totalUsd * (config.demoCommissionPct / 100);
        const demoBalance = queries.getDemoBalance();
        queries.setDemoBalance(demoBalance + totalUsd - commission);
        const pnl = totalUsd - position.avgPrice * size;
        log.info(
          { size: size.toFixed(2), price: bestBid.toFixed(4), total: totalUsd.toFixed(2), pnl: pnl.toFixed(2), commission: commission.toFixed(2) },
          'DRY RUN: SELL (price exit)',
        );
        const result = this.createResult(trade, 'SELL', 'simulated', bestBid, size, totalUsd);
        result.isDryRun = true;
        result.commission = commission;
        queries.insertTrade(result);
        this.portfolio.updateAfterSell(result);
        if (commission > 0) {
          const prev = parseFloat(queries.getSetting('demo_total_commission') ?? '0');
          queries.setSetting('demo_total_commission', String(prev + commission));
        }
        queries.insertActivity('trade', `DRY RUN SELL (exit): ${trade.marketTitle} - ${size.toFixed(2)} shares @ $${bestBid.toFixed(4)} (P&L: $${pnl.toFixed(2)})`);
        return result;
      }

      // Real mode
      const authClient = await this.getAuthenticatedClobClient();
      if (!authClient) {
        const pnl = totalUsd - position.avgPrice * size;
        const fallbackResult = this.createResult(trade, 'SELL', 'simulated', bestBid, size, totalUsd);
        fallbackResult.isDryRun = true;
        fallbackResult.error = 'Missing credentials — executed as dry-run';
        queries.insertTrade(fallbackResult);
        queries.insertActivity('trade', `FALLBACK DRY RUN SELL: ${trade.marketTitle} — missing credentials (P&L: $${pnl.toFixed(2)})`);
        return fallbackResult;
      }

      const orderBookData = await authClient.getOrderBook(trade.tokenId);
      const tickSize = orderBookData.tick_size ?? '0.01';
      const negRisk = orderBookData.neg_risk ?? false;
      const adjustedPrice = this.roundToTickSize(bestBid, tickSize);
      const { Side, OrderType } = await import('@polymarket/clob-client');
      const orderResponse = await authClient.createAndPostOrder(
        { tokenID: trade.tokenId, price: adjustedPrice, side: Side.SELL, size },
        { tickSize: tickSize as import('@polymarket/clob-client').TickSize, negRisk },
        OrderType.GTC,
      );

      if (!orderResponse?.success) {
        const errMsg = orderResponse?.errorMsg ?? 'Order placement failed';
        return this.createResult(trade, 'SELL', 'failed', adjustedPrice, size, totalUsd, errMsg);
      }

      const orderId = orderResponse.orderID;
      const immediateStatus = (orderResponse.status ?? '').toUpperCase();
      let fillStatus: 'filled' | 'partial' | 'failed';
      if (immediateStatus === 'MATCHED') fillStatus = 'filled';
      else if (immediateStatus === 'LIVE' || immediateStatus === 'DELAYED') fillStatus = await this.waitForOrderFill(orderId);
      else fillStatus = 'partial';

      const result = this.createResult(trade, 'SELL', fillStatus, adjustedPrice, size, totalUsd);
      result.orderId = orderId;
      queries.insertTrade(result);
      if (fillStatus === 'filled' || fillStatus === 'partial') this.portfolio.updateAfterSell(result);
      queries.insertActivity('trade', `REAL SELL (exit): ${trade.marketTitle} — ${size.toFixed(2)} shares @ $${adjustedPrice.toFixed(4)} [${fillStatus}] orderId=${orderId}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'SELL (price exit) execution failed');
      return this.createResult(trade, 'SELL', 'failed', 0, 0, 0, msg);
    }
  }

  private createSyntheticTrade(
    tokenId: string,
    conditionId: string,
    traderAddress: string,
    traderName: string,
    marketSlug: string,
    size: number,
    price: number,
    marketTitle?: string,
    outcome?: string,
  ): DetectedTrade {
    return {
      id: generateId(),
      timestamp: Date.now(),
      traderAddress,
      traderName,
      action: 'sell',
      marketSlug,
      marketTitle: marketTitle ?? marketSlug,
      conditionId,
      tokenId,
      outcome: outcome ?? '',
      size,
      price,
      usdValue: size * price,
      transactionHash: `price-exit-${tokenId.slice(0, 8)}-${Date.now()}`,
    };
  }

  private createStopLossTrade(
    tokenId: string,
    traderAddress: string,
    traderName: string,
    conditionId: string,
    marketSlug: string,
    size: number,
    price: number,
    reason: 'stop_loss' | 'trailing_stop',
    marketTitle?: string,
    outcome?: string,
  ): DetectedTrade {
    return {
      id: generateId(),
      timestamp: Date.now(),
      traderAddress,
      traderName,
      action: 'sell',
      marketSlug,
      marketTitle: marketTitle ?? marketSlug,
      conditionId,
      tokenId,
      outcome: outcome ?? '',
      size,
      price,
      usdValue: size * price,
      transactionHash: `stop-loss-${reason}-${tokenId.slice(0, 8)}-${Date.now()}`,
    };
  }

  /**
   * Process a detected trade (route to buy or sell)
   */
  async processTrade(trade: DetectedTrade): Promise<TradeResult> {
    // If trader is halted due to anomaly, skip new BUYs (SELLs still allowed).
    if (trade.action === 'buy' && queries.isTraderHalted(trade.traderAddress)) {
      log.info(
        { trader: trade.traderName, market: trade.marketTitle },
        'Skipping BUY: trader halted (anomaly)',
      );
      const halted = this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, 'Trader halted (anomaly)');
      try {
        queries.insertTrade(halted);
      } catch (err) {
        log.error({ err }, 'Failed to persist halted-trader skipped trade');
      }
      return halted;
    }

    // If trader is in exit-only mode, ignore their BUY signals but still allow
    // SELLs (so we can exit positions they originally opened).
    if (trade.action === 'buy') {
      const trader = queries.getTraderByAddress(trade.traderAddress);
      if (trader?.exitOnly) {
        log.info(
          { trader: trade.traderName, market: trade.marketTitle },
          'Skipping BUY: trader in exit-only mode',
        );
        const skipped = this.createResult(
          trade,
          'BUY',
          'skipped',
          0,
          0,
          0,
          'Trader in exit-only mode',
        );
        try {
          queries.insertTrade(skipped);
        } catch (err) {
          log.error({ err }, 'Failed to persist exit-only skipped trade');
        }
        return skipped;
      }
    }

    const result =
      trade.action === 'buy' ? await this.executeBuy(trade) : await this.executeSell(trade);

    // Persist skipped trades too so the dashboard shows *why* we're not copying.
    // (simulated/filled/failed are already written by the execute* paths.)
    if (result.status === 'skipped') {
      try {
        queries.insertTrade(result);
      } catch (err) {
        log.error({ err }, 'Failed to persist skipped trade');
      }
    }

    return result;
  }

  private createResult(
    trade: DetectedTrade,
    side: 'BUY' | 'SELL',
    status: TradeResult['status'],
    price: number,
    size: number,
    totalUsd: number,
    error?: string,
  ): TradeResult {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      traderAddress: trade.traderAddress,
      traderName: trade.traderName,
      side,
      marketSlug: trade.marketSlug,
      marketTitle: trade.marketTitle,
      conditionId: trade.conditionId,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      size,
      price,
      totalUsd,
      status,
      error,
      originalTraderSize: trade.size,
      originalTraderPrice: trade.price,
      isDryRun: config.dryRun,
      commission: 0,
    };
  }
}
