import type { DetectedTrade, BotPosition, ExitSignal, SellMode } from '../../types.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('exit-strategy');

export class ExitStrategy {
  /**
   * Evaluate whether we should act on a trader's SELL signal and how much.
   *
   * Returns null when the current sellMode does not respond to trader SELL events
   * (e.g. take_profit / partial_scale_out use price-based triggers instead).
   */
  evaluateTraderSell(
    trade: DetectedTrade,
    position: BotPosition,
    traderPositionBefore: number,
    traderSellSize: number,
  ): ExitSignal | null {
    const mode = config.sellMode as SellMode;

    if (mode === 'mirror') {
      return {
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        sellPct: 1.0,
        reason: 'Mirror: full exit',
        triggerSource: 'trader_mirror',
      };
    }

    if (mode === 'proportional') {
      if (traderPositionBefore <= 0) {
        log.warn(
          { trader: trade.traderAddress, tokenId: trade.tokenId },
          'Proportional: trader position unknown, fallback to mirror',
        );
        return {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          sellPct: 1.0,
          reason: 'Proportional fallback: mirror',
          triggerSource: 'trader_mirror',
        };
      }
      const sellPct = Math.min(1.0, traderSellSize / traderPositionBefore);
      return {
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        sellPct,
        reason: `Proportional: ${(sellPct * 100).toFixed(0)}%`,
        triggerSource: 'trader_proportional',
      };
    }

    // take_profit / partial_scale_out — these modes do NOT react to trader SELL
    return null;
  }

  /**
   * Evaluate price-based exit conditions (take_profit / partial_scale_out).
   * Called from markToMarket after each price update.
   */
  evaluatePriceExit(
    position: BotPosition,
    currentPrice: number,
    alreadyScaledOut: boolean,
  ): ExitSignal | null {
    const mode = config.sellMode as SellMode;

    if (mode === 'take_profit') {
      const target = position.avgPrice * (1 + config.takeProfitPct / 100);
      if (currentPrice >= target) {
        return {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          sellPct: 1.0,
          reason: `Take profit: ${currentPrice.toFixed(3)} >= ${target.toFixed(3)}`,
          triggerSource: 'take_profit',
        };
      }
    }

    if (mode === 'partial_scale_out') {
      if (!alreadyScaledOut) {
        const target = position.avgPrice * (1 + config.partialScaleOutThreshold / 100);
        if (currentPrice >= target) {
          return {
            tokenId: position.tokenId,
            conditionId: position.conditionId,
            sellPct: config.partialScaleOutPct / 100,
            reason: `Scale-out ${config.partialScaleOutPct}% @ ${currentPrice.toFixed(3)}`,
            triggerSource: 'scale_out',
          };
        }
      }
    }

    return null;
  }
}
