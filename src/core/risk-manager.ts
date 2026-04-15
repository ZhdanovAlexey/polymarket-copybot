import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, RiskCheckResult, BotPosition } from '../types.js';

const log = createLogger('risk-manager');

export class RiskManager {

  /**
   * Full risk check before executing a trade
   */
  canTrade(trade: DetectedTrade): RiskCheckResult {
    // Check 1: Daily P&L limit
    const dailyCheck = this.checkDailyLimit();
    if (!dailyCheck.allowed) return dailyCheck;

    // Check 2: Max open positions
    const positionsCheck = this.checkMaxPositions();
    if (!positionsCheck.allowed) return positionsCheck;

    // Check 3: Min trade size (don't copy micro-trades)
    if (trade.usdValue < 0.5) {
      return { allowed: false, reason: 'Trade too small (< $0.50)' };
    }

    return { allowed: true };
  }

  /**
   * Check slippage between our price and trader's price
   */
  checkSlippage(currentPrice: number, traderPrice: number): RiskCheckResult {
    if (traderPrice === 0) return { allowed: true };
    const slippage = Math.abs(currentPrice - traderPrice) / traderPrice * 100;
    if (slippage > config.maxSlippagePct) {
      return { allowed: false, reason: `Slippage ${slippage.toFixed(1)}% exceeds max ${config.maxSlippagePct}%` };
    }
    return { allowed: true };
  }

  /**
   * Check daily P&L limit
   */
  checkDailyLimit(): RiskCheckResult {
    if (config.dailyLossLimitUsd <= 0) return { allowed: true };

    const todayTrades = queries.getTodayTrades();
    const todayPnl = todayTrades
      .filter(t => t.status === 'filled' || t.status === 'simulated')
      .reduce((sum, t) => {
        if (t.side === 'SELL') return sum + t.totalUsd;
        if (t.side === 'BUY') return sum - t.totalUsd;
        return sum;
      }, 0);

    if (todayPnl < -config.dailyLossLimitUsd) {
      return { allowed: false, reason: `Daily loss limit reached: ${todayPnl.toFixed(2)}` };
    }
    return { allowed: true };
  }

  /**
   * Check max open positions
   */
  checkMaxPositions(): RiskCheckResult {
    const positions = queries.getAllOpenPositions();
    if (positions.length >= config.maxOpenPositions) {
      return { allowed: false, reason: `Max positions (${config.maxOpenPositions}) reached` };
    }
    return { allowed: true };
  }

  /**
   * Check concentration limits: max positions per market and max token exposure.
   */
  checkConcentration(
    trade: DetectedTrade,
    positions: BotPosition[],
    equity: number,
  ): RiskCheckResult {
    const marketCheck = this.checkMarketConcentration(trade.conditionId, positions);
    if (!marketCheck.allowed) return marketCheck;

    const tokenCheck = this.checkTokenExposure(trade.tokenId, trade.usdValue || 0, positions, equity);
    if (!tokenCheck.allowed) return tokenCheck;

    // TODO Phase 5+: event-level concentration via negRiskMarketId from markets_cache
    return { allowed: true };
  }

  private checkMarketConcentration(conditionId: string, positions: BotPosition[]): RiskCheckResult {
    const sameMarket = positions.filter((p) => p.conditionId === conditionId && p.status === 'open');
    if (sameMarket.length >= config.maxPositionsPerMarket) {
      return {
        allowed: false,
        reason: `Max ${config.maxPositionsPerMarket} positions per market reached`,
      };
    }
    return { allowed: true };
  }

  private checkTokenExposure(
    tokenId: string,
    tradeUsd: number,
    positions: BotPosition[],
    equity: number,
  ): RiskCheckResult {
    const existing = positions.filter((p) => p.tokenId === tokenId && p.status === 'open');
    const existingUsd = existing.reduce((s, p) => {
      const mtm =
        p.currentPrice !== null && p.currentPrice !== undefined
          ? p.totalShares * p.currentPrice
          : p.totalInvested;
      return s + mtm;
    }, 0);
    const maxUsd = equity * (config.maxExposurePerTokenPct / 100);
    if (existingUsd + tradeUsd > maxUsd) {
      return {
        allowed: false,
        reason: `Token exposure $${(existingUsd + tradeUsd).toFixed(0)} exceeds ${config.maxExposurePerTokenPct}% of equity ($${maxUsd.toFixed(0)})`,
      };
    }
    return { allowed: true };
  }

  /**
   * Check market liquidity
   */
  checkLiquidity(liquidity: number): RiskCheckResult {
    if (liquidity < config.minMarketLiquidity) {
      return { allowed: false, reason: `Market liquidity $${liquidity} below minimum $${config.minMarketLiquidity}` };
    }
    return { allowed: true };
  }
}
