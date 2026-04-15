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

  // Depth at N% from midpoint: sum USD on ask-side up to midpoint*(1+pct)
  // and bid-side down to midpoint*(1-pct).
  const ceiling = midpoint * (1 + depthSlippagePct / 100);
  let depthAt2pct = 0;
  for (const level of asksSortedAsc) {
    if (level.price <= ceiling) {
      depthAt2pct += level.price * level.size;
    } else {
      break; // sorted ASC — further entries are even higher
    }
  }
  const floor = midpoint * (1 - depthSlippagePct / 100);
  for (const level of bidsSortedDesc) {
    if (level.price >= floor) {
      depthAt2pct += level.price * level.size;
    } else {
      break; // sorted DESC — further entries are even lower
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
