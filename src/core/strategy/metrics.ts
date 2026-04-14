/**
 * Calmar ratio = total PnL / max drawdown.
 * Higher is better. Returns Infinity if no drawdown.
 */
export function calmar(totalPnl: number, maxDrawdown: number): number {
  if (maxDrawdown === 0) return totalPnl > 0 ? Infinity : 0;
  return totalPnl / maxDrawdown;
}

/**
 * Annualized Sharpe ratio from an equity curve (daily values).
 * sharpe = (mean_daily_return / std_daily_return) * sqrt(252).
 * Returns 0 if fewer than 2 data points or zero variance.
 */
export function sharpe(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i]! - equityCurve[i - 1]!) / equityCurve[i - 1]!);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

/**
 * Win rate = wins / total. Returns 0 if total = 0.
 */
export function winRate(wins: number, total: number): number {
  if (total === 0) return 0;
  return wins / total;
}
