import type { LiquidityMetrics, LiquidityCheckResult, OrderBookResponse } from '../../types.js';

/**
 * Compute liquidity metrics from an order book snapshot.
 *
 * Polymarket CLOB returns:
 *   bids: ASC by price (worst first) — book.bids[last] is best bid (highest)
 *   asks: DESC by price (worst first) — book.asks[last] is best ask (lowest)
 *   each entry: { price: string, size: string }
 *
 * We sort locally to be robust regardless of server order.
 */
export function computeLiquidityMetrics(
  book: OrderBookResponse,
  depthSlippagePct: number,
): LiquidityMetrics {
  // Sort locally so index 0 is always best.
  const bidsSortedDesc = [...book.bids]
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size))
    .sort((a, b) => b.price - a.price); // highest first
  const asksSortedAsc = [...book.asks]
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price); // lowest first

  const bid = bidsSortedDesc.length > 0 ? bidsSortedDesc[0].price : 0;
  const ask = asksSortedAsc.length > 0 ? asksSortedAsc[0].price : 0;

  // Midpoint
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;

  // Spread as % of midpoint
  const spreadPct =
    midpoint > 0 && bid > 0 && ask > 0 ? ((ask - bid) / midpoint) * 100 : 999;

  // Depth available within slippage window.
  // IMPORTANT: we measure relative to each side's BEST price, not midpoint.
  // Measuring relative to midpoint breaks when spread > window (e.g. spread
  // 4% with ±2% window → best bid/ask themselves fall outside, depth=0).
  // For a BUY we care about ask-side (we're lifting offers); for a SELL we
  // care about bid-side. Since checkLiquidity() is currently only used on
  // the BUY path, depth here = ask-side up to best_ask × (1 + pct/100).
  // We still compute bid-side for symmetry / informational purposes.
  const askCeiling = ask > 0 ? ask * (1 + depthSlippagePct / 100) : 0;
  let depthAt2pct = 0;
  for (const level of asksSortedAsc) {
    if (level.price <= askCeiling) {
      depthAt2pct += level.price * level.size;
    } else {
      break;
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
