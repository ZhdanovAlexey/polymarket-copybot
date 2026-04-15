import { createLogger } from '../utils/logger.js';
import * as queries from '../db/queries.js';
import type { BotPosition, TradeResult } from '../types.js';

const log = createLogger('portfolio');

export class Portfolio {

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
   * Calculate total portfolio value (requires current prices)
   */
  getTotalInvested(): number {
    return this.getAllPositions().reduce((sum, p) => sum + p.totalInvested, 0);
  }

  /**
   * Fetch current midpoint prices for all open positions and persist to DB.
   * Used for mark-to-market valuation in budget calculations.
   * Failures per-position are tolerated (market may be resolved / 404).
   */
  async markToMarket(
    getMidpoint: (tokenId: string) => Promise<number>,
  ): Promise<{ updated: number; failed: number }> {
    const positions = this.getAllPositions();
    const now = Math.floor(Date.now() / 1000);
    let updated = 0;
    let failed = 0;

    await Promise.all(
      positions.map(async (p) => {
        try {
          const price = await getMidpoint(p.tokenId);
          if (Number.isFinite(price) && price > 0) {
            queries.setPositionPrice(p.tokenId, price, now);
            updated++;
          }
        } catch {
          failed++;
        }
      }),
    );

    if (updated > 0 || failed > 0) {
      log.debug({ updated, failed, total: positions.length }, 'Mark-to-market updated');
    }
    return { updated, failed };
  }
}
