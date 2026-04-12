import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { generateId, sleep } from '../utils/helpers.js';
import { ClobClientWrapper, getClobClient } from '../api/clob-client.js';
import { fetchWithRetry } from '../utils/retry.js';
import { RiskManager } from './risk-manager.js';
import { Portfolio } from './portfolio.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, TradeResult } from '../types.js';

const log = createLogger('executor');

// Lazily-imported types from @polymarket/clob-client
type AuthenticatedClobClient = import('@polymarket/clob-client').ClobClient;

export class Executor {
  private riskManager: RiskManager;
  private portfolio: Portfolio;
  private clobClient: ClobClientWrapper;
  private authenticatedClient: AuthenticatedClobClient | null = null;
  private authClientInitAttempted = false;

  constructor(riskManager?: RiskManager, portfolio?: Portfolio) {
    this.riskManager = riskManager ?? new RiskManager();
    this.portfolio = portfolio ?? new Portfolio();
    this.clobClient = getClobClient();
  }

  /**
   * Lazily create an authenticated ClobClient for real order placement.
   * Returns null if credentials are missing (will fall back to dry-run with a warning).
   */
  private async getAuthenticatedClobClient(): Promise<AuthenticatedClobClient | null> {
    if (this.authenticatedClient) return this.authenticatedClient;
    if (this.authClientInitAttempted) return null;

    this.authClientInitAttempted = true;

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
      return this.authenticatedClient;
    } catch (err) {
      log.error({ err }, 'Failed to create authenticated ClobClient');
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
      // 2. Get current price from CLOB
      const midpoint = await this.clobClient.getMidpoint(trade.tokenId);

      // 3. Check slippage
      const slippageCheck = this.riskManager.checkSlippage(midpoint, trade.price);
      if (!slippageCheck.allowed) {
        log.warn({ reason: slippageCheck.reason }, 'Slippage check FAILED');
        return this.createResult(trade, 'BUY', 'skipped', midpoint, 0, 0, slippageCheck.reason);
      }

      // 4. Calculate size
      const size = config.betSizeUsd / midpoint;
      const totalUsd = config.betSizeUsd;

      // 5. Execute or simulate
      if (config.dryRun) {
        log.info({
          market: trade.marketTitle,
          outcome: trade.outcome,
          shares: size.toFixed(2),
          price: midpoint.toFixed(4),
          total: totalUsd.toFixed(2),
        }, 'DRY RUN: Would BUY');

        const result = this.createResult(trade, 'BUY', 'simulated', midpoint, size, totalUsd);
        result.isDryRun = true;

        // Save to DB
        queries.insertTrade(result);
        this.portfolio.updateAfterBuy(result);
        queries.insertActivity('trade', `DRY RUN BUY: ${trade.marketTitle} ${trade.outcome} - ${size.toFixed(2)} shares @ $${midpoint.toFixed(4)}`);

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
        const pnl = totalUsd - position.totalInvested;
        log.info({
          market: trade.marketTitle,
          shares: size.toFixed(2),
          price: bestBid.toFixed(4),
          total: totalUsd.toFixed(2),
          pnl: pnl.toFixed(2),
        }, 'DRY RUN: Would SELL');

        const result = this.createResult(trade, 'SELL', 'simulated', bestBid, size, totalUsd);
        result.isDryRun = true;

        queries.insertTrade(result);
        this.portfolio.updateAfterSell(result);
        queries.insertActivity('trade', `DRY RUN SELL: ${trade.marketTitle} - ${size.toFixed(2)} shares @ $${bestBid.toFixed(4)} (P&L: $${pnl.toFixed(2)})`);

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
   * Process a detected trade (route to buy or sell)
   */
  async processTrade(trade: DetectedTrade): Promise<TradeResult> {
    if (trade.action === 'buy') {
      return this.executeBuy(trade);
    } else {
      return this.executeSell(trade);
    }
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
    };
  }
}
