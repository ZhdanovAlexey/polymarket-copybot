import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { ClobClientWrapper, getClobClient } from '../api/clob-client.js';
import { RiskManager } from './risk-manager.js';
import { Portfolio } from './portfolio.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, TradeResult } from '../types.js';

const log = createLogger('executor');

export class Executor {
  private riskManager: RiskManager;
  private portfolio: Portfolio;
  private clobClient: ClobClientWrapper;

  constructor(riskManager?: RiskManager, portfolio?: Portfolio) {
    this.riskManager = riskManager ?? new RiskManager();
    this.portfolio = portfolio ?? new Portfolio();
    this.clobClient = getClobClient();
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
      // TODO: clobClient.createAndPostOrder(...)
      log.warn('Real trading not yet implemented');
      return this.createResult(trade, 'BUY', 'failed', midpoint, size, totalUsd, 'Real trading not implemented');

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
      log.warn('Real trading not yet implemented');
      return this.createResult(trade, 'SELL', 'failed', bestBid, size, totalUsd, 'Real trading not implemented');

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
