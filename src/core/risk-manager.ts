import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import * as queries from '../db/queries.js';
import type { DetectedTrade, RiskCheckResult } from '../types.js';

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
   * Check daily P&L limit based on realized PnL from positions closed today.
   * Only counts actual losses from sold/redeemed positions — open buys are not losses.
   */
  checkDailyLimit(): RiskCheckResult {
    if (config.dailyLossLimitUsd <= 0) return { allowed: true };

    const todayRealizedPnl = queries.getTodayRealizedPnl();

    if (todayRealizedPnl < -config.dailyLossLimitUsd) {
      return { allowed: false, reason: `Daily loss limit reached: ${todayRealizedPnl.toFixed(2)}` };
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
   * Check market liquidity
   */
  checkLiquidity(liquidity: number): RiskCheckResult {
    if (liquidity < config.minMarketLiquidity) {
      return { allowed: false, reason: `Market liquidity $${liquidity} below minimum $${config.minMarketLiquidity}` };
    }
    return { allowed: true };
  }
}
