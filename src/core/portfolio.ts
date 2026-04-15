import { createLogger } from '../utils/logger.js';
import { ClobClientWrapper, getClobClient } from '../api/clob-client.js';
import * as queries from '../db/queries.js';
import type { BotPosition, TradeResult } from '../types.js';

const log = createLogger('portfolio');

export class Portfolio {
  private clobClient: ClobClientWrapper;

  constructor(clobClient?: ClobClientWrapper) {
    this.clobClient = clobClient ?? getClobClient();
  }

  /**
   * Get position by token ID
   */
  getPosition(tokenId: string): BotPosition | undefined {
    return queries.getPositionByTokenId(tokenId);
  }

  /**
   * Get all open positions
   */
  getAllPositions(): BotPosition[] {
    return queries.getAllOpenPositions();
  }

  /**
   * Update position after a BUY trade
   */
  updateAfterBuy(trade: TradeResult): void {
    const existing = queries.getPositionByTokenId(trade.tokenId);

    if (existing) {
      // Update: recalculate avg price
      const totalShares = existing.totalShares + trade.size;
      const totalInvested = existing.totalInvested + trade.totalUsd;
      const avgPrice = totalInvested / totalShares;

      queries.upsertPosition({
        tokenId: trade.tokenId,
        conditionId: trade.conditionId,
        marketSlug: trade.marketSlug,
        marketTitle: trade.marketTitle,
        outcome: trade.outcome,
        totalShares,
        avgPrice,
        totalInvested,
        openedAt: existing.openedAt,
        status: 'open',
      });

      log.info({ tokenId: trade.tokenId, totalShares, avgPrice: avgPrice.toFixed(4) }, 'Position updated (BUY)');
    } else {
      // New position
      queries.upsertPosition({
        tokenId: trade.tokenId,
        conditionId: trade.conditionId,
        marketSlug: trade.marketSlug,
        marketTitle: trade.marketTitle,
        outcome: trade.outcome,
        totalShares: trade.size,
        avgPrice: trade.price,
        totalInvested: trade.totalUsd,
        openedAt: new Date().toISOString(),
        status: 'open',
      });

      log.info({ tokenId: trade.tokenId, shares: trade.size, price: trade.price }, 'New position opened');
    }
  }

  /**
   * Update position after a SELL trade
   */
  updateAfterSell(trade: TradeResult): void {
    const existing = queries.getPositionByTokenId(trade.tokenId);
    if (!existing) {
      log.warn({ tokenId: trade.tokenId }, 'No position found for SELL');
      return;
    }

    const remainingShares = existing.totalShares - trade.size;

    if (remainingShares <= 0.001) {
      // Close position
      queries.closePosition(trade.tokenId);
      log.info({ tokenId: trade.tokenId }, 'Position closed');
    } else {
      // Reduce position
      const remainingInvested = existing.avgPrice * remainingShares;
      queries.upsertPosition({
        tokenId: trade.tokenId,
        conditionId: existing.conditionId,
        marketSlug: existing.marketSlug,
        marketTitle: existing.marketTitle,
        outcome: existing.outcome,
        totalShares: remainingShares,
        avgPrice: existing.avgPrice,
        totalInvested: remainingInvested,
        openedAt: existing.openedAt,
        status: 'open',
      });
      log.info({ tokenId: trade.tokenId, remaining: remainingShares }, 'Position reduced');
    }
  }

  /**
   * Mark-to-market: fetch current price for each open position,
   * update high_price tracker (used by trailing stop-loss).
   *
   * Errors per-position are swallowed so one failing token doesn't
   * block the others.
   */
  async markToMarket(): Promise<void> {
    const positions = this.getAllPositions();
    if (positions.length === 0) return;

    log.debug({ count: positions.length }, 'Starting mark-to-market');

    for (const p of positions) {
      try {
        const price = await this.clobClient.getMidpoint(p.tokenId);
        if (isNaN(price) || price <= 0) continue;

        const now = Date.now();

        // Always update current price
        queries.setPositionCurrentPrice(p.tokenId, price, now);

        // Update high_price if this is a new high
        if (p.highPrice === null || p.highPrice === undefined || price > p.highPrice) {
          queries.setPositionHighPrice(p.tokenId, price, now);
          log.debug({ tokenId: p.tokenId, price, prev: p.highPrice }, 'High price updated');
        }
      } catch (err) {
        log.warn({ err, tokenId: p.tokenId }, 'MTM price fetch failed for position');
      }
    }

    log.debug({ count: positions.length }, 'Mark-to-market complete');
  }

  /**
   * Calculate total portfolio value (requires current prices)
   */
  getTotalInvested(): number {
    return this.getAllPositions().reduce((sum, p) => sum + p.totalInvested, 0);
  }
}
