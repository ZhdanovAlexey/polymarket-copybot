import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { generateId, sleep } from '../utils/helpers.js';
import { ClobClientWrapper, getClobClient } from '../api/clob-client.js';
import { fetchWithRetry } from '../utils/retry.js';
import { RiskManager } from './risk-manager.js';
import { Portfolio } from './portfolio.js';
import { computeLiquidityMetrics, checkLiquidity } from './execution/liquidity.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, TradeResult, TradeReason } from '../types.js';
import type { HealthChecker } from './health-checker.js';

const log = createLogger('executor');

// Lazily-imported types from @polymarket/clob-client
type AuthenticatedClobClient = import('@polymarket/clob-client').ClobClient;

export class Executor {
  private riskManager: RiskManager;
  private portfolio: Portfolio;
  private clobClient: ClobClientWrapper;
  private authenticatedClient: AuthenticatedClobClient | null = null;
  private authFailedAt: number | null = null;
  private healthChecker?: HealthChecker;

  constructor(riskManager?: RiskManager, portfolio?: Portfolio, healthChecker?: HealthChecker) {
    this.riskManager = riskManager ?? new RiskManager();
    this.portfolio = portfolio ?? new Portfolio();
    this.clobClient = getClobClient();
    this.healthChecker = healthChecker;
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
   * Execute a BUY order (or simulate in dry run)
   */
  async executeBuy(trade: DetectedTrade): Promise<TradeResult> {
    log.info({
      trader: trade.traderName,
      market: trade.marketTitle,
      outcome: trade.outcome,
      traderPrice: trade.price,
    }, 'Processing BUY signal');

    // 1. Risk check
    const riskCheck = this.riskManager.canTrade(trade);
    if (!riskCheck.allowed) {
      log.warn({ reason: riskCheck.reason }, 'Risk check FAILED');
      return this.createResult(trade, 'BUY', 'skipped', 0, 0, 0, riskCheck.reason);
    }

    try {
      // 2. Get current price from CLOB (attempt order book fetch for liquidity check too)
      let midpoint: number;
      let liquidityChecked = false;
      let totalUsd = this.computeBetSize(trade.usdValue);

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

      // 4. Calculate size — proportional to trader's USD when configured.
      // Note: totalUsd may already be adjusted by liquidity check above
      const size = totalUsd / midpoint;

      // 5. Execute or simulate
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

      // 3. Conservative mode: sell entire position
      const size = position.totalShares;
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
