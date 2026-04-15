import type { LiquidityMetrics, LiquidityCheckResult, OrderBookResponse } from '../../types.js';

/**
 * Compute liquidity metrics from an order book snapshot.
 *
 * Polymarket CLOB book format:
 *   bids[0] = best bid (highest price, sorted DESC)
 *   asks[0] = best ask (lowest price, sorted ASC)
 *   each entry: { price: string, size: string }
 */
export function computeLiquidityMetrics(
  book: OrderBookResponse,
  depthSlippagePct: number,
): LiquidityMetrics {
  const bid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
  const ask = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 0;

  // Midpoint
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;

  // Spread as % of midpoint
  const spreadPct =
    midpoint > 0 && bid > 0 && ask > 0 ? ((ask - bid) / midpoint) * 100 : 999;

  // Depth at N% from midpoint (summed ask-side USD within slippage band)
  // Summing size * price for each ask level where price <= midpoint * (1 + pct/100)
  const ceiling = midpoint * (1 + depthSlippagePct / 100);
  let depthAt2pct = 0;
  for (const level of book.asks) {
    const p = parseFloat(level.price);
    const s = parseFloat(level.size);
    if (p <= ceiling) {
      depthAt2pct += p * s;
    } else {
      break; // asks are sorted ASC, no need to continue
    }
  }

  // Also include bid-side depth within the band (below midpoint)
  const floor = midpoint * (1 - depthSlippagePct / 100);
  for (const level of book.bids) {
    const p = parseFloat(level.price);
    const s = parseFloat(level.size);
    if (p >= floor) {
      depthAt2pct += p * s;
    } else {
      break; // bids sorted DESC
    }
  }

  return { bid, ask, midpoint, spreadPct, depthAt2pct };
}

/**
 * Check whether the liquidity is sufficient for the intended trade.
 */
export function checkLiquidity(
  metrics: LiquidityMetrics,
  betUsd: number,
  cfg: {
    minLiquidityUsd: number;
    maxSpreadPct: number;
    depthSlippagePct: number; // informational, already applied in compute
    depthAdaptivePct: number;
  },
): LiquidityCheckResult {
  // 1. Spread check
  if (cfg.maxSpreadPct > 0 && metrics.spreadPct > cfg.maxSpreadPct) {
    return {
      allowed: false,
      reason: `Spread ${metrics.spreadPct.toFixed(2)}% > max ${cfg.maxSpreadPct}%`,
    };
  }

  // 2. Depth check
  if (cfg.minLiquidityUsd > 0 && metrics.depthAt2pct < betUsd) {
    // Try adaptive: reduce bet to depthAdaptivePct of available depth
    const adapted = metrics.depthAt2pct * (cfg.depthAdaptivePct / 100);
    const MIN_BET = 0.5;
    if (adapted >= MIN_BET) {
      return { allowed: true, adjustedBetUsd: adapted };
    }
    return {
      allowed: false,
      reason: `Insufficient depth: $${metrics.depthAt2pct.toFixed(2)} available, need $${betUsd.toFixed(2)} (adapted $${adapted.toFixed(2)} < min $${MIN_BET})`,
    };
  }

  return { allowed: true };
}
